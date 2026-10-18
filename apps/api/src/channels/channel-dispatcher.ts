import { Inject, Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { sendingInbox, type ConversationWithMessages, type Message } from "@ding/schemas";
import { Store, type EmailRecipientInput } from "../data/store";
import { MediaService } from "../storage/media.service";
import { redactSecrets } from "../crypto/redact";
import { env } from "../config/env";
import {
  CHANNEL_PROVIDERS,
  ChannelProvider,
  isRetryableStatus,
  type OutboundMedia,
  type OutboundTemplate,
  type SendContext,
  type SendParams,
  type SendResult,
} from "./channel-provider";
import { forwardSubject } from "./email/email.provider";
import { SandboxPolicy } from "../tenancy/sandbox";

/**
 * The result of a single provider send attempt, in the domain's terms. The
 * delivery layer (queue/worker) turns this into status writes + retries; the
 * dispatcher itself performs no persistence and schedules no timers.
 */
/**
 * `inboxId` is which inbox the send was actually made from — reported rather
 * than written here, because this class is deliberately side-effect free with
 * respect to message state (see below). The caller persists it, so a message
 * carries the number or address the customer saw it arrive from, including when
 * the send failed: "which number did this try to go from" is exactly the
 * question a failure raises.
 */
export type DeliveryOutcome =
  | { ok: true; inboxId: string; channelMsgId?: string; simulated: boolean }
  | { ok: false; inboxId?: string; retryable: boolean; reason: string; error?: string; code?: string };

/**
 * Sends an outbound message through the right channel provider and reports the
 * outcome. Channel-agnostic: it picks the recipient address and threading
 * context by channel, then calls the provider. It is deliberately side-effect
 * free with respect to message state so it can be driven by a durable job queue.
 */
@Injectable()
export class ChannelDispatcher {
  private readonly logger = new Logger(ChannelDispatcher.name);

  constructor(
    @Inject(CHANNEL_PROVIDERS) private readonly providers: ChannelProvider[],
    private readonly store: Store,
    private readonly media: MediaService,
    private readonly sandbox: SandboxPolicy,
  ) {}

  /** Attempt one send. Returns a structured outcome; never throws for a normal
   *  provider rejection (only genuinely unexpected errors propagate). */
  async attemptSend(
    conversation: ConversationWithMessages,
    message: Message,
    template?: OutboundTemplate,
    opts?: { cc?: string[]; bcc?: string[]; signatureHtml?: string; forwardTo?: string[] },
  ): Promise<DeliveryOutcome> {
    // A demo workspace's replies go nowhere: no provider is so much as looked
    // up. The thread shows them sent (and, via the simulated ladder, delivered
    // and read), which is what a demo is for; no customer is real, and none is
    // ever contacted.
    if (await this.sandbox.isSandbox(conversation.orgId)) {
      return { ok: true, inboxId: conversation.inboxId, channelMsgId: `sandbox_${randomUUID()}`, simulated: true };
    }

    // A message may be sent on a different channel than the conversation's own
    // (cross-channel reply within one open thread). Resolve the effective channel
    // and the inbox to send from. The conversation's inbox tracks the customer's
    // most-recent channel, which can differ from the origin `channel`, so compare
    // the target channel against the inbox's *type* (whatsapp_group ≡ whatsapp):
    // send from that inbox when it serves the channel, else the channel's primary
    // inbox. For a conversation that never went cross-channel this is unchanged.
    const channel = message.channel ?? conversation.channel;
    // The same function the composer labels itself with, so what an agent was
    // told they were sending from is what actually sends. Two copies of this
    // rule would drift, and the drift would be invisible until a customer
    // replied to the wrong number.
    const sendingInboxId =
      sendingInbox(await this.store.listInboxes(), conversation, { channel })?.id ?? conversation.inboxId;

    // Email is served by more than one provider (Gmail vs generic), chosen by
    // the sending inbox's connected provider. Other channels ignore the context.
    const ctx =
      channel === "email"
        ? { provider: (await this.store.getInboxConfig(sendingInboxId))?.provider }
        : undefined;
    const provider = this.providers.find((p) => p.supports(channel, ctx));
    if (!provider) {
      // Channel not wired for sending — a configuration error, not worth retrying.
      return { ok: false, inboxId: sendingInboxId, retryable: false, reason: `No provider configured for ${channel}` };
    }

    // A forward (email only) re-addresses this send to other people instead of
    // the customer: the first address is the To, any others ride as Cc, and it
    // goes out as a fresh "Fwd:" thread (built below) rather than a reply.
    const forwardTo = channel === "email" ? opts?.forwardTo?.filter((a) => a.trim()) : undefined;
    const isForward = Boolean(forwardTo?.length);

    // A group message is addressed to the group id (kept on channelRef), not a
    // person's number; a 1:1 message goes to the customer's phone / email.
    //
    // NestChat is addressed to the browser the visitor chatted from — its own
    // identity, not a phone number. Naming it here rather than falling through
    // to `contact.phone` is what makes the "no address" guard below mean
    // something for this channel too.
    const to =
      channel === "email"
        ? isForward
          ? forwardTo![0]
          : conversation.contact.email
        : channel === "whatsapp_group"
          ? conversation.channelRef
          : channel === "nestchat"
            ? conversation.contact.visitorId
            : conversation.contact.phone;
    if (!to) {
      return { ok: false, inboxId: sendingInboxId, retryable: false, reason: `Conversation has no ${channel} address` };
    }
    // Extra forward recipients (beyond the To) join any explicit Cc.
    const cc = isForward ? [...forwardTo!.slice(1), ...(opts?.cc ?? [])] : opts?.cc;

    let context: SendContext | undefined;
    if (isForward) {
      // A forward opens a NEW thread to a new recipient — no In-Reply-To /
      // References / Gmail threadId, so it never lands in the customer's thread.
      context = { subject: forwardSubject(conversation.subject), toName: undefined };
    } else if (channel === "email") {
      // See the threadId note below: only an email-primary conversation being
      // answered from its own inbox has a Gmail thread id we can safely reuse.
      const threadIdForSend =
        conversation.channel === "email" && sendingInboxId === conversation.inboxId
          ? conversation.channelRef ?? undefined
          : undefined;
      // Prior EMAIL messages in this thread that carry a Message-ID, oldest→newest
      // (a WhatsApp wamid is not an email Message-ID, so other channels are out).
      const priorEmail = conversation.messages.filter(
        (m) => m.channelMsgId && m.id !== message.id && (m.channel ?? conversation.channel) === "email",
      );
      // The parent is the most-recent one; References chains the whole thread and
      // ends with that parent — this is what the customer's client threads on.
      const chain = priorEmail
        .map((m) => m.channelMsgId)
        .filter((id): id is string => Boolean(id));
      const parentId = chain.length ? chain[chain.length - 1] : undefined;
      context = {
        subject: conversation.subject ?? undefined,
        toName: conversation.contact.displayName,
        inReplyTo: parentId,
        references: chain.length ? chain.join(" ") : undefined,
        // For a Gmail-connected inbox the thread's Gmail id is kept on channelRef;
        // passing it keeps the reply in the same server-side thread. Undefined for
        // Postmark threads, which rely solely on the In-Reply-To/References headers.
        //
        // Only pass it when it is actually THIS mailbox's Gmail thread id:
        //  - channelRef is overloaded — a Gmail thread id on an email thread, but
        //    a WhatsApp group id on a group, and on a WhatsApp thread that later
        //    received an email it holds that email's thread id;
        //  - Gmail thread ids are per-mailbox, and a cross-channel send resolves
        //    its own email inbox (firstInboxOfType), which needn't be the mailbox
        //    that owns the id.
        // Passing an id the sending mailbox can't see makes Gmail reject the send
        // with 404 ("Email: rejected (404)" in the thread). Omitting it costs
        // nothing: In-Reply-To/References above still thread it for the recipient,
        // it just starts a new server-side thread in our own mailbox.
        threadId: threadIdForSend,
      };
    }

    const media = template ? undefined : await this.resolveMedia(message);
    // If this reply quotes an earlier message, pass its provider id so the
    // channel threads it as a reply.
    const replyToChannelMsgId = message.quotedMsgId
      ? conversation.messages.find((m) => m.id === message.quotedMsgId)?.channelMsgId ?? undefined
      : undefined;
    const base = {
      body: message.body,
      bodyHtml: message.bodyHtml ?? undefined,
      signatureHtml: opts?.signatureHtml,
      conversation,
      inboxId: sendingInboxId,
      context,
      media,
      template,
      replyToChannelMsgId,
      messageId: message.id,
      authorName: message.authorName,
    };
    // Email fans out into one tracked copy per recipient (read receipts); other
    // channels send a single message. A template send skips tracking (WhatsApp).
    const result =
      channel === "email" && !template
        ? await this.sendEmailPerRecipient(provider, message.id, base, to, cc ?? [], opts?.bcc ?? [])
        : await provider.sendText({ ...base, to, cc, bcc: opts?.bcc });

    if (result.ok) {
      return { ok: true, inboxId: sendingInboxId, channelMsgId: result.channelMsgId, simulated: Boolean(result.simulated) };
    }
    const retryable = result.retryable ?? isRetryableStatus(result.httpStatus);
    this.logger.warn(
      `Send failed on ${channel} (${retryable ? "transient" : "permanent"}): ${redactSecrets(result.error)}`,
    );
    return {
      ok: false,
      inboxId: sendingInboxId,
      retryable,
      reason: shortReason(channel, result),
      error: result.error,
      code: result.errorCode,
    };
  }

  /**
   * Send an email as one copy PER recipient (Front-style read receipts): each
   * To/Cc address gets its own message carrying a unique tracking pixel, so an
   * open is attributable to a person, not just "someone". The primary (`to`)
   * copy carries the full threading context and IS the delivery outcome (its
   * Message-ID becomes the stored message's); Cc/Bcc copies are best-effort and
   * drop the Gmail threadId so they don't fold into the customer's server thread.
   * Bcc addresses get individual, untracked copies (hidden, as Bcc should be).
   */
  private async sendEmailPerRecipient(
    provider: ChannelProvider,
    messageId: string,
    base: Omit<SendParams, "to" | "cc" | "bcc" | "trackingPixelUrl">,
    to: string,
    cc: string[],
    bcc: string[],
  ): Promise<SendResult> {
    const norm = (a: string) => a.trim().toLowerCase();
    const seen = new Set<string>();
    const copies: Array<{ address: string; kind: "to" | "cc" | "bcc"; track: boolean }> = [];
    const add = (address: string, kind: "to" | "cc" | "bcc", track: boolean) => {
      const a = norm(address);
      // De-dup case-insensitively; the primary `to` claims an address over a Cc/Bcc.
      if (!a || seen.has(a)) return;
      seen.add(a);
      copies.push({ address: address.trim(), kind, track });
    };
    add(to, "to", true);
    for (const a of cc) add(a, "cc", true);
    for (const a of bcc) add(a, "bcc", false);

    // Register the tracked (To/Cc) recipients up-front, each with a unique pixel
    // token, so an open racing back mid-send still resolves to a person.
    const tokenByAddress = new Map<string, string>();
    const tracked: EmailRecipientInput[] = [];
    for (const c of copies) {
      if (!c.track) continue;
      const token = randomUUID().replace(/-/g, "");
      tokenByAddress.set(norm(c.address), token);
      tracked.push({ address: norm(c.address), kind: c.kind as "to" | "cc", token });
    }
    if (tracked.length) await this.store.registerEmailRecipients(messageId, tracked);

    const trackBase = env.appUrl.replace(/\/+$/, "");
    let primary: SendResult = { ok: false, retryable: false, error: "No recipient to send to" };
    for (const c of copies) {
      const token = tokenByAddress.get(norm(c.address));
      // Only the primary keeps the Gmail threadId; Cc/Bcc still thread on the
      // client via In-Reply-To/References but never join the customer's thread.
      const context =
        c.kind === "to"
          ? base.context
          : base.context
            ? { ...base.context, threadId: undefined }
            : undefined;
      const res = await provider.sendText({
        ...base,
        to: c.address,
        context,
        trackingPixelUrl: token ? `${trackBase}/api/track/open/${token}.gif` : undefined,
      });
      if (c.kind === "to") primary = res;
      else if (!res.ok) {
        this.logger.warn(`Email ${c.kind} copy to ${c.address} failed: ${redactSecrets(res.error)}`);
      }
    }
    return primary;
  }

  /** Send a read receipt for an inbound message on a channel that supports it. */
  async markRead(conversation: ConversationWithMessages, channelMsgId?: string): Promise<void> {
    if (await this.sandbox.isSandbox(conversation.orgId)) return;
    const provider = this.providers.find((p) => p.supports(conversation.channel) && p.markRead);
    if (!provider?.markRead) return;
    try {
      await provider.markRead({ conversation, channelMsgId });
    } catch (err) {
      this.logger.warn(`markRead failed on ${conversation.channel}: ${String(err)}`);
    }
  }

  /** Show the customer a typing indicator on a channel that supports it. */
  async sendTyping(conversation: ConversationWithMessages, channelMsgId?: string): Promise<void> {
    if (await this.sandbox.isSandbox(conversation.orgId)) return;
    const provider = this.providers.find((p) => p.supports(conversation.channel) && p.sendTyping);
    if (!provider?.sendTyping) return;
    try {
      await provider.sendTyping({ conversation, channelMsgId });
    } catch (err) {
      this.logger.warn(`sendTyping failed on ${conversation.channel}: ${String(err)}`);
    }
  }

  /** Deliver an emoji reaction to a message on a channel that supports it. */
  async sendReaction(
    conversation: ConversationWithMessages,
    channelMsgId: string,
    emoji: string,
    messageId?: string,
  ): Promise<void> {
    if (await this.sandbox.isSandbox(conversation.orgId)) return;
    const provider = this.providers.find((p) => p.supports(conversation.channel) && p.sendReaction);
    if (!provider?.sendReaction) return;
    try {
      await provider.sendReaction({ conversation, channelMsgId, messageId, emoji });
    } catch (err) {
      this.logger.warn(`sendReaction failed on ${conversation.channel}: ${String(err)}`);
    }
  }

  /**
   * React to a customer's email the way Gmail does: a reply to that exact email
   * (In-Reply-To its Message-ID) carrying the emoji. Gmail shows it as a
   * reaction; other mail apps show a one-line "reacted 👍" note. Taking a
   * reaction off can't be unsent, so that sends nothing.
   */
  async sendEmailReaction(
    conversation: ConversationWithMessages,
    target: Message,
    emoji: string,
    reactorName: string,
  ): Promise<void> {
    if (!emoji.trim() || !target.channelMsgId) return;
    if (await this.sandbox.isSandbox(conversation.orgId)) return;
    const to = conversation.contact.email;
    if (!to) return;
    const sendingInboxId =
      sendingInbox(await this.store.listInboxes(), conversation, { channel: "email" })?.id ?? conversation.inboxId;
    const ctx = { provider: (await this.store.getInboxConfig(sendingInboxId))?.provider };
    const provider = this.providers.find((p) => p.supports("email", ctx) && p.sendReaction);
    if (!provider?.sendReaction) return;
    // References: the thread's email Message-IDs up to and including the one reacted to.
    const upTo = conversation.messages.findIndex((m) => m.id === target.id);
    const chain = conversation.messages
      .slice(0, upTo + 1)
      .filter((m) => m.channelMsgId && (m.channel ?? conversation.channel) === "email")
      .map((m) => m.channelMsgId as string);
    const context: SendContext = {
      subject: conversation.subject ?? undefined,
      toName: conversation.contact.displayName,
      inReplyTo: target.channelMsgId,
      references: chain.join(" ") || target.channelMsgId,
      threadId:
        conversation.channel === "email" && sendingInboxId === conversation.inboxId
          ? conversation.channelRef ?? undefined
          : undefined,
    };
    try {
      await provider.sendReaction({
        conversation,
        channelMsgId: target.channelMsgId,
        messageId: target.id,
        emoji: emoji.trim(),
        to,
        inboxId: sendingInboxId,
        context,
        reactorName,
      });
    } catch (err) {
      this.logger.warn(`Email reaction failed: ${String(err)}`);
    }
  }

  /** Turn a message's attachments into ready-to-send media (bytes loaded from storage). */
  private async resolveMedia(message: Message): Promise<OutboundMedia[] | undefined> {
    if (!message.attachments?.length) return undefined;
    const out: OutboundMedia[] = [];
    for (const att of message.attachments) {
      const loaded = await this.media.load(att.id);
      if (!loaded) {
        this.logger.warn(`Outbound attachment ${att.id} could not be loaded — skipping`);
        continue;
      }
      out.push({
        id: att.id,
        kind: att.kind,
        mime: att.mime,
        filename: att.filename,
        bytes: loaded.bytes,
        durationMs: att.durationMs,
      });
    }
    return out.length ? out : undefined;
  }
}

/** A short, user-facing failure reason derived from a provider send result. */
function shortReason(channel: string, result: { httpStatus?: number; errorCode?: string; error?: string }): string {
  const label = channel === "email" ? "Email" : channel === "nestchat" ? "NestChat" : channel === "sms" ? "SMS" : "WhatsApp";
  if (result.errorCode === "not_connected") return `${label} isn’t connected`;
  // SMS providers are configured, not known: their own words ("Number barred",
  // "Insufficient credit") say more than a status code would.
  if (channel === "sms" && result.error) return `SMS: ${(redactSecrets(result.error) ?? "").slice(0, 160)}`;
  if (result.errorCode === "reauth_required") return `${label}: the channel needs reconnecting — Google signed it out`;
  // Graph error 100 on a send means the phone-number-id and access token don't
  // match (wrong/expired token, or a token for a different number).
  if (result.errorCode === "100") return `${label}: this number’s credentials don’t match — re-check its Phone number ID and access token`;
  if (result.httpStatus === 401 || result.httpStatus === 403) return `${label}: authentication rejected`;
  if (result.httpStatus === 429) return `${label}: rate limited`;
  if (result.httpStatus && result.httpStatus >= 500) return `${label}: provider error (${result.httpStatus})`;
  if (result.httpStatus && result.httpStatus >= 400) return `${label}: rejected (${result.httpStatus})`;
  return `${label}: delivery failed`;
}
