import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import type { Inbox } from "@ding/schemas";
import { env } from "../../config/env";
import { Store, type AttachmentInput } from "../../data/store";
import { MediaService } from "../../storage/media.service";
import { IngestService } from "../ingest.service";
import { htmlToText } from "../google/gmail-api";
import { MicrosoftOAuthService, OUTLOOK_CONFIG } from "./microsoft-oauth.service";
import {
  addressOf,
  graph,
  isNestOrigin,
  mailboxPath,
  recipientList,
  threadRefs,
  type GraphMessage,
} from "./graph-api";

type Folder = "inbox" | "sentitems";

const CURSOR = {
  inbox: { at: OUTLOOK_CONFIG.inboxCursor, ids: OUTLOOK_CONFIG.inboxCursorIds },
  sentitems: { at: OUTLOOK_CONFIG.sentCursor, ids: OUTLOOK_CONFIG.sentCursorIds },
} as const;

/**
 * Pulls new mail from every connected Outlook / Microsoft 365 inbox into the
 * shared inbound pipeline — the Outlook counterpart of GmailSyncService.
 *
 * Incremental by a per-folder time cursor: each pass asks Graph for messages
 * received at or after the newest one already seen. Inbox mail is ingested as
 * customer messages; Sent Items mail an agent wrote straight from Outlook is
 * recorded as outbound on its thread, so the conversation stays complete. Copies
 * of mail Nest sent itself are recognised by their marker header and skipped.
 */
@Injectable()
export class OutlookSyncService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutlookSyncService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly store: Store,
    private readonly ingest: IngestService,
    private readonly microsoft: MicrosoftOAuthService,
    private readonly media: MediaService,
  ) {}

  get isPollingDisabled(): boolean {
    return this.microsoft.isMock || env.outlook.pollSeconds <= 0;
  }

  onApplicationBootstrap(): void {
    if (this.isPollingDisabled) return;
    // With Redis, polling runs as one cluster-wide repeatable queue job.
    if (env.usingRedis) return;
    this.timer = setInterval(() => void this.syncAll(), env.outlook.pollSeconds * 1000);
    this.timer.unref?.();
    this.logger.log(`Outlook background poll every ${env.outlook.pollSeconds}s`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Sync every connected Outlook inbox once. Guards against overlapping runs. */
  async syncAll(): Promise<number> {
    if (this.microsoft.isMock || this.running) return 0;
    this.running = true;
    let synced = 0;
    try {
      for (const { inbox, config } of await this.outlookInboxes()) {
        try {
          await this.syncInbox(inbox, config);
          synced++;
        } catch (err) {
          this.logger.warn(`Outlook sync failed for ${inbox.handle}: ${message(err)}`);
        }
      }
    } finally {
      this.running = false;
    }
    return synced;
  }

  /**
   * Start a freshly-connected inbox's cursors at "now", so the first sync picks
   * up only mail that arrives from here on — no full-mailbox backfill.
   */
  async establishBaseline(inbox: Inbox, at = new Date()): Promise<void> {
    const iso = at.toISOString();
    await this.store.updateInbox(inbox.id, {
      channelConfig: {
        [OUTLOOK_CONFIG.inboxCursor]: iso,
        [OUTLOOK_CONFIG.sentCursor]: iso,
        [OUTLOOK_CONFIG.inboxCursorIds]: "",
        [OUTLOOK_CONFIG.sentCursorIds]: "",
      },
    });
  }

  /* ------------------------------- internals ------------------------------ */

  private async outlookInboxes(): Promise<Array<{ inbox: Inbox; config: Record<string, string> }>> {
    const out: Array<{ inbox: Inbox; config: Record<string, string> }> = [];
    for (const inbox of await this.store.listInboxes()) {
      if (inbox.type !== "email") continue;
      const config = await this.store.getInboxConfig(inbox.id);
      if (config?.[OUTLOOK_CONFIG.provider] === "outlook") out.push({ inbox, config });
    }
    return out;
  }

  async syncInbox(inbox: Inbox, config: Record<string, string>): Promise<void> {
    if (!config[OUTLOOK_CONFIG.inboxCursor] || !config[OUTLOOK_CONFIG.sentCursor]) {
      await this.establishBaseline(inbox);
      return;
    }
    const token = await this.microsoft.accessTokenForInbox(inbox, config);
    const base = mailboxPath(config[OUTLOOK_CONFIG.sharedMailbox] || undefined);
    let ingested = 0;
    for (const folder of ["inbox", "sentitems"] as const) {
      ingested += await this.syncFolder(inbox, config, token, base, folder);
    }
    if (ingested) this.logger.log(`Outlook: ingested ${ingested} new message(s) for ${inbox.handle}`);
  }

  private async syncFolder(
    inbox: Inbox,
    config: Record<string, string>,
    token: string,
    base: string,
    folder: Folder,
  ): Promise<number> {
    const keys = CURSOR[folder];
    let cursor = config[keys.at];
    let seenAtCursor = new Set((config[keys.ids] ?? "").split(",").filter(Boolean));

    let ingested = 0;
    for (const item of await graph.listSince(token, base, folder, cursor)) {
      if (item.receivedDateTime === cursor && seenAtCursor.has(item.id)) continue;
      try {
        if (await this.ingestOne(inbox, config, token, base, folder, item.id)) ingested++;
      } catch (err) {
        // One bad message must not wedge the cursor behind it forever; it is
        // logged and passed over, the same trade the Gmail sync makes.
        this.logger.warn(`Outlook ingest of message ${item.id} failed: ${message(err)}`);
      }
      if (item.receivedDateTime !== cursor) {
        cursor = item.receivedDateTime;
        seenAtCursor = new Set();
      }
      seenAtCursor.add(item.id);
    }

    const update = { [keys.at]: cursor, [keys.ids]: [...seenAtCursor].join(",") };
    await this.store.updateInbox(inbox.id, { channelConfig: update });
    Object.assign(config, update);
    return ingested;
  }

  /** Fetch, filter, dedup, and ingest one Outlook message. Returns true if ingested. */
  private async ingestOne(
    inbox: Inbox,
    config: Record<string, string>,
    token: string,
    base: string,
    folder: Folder,
    id: string,
  ): Promise<boolean> {
    const msg = await graph.getMessage(token, base, id);
    if (msg.isDraft) return false;
    // Nest's own sends land in Sent Items too; that copy is the message Nest
    // already stored.
    if (isNestOrigin(msg)) return false;

    const messageId = msg.internetMessageId || undefined;
    if (messageId && (await this.store.findConversationByMessageChannelIds([messageId]))) return false;

    const { html, text } = bodyOf(msg);
    const selfAddress = (config[OUTLOOK_CONFIG.email] || inbox.handle).toLowerCase();

    if (folder === "sentitems") {
      const res = await this.ingest.ingestOutboundEmail({
        subject: msg.subject ?? undefined,
        text,
        html,
        messageId,
        references: threadRefs(msg),
        threadId: msg.conversationId,
        authorName: addressOf(msg.from).name || "Outlook",
        recipients: recipientList(msg.toRecipients, msg.ccRecipients),
        attachments: await this.attachments(token, base, msg),
      });
      return !!res;
    }

    const { email: from, name: fromName } = addressOf(msg.from);
    if (!from || from === selfAddress) return false;

    const attachments = await this.attachments(token, base, msg);
    await this.ingest.ingestEmail({
      toAddress: selfAddress,
      from,
      fromName,
      subject: msg.subject ?? undefined,
      text,
      html,
      messageId,
      references: threadRefs(msg),
      // Outlook's conversation id plays the part Gmail's thread id does.
      threadId: msg.conversationId,
      attachments,
    });
    return true;
  }

  private async attachments(token: string, base: string, msg: GraphMessage): Promise<AttachmentInput[] | undefined> {
    if (!msg.hasAttachments) return undefined;
    const out: AttachmentInput[] = [];
    for (const att of await graph.listAttachments(token, base, msg.id)) {
      // Item and reference attachments (an attached email, a OneDrive link) have
      // no bytes to store; only file attachments carry contentBytes.
      if (!att.contentBytes) continue;
      try {
        out.push(
          await this.media.store(Buffer.from(att.contentBytes, "base64"), {
            filename: att.name || "attachment",
            mime: att.contentType || "application/octet-stream",
          }),
        );
      } catch (err) {
        this.logger.warn(`Outlook attachment ${att.name} failed: ${message(err)}`);
      }
    }
    return out.length ? out : undefined;
  }
}

function bodyOf(msg: GraphMessage): { html?: string; text: string } {
  const content = msg.body?.content ?? "";
  if (msg.body?.contentType === "text") return { text: content.trim() };
  return { html: content || undefined, text: htmlToText(content) };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
