import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import type { Message } from "@ding/schemas";
import { Store } from "../../data/store";
import { Mailer } from "../../mail/mailer.service";
import { visitorReplyEmail } from "../../mail/templates";
import { runInTenant } from "../../tenancy/tenant-scope";
import { isWorkspaceFrozen } from "../../tenancy/workspace-status";
import { SandboxPolicy } from "../../tenancy/sandbox";
import { NestChatService } from "./nestchat.service";

/** How long a reply goes unseen before it's emailed. Long enough for somebody
 *  who glanced away to come back; short enough to reach somebody who left. */
export const UNSEEN_REPLY_EMAIL_AFTER_MS = 5 * 60_000;
/** How far back a sweep looks. A server down for longer than this loses the
 *  follow-up for what was sent meanwhile, rather than emailing day-old news. */
const LOOKBACK_MS = 6 * 60 * 60_000;
const SWEEP_EVERY_MS = 60_000;
/** Set the first time this runs, so a deploy doesn't email the replies of the
 *  hours before it existed. */
const SINCE_KEY = "nestchat_visitor_email_since";

/**
 * Website chat: a visitor who leaves still hears back.
 *
 * The chat asks for an email "so we can reply if you leave", and the away
 * message says the same. This is what keeps the promise. A few minutes after
 * an agent replies, any reply the visitor hasn't seen is emailed to the
 * address they gave, the way every other channel (and every other chat tool)
 * reaches somebody who has gone.
 *
 * "Seen" is the widget's own read receipt: it marks a message read when it is
 * on screen. A reply still only sent or delivered after five minutes is one
 * nobody is looking at. Replies before the visitor's own latest message are
 * left alone — answering is proof enough of having read.
 *
 * Each reply is emailed once. The conversation's `visitorEmailedSeq` is
 * claimed before sending (compare-and-set, so two servers can't both send) and
 * put back if the email fails. Off per channel (`emailReplies`), never in a
 * demo workspace, and never without an address the visitor gave.
 */
@Injectable()
export class VisitorEmailService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VisitorEmailService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly store: Store,
    private readonly mailer: Mailer,
    private readonly nestchat: NestChatService,
    private readonly sandbox: SandboxPolicy,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.sweep(), SWEEP_EVERY_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass: email every conversation with a reply unseen for long enough.
   *  Returns the conversations emailed (for the checks). */
  async sweep(now: Date = new Date()): Promise<string[]> {
    if (this.running) return [];
    this.running = true;
    try {
      const since = await this.since(now);
      const from = new Date(Math.max(now.getTime() - LOOKBACK_MS, since.getTime()));
      const to = new Date(now.getTime() - UNSEEN_REPLY_EMAIL_AFTER_MS);
      if (to <= from) return [];
      const due = await this.store.listUnseenNestChatReplies(from, to);
      const sent: string[] = [];
      for (const { conversationId, orgId } of due) {
        if (isWorkspaceFrozen(orgId)) continue;
        try {
          if (await runInTenant(orgId, () => this.followUp(conversationId, to))) sent.push(conversationId);
        } catch (err) {
          this.logger.warn(`Visitor email for ${conversationId} failed: ${String(err)}`);
        }
      }
      return sent;
    } finally {
      this.running = false;
    }
  }

  private async since(now: Date): Promise<Date> {
    const saved = await this.store.getPlatformSetting(SINCE_KEY);
    const at = saved ? new Date(saved) : null;
    if (at && !Number.isNaN(at.getTime())) return at;
    await this.store.setPlatformSetting(SINCE_KEY, now.toISOString());
    return now;
  }

  /** Inside the conversation's workspace: email what's unseen, once. */
  private async followUp(conversationId: string, sentBefore: Date): Promise<boolean> {
    if (await this.sandbox.current()) return false;
    const conv = await this.store.getConversation(conversationId);
    if (!conv || conv.channel !== "nestchat") return false;
    const to = conv.contact.email?.trim();
    if (!to) return false;
    const appearance = await this.nestchat.appearanceFor(conv.inboxId);
    if (!appearance.emailReplies) return false;

    const prev = (await this.store.getVisitorEmailedSeq(conversationId)) ?? 0;
    const unseen = unseenReplies(conv.messages, prev, sentBefore);
    if (!unseen.length) return false;
    const through = unseen[unseen.length - 1]!.seq;
    if (!(await this.store.claimVisitorEmail(conversationId, prev, through))) return false;

    const inbox = await this.store.getInbox(conv.inboxId);
    const mail = visitorReplyEmail({
      // The business's own name: the chat's title is a greeting ("How can we
      // help?"), not who is writing.
      business: (await this.store.getOrganizationName(conv.orgId))?.trim() || inbox?.name || "Us",
      visitorName: isPlaceholderName(conv.contact.displayName) ? undefined : conv.contact.displayName.split(/\s+/)[0],
      replies: unseen.map((m) => ({
        author: m.authorName?.split(/\s+/)[0] || "Us",
        text: m.body.trim() || (m.attachments?.length ? "(sent you a file)" : ""),
      })),
      siteUrl: siteUrlOf(inbox?.handle),
    });
    const result = await this.mailer.sendMail({ to, ...mail });
    if (!result.sent) {
      // Put the claim back, so the next pass tries again.
      await this.store.claimVisitorEmail(conversationId, through, prev);
      this.logger.warn(`Visitor email for ${conversationId} not sent: ${result.error ?? "no email transport"}`);
      return false;
    }
    return true;
  }
}

/**
 * The agent replies a visitor hasn't seen: after the visitor's own latest
 * message (answering is proof of having read), past what was already emailed,
 * sent before the cut-off, and not yet read.
 */
export function unseenReplies(messages: Message[], emailedThrough: number, sentBefore: Date): Message[] {
  const lastVisitor = messages.reduce((n, m) => (m.direction === "in" ? Math.max(n, m.seq) : n), 0);
  return messages
    .filter(
      (m) =>
        m.direction === "out" &&
        !m.internal &&
        m.authorType !== "system" &&
        // Nest's own "nobody's online" reply isn't a reply to send on.
        !m.auto &&
        m.seq > Math.max(emailedThrough, lastVisitor) &&
        (m.status === "sent" || m.status === "delivered") &&
        new Date(m.createdAt).getTime() <= sentBefore.getTime(),
    )
    .sort((a, b) => a.seq - b.seq);
}

/** "Visitor 4f2a1c" is our placeholder, not a name to greet somebody by. */
function isPlaceholderName(name: string): boolean {
  return /^Visitor\b/i.test(name.trim());
}

/** The channel's website, when its handle is one ("shop.example.com"). */
function siteUrlOf(handle: string | undefined): string | undefined {
  const h = handle?.trim();
  if (!h || /\s/.test(h)) return undefined;
  if (/^https?:\/\//i.test(h)) return h;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/.*)?$/i.test(h) ? `https://${h}` : undefined;
}
