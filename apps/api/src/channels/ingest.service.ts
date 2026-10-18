import { Injectable, Logger } from "@nestjs/common";
import {
  GROUP_MAX_MEMBERS,
  type Contact,
  type Conversation,
  type Inbox,
  type Message,
  type MessageType,
} from "@ding/schemas";
import { Store, type AttachmentInput } from "../data/store";
import { RealtimeGateway } from "../realtime/realtime.gateway";
import { TenantContext } from "../tenancy/tenant-context";
import { PushService } from "../push/push.service";
import { RoutingService, type RoutingDecision } from "./routing.service";
import { fileArrival } from "./arrival-tags";
import { correspondent, type EmailParty } from "./email/reply-to";
import { ConversationLog, customer, SYSTEM } from "../conversations/conversation-log";
import { sanitizeEmailHtml } from "./email/html-sanitize";
import { ConversationSubjectService } from "../ai/conversation-subject.service";

export interface WhatsAppInbound {
  phoneNumberId: string;
  from: string; // E.164
  name?: string;
  text: string;
  channelMsgId?: string;
  messageType?: MessageType;
  attachments?: AttachmentInput[];
  /** Id of the message this one replies to (already resolved to our id). */
  quotedMsgId?: string;
  /** WhatsApp flagged this as forwarded to us rather than written by the sender. */
  forwarded?: boolean;
}

/** "+44 20 8800 9090" → "442088009090". */
function digitsOnly(s: string): string {
  return s.replace(/\D/g, "");
}

export interface EmailInbound {
  toAddress: string;
  from: string;
  fromName?: string;
  /** The Reply-To header's (first) address, if the mail had one. When it names
   *  someone else, they are the customer and the reply goes to them — see
   *  `correspondent` in email/reply-to.ts. */
  replyTo?: EmailParty;
  subject?: string;
  text: string;
  /** Raw HTML body, if the email had one — sanitized here before storage. */
  html?: string;
  messageId?: string;
  references?: string[]; // In-Reply-To + References header ids, for threading
  /** Gmail server-side thread id (Gmail ingest only). Persisted on the
   *  conversation so an outbound reply can be sent back into the same thread. */
  threadId?: string;
  messageType?: MessageType;
  attachments?: AttachmentInput[];
}

/**
 * Channel-agnostic inbound pipeline: resolve the inbox, unify the contact,
 * find or open a conversation (routing new ones), append the message, and emit
 * realtime events. A new channel just needs to call this with a normalized
 * payload — the routing, persistence, and realtime are shared.
 */
/**
 * Who is told when a customer writes, and under which of their switches.
 *
 * Two audiences, and they are not alternatives:
 *
 *   `assignee` is the person the thread belongs to, under "My conversations" —
 *   on by default, because a message on your own thread is the one everybody
 *   wants.
 *
 *   `team` is everybody else, under "Everything in my team's inboxes" — off by
 *   default, because a shared inbox that tells everyone about everything is how
 *   an app teaches people to switch it off.
 *
 * They used to be an if/else, and that was the bug: an assigned conversation
 * told the assignee and returned, so somebody who had deliberately turned team
 * inbound ON still heard nothing about most of the workspace — assigned is the
 * normal state of an active thread. The setting says "any new inbound in an
 * inbox my team owns"; an assigned one is still in the team's inbox.
 *
 * A conversation in a team's queue belongs to that team. One with no team at
 * all — an inbox nobody has attached a team to — belongs to the whole
 * workspace rather than, as it once did, to nobody.
 */
export function inboundAudience(
  members: { user: { id: string }; teamIds: string[] }[],
  conv: { assigneeUserId: string | null; assignedTeamId: string | null },
): { assignee: string | null; team: string[] } {
  const inTeam = conv.assignedTeamId
    ? members.filter((m) => m.teamIds.includes(conv.assignedTeamId!))
    : members;
  return {
    assignee: conv.assigneeUserId,
    // The assignee has already been told, as the person it is actually for.
    // Telling them twice would be two banners and two chimes for one message.
    team: inTeam.map((m) => m.user.id).filter((id) => id !== conv.assigneeUserId),
  };
}

@Injectable()
export class IngestService {
  private readonly logger = new Logger(IngestService.name);

  constructor(
    private readonly store: Store,
    private readonly routing: RoutingService,
    private readonly realtime: RealtimeGateway,
    private readonly tenant: TenantContext,
    private readonly push: PushService,
    private readonly subjects: ConversationSubjectService,
  ) {}

  /** The conversation log (docs/conversation-log.md). */
  private get log(): ConversationLog {
    return new ConversationLog(this.store);
  }

  /** A new conversation: how it started, and where routing sent it and why. */
  private async logArrival(
    conversationId: string,
    contactName: string,
    channel: string,
    decision: RoutingDecision,
    option?: string,
  ): Promise<void> {
    await this.log.record(conversationId, "created", customer(contactName), { channel });
    await this.log.record(conversationId, "routed", SYSTEM, {
      teamId: decision.assignedTeamId,
      userId: decision.assigneeUserId,
      reason: decision.reason,
      ...(decision.organisation ? { organisation: decision.organisation } : {}),
      ...(option ? { option } : {}),
    });
  }

  /** A customer's message, with what it did to the conversation logged: a
   *  reply to a snoozed or closed chat reopens it. */
  private appendInbound(conversationId: string, input: Parameters<Store["appendInboundMessage"]>[1]) {
    return this.log.track(conversationId, customer(input.authorName || "The customer"), () =>
      this.store.appendInboundMessage(conversationId, input),
    );
  }

  /**
   * Tell whoever owns this conversation that a customer has written.
   *
   * Who "owns" it is the whole question. An assigned conversation notifies its
   * assignee — that's the notification people actually want. An unassigned one
   * sitting in a team queue notifies that team, but under a separate preference
   * that is off by default: a shared inbox that pushes every arrival to everyone
   * is how an app earns itself a permanently disabled notification setting.
   *
   * Fire-and-forget by construction — PushService never blocks ingest, and its
   * own rules (open thread, quiet hours, rate limit) decide what actually goes.
   */
  private async pushInbound(conversationId: string, authorName: string, preview: string, created = false): Promise<void> {
    const conv = await this.store.getConversation(conversationId);
    if (!conv) return;
    const body = preview.trim().slice(0, 140) || "Sent an attachment";
    // In a group, who spoke matters as much as which group — a banner saying
    // only the sender's name gives no way to tell which chat it came from.
    const title =
      conv.channel === "whatsapp_group" ? `${authorName} · ${conv.contact.displayName}` : authorName;

    const { assignee, team } = inboundAudience(await this.store.listMembers(), conv);
    if (assignee) {
      this.push.notify({ userIds: [assignee], kind: "message", title, body, conversationId });
    }
    if (!team.length) return;
    if (created && !assignee) {
      // A brand-new chat waiting in the queue: the team hears about it under
      // "new chats for my team" (on by default), not the noisy every-message
      // setting. Follow-ups in it stay under that one.
      const teamName = conv.assignedTeamId ? (await this.store.getTeam(conv.assignedTeamId))?.name : undefined;
      this.push.notify({
        userIds: team,
        kind: "team_chat",
        title: teamName ? `New chat for ${teamName}` : "New chat",
        body: `${title}: ${body}`,
        conversationId,
      });
      return;
    }
    this.push.notify({ userIds: team, kind: "team_message", title, body, conversationId });
  }

  /**
   * A customer reacted to one of our messages — "Marta reacted ❤️ to: “Your
   * order is on its way”", the way WhatsApp tells you. Whatever the channel
   * (WhatsApp, website chat, an email reaction from Gmail), it goes to the
   * same people a message from them would: the assignee, or else the team
   * under its every-message setting. Taking a reaction off says nothing, and
   * neither does a reaction to their own message.
   */
  async customerReacted(conversationId: string, messageId: string, emoji: string): Promise<void> {
    if (!emoji.trim()) return;
    const conv = await this.store.getConversation(conversationId);
    const target = conv?.messages.find((m) => m.id === messageId);
    if (!conv || !target || target.direction !== "out" || target.internal) return;
    const words = (target.body ?? "").replace(/\s+/g, " ").trim();
    const what = words ? (words.length > 100 ? `${words.slice(0, 99)}…` : words) : target.attachments?.length ? "an attachment" : "your message";
    const title = conv.contact.displayName || "Customer";
    const body = `Reacted ${emoji.trim()} to: “${what}”`;
    const { assignee, team } = inboundAudience(await this.store.listMembers(), conv);
    if (assignee) this.push.notify({ userIds: [assignee], kind: "message", title, body, conversationId });
    if (team.length) this.push.notify({ userIds: team, kind: "team_message", title, body, conversationId });
  }

  /**
   * An email that is a reaction (Gmail's format), not a message: put the emoji
   * on the email it answers rather than filing a new message that just says
   * "reacted via Gmail". `by` is the customer, or one of us when it was sent
   * straight from our own Gmail. False when the email it answers isn't ours to
   * find — then it's filed as an ordinary email, so nothing is lost.
   */
  async ingestEmailReaction(input: { inReplyTo?: string; emoji: string; by: "contact" | "user" }): Promise<boolean> {
    const parent = input.inReplyTo?.trim();
    if (!parent || !input.emoji) return false;
    const ref = await this.store.getMessageRefByChannelId(parent);
    if (!ref) return false;
    const updated = await this.store.reactToMessage(ref.id, input.emoji, input.by);
    if (!updated) return false;
    this.realtime.emitMessageUpdated(updated.conversationId, updated.message);
    if (input.by === "contact") await this.customerReacted(updated.conversationId, updated.message.id, input.emoji);
    return true;
  }

  /* ---- WhatsApp Business app numbers (coexistence) ---- */

  /**
   * A message the business sent from the WhatsApp Business app on its phone
   * (Meta's `smb_message_echoes`). It goes into the customer's open
   * conversation as an outbound message labelled as sent from the app, so the
   * thread here is the whole conversation. It counts as answering: the reply
   * timer stops and the chat is no longer waiting.
   */
  async ingestWhatsAppEcho(input: {
    phoneNumberId: string;
    to: string;
    channelMsgId: string;
    text: string;
    messageType: MessageType;
    attachments?: AttachmentInput[];
  }): Promise<{ conversationId: string; created: boolean } | undefined> {
    const inbox = await this.store.getInboxByWhatsAppPhoneId(input.phoneNumberId);
    if (!inbox) return undefined;
    this.tenant.bind(inbox.orgId);
    // Our own sends can come back this way too; and Meta retries.
    const seen = await this.store.getMessageRefByChannelId(input.channelMsgId);
    if (seen) return { conversationId: seen.conversationId, created: false };
    const contact = await this.store.upsertContactByIdentity({
      orgId: inbox.orgId,
      kind: "wa_id",
      value: input.to,
      displayName: input.to,
    });
    // Started from the phone, so not routed: it shows on the channel (and to
    // the teams it serves) unassigned, and the customer's answer comes back here.
    const { conversation, created } = await this.store.findOrCreateOpenConversation({
      orgId: inbox.orgId,
      inboxId: inbox.id,
      contact,
      channel: "whatsapp",
      autoSubject: true,
    });
    if (created) await this.log.record(conversation.id, "created", SYSTEM, { channel: "whatsapp" });
    const message = await this.store.appendSyncedOutbound(conversation.id, {
      body: input.text,
      channelMsgId: input.channelMsgId,
      authorName: "WhatsApp Business app",
      channel: "whatsapp",
      messageType: input.messageType,
      attachments: input.attachments,
      markRead: true,
    });
    if (!message) return undefined;
    const cleared = await this.store.setSla(conversation.id, null);
    this.realtime.emitMessageCreated(conversation.id, message, inbox.orgId);
    if (cleared) this.realtime.emitConversationUpdated(cleared);
    return { conversationId: conversation.id, created };
  }

  /**
   * One customer's batch of chat history from a WhatsApp Business app number
   * (Meta's `history`). Filed in that customer's history conversation — closed
   * and read, so nobody is notified and no timer starts.
   */
  async importWhatsAppHistory(input: {
    phoneNumberId: string;
    /** The business's own number, digits only: what tells its messages apart. */
    businessNumber: string;
    waId: string;
    messages: Array<{ from: string; id: string; sentAt: Date; text: string; messageType: MessageType; attachments?: AttachmentInput[] }>;
  }): Promise<{ conversationId: string; added: number } | undefined> {
    const inbox = await this.store.getInboxByWhatsAppPhoneId(input.phoneNumberId);
    if (!inbox || !input.messages.length) return undefined;
    this.tenant.bind(inbox.orgId);
    const contact = await this.store.upsertContactByIdentity({
      orgId: inbox.orgId,
      kind: "wa_id",
      value: input.waId,
      displayName: input.waId,
    });
    const ours = digitsOnly(input.businessNumber);
    return this.store.importWhatsAppHistory({
      orgId: inbox.orgId,
      inboxId: inbox.id,
      contactId: contact.id,
      messages: input.messages.map((m) => {
        const out = !!ours && digitsOnly(m.from) === ours;
        return {
          direction: out ? ("out" as const) : ("in" as const),
          authorName: out ? "WhatsApp Business app" : contact.displayName,
          body: m.text,
          channelMsgId: m.id,
          sentAt: m.sentAt,
          messageType: m.messageType,
          attachments: m.attachments,
        };
      }),
    });
  }

  /**
   * The phone's address book (Meta's `smb_app_state_sync`). A customer we only
   * know by number takes the name the phone has for them; a name somebody here
   * has already given them is left alone.
   */
  async syncWhatsAppContacts(input: {
    phoneNumberId: string;
    contacts: Array<{ phone: string; name?: string }>;
  }): Promise<number> {
    const inbox = await this.store.getInboxByWhatsAppPhoneId(input.phoneNumberId);
    if (!inbox) return 0;
    this.tenant.bind(inbox.orgId);
    let n = 0;
    for (const c of input.contacts) {
      const phone = digitsOnly(c.phone);
      if (!phone) continue;
      const name = c.name?.trim();
      const contact = await this.store.upsertContactByIdentity({
        orgId: inbox.orgId,
        kind: "wa_id",
        value: phone,
        displayName: name || phone,
      });
      const bare = digitsOnly(contact.displayName);
      if (name && contact.displayName !== name && (bare === phone || contact.displayName === `+${phone}`)) {
        await this.store.updateContact(contact.id, { displayName: name });
      }
      n++;
    }
    return n;
  }

  async ingestWhatsApp(input: WhatsAppInbound): Promise<{ conversationId: string; created: boolean } | undefined> {
    // The inbox first: it is what says which workspace this message is for, and
    // nothing of any workspace's is read until that is settled.
    const inbox = await this.store.getInboxByWhatsAppPhoneId(input.phoneNumberId);
    if (!inbox) {
      this.logger.warn(`No inbox mapped for WhatsApp phone id ${input.phoneNumberId}`);
      await this.store.recordWebhookDiagnostic({
        channel: "whatsapp",
        kind: "unmapped_inbox",
        reference: input.phoneNumberId,
        detail: `Inbound WhatsApp for an unmapped phone number id (from ${input.from})`,
      });
      return undefined;
    }
    this.tenant.bind(inbox.orgId);

    // Idempotency: Meta retries any webhook it doesn't get a fast 2xx for, so a
    // message we've already stored must not be ingested twice.
    if (input.channelMsgId) {
      const seen = await this.store.getMessageRefByChannelId(input.channelMsgId);
      if (seen) return { conversationId: seen.conversationId, created: false };
    }

    const contact = await this.store.upsertContactByIdentity({
      orgId: inbox.orgId,
      // Record WhatsApp's wa_id (the sender's WhatsApp user id) as `wa_id`, not
      // `phone`, so identity stays anchored to the WhatsApp account if Meta
      // migrates to Business-Scoped IDs. Matching still unifies phone↔wa_id.
      kind: "wa_id",
      value: input.from,
      displayName: input.name || input.from,
    });
    if (contact.blocked) {
      this.logger.log(`Dropped inbound WhatsApp from blocked contact ${input.from}`);
      return undefined;
    }

    // An agent who answered a live-chat (or email) customer on WhatsApp has
    // made that conversation the one this number is talking to them in: the
    // customer's WhatsApp reply goes there, not into a new WhatsApp chat.
    const crossThread =
      inbox.type === "whatsapp"
        ? await this.store.findCrossChannelReplyThread({ orgId: inbox.orgId, inboxId: inbox.id, contactId: contact.id })
        : undefined;
    const joined = crossThread ? await this.store.getConversation(crossThread) : undefined;
    const { conversation, created } = joined
      ? { conversation: joined, created: false }
      : await this.store.findOrCreateOpenConversation({
          orgId: inbox.orgId,
          inboxId: inbox.id,
          contact,
          channel: inbox.type,
          // WhatsApp has no subject of its own; Nest writes one (fields + topic).
          autoSubject: inbox.type === "whatsapp",
        });

    let conv = conversation;
    if (created) {
      const decision = await this.routing.route(inbox, contact);
      const assigned = await this.store.assign(conv.id, decision);
      if (assigned) conv = assigned;
      await this.applyTeamSla(conv);
      this.realtime.emitConversationAssigned(conv, "auto-routing");
      await this.logArrival(conv.id, contact.displayName, inbox.type, decision);
      await fileArrival(this.store, inbox, contact.id, conv.id);
      this.logger.log(
        `New WhatsApp conversation ${conv.id} from ${input.from} → ` +
          `${decision.assigneeUserId ? `agent ${decision.assigneeUserId}` : `team ${decision.assignedTeamId} (queue)`}`,
      );
    }

    const message = await this.appendInbound(conv.id, {
      authorName: contact.displayName,
      body: input.text,
      channelMsgId: input.channelMsgId,
      channel: "whatsapp",
      messageType: input.messageType,
      attachments: input.attachments,
      quotedMsgId: input.quotedMsgId,
      forwarded: input.forwarded,
    });
    if (message) {
      this.realtime.emitMessageCreated(conv.id, message, inbox.orgId);
      void this.pushInbound(conv.id, contact.displayName, input.text, created);
      this.subjects.customerWrote(conv.id, inbox.orgId);
    }

    return { conversationId: conv.id, created };
  }

  /** Inbound message in an existing WhatsApp group — routed by group id, attributed to the sender. */
  async ingestWhatsAppGroup(input: {
    groupId: string;
    from: string;
    name?: string;
    text: string;
    channelMsgId?: string;
    messageType?: MessageType;
    attachments?: AttachmentInput[];
    quotedMsgId?: string;
    forwarded?: boolean;
  }): Promise<{ conversationId: string; created: boolean } | undefined> {
    if (input.channelMsgId) {
      const seen = await this.store.getMessageRefByChannelId(input.channelMsgId);
      if (seen) return { conversationId: seen.conversationId, created: false };
    }
    const conversationId = await this.store.findConversationByChannelRef(input.groupId);
    if (!conversationId) {
      this.logger.warn(`No group conversation for WhatsApp group ${input.groupId}`);
      await this.store.recordWebhookDiagnostic({
        channel: "whatsapp_group",
        kind: "unmapped_group",
        reference: input.groupId,
        detail: `Inbound WhatsApp group message for an unknown group (from ${input.from})`,
      });
      return undefined;
    }
    const conv = await this.store.getConversation(conversationId);
    // Bound by the caller to the workspace whose number received this; the
    // group was looked up within it.
    const orgId = this.tenant.orgId;
    const contact = await this.store.upsertContactByIdentity({
      orgId,
      // Record WhatsApp's wa_id (the sender's WhatsApp user id) as `wa_id`, not
      // `phone`, so identity stays anchored to the WhatsApp account if Meta
      // migrates to Business-Scoped IDs. Matching still unifies phone↔wa_id.
      kind: "wa_id",
      value: input.from,
      displayName: input.name || input.from,
    });
    const isMember = conv?.participants.some((p) => p.contact.id === contact.id) ?? false;
    if (!isMember && (await this.store.countParticipants(conversationId)) < GROUP_MAX_MEMBERS) {
      await this.store.addParticipant(conversationId, contact);
    }

    const message = await this.appendInbound(conversationId, {
      authorName: contact.displayName,
      body: input.text,
      channelMsgId: input.channelMsgId,
      channel: "whatsapp_group",
      messageType: input.messageType,
      attachments: input.attachments,
      quotedMsgId: input.quotedMsgId,
      forwarded: input.forwarded,
    });
    if (message) {
      this.realtime.emitMessageCreated(conversationId, message, orgId);
      void this.pushInbound(conversationId, contact.displayName, input.text);
    }
    return { conversationId, created: false };
  }

  /**
   * A visitor wrote in the NestChat widget on the business's own website.
   *
   * The simplest inbound path we have: the widget already told us which channel
   * it belongs to and who is writing (the visitor session resolved both), so
   * there is no address to map and no provider id to de-duplicate against — the
   * only way to reach here is one HTTP call from one browser.
   *
   * Everything after that is the shared pipeline: find or open the conversation,
   * route a new one, append, notify. A NestChat thread behaves like any other.
   */
  async ingestNestChat(input: {
    inbox: Inbox;
    contact: Contact;
    text: string;
    /** The page the widget is embedded on, recorded in the new thread's subject
     *  so an agent opening it knows where the visitor was standing. */
    pageUrl?: string;
    /**
     * What the visitor said they were here about, already resolved against the
     * channel's live routing menu by `NestChatService.resolveOption`.
     *
     * `teamId` is null for an option whose team has since been taken off the
     * channel: the label is still what they chose and still worth showing, but
     * there is no longer anywhere particular to send it.
     */
    option?: { label: string; teamId: string | null };
    /** Files the customer attached, already redeemed from their tickets. */
    attachments?: AttachmentInput[];
    /** The message they swiped to reply to. Checked against the thread here
     *  rather than trusted — see below. */
    quotedMsgId?: string;
    /** Who is writing — `visitorStamp` of their visitor id. Only a thread they
     *  started is joined; otherwise a new one is opened under the contact. */
    startedBy?: string;
    /**
     * Where the visitor's session says this goes: the conversation it is
     * attached to, already checked as theirs, live and on this channel by
     * `NestChatService.sendTarget`. A customer with two orders open writes in
     * the one they have in front of them, not in whichever moved last.
     */
    conversationId?: string;
    /** No thread for this yet, and joining another would be wrong (a chat
     *  keyed per order, about an order with no thread). */
    forceNew?: boolean;
  }): Promise<{ conversationId: string; created: boolean; message?: Message } | undefined> {
    if (input.contact.blocked) {
      this.logger.log(`Dropped inbound NestChat from blocked contact ${input.contact.id}`);
      return undefined;
    }

    const attached = input.conversationId ? await this.store.getConversation(input.conversationId) : undefined;
    const res = attached
      ? { conversation: attached, created: false }
      : await this.store.findOrCreateOpenConversation({
      orgId: input.inbox.orgId,
      inboxId: input.inbox.id,
      contact: input.contact,
      channel: "nestchat",
      // What they picked, then where they were standing. Both matter and the
      // header has room for about one of them, so the half a visitor chose
      // deliberately goes first and the URL takes the ellipsis.
      subject: [input.option?.label, input.pageUrl].filter(Boolean).join(" · ") || undefined,
      startedBy: input.startedBy,
      // That is only its starting topic: Nest writes the subject from here on
      // (custom fields, then an AI topic once the visitor has said something).
      autoSubject: true,
      forceNew: input.forceNew,
    });
    const conversationId = res.conversation.id;
    if (res.created) {
      const decision = await this.routing.route(input.inbox, input.contact, {
        optionTeamId: input.option?.teamId,
      });
      const assigned = await this.store.assign(conversationId, decision);
      if (assigned) await this.applyTeamSla(assigned);
      this.realtime.emitConversationAssigned(assigned ?? res.conversation, "auto-routing");
      await this.logArrival(conversationId, input.contact.displayName, "nestchat", decision, input.option?.label);
      await fileArrival(this.store, input.inbox, input.contact.id, conversationId);
      this.logger.log(
        `New NestChat conversation ${conversationId} from ${input.contact.displayName}` +
          `${input.option ? ` about "${input.option.label}"` : ""} → ` +
          `${decision.assigneeUserId ? `agent ${decision.assigneeUserId}` : `team ${decision.assignedTeamId} (queue)`}`,
      );
    }

    // A quote is a copy of somebody's words rendered inside the reply, so the
    // id has to be one of ours and one of theirs. An id from another thread is
    // dropped rather than refused: the reply is still worth sending, and
    // failing it would turn a stale widget into a chat that cannot send.
    // Internal notes are excluded for the stronger reason — the visitor has
    // never seen them, and quoting one would be the first time they did.
    const quotedMsgId = await this.resolveNestChatQuote(conversationId, input.quotedMsgId);

    const message = await this.appendInbound(conversationId, {
      authorName: input.contact.displayName,
      body: input.text,
      channel: "nestchat",
      attachments: input.attachments,
      quotedMsgId,
    });
    if (message) {
      this.realtime.emitMessageCreated(conversationId, message, input.inbox.orgId);
      // A photo on its own is a message. The alert has to say something, and
      // "" would arrive on a phone as a notification with no content at all.
      const preview = input.text.trim() || describeAttachments(input.attachments);
      void this.pushInbound(conversationId, input.contact.displayName, preview, res.created);
      this.subjects.customerWrote(conversationId, input.inbox.orgId);
    }

    return { conversationId, created: res.created, message };
  }

  /**
   * A text message, from any SMS provider — already read out of its webhook or
   * poll by the SMS engine (channels/sms). The sender is a phone number, so the
   * customer is the same contact as on WhatsApp; the rest is the shared
   * pipeline, the same as every other channel.
   *
   * `channelMsgId` is the provider's id, made unique to the channel by the
   * caller (`smsMessageKey`): a provider may number its texts 1, 2, 3, and a
   * retried webhook or an overlapping poll must not store one twice.
   */
  async ingestSms(input: {
    inbox: Inbox;
    from: string;
    text: string;
    channelMsgId: string;
  }): Promise<{ conversationId: string; created: boolean; duplicate?: boolean } | undefined> {
    const { inbox } = input;
    const seen = await this.store.getMessageRefByChannelId(input.channelMsgId);
    if (seen) return { conversationId: seen.conversationId, created: false, duplicate: true };

    const contact = await this.store.upsertContactByIdentity({
      orgId: inbox.orgId,
      kind: "phone",
      value: input.from,
      displayName: input.from,
    });
    if (contact.blocked) {
      this.logger.log(`Dropped inbound SMS from blocked contact ${input.from}`);
      return undefined;
    }

    const { conversation, created } = await this.store.findOrCreateOpenConversation({
      orgId: inbox.orgId,
      inboxId: inbox.id,
      contact,
      channel: "sms",
      // A text has no subject of its own; Nest writes one (fields + topic).
      autoSubject: true,
    });
    let conv = conversation;
    if (created) {
      const decision = await this.routing.route(inbox, contact);
      const assigned = await this.store.assign(conv.id, decision);
      if (assigned) conv = assigned;
      await this.applyTeamSla(conv);
      this.realtime.emitConversationAssigned(conv, "auto-routing");
      await this.logArrival(conv.id, contact.displayName, "sms", decision);
      await fileArrival(this.store, inbox, contact.id, conv.id);
      this.logger.log(
        `New SMS conversation ${conv.id} from ${input.from} → ` +
          `${decision.assigneeUserId ? `agent ${decision.assigneeUserId}` : `team ${decision.assignedTeamId} (queue)`}`,
      );
    }

    const message = await this.appendInbound(conv.id, {
      authorName: contact.displayName,
      body: input.text,
      channelMsgId: input.channelMsgId,
      channel: "sms",
    });
    if (message) {
      this.realtime.emitMessageCreated(conv.id, message, inbox.orgId);
      void this.pushInbound(conv.id, contact.displayName, input.text, created);
      this.subjects.customerWrote(conv.id, inbox.orgId);
    }
    return { conversationId: conv.id, created };
  }

  /** The quoted id if it names a message in this thread the visitor may quote,
   *  and nothing otherwise. */
  private async resolveNestChatQuote(
    conversationId: string,
    quotedMsgId: string | undefined,
  ): Promise<string | undefined> {
    if (!quotedMsgId) return undefined;
    const conv = await this.store.getConversation(conversationId);
    const target = conv?.messages.find((m) => m.id === quotedMsgId);
    if (!target || target.internal || target.authorType === "system") return undefined;
    return quotedMsgId;
  }

  async ingestEmail(input: EmailInbound): Promise<{ conversationId: string; created: boolean } | undefined> {
    // The inbox first: the address it was sent to is what says which workspace
    // it is for, and nothing of any workspace's is read before that.
    const inbox = await this.store.getInboxByEmailAddress(input.toAddress);
    if (!inbox) {
      this.logger.warn(`No inbox mapped for email address ${input.toAddress}`);
      await this.store.recordWebhookDiagnostic({
        channel: "email",
        kind: "unmapped_inbox",
        reference: input.toAddress,
        detail: `Inbound email to an unmanaged address (from ${input.from})`,
      });
      return undefined;
    }
    this.tenant.bind(inbox.orgId);

    // Idempotency: a Postmark/webhook retry of an email we've already stored
    // (matched on its own Message-ID) must not append a duplicate.
    if (input.messageId) {
      const seen = await this.store.getMessageRefByChannelId(input.messageId);
      if (seen) return { conversationId: seen.conversationId, created: false };
    }

    // The customer is whoever replies should go to: the Reply-To when it
    // names someone else (a website form's visitor), the sender otherwise.
    const who = correspondent({ email: input.from, name: input.fromName }, input.replyTo, [input.toAddress, inbox.handle]);
    const contact = await this.store.upsertContactByIdentity({
      orgId: inbox.orgId,
      kind: "email",
      value: who.email,
      displayName: who.name,
    });
    if (contact.blocked) {
      this.logger.log(`Dropped inbound email from blocked contact ${who.email}`);
      return undefined;
    }

    // Thread onto an existing conversation via References/In-Reply-To first —
    // but only onto THIS contact's thread.
    //
    // Everyone on a CC list shares one References chain, so an unscoped lookup
    // files a CC'd recipient's Reply-All onto the original sender's
    // conversation: two customers, one thread, and an agent replying to the
    // wrong person. Scoping by contact means a new sender opens their own
    // conversation, which is what a shared inbox has to do.
    let conversationId = input.references?.length
      ? await this.store.findConversationByMessageChannelIds(input.references, { contactIds: [contact.id] })
      : undefined;
    let created = false;

    if (!conversationId) {
      const res = await this.store.findOrCreateOpenConversation({
        orgId: inbox.orgId,
        inboxId: inbox.id,
        contact,
        channel: "email",
        subject: input.subject,
      });
      conversationId = res.conversation.id;
      created = res.created;
      if (created) {
        const decision = await this.routing.route(inbox, contact);
        const assigned = await this.store.assign(conversationId, decision);
        if (assigned) await this.applyTeamSla(assigned);
        this.realtime.emitConversationAssigned(assigned ?? res.conversation, "auto-routing");
        await this.logArrival(conversationId, contact.displayName, "email", decision);
        await fileArrival(this.store, inbox, contact.id, conversationId);
        this.logger.log(
          `New email conversation ${conversationId} from ${who.email}${who.via ? ` (via ${who.via})` : ""} → ` +
            `${decision.assigneeUserId ? `agent ${decision.assigneeUserId}` : `team ${decision.assignedTeamId} (queue)`}`,
        );
      }
    }

    // Remember the latest inbound Gmail thread id on the conversation so an
    // outbound reply is sent back into that same server-side thread (Gmail only;
    // Postmark inbound carries no thread id and threads via headers alone).
    //
    // One thread id, one conversation. Gmail groups a CC'd person's Reply-All
    // into the *same* mailbox thread, so without this a second customer's
    // conversation would claim a thread the first one already owns — which puts
    // our replies to one of them into the other's thread, and makes the
    // channelRef lookup ambiguous. A conversation with no claim of its own
    // simply starts a fresh Gmail thread when we reply, which is correct.
    if (input.threadId) {
      const owner = await this.store.findConversationByChannelRef(input.threadId);
      if (!owner || owner === conversationId) {
        await this.store.setConversationChannelRef(conversationId, input.threadId);
      }
    }

    // Sanitize the email's HTML once, at the boundary — the stored bodyHtml is
    // always safe for the sandboxed iframe to render (remote images pre-blocked).
    const { html: bodyHtml } = sanitizeEmailHtml(input.html);

    const message = await this.appendInbound(conversationId, {
      authorName: contact.displayName,
      body: input.text,
      bodyHtml: bodyHtml || undefined,
      channelMsgId: input.messageId,
      channel: "email",
      messageType: input.messageType,
      attachments: input.attachments,
      ...(who.via ? { emailVia: who.via } : {}),
    });
    if (message) {
      this.realtime.emitMessageCreated(conversationId, message, inbox.orgId);
      void this.pushInbound(conversationId, contact.displayName, input.text, created);
    }

    return { conversationId, created };
  }

  /**
   * Record a reply the agent sent straight from Gmail (not through Nest) onto its
   * conversation, so the thread stays complete. Resolves the thread by
   * References/In-Reply-To, then by the Gmail thread id; a reply to a thread Nest
   * has never seen is skipped.
   *
   * `recipients` is what makes that resolution safe. A Gmail thread started by
   * one customer can hold replies addressed to a different one — a CC'd person
   * the agent then answered — and both share the References chain and the thread
   * id. Without knowing who the mail was actually *to*, either lookup files the
   * agent's reply to Bob onto Alice's conversation. So the thread this belongs
   * to is the one whose customer is among the recipients; if none of them is a
   * customer we know, we record nothing rather than guess.
   */
  async ingestOutboundEmail(input: {
    subject?: string;
    text: string;
    html?: string;
    messageId?: string;
    references?: string[];
    threadId?: string;
    authorName?: string;
    /** Every address the agent sent to — To and Cc. */
    recipients?: string[];
    attachments?: AttachmentInput[];
  }): Promise<{ conversationId: string } | undefined> {
    // Already stored (Nest sent it, or a previous sync grabbed it) → nothing to do.
    if (input.messageId) {
      const seen = await this.store.getMessageRefByChannelId(input.messageId);
      if (seen) return { conversationId: seen.conversationId };
    }

    const contactIds = await this.recipientContactIds(input.recipients);
    // A message whose recipients we can't place is one we can't file safely.
    // Before scoping existed this fell through to an unscoped lookup, which is
    // precisely how a reply landed on the wrong customer's thread.
    if (input.recipients?.length && !contactIds.length) return undefined;
    const scope = contactIds.length ? { contactIds } : undefined;

    let conversationId = input.references?.length
      ? await this.store.findConversationByMessageChannelIds(input.references, scope)
      : undefined;
    if (!conversationId && input.threadId) {
      conversationId = await this.store.findConversationByChannelRef(input.threadId, scope);
    }
    if (!conversationId) return undefined;

    const { html: bodyHtml } = sanitizeEmailHtml(input.html);
    const message = await this.store.appendSyncedOutbound(conversationId, {
      body: input.text,
      bodyHtml: bodyHtml || undefined,
      channelMsgId: input.messageId,
      authorName: input.authorName,
      attachments: input.attachments,
    });
    if (message) {
      const conv = await this.store.getConversation(conversationId);
      if (conv) {
        this.realtime.emitMessageCreated(conversationId, message, conv.orgId);
        this.realtime.emitConversationUpdated(conv);
      }
    }
    return { conversationId };
  }

  /**
   * Which of these addresses are customers we already know.
   *
   * Lookup only, never create: an agent's outgoing mail is addressed to
   * colleagues, suppliers and mailing lists as well as customers, and turning
   * every one of those into a contact would bury the customer list. An address
   * we don't recognise simply doesn't narrow the search.
   */
  private async recipientContactIds(recipients: string[] | undefined): Promise<string[]> {
    if (!recipients?.length) return [];
    // The sync that called this runs inside the mailbox's own workspace.
    const orgId = this.tenant.orgId;
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const address of recipients) {
      const value = address.trim().toLowerCase();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      const contact = await this.store.findContactByIdentity({ orgId, kind: "email", value });
      if (contact && !ids.includes(contact.id)) ids.push(contact.id);
    }
    return ids;
  }

  /** A new conversation inherits its routed team's first-response SLA target. */
  private async applyTeamSla(conv: Conversation): Promise<void> {
    if (!conv.assignedTeamId || conv.slaDueAt) return;
    const team = await this.store.getTeam(conv.assignedTeamId);
    if (!team?.slaMinutes) return;
    const due = new Date(Date.now() + team.slaMinutes * 60_000).toISOString();
    await this.store.setSla(conv.id, due);
  }
}

/**
 * What a notification says arrived when nobody typed anything.
 *
 * A voice note is not "a file". Somebody who gets "Sent a file" on a lock
 * screen expects a PDF, opens the app for one, and finds a recording — and the
 * whole value of the preview is that it sets that expectation right.
 */
function describeAttachments(attachments: AttachmentInput[] | undefined): string {
  const files = attachments ?? [];
  if (files.length !== 1) return `Sent ${files.length} files`;
  switch (files[0]!.kind) {
    case "voice":
      return "Sent a voice message";
    case "image":
      return "Sent a photo";
    case "video":
      return "Sent a video";
    default:
      return "Sent a file";
  }
}
