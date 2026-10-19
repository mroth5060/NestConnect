import type { Prisma } from "@prisma/client";
import type {
  Attachment,
  ChannelType,
  Contact,
  CustomField,
  CustomFieldEntity,
  CustomFieldType,
  Conversation,
  Inbox,
  Message,
  MessageStatus,
  MessageType,
  Notification,
  Participant,
  ParticipantRole,
  Priority,
  RoutingStrategy,
  Team,
  Template,
  TemplateApproval,
  TemplateCategory,
  User,
  WaWindow,
} from "@ding/schemas";
import { availabilityScheduleSchema, inboxStatus, publicChannelConfig, type AvailabilitySchedule } from "@ding/schemas";
import type { StoredCustomerDevice, StoredDevice, StoredSession } from "./store";

/** A Prisma Session row → the store's StoredSession (dates as ISO strings). */
export function mapSession(s: Prisma.SessionGetPayload<object>): StoredSession {
  return {
    id: s.id,
    userId: s.userId,
    ip: s.ip ?? null,
    userAgent: s.userAgent ?? null,
    createdAt: s.createdAt.toISOString(),
    lastSeenAt: s.lastSeenAt.toISOString(),
    revokedAt: s.revokedAt ? s.revokedAt.toISOString() : null,
  };
}

export function mapDevice(d: Prisma.DeviceGetPayload<object>): StoredDevice {
  return {
    id: d.id,
    userId: d.userId,
    sessionId: d.sessionId ?? null,
    pushToken: d.pushToken,
    platform: d.platform,
    appVersion: d.appVersion ?? null,
    osVersion: d.osVersion ?? null,
    deviceName: d.deviceName ?? null,
    createdAt: d.createdAt.toISOString(),
    lastSeenAt: d.lastSeenAt.toISOString(),
    disabledAt: d.disabledAt ? d.disabledAt.toISOString() : null,
    disabledReason: d.disabledReason ?? null,
  };
}

export function mapCustomerDevice(d: Prisma.CustomerDeviceGetPayload<object>): StoredCustomerDevice {
  return {
    id: d.id,
    orgId: d.orgId,
    contactId: d.contactId,
    inboxId: d.inboxId,
    token: d.token,
    platform: d.platform,
    createdAt: d.createdAt.toISOString(),
    lastSeenAt: d.lastSeenAt.toISOString(),
    disabledAt: d.disabledAt ? d.disabledAt.toISOString() : null,
    disabledReason: d.disabledReason ?? null,
  };
}

/** WhatsApp's customer-service window is 24 hours from the last inbound message. */
const WA_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Whether a channel is one of the WhatsApp channels (1:1 or group). */
export function isWaChannel(channel: string | null | undefined): boolean {
  return channel === "whatsapp" || channel === "whatsapp_group";
}

/**
 * Compute the WhatsApp 24-hour window for a conversation. Only WhatsApp channels
 * have a window; everything else returns null. With no inbound yet the window is
 * closed (you must open with a template).
 */
export function computeWaWindow(
  channel: string,
  lastInboundAt: Date | string | null | undefined,
): WaWindow | null {
  if (channel !== "whatsapp" && channel !== "whatsapp_group") return null;
  if (!lastInboundAt) return { open: false, expiresAt: null };
  const last = typeof lastInboundAt === "string" ? new Date(lastInboundAt) : lastInboundAt;
  const expiresAt = new Date(last.getTime() + WA_WINDOW_MS);
  return { open: Date.now() < expiresAt.getTime(), expiresAt: expiresAt.toISOString() };
}

/** The delivery ladder order: queued → sending → sent → delivered → read. */
const STATUS_ORDER: MessageStatus[] = ["queued", "sending", "sent", "delivered", "read"];

/**
 * Whether a message may move from `current` to `next`. Status only ever advances
 * up the ladder (so a late/duplicate/out-of-order webhook can't drag a "read"
 * back to "sent"); "failed" is terminal and only reachable before delivery.
 */
export function canAdvanceStatus(current: MessageStatus, next: MessageStatus): boolean {
  if (current === next) return false;
  if (current === "failed") return false;
  if (next === "failed") return STATUS_ORDER.indexOf(current) < STATUS_ORDER.indexOf("delivered");
  return STATUS_ORDER.indexOf(next) > STATUS_ORDER.indexOf(current);
}

/** Count the distinct {{n}} positional variables in a template body. */
export function templateVariableCount(body: string): number {
  const nums = new Set<number>();
  for (const m of body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) nums.add(Number(m[1]));
  return nums.size;
}

/** Lower-cased primary subtag of a language code ("en_US" / "en-GB" → "en"). */
export function canonicalLang(code: string): string {
  return code.trim().toLowerCase().split(/[-_]/)[0];
}

/**
 * Whether a locally-stored template language should be treated as the same
 * language as one coming from Meta. Meta returns locale-qualified codes
 * ("en_US") while templates authored or seeded locally often use the bare
 * primary subtag ("en"), so a sync must reconcile "en" with "en_US" instead of
 * inserting a stale duplicate. Two *different* region-qualified locales
 * (en_US vs en_GB) remain distinct templates and never collapse into each other.
 */
export function sameTemplateLang(a: string, b: string): boolean {
  const la = a.trim().toLowerCase();
  const lb = b.trim().toLowerCase();
  if (la === lb) return true;
  const ca = canonicalLang(la);
  if (ca !== canonicalLang(lb)) return false;
  // Same primary subtag: reconcile only when at least one side is the bare code.
  return la === ca || lb === ca;
}

/** Prisma CustomField row → domain CustomField. The string columns are widened
 *  enums; they are written through Zod-validated inputs, so the cast is the
 *  same trade every other mapper here makes. */
export function mapCustomField(f: Prisma.CustomFieldGetPayload<object>): CustomField {
  return {
    id: f.id,
    key: f.key,
    label: f.label,
    type: f.type as CustomFieldType,
    entity: f.entity as CustomFieldEntity,
    options: f.options ?? [],
    inboxIds: f.inboxIds ?? [],
    position: f.position,
    filterable: f.filterable,
    archived: f.archived,
  };
}

/** Prisma Template row → domain Template (variable count derived from the body). */
export function mapTemplate(t: Prisma.TemplateGetPayload<object>): Template {
  return {
    id: t.id,
    name: t.name,
    category: t.category as TemplateCategory,
    language: t.language,
    body: t.body,
    approvalStatus: t.approvalStatus as TemplateApproval,
    variableCount: templateVariableCount(t.body),
    variableDefaults: t.variableDefaults ?? [],
    // Null in the column means "no account has claimed this yet"; the domain
    // type says that with an absent field rather than a null.
    ...(t.wabaId ? { wabaId: t.wabaId } : {}),
    // The per-account default is an org setting, applied by TemplatesService.
    isDefault: false,
  };
}

/* Prisma row → domain type mappers. Includes are typed via Prisma payload helpers. */

type ContactWithIdentities = Prisma.ContactGetPayload<{ include: { identities: true } }> & {
  /** The organisation the contact is shown under (see CONTACT_INCLUDE). */
  accountLinks?: Array<{ account: { name: string } }>;
};
type InboxWithTeams = Prisma.InboxGetPayload<{ include: { teams: true } }>;
type ConversationSummaryRow = Prisma.ConversationGetPayload<{
  include: {
    contact: { include: { identities: true } };
    labels: { include: { label: true } };
    assignee: { select: { name: true } };
    messages: true;
  };
}>;
// Base row includes attachments; emailRecipients is optional so the many message
// queries that don't need open-tracking (fresh sends, status writes) still map.
type MessageRow = Prisma.MessageGetPayload<{ include: { attachments: true } }> & {
  emailRecipients?: Prisma.EmailRecipientGetPayload<Record<string, never>>[];
};
type AttachmentRow = Prisma.AttachmentGetPayload<object>;

/** Same-origin URL the client uses to stream/download the file. */
export function mediaUrl(attachmentId: string): string {
  return `/api/media/${attachmentId}`;
}

/** The message type implied by an attachment's kind (for outbound media). */
export function messageTypeForKind(kind: string): MessageType {
  switch (kind) {
    case "image":
    case "video":
    case "audio":
    case "voice":
    case "sticker":
      return kind;
    default:
      return "document";
  }
}

/** A list preview for a media message that carries no text caption. */
/**
 * One line of plain text for a conversation list row.
 *
 * A message body is not automatically safe to show as a preview. An email that
 * arrives HTML-only has no text part to fall back to, so the body *is* the
 * markup — and the row then reads `<html xmlns="http://www.w3.org/1999/…`,
 * which tells you nothing about the message and wraps onto several lines,
 * pushing the rest of the list around.
 *
 * Deliberately a light touch rather than a parser: strip script and style
 * wholesale (their contents are never prose), drop the remaining tags, decode
 * the handful of entities that show up in ordinary mail, and collapse the
 * whitespace that formatting leaves behind. The result only ever has to survive
 * one truncated line.
 */
export function previewFromBody(body?: string | null): string {
  if (!body) return "";
  // Tags only need stripping when there are any; entities are decoded either
  // way, because a plain-text part can carry `&amp;` with no tag in sight.
  const stripped = body.includes("<")
    ? body.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]*>/g, " ")
    : body;
  return stripped
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function previewForType(type?: MessageType): string {
  switch (type) {
    case "image": return "📷 Photo";
    case "video": return "🎥 Video";
    case "voice": return "🎤 Voice message";
    case "audio": return "🎵 Audio";
    case "document": return "📄 Document";
    case "sticker": return "Sticker";
    case "location": return "📍 Location";
    case "contact": return "👤 Contact";
    default: return "";
  }
}

export function mapAttachment(a: AttachmentRow): Attachment {
  let waveform: number[] | undefined;
  if (a.waveform) {
    try {
      const parsed = JSON.parse(a.waveform);
      if (Array.isArray(parsed)) waveform = parsed as number[];
    } catch {
      /* ignore malformed waveform */
    }
  }
  return {
    id: a.id,
    kind: a.kind as Attachment["kind"],
    mime: a.mime,
    size: a.size,
    filename: a.filename,
    url: mediaUrl(a.id),
    durationMs: a.durationMs ?? undefined,
    width: a.width ?? undefined,
    height: a.height ?? undefined,
    waveform,
    transcript: a.transcript ?? undefined,
  };
}
type ParticipantRow = Prisma.ParticipantGetPayload<{
  include: { contact: { include: { identities: true } } };
}>;

export function mapUser(u: Prisma.UserGetPayload<object>): User {
  return {
    id: u.id,
    orgId: u.orgId,
    name: u.name,
    email: u.email,
    role: u.role as User["role"],
    avatarColor: u.avatarColor ?? undefined,
    avatarUrl: u.avatarUrl ?? undefined,
    online: u.online,
    available: u.available,
    schedule: readSchedule(u.availabilitySchedule),
    position: u.position ?? null,
    twoFactorEnabled: u.twoFactorEnabled,
    twoFactorMethod: (u.twoFactorMethod as "totp" | "email" | null) ?? null,
  };
}

/** Stored working hours, or null when unset or unreadable (the switch then
 *  decides alone — a bad row must not make somebody permanently away). */
function readSchedule(raw: unknown): AvailabilitySchedule | null {
  if (!raw) return null;
  const parsed = availabilityScheduleSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function mapNotification(n: Prisma.NotificationGetPayload<object>): Notification {
  return {
    id: n.id,
    type: n.type as Notification["type"],
    title: n.title,
    body: n.body,
    conversationId: n.conversationId ?? undefined,
    opsSopId: n.opsSopId ?? undefined,
    chatRoomId: n.chatRoomId ?? undefined,
    read: n.read,
    createdAt: n.createdAt.toISOString(),
  };
}

export function mapTeam(t: Prisma.TeamGetPayload<object>): Team {
  return { id: t.id, orgId: t.orgId, name: t.name, icon: t.icon ?? null, order: t.order, slaMinutes: t.slaMinutes ?? null };
}

/** The in-app SDK's "tag every customer from here", from a NestChat channel's
 *  config — "" when there isn't one or it doesn't parse. */
function legacyAppTag(config: Record<string, string> | null): string {
  try {
    const app = config?.app ? (JSON.parse(config.app) as { contactTag?: unknown }) : undefined;
    return typeof app?.contactTag === "string" ? app.contactTag.trim() : "";
  } catch {
    return "";
  }
}

export function mapInbox(i: InboxWithTeams): Inbox {
  const type = i.type as ChannelType;
  return {
    id: i.id,
    orgId: i.orgId,
    type,
    name: i.name,
    handle: i.handle,
    teamIds: i.teams.map((t) => t.teamId),
    routingStrategy: i.routingStrategy as RoutingStrategy,
    isDefault: i.isDefault,
    order: i.order,
    unread: 0,
    ...inboxStatus(type, i.channelConfig as Record<string, string> | null),
    channelConfigPublic: publicChannelConfig(i.channelConfig as Record<string, string> | null),
    ...(type === "email" ? { signature: { layoutHtml: i.signatureHtml, footerHtml: i.signatureFooterHtml } } : {}),
    // Never set (null): a NestChat channel's in-app SDK tag, where the Ding
    // app's was first kept. Set, even to "" (turned off): the channel's own.
    contactTag: i.contactTag ?? legacyAppTag(i.channelConfig as Record<string, string> | null),
    conversationLabelId: i.conversationLabelId ?? null,
  };
}

export function mapContact(c: ContactWithIdentities): Contact {
  const phone = c.identities.find((x) => x.kind === "phone" || x.kind === "wa_id")?.value;
  const email = c.identities.find((x) => x.kind === "email")?.value;
  // The handle this person chats under on a live-chat channel: a per-install id
  // for somebody anonymous, the app's own verified user id for somebody signed
  // in. Both are "who to deliver to" on `nestchat`, and reading only the first
  // meant a verified app customer had no address at all — so an agent replying
  // to them was told the conversation had none, which was true and useless.
  //
  // The verified one wins where a contact has both, which happens when somebody
  // chatted anonymously before signing in and the two records were merged.
  const visitorId =
    c.identities.find((x) => x.kind === "external")?.value ??
    c.identities.find((x) => x.kind === "nestchat")?.value;
  return {
    id: c.id,
    orgId: c.orgId,
    displayName: c.displayName,
    // Their organisation's name. The free-text Company column this used to
    // read is superseded by Organisations and no longer shown.
    company: c.accountLinks?.[0]?.account.name ?? undefined,
    phone,
    // A WhatsApp id is only ever written from WhatsApp itself — a message they
    // sent, or a chat history Meta handed over — so it's proof, where a phone
    // number is not.
    onWhatsApp: c.identities.some((x) => x.kind === "wa_id"),
    email,
    visitorId,
    avatarColor: c.avatarColor ?? undefined,
    tags: c.tags ?? [],
    ownerUserId: c.ownerUserId ?? undefined,
    ownerTeamId: c.ownerTeamId ?? undefined,
    blocked: c.blocked ?? false,
  };
}

/** Parse the stored reactions JSON into a clean [{emoji, by}] array. */
export function parseReactions(raw: unknown): Message["reactions"] {
  if (!Array.isArray(raw)) return [];
  const out: Message["reactions"] = [];
  for (const r of raw) {
    if (r && typeof r === "object" && typeof (r as { emoji?: unknown }).emoji === "string") {
      const by = (r as { by?: unknown }).by;
      out.push({ emoji: (r as { emoji: string }).emoji, by: by === "user" ? "user" : "contact" });
    }
  }
  return out;
}

export function mapMessage(m: MessageRow): Message {
  const dm = m.deliveryMeta as
    | { subject?: string; cc?: string[]; bcc?: string[]; forwardTo?: string[]; via?: string }
    | null;
  // Per-recipient open-tracking rows, To before Cc (the natural reading order).
  const recipients = (m.emailRecipients ?? []).length
    ? [...m.emailRecipients!]
        .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "to" ? -1 : 1))
        .map((r) => ({
          address: r.address,
          kind: (r.kind === "cc" ? "cc" : "to") as "to" | "cc",
          openedAt: r.openedAt ? r.openedAt.toISOString() : null,
        }))
    : undefined;
  const hasMeta = dm && (dm.subject || dm.cc?.length || dm.bcc?.length || dm.forwardTo?.length || dm.via);
  const email =
    hasMeta || recipients
      ? { subject: dm?.subject, cc: dm?.cc, bcc: dm?.bcc, forwardedTo: dm?.forwardTo, ...(dm?.via ? { via: dm.via } : {}), recipients }
      : undefined;
  return {
    id: m.id,
    conversationId: m.conversationId,
    seq: m.seq,
    direction: m.direction as Message["direction"],
    authorType: m.authorType as Message["authorType"],
    authorName: m.authorName ?? undefined,
    authorUserId: m.authorUserId ?? undefined,
    body: m.body,
    status: m.status as MessageStatus,
    internal: m.internal,
    channelMsgId: m.channelMsgId ?? undefined,
    channel: (m.channel as ChannelType | null) ?? undefined,
    inboxId: m.inboxId ?? undefined,
    messageType: (m.messageType as MessageType) ?? "text",
    attachments: (m.attachments ?? []).map(mapAttachment),
    reactions: parseReactions(m.reactions),
    quotedMsgId: m.quotedMsgId ?? undefined,
    // Only sent when true: the label is the exception, and every message
    // carrying `forwarded: false` would be noise on the wire.
    forwarded: m.forwarded ? true : undefined,
    auto: m.auto === "away" || m.auto === "away_ask" ? m.auto : undefined,
    bodyHtml: m.bodyHtml ?? undefined,
    attemptCount: m.attemptCount ?? 0,
    failureReason: m.failureReason ?? undefined,
    email,
    createdAt: m.createdAt.toISOString(),
  };
}

export function mapParticipant(p: ParticipantRow): Participant {
  return {
    id: p.id,
    conversationId: p.conversationId,
    contact: mapContact(p.contact),
    role: p.role as ParticipantRole,
    joinedAt: p.joinedAt.toISOString(),
  };
}

export function mapConversation(c: ConversationSummaryRow): Conversation {
  return {
    id: c.id,
    orgId: c.orgId,
    inboxId: c.inboxId,
    channel: c.channel as ChannelType,
    contact: mapContact(c.contact),
    subject: c.subject ?? undefined,
    inviteLink: c.inviteLink ?? undefined,
    channelRef: c.channelRef ?? undefined,
    status: c.status as Conversation["status"],
    assigneeUserId: c.assigneeUserId,
    assigneeName: c.assignee?.name ?? null,
    assignedTeamId: c.assignedTeamId,
    priority: c.priority as Priority,
    labels: c.labels.map((cl) => ({ id: cl.label.id, name: cl.label.name, color: cl.label.color })),
    unread: c.unread,
    unreadCount: c.unreadCount ?? 0,
    slaDueAt: c.slaDueAt ? c.slaDueAt.toISOString() : null,
    snoozedUntil: c.snoozedUntil ? c.snoozedUntil.toISOString() : null,
    lastActivityAt: c.lastActivityAt.toISOString(),
    seq: c.seq,
    preview: c.preview,
    // Channel of the latest customer-facing message (falls back to the origin).
    lastChannel: ((c.messages?.[0]?.channel as ChannelType | null | undefined) ?? (c.channel as ChannelType)),
    waWindow: computeWaWindow(c.channel, c.lastInboundAt),
  };
}

