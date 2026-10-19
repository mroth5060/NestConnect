import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import type { Conversation, Notification, NotificationType } from "@ding/schemas";
import { mentionHandle, mentionsToNames } from "@ding/schemas";
import { Store } from "../data/store";
import { ConversationLog, SYSTEM } from "../conversations/conversation-log";
import { runInTenant } from "../tenancy/tenant-scope";
import { RealtimeGateway } from "../realtime/realtime.gateway";
import { PushService, type PushKind } from "../push/push.service";

/** How often we sweep for snoozed conversations whose wake time has passed. */
const SNOOZE_SWEEP_MS = 30_000;

/** Bell type → push class, so a mention lands on its own Android channel and
 *  ignores quiet hours while a routine reminder doesn't. */
const PUSH_KIND: Record<NotificationType, PushKind> = {
  mention: "mention",
  snooze_due: "reminder",
  team_transfer: "team_chat",
  ops_review: "reminder",
  ops_must_read: "assignment",
  chat_mention: "chat_mention",
  // A channel that's stopped working: the people who can fix it should hear.
  channel_reauth: "assignment",
};

/**
 * The bell's brain. Creates per-user notifications (persisted + pushed live) and
 * runs the snooze sweep that wakes due conversations and tells their owner.
 *
 * Deliberately narrow: high-frequency events (a brand-new inbound chat) stay
 * sound-only and never become a notification here.
 */
@Injectable()
export class NotificationsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(NotificationsService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly store: Store,
    private readonly realtime: RealtimeGateway,
    private readonly push: PushService,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.sweepSnoozed(), SNOOZE_SWEEP_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Persist a notification, push it to the user's live session(s), and send it
   * to their phone.
   *
   * The three are one act deliberately: a bell row nobody sees because they're
   * away from the desk is the failure this exists to prevent. PushService
   * decides whether it actually goes out — the actor, an open thread, the
   * person's preferences and quiet hours are all its call, not this one's.
   */
  async create(
    userId: string,
    input: {
      type: Notification["type"];
      title: string;
      body?: string;
      conversationId?: string | null;
      /** A Business Ops SOP to open instead of a conversation. */
      opsSopId?: string | null;
      /** A Team Chat chat to open instead. */
      chatRoomId?: string | null;
      /** Whoever caused this, so they're never notified about their own action. */
      actorUserId?: string;
      /** Overrides the kind inferred from `type` (a mention is not a message). */
      pushKind?: PushKind;
    },
  ): Promise<void> {
    const { actorUserId, pushKind, ...row } = input;
    const notif = await this.store.createNotification({ userId, ...row });
    this.realtime.emitNotification(userId, notif);
    this.push.notify({
      userIds: [userId],
      kind: pushKind ?? PUSH_KIND[row.type] ?? "message",
      title: row.title,
      body: row.body ?? "",
      conversationId: row.conversationId ?? undefined,
      opsSopId: row.opsSopId ?? undefined,
      chatRoomId: row.chatRoomId ?? undefined,
      actorUserId,
      // The bell row reaching the screen plays its own sound.
      cue: false,
    });
  }

  /**
   * On an internal note: tell every teammate it @-mentions, and everyone
   * already in this conversation's notes — whoever wrote one, or was
   * @-mentioned in one. That second group is how you hear that somebody
   * answered your note: an answer rarely @-mentions back the person it answers,
   * and without it "@Isaac can you check?" gets a reply nobody is told about.
   * Never the author, and never twice.
   */
  /**
   * Who a new internal note is for: every teammate it @-mentions ("mention"),
   * and everyone already in this conversation's notes — whoever wrote one, or
   * was @-mentioned in one ("reply"). Never the author.
   *
   * The same people the note notifies, and whose My Inbound it lands in (see
   * NoteFollowUp): one answer to "who is this note for", used for both.
   */
  async noteAudience(
    conversationId: string,
    body: string,
    authorId: string,
    noteId?: string,
  ): Promise<Map<string, "mention" | "reply">> {
    const members = await this.store.listMembers();
    const byHandle = new Map(members.map((m) => [mentionHandle(m.user), m.user.id]));
    const mentioned = new Set([...handlesIn(body)].map((h) => byHandle.get(h)).filter((id): id is string => !!id));
    const inNotes = await this.noteParticipants(conversationId, byHandle, noteId);
    const out = new Map<string, "mention" | "reply">();
    for (const m of members) {
      const id = m.user.id;
      if (id === authorId) continue;
      if (mentioned.has(id)) out.set(id, "mention");
      else if (inNotes.has(id)) out.set(id, "reply");
    }
    return out;
  }

  /**
   * On an internal note: tell every teammate it @-mentions, and everyone
   * already in this conversation's notes. That second group is how you hear
   * that somebody answered your note: an answer rarely @-mentions back the
   * person it answers, and without it "@Isaac can you check?" gets a reply
   * nobody is told about. Never the author, and never twice.
   */
  async notifyMentions(
    conversation: Conversation,
    body: string,
    authorName: string,
    authorId: string,
    noteId?: string,
    /** Already worked out by the caller (see `noteAudience`), to skip a second pass. */
    audience?: Map<string, "mention" | "reply">,
  ): Promise<void> {
    const members = await this.store.listMembers();
    const who = audience ?? (await this.noteAudience(conversation.id, body, authorId, noteId));
    // Shown by name ("@Nathan A"), the way the note itself reads in the app.
    const readable = mentionsToNames(body, members.map((m) => m.user));
    const snippet = readable.length > 120 ? `${readable.slice(0, 117)}…` : readable;
    const customer = conversation.contact.displayName;
    for (const [id, reason] of who) {
      await this.create(id, {
        type: "mention",
        title: reason === "mention" ? `${authorName} mentioned you` : `${authorName} replied in the notes on ${customer}`,
        body: snippet,
        conversationId: conversation.id,
        actorUserId: authorId,
      });
    }
  }

  /**
   * Who is in a conversation's notes: everyone who wrote one, and everyone
   * @-mentioned in one. Bounded, so a years-long thread can't stall a note.
   */
  private async noteParticipants(conversationId: string, byHandle: Map<string, string>, skipId?: string): Promise<Set<string>> {
    const people = new Set<string>();
    let before: string | undefined;
    for (let page = 0; page < 10; page++) {
      const { items, nextCursor } = await this.store.listMessages(conversationId, { before, limit: 100 });
      for (const m of items) {
        if (!m.internal || m.id === skipId) continue;
        if (m.authorUserId) people.add(m.authorUserId);
        for (const h of handlesIn(m.body)) {
          const id = byHandle.get(h);
          if (id) people.add(id);
        }
      }
      if (!nextCursor) break;
      before = nextCursor;
    }
    return people;
  }

  /**
   * A chat handed to a team with nobody picked: tell the team, or it sits in
   * their queue until someone happens to look. Everyone in the team except
   * whoever moved it, and only those who want "new chats for my team" — the
   * bell row is skipped too for anyone who switched it off, so turning it off
   * means it, not "no banner but the bell still fills up".
   */
  async notifyTeamTransfer(conversation: Conversation, teamId: string, byUserId: string): Promise<number> {
    const [team, by, members] = await Promise.all([
      this.store.getTeam(teamId),
      this.store.getUser(byUserId),
      this.store.listMembers(),
    ]);
    if (!team) return 0;
    let told = 0;
    for (const m of members) {
      if (m.user.id === byUserId || !m.teamIds.includes(teamId)) continue;
      const prefs = await this.push.preferences(m.user.id);
      if (!prefs.teamChats) continue;
      await this.create(m.user.id, {
        type: "team_transfer",
        title: by ? `${by.name} sent a chat to ${team.name}` : `A chat was sent to ${team.name}`,
        body: conversation.contact.displayName,
        conversationId: conversation.id,
        actorUserId: byUserId,
      });
      told++;
    }
    return told;
  }

  /** Wake snoozed conversations that have come due and tell their assignee. */
  private async sweepSnoozed(): Promise<void> {
    try {
      // Every workspace's due snoozes; each is woken inside its own workspace.
      const due = await this.store.listDueSnoozed();
      for (const conv of due) {
        await runInTenant(conv.orgId, async () => {
          const woken = await new ConversationLog(this.store).track(conv.id, SYSTEM, () => this.store.wakeSnoozed(conv.id));
          if (!woken) return;
          this.realtime.emitConversationUpdated(woken);
          if (conv.assigneeUserId) {
            await this.create(conv.assigneeUserId, {
              type: "snooze_due",
              title: "Snoozed chat is back",
              body: conv.contact.displayName,
              conversationId: conv.id,
            });
          }
        });
      }
    } catch (err) {
      this.logger.warn(`Snooze sweep failed: ${String(err)}`);
    }
  }
}

/** The @handles in a note, lower-cased. "@nathan." at the end of a sentence still means @nathan. */
function handlesIn(body: string): Set<string> {
  return new Set((body.toLowerCase().match(/@[\w.+-]+/g) ?? []).map((t) => t.replace(/[.+-]+$/, "")));
}
