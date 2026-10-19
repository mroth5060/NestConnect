/**
 * @ding/schemas — the single source of truth for domain types and the
 * realtime event contract, shared by the API and the web app.
 *
 * Everything is a Zod schema first; TypeScript types are inferred from it,
 * so validation and types can never drift apart.
 */
import { z } from "zod";
import { positionInputSchema } from "./signatures";
import type { ChatClientEvents, ChatServerEvents } from "./chat";

/* ------------------------------------------------------------------ */
/* Enums                                                               */
/* ------------------------------------------------------------------ */

export const ChannelType = {
  WhatsApp: "whatsapp",
  WhatsAppGroup: "whatsapp_group",
  Email: "email",
  NestChat: "nestchat",
} as const;
export const channelTypeSchema = z.enum(["whatsapp", "whatsapp_group", "email", "nestchat", "sms"]);
export type ChannelType = z.infer<typeof channelTypeSchema>;

/**
 * How we know a customer. One person can have several: a phone number, an email
 * address, a WhatsApp id, a browser that has chatted with us before. Matching on
 * any of them is what makes a conversation follow the person across channels.
 *
 * `nestchat` is the odd one out — it is a random id the visitor's own browser
 * keeps, not something they own or could prove. It identifies a *browser*, so it
 * unifies a returning visitor with their own history and nothing else.
 */
export const contactIdentityKindSchema = z.enum([
  "phone",
  "email",
  "wa_id",
  "nestchat",
  /**
   * The id an app's own system knows this person by.
   *
   * Unlike `nestchat`, which is a random id a browser keeps and which anyone
   * who opens a console can rewrite, this one comes from a system that has
   * already authenticated them — so the same customer on a new phone, or after
   * reinstalling, is still the same customer with the same history.
   *
   * The value is namespaced by channel (see `externalIdentity`): the identity
   * table is unique on (kind, value) across every org, so two apps that both
   * start numbering their users at 1 would otherwise be one person.
   */
  "external",
]);
export type ContactIdentityKind = z.infer<typeof contactIdentityKindSchema>;

/**
 * How often an agent's client should re-poke the CUSTOMER-facing typing
 * indicator on this channel, or null where the customer is shown nothing.
 *
 * Separate from the presence agents broadcast to each other, and channel-shaped
 * because the two that have it keep it alive for very different lengths of
 * time: WhatsApp holds an indicator ~25 seconds per ping, so pinging hard would
 * be rude to Meta and pointless; the NestChat widget drops its dots after a few
 * seconds, so the same interval would make them blink on and off while somebody
 * is mid-sentence.
 *
 * Here rather than in each client because it was in neither: both the web and
 * the phone gated this on "is this WhatsApp", so NestChat visitors saw nothing
 * however well the server behaved.
 */
export function typingPingMs(channel: ChannelType): number | null {
  switch (channel) {
    case "whatsapp":
    case "whatsapp_group":
      return 9_000;
    case "nestchat":
      return 3_000;
    default:
      return null;
  }
}

/**
 * The channels the composer offers on an open thread.
 *
 * A thread's channel is its identity, but the composer may answer on any channel
 * the customer is actually reachable on — someone who wrote in by email and gave
 * us a phone number can be answered on WhatsApp without starting a second
 * conversation. A group is the exception: a group message goes to the group, so
 * that is the only place to answer it.
 *
 * The thread's own channel is always in the list. Deriving this purely from the
 * addresses on the contact record dropped it whenever the thread was on a
 * channel that isn't a phone or an email — a NestChat thread with a customer
 * whose email we hold offered WhatsApp and Email and no way to reply in the chat
 * the visitor was sitting in. It hid for as long as visitors stayed anonymous,
 * because an empty list fell through to the thread's own channel; it appeared
 * the moment they started telling us who they were.
 *
 * Here rather than in each client because both clients had written it out, and
 * both were wrong in the same way. One list, one place to be right.
 */
export function replyTargetsFor(
  conv: {
    channel: ChannelType;
    contact: { phone?: string | null; email?: string | null };
  },
  /** The channels the workspace has connected. A phone number reaches
   *  WhatsApp always (as it always has), and SMS only where there's an SMS
   *  channel to send from — most workspaces have none. */
  connected?: ChannelType[],
): ChannelType[] {
  if (conv.channel === "whatsapp_group") return [conv.channel];
  const out: ChannelType[] = [];
  if (conv.contact.phone) out.push("whatsapp");
  if (conv.contact.phone && connected?.includes("sms")) out.push("sms");
  if (conv.contact.email) out.push("email");
  if (!out.includes(conv.channel)) out.push(conv.channel);
  return out;
}

/** The shape `sendingInbox` needs — satisfied by `Inbox`, and by anything else
 *  carrying an id and a type. Generic so callers get their own type back. */
export interface InboxIdentity {
  id: string;
  type: ChannelType;
  name: string;
  handle: string;
  /** Marks the channel's chosen send-from inbox. Optional so callers holding a
   *  bare identity (a test fixture, a trimmed row) still satisfy the type. */
  isDefault?: boolean;
}

/** whatsapp_group and whatsapp are served by the same number. */
const sameChannelFamily = (t: ChannelType): ChannelType => (t === "whatsapp_group" ? "whatsapp" : t);

/**
 * Which of our numbers or addresses a message goes out from — the one the
 * customer sees it arrive from.
 *
 * A conversation has one inbox, but a reply can be sent on a channel it did not
 * start on, and that reply goes from the channel's own inbox instead. So the
 * answer is not simply "the conversation's inbox", and the difference is
 * invisible in the UI unless something says it.
 *
 * This is the single copy of that rule. The dispatcher resolves the real send
 * with it and the apps label the composer with it, which is the point: a
 * composer that says one number while the server uses another is worse than
 * saying nothing at all. `replyTargetsFor` above exists for the same reason —
 * that rule was written out twice, and so the bug existed twice.
 *
 * `recordedInboxId` wins outright when present: a sent message knows where it
 * actually went, and no amount of re-deriving should be allowed to disagree
 * with it. Absent — inbound, or anything sent before we recorded it — the rule
 * is re-run, which is right for every message that never crossed channels.
 */
export function sendingInbox<T extends InboxIdentity>(
  inboxes: T[],
  conv: { inboxId: string; channel: ChannelType },
  opts?: { channel?: ChannelType | null; recordedInboxId?: string | null },
): T | undefined {
  const byId = (id: string) => inboxes.find((i) => i.id === id);
  if (opts?.recordedInboxId) return byId(opts.recordedInboxId);

  const channel = opts?.channel ?? conv.channel;
  const convInbox = byId(conv.inboxId);
  if (convInbox && sameChannelFamily(convInbox.type) === sameChannelFamily(channel)) return convInbox;

  // Otherwise the channel's own default. The chosen one if somebody has said
  // which — that is the whole point of the flag — and failing that the oldest,
  // which is arbitrary but at least the same answer every time (`inboxes` is
  // oldest-first; see Store.listInboxes).
  const ofChannel = inboxes.filter((i) => i.type === sameChannelFamily(channel));
  return ofChannel.find((i) => i.isDefault) ?? ofChannel[0] ?? convInbox;
}

/**
 * How to write an inbox down in one line.
 *
 * A mailbox usually names itself — `support@swiftee.co.uk` is both the name and
 * the handle — and printing that twice with a separator between looks like a
 * bug. A number usually has a name worth keeping ("Sales") next to a handle
 * nobody recognises without it.
 */
export function inboxLabel(inbox: Pick<InboxIdentity, "name" | "handle">): string {
  const name = inbox.name.trim();
  const handle = inbox.handle.trim();
  if (!handle || name === handle) return name || handle;
  // A name that is just the handle with the spacing rubbed out ("+44 20 7946"
  // against "+44 20 7946 0100") adds nothing either.
  const bare = (v: string) => v.replace(/[\s()\-+]/g, "").toLowerCase();
  if (bare(handle).startsWith(bare(name)) || bare(name).startsWith(bare(handle))) return handle;
  return `${name} · ${handle}`;
}

export const conversationStatusSchema = z.enum(["open", "pending", "snoozed", "closed"]);
export type ConversationStatus = z.infer<typeof conversationStatusSchema>;

/**
 * The statuses an inbound message may thread into.
 *
 * A customer writing again continues the conversation they are already in —
 * including one an agent has put down for later. Snoozing says "not now", not
 * "not this person"; if they come back before the timer does, the timer is what
 * loses. The store that receives the message wakes it (see `appendInboundMessage`
 * in either store), so the only job here is to make sure the lookup *finds* it.
 *
 * `closed` is deliberately absent. A resolved conversation is finished, and a
 * new subject from the same customer deserves its own thread rather than being
 * filed under whatever was last settled with them. Email is the exception and
 * makes itself one: a reply carrying a `References` chain is matched by that
 * chain instead, which has no status filter at all, so it reopens the exact
 * thread it belongs to.
 *
 * Shared because it was written twice — once in each store — and the copies
 * disagreed. Both had "open" and "pending" and neither had "snoozed", so every
 * reply to a snoozed chat opened a *second* conversation with the same customer
 * and the wake-it-up branch waiting in both stores could never run.
 */
export const THREADABLE_STATUSES = ["open", "pending", "snoozed"] as const satisfies readonly ConversationStatus[];

export const messageDirectionSchema = z.enum(["in", "out"]);
export type MessageDirection = z.infer<typeof messageDirectionSchema>;

export const messageStatusSchema = z.enum(["queued", "sending", "sent", "delivered", "read", "failed"]);
export type MessageStatus = z.infer<typeof messageStatusSchema>;

export const authorTypeSchema = z.enum(["contact", "user", "system"]);
export type AuthorType = z.infer<typeof authorTypeSchema>;

export const prioritySchema = z.enum(["low", "normal", "high", "urgent"]);
export type Priority = z.infer<typeof prioritySchema>;

export const roleSchema = z.enum(["admin", "manager", "agent"]);
export type Role = z.infer<typeof roleSchema>;

/** How an inbox/team turns inbound conversations into assignments. */
export const routingStrategySchema = z.enum([
  "manual", // stays "up for grabs" until an agent takes it
  "round_robin",
  "load_balanced",
  "most_idle",
]);
export type RoutingStrategy = z.infer<typeof routingStrategySchema>;

/* ------------------------------------------------------------------ */
/* Core entities                                                       */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Availability — the switch, and the working hours behind it.          */
/* ------------------------------------------------------------------ */

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM, 24-hour");

/** One day of somebody's working hours. An end at or before the start runs
 *  past midnight into the next day — a 22:00–06:00 night shift. */
export const availabilityDaySchema = z.object({
  on: z.boolean(),
  start: clockTime,
  end: clockTime,
});
export type AvailabilityDay = z.infer<typeof availabilityDaySchema>;

const workday = { on: true, start: "09:00", end: "17:30" };
const dayOff = { on: false, start: "09:00", end: "17:30" };

/**
 * When somebody works. Off by default: until they set hours, the switch alone
 * decides, as it always has. With it on, they are available only inside these
 * hours (in their own time zone) *and* with the switch on — so "Unavailable"
 * still means unavailable, and leaving the switch on overnight no longer
 * means taking chats at 3am.
 */
export const availabilityScheduleSchema = z.object({
  enabled: z.boolean().default(false),
  /** IANA time zone, e.g. "Europe/London". The hours are read in it. */
  timezone: z.string().min(1).max(64).default("Europe/London"),
  days: z
    .object({
      mon: availabilityDaySchema.default(workday),
      tue: availabilityDaySchema.default(workday),
      wed: availabilityDaySchema.default(workday),
      thu: availabilityDaySchema.default(workday),
      fri: availabilityDaySchema.default(workday),
      sat: availabilityDaySchema.default(dayOff),
      sun: availabilityDaySchema.default(dayOff),
    })
    .default({}),
});
export type AvailabilitySchedule = z.infer<typeof availabilityScheduleSchema>;
export const DEFAULT_AVAILABILITY_SCHEDULE: AvailabilitySchedule = availabilityScheduleSchema.parse({});

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** The weekday and minute-of-day at `at`, in `timezone` (UTC if it's not one
 *  the runtime knows — a typo must not make somebody permanently away). */
function localClock(at: Date, timezone: string): { day: Weekday; minute: number } | null {
  const read = (tz: string) => {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(at);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return {
      day: get("weekday").slice(0, 3).toLowerCase() as Weekday,
      minute: Number(get("hour")) * 60 + Number(get("minute")),
    };
  };
  try {
    return read(timezone);
  } catch {
    try {
      return read("UTC");
    } catch {
      // A runtime without time zones at all (some phone JS engines): the hours
      // can't be read, so they don't decide — the switch alone does.
      return null;
    }
  }
}

/** Whether `timezone` is one the runtime can read hours in. */
export function isTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** Whether a schedule says "working" at `at`. A disabled schedule always does. */
export function withinSchedule(schedule: AvailabilitySchedule | null | undefined, at: Date = new Date()): boolean {
  if (!schedule?.enabled) return true;
  const clock = localClock(at, schedule.timezone);
  if (!clock || !WEEKDAYS.includes(clock.day) || Number.isNaN(clock.minute)) return true;
  const { day, minute } = clock;
  const i = WEEKDAYS.indexOf(day);
  const today = schedule.days[day];
  const yesterday = schedule.days[WEEKDAYS[(i + 6) % 7]!];
  if (today?.on) {
    const start = minutesOf(today.start);
    const end = minutesOf(today.end);
    if (start < end ? minute >= start && minute < end : minute >= start) return true;
  }
  // Yesterday's shift running on past midnight.
  if (yesterday?.on) {
    const start = minutesOf(yesterday.start);
    const end = minutesOf(yesterday.end);
    if (end <= start && minute < end) return true;
  }
  return false;
}

/**
 * Whether somebody is taking new chats right now: the switch is on, and — if
 * they've set working hours — it's within them. The one rule round-robin, the
 * chat widget's "online" and the apps' availability all read, so they can't
 * disagree about whether a person is there.
 */
export function availableNow(
  user: { available?: boolean; schedule?: AvailabilitySchedule | null },
  at: Date = new Date(),
): boolean {
  return user.available !== false && withinSchedule(user.schedule, at);
}

export const userSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  name: z.string(),
  email: z.string().email(),
  role: roleSchema,
  avatarColor: z.string().optional(),
  /** Uploaded profile photo URL (served via /api/media/:id). Falls back to
   *  Gravatar, then coloured initials, when absent. */
  avatarUrl: z.string().nullable().optional(),
  online: z.boolean().default(false),
  /** Manual "accepting work" flag — an unavailable agent is skipped by
   *  round-robin auto-assignment (distinct from `online` presence). */
  available: z.boolean().default(true),
  /** Working hours. Null or disabled: the switch alone decides. See availableNow. */
  schedule: availabilityScheduleSchema.nullable().optional(),
  /** Job title, e.g. "Operations Manager" — filled into email signatures. */
  position: z.string().nullable().optional(),
  /** Two-factor status, surfaced so the UI can show it + gate mandatory setup.
   *  The secret itself is never sent to the client. */
  twoFactorEnabled: z.boolean().optional(),
  twoFactorMethod: z.enum(["totp", "email"]).nullable().optional(),
});
export type User = z.infer<typeof userSchema>;

export const teamSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  name: z.string(),
  /** Icon key from the shared team-icon library (see web lib/icons). */
  icon: z.string().nullable().optional(),
  /** Sort position in Settings and the sidebar (ascending). */
  order: z.number().int().default(0),
  /** First-response SLA target in minutes; null = no SLA for this team. */
  slaMinutes: z.number().int().positive().nullable().optional(),
});
export type Team = z.infer<typeof teamSchema>;

export const contactSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  displayName: z.string(),
  company: z.string().optional(),
  phone: z.string().optional(),
  /** Known to be on WhatsApp: they've written to us there. A phone number on
   *  its own says nothing about it — it may only take texts — so a number is
   *  shown as a phone, and WhatsApp's mark only where this is true. */
  onWhatsApp: z.boolean().optional(),
  email: z.string().optional(),
  /** The browser id this customer first chatted from, if they came in through a
   *  NestChat widget. Its own field rather than folded into `phone`: it is not a
   *  number, nothing can be dialled or messaged at it, and showing it under a
   *  phone icon tells an agent something untrue. */
  visitorId: z.string().optional(),
  avatarColor: z.string().optional(),
  /** Free-form labels for organising customers (VIP, Wholesale, …). */
  tags: z.array(z.string()).default([]),
  /** Owner drives per-customer auto-routing (a client always reaches "their" person/team). */
  ownerUserId: z.string().nullable().optional(),
  ownerTeamId: z.string().nullable().optional(),
  /** Blocked customers have their inbound dropped and are hidden by default. */
  blocked: z.boolean().optional(),
});
export type Contact = z.infer<typeof contactSchema>;

/** Why two contacts were flagged as possible duplicates: a shared, canonicalised
 *  identifier (E.164 phone or lower-cased email). */
export interface ContactDuplicateReason {
  kind: "phone" | "email";
  value: string;
}
/** A cluster of contacts that probably represent the same customer, found by
 *  matching normalised phone/email. Surfaced for review, then merged. */
export interface ContactDuplicateGroup {
  contacts: Contact[];
  reasons: ContactDuplicateReason[];
}

/** Merge duplicate customers into one surviving record. The winner keeps its
 *  name; the losers' identities, conversations and blank-filled fields move
 *  onto it and the loser records are deleted. */
export const mergeContactsInputSchema = z.object({
  winnerId: z.string(),
  loserIds: z.array(z.string()).min(1),
});
export type MergeContactsInput = z.infer<typeof mergeContactsInputSchema>;

/** One action on many customers at once (Customers › select). Merging is
 *  `merge` above; putting them in an organisation is the organisation's own
 *  `contacts/many`. */
const bulkIds = z.array(z.string().min(1)).min(1).max(1000);
const bulkTags = z.array(z.string().trim().min(1)).max(50).default([]);
export const bulkContactsInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("tag"), ids: bulkIds, add: bulkTags, remove: bulkTags }),
  z.object({ action: z.literal("block"), ids: bulkIds, blocked: z.boolean() }),
  z.object({ action: z.literal("delete"), ids: bulkIds }),
]);
export type BulkContactsInput = z.input<typeof bulkContactsInputSchema>;
/** How many it changed, and how many were already gone. */
export interface BulkContactsResult {
  done: number;
  missing: number;
}

export const inboxSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  type: channelTypeSchema,
  name: z.string(),
  /** Human handle: a phone number, group name, or email address. */
  handle: z.string(),
  teamIds: z.array(z.string()).default([]),
  routingStrategy: routingStrategySchema.default("manual"),
  /** This channel's send-from default: which of several numbers or mailboxes a
   *  reply switched onto this channel goes out from. At most one per channel
   *  type; with none set the oldest wins. */
  isDefault: z.boolean().default(false),
  /** Where this channel sits in the sidebar, low first. Set by the arrows in
   *  Settings, the same way a team's order is. */
  order: z.number().int().default(0),
  unread: z.number().int().nonnegative().default(0),
  /** True once the integration credentials needed to send/receive live are set
   *  — and still working: a mailbox Google has signed out is not connected. */
  connected: z.boolean().optional(),
  /** Set when the provider has signed this channel out (a Gmail mailbox whose
   *  sign-in was revoked or expired): why, and since when. It needs
   *  reconnecting — in place, keeping its conversations — to work again. */
  signedOut: z.object({ reason: z.string(), since: z.string().nullable() }).nullable().optional(),
  /** Non-secret channelConfig values (e.g. the Phone number ID) surfaced so the
   *  channel editor can show what's configured. Access tokens are NEVER included. */
  channelConfigPublic: z.record(z.string()).optional(),
  /** An email channel's signature design (layout with tags + marketing
   *  section). Absent on other channels. See signatures.ts. */
  signature: z.object({ layoutHtml: z.string().nullable(), footerHtml: z.string().nullable() }).optional(),
  /** Added to every customer who starts a conversation on this channel. */
  contactTag: z.string().optional(),
  /** The label put on every conversation that starts on this channel. */
  conversationLabelId: z.string().nullable().optional(),
});
export type Inbox = z.infer<typeof inboxSchema>;

/**
 * The channelConfig keys that must be present (and non-empty) before an inbox
 * of a given type can send/receive live. Used to derive `connected`. Secrets in
 * channelConfig never leave the backend — only the boolean does.
 */
export const REQUIRED_CHANNEL_KEYS: Record<ChannelType, string[]> = {
  whatsapp: ["phoneNumberId", "accessToken"],
  whatsapp_group: ["phoneNumberId", "accessToken"],
  email: ["providerToken"],
  // NestChat is our own channel — there is no third party to authenticate with,
  // so a NestChat inbox is live the moment it exists (its widget key is minted
  // on creation). An empty requirement list makes isInboxConnected() say so.
  nestchat: [],
  // The provider config (sms.ts); the secret is optional — some
  // providers authenticate by account id in the URL alone.
  sms: ["smsConfig"],
};

/**
 * channelConfig keys that are safe to send to the client — identifiers, not
 * credentials. Access tokens (`accessToken`, `providerToken`) and the webhook
 * `verifyToken` are deliberately absent, so a token never leaves the backend.
 */
export const PUBLIC_CHANNEL_KEYS = [
  "phoneNumberId",
  "wabaId",
  "displayNumber",
  "fromName",
  "provider",
  // The NestChat widget key is public by design — it is what the embed snippet
  // on the customer's own website carries. It identifies an inbox; it authorises
  // nothing beyond "open a chat with this business", which is the point.
  "widgetKey",
  // A WhatsApp number that stays on the WhatsApp Business app alongside us
  // (Meta's "coexistence"): "true". It changes what the editor offers — never
  // the API "register" step, which would take the number off the phone.
  "coexistence",
  // Where its one-time history/contacts import stands, and whether Meta still
  // has it linked to the app — read-only status lines for the editor.
  "coexistenceSync",
  "coexistenceState",
] as const;

/** Pick only the non-secret channelConfig keys, for display in the channel editor. */
export function publicChannelConfig(
  config?: Record<string, string> | null,
): Record<string, string> | undefined {
  if (!config) return undefined;
  const out: Record<string, string> = {};
  for (const k of PUBLIC_CHANNEL_KEYS) {
    if (config[k]) out[k] = config[k];
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Whether an inbox is wired up to its provider. A `null`/absent config means a
 * legacy/demo channel that predates the integration flow — treated as connected
 * so existing inboxes don't suddenly read as broken. A present config (even `{}`)
 * is checked strictly against REQUIRED_CHANNEL_KEYS.
 */
export function isInboxConnected(
  type: ChannelType,
  config?: Record<string, string> | null,
): boolean {
  if (config == null) return true;
  if (config.authError) return false;
  const keys = REQUIRED_CHANNEL_KEYS[type] ?? [];
  return keys.every((k) => Boolean(config[k] && config[k].trim()));
}

/** An inbox's live state, from its (server-side) config: connected, or signed out and why. */
export function inboxStatus(
  type: ChannelType,
  config?: Record<string, string> | null,
): { connected: boolean; signedOut: { reason: string; since: string | null } | null } {
  return {
    connected: isInboxConnected(type, config),
    signedOut: config?.authError ? { reason: config.authError, since: config.authErrorAt || null } : null,
  };
}

export const labelSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
});
export type Label = z.infer<typeof labelSchema>;

/* ---- custom fields ---- */

/**
 * What a custom field hangs off.
 *
 * The distinction is whether the fact follows the person or belongs to one
 * thread. A loyalty tier is the customer's and should be on every conversation
 * they ever open; the order a chat is about is that chat's, and putting it on
 * the contact would mean last week's complaint silently relabelled itself when
 * they ordered again tonight.
 */
export const customFieldEntitySchema = z.enum(["contact", "conversation"]);
export type CustomFieldEntity = z.infer<typeof customFieldEntitySchema>;

/**
 * How a value is entered and read back.
 *
 * Deliberately few. Every type here is one an agent can be shown a sensible
 * input for and a search can match on as text; a richer set (currency,
 * relations, formulas) is a spreadsheet, and the moment a field can compute
 * something it stops being a fact somebody recorded.
 */
export const customFieldTypeSchema = z.enum(["text", "number", "date", "url", "select"]);
export type CustomFieldType = z.infer<typeof customFieldTypeSchema>;

/** A field key: what an SDK sends, and what never changes once in use. */
const customFieldKey = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z][a-z0-9_]*$/, "Use lower-case letters, numbers and underscores; start with a letter");

export const customFieldSchema = z.object({
  id: z.string(),
  /** Stable machine name — the identity. The label is the part that may change. */
  key: customFieldKey,
  label: z.string().min(1).max(60),
  type: customFieldTypeSchema.default("text"),
  entity: customFieldEntitySchema,
  /** The choices, for `select`. Empty for every other type. */
  options: z.array(z.string().max(80)).max(50).default([]),
  /** Which channels offer it. Empty means every channel. */
  inboxIds: z.array(z.string()).default([]),
  position: z.number().int().nonnegative().default(0),
  /**
   * Whether it gets a chip in the inbox's filter row.
   *
   * Opt-in, because "worth recording" and "worth a permanent chip" are
   * different questions — and a row that grows a chip for every field somebody
   * defines is a row people stop reading.
   */
  filterable: z.boolean().default(false),
  /** Retired, not deleted: the values already recorded against it are history. */
  archived: z.boolean().default(false),
});
export type CustomField = z.infer<typeof customFieldSchema>;

export const createCustomFieldInputSchema = z.object({
  key: customFieldKey,
  label: z.string().min(1).max(60),
  type: customFieldTypeSchema.default("text"),
  entity: customFieldEntitySchema,
  options: z.array(z.string().max(80)).max(50).default([]),
  inboxIds: z.array(z.string()).default([]),
  filterable: z.boolean().default(false),
});
export type CreateCustomFieldInput = z.infer<typeof createCustomFieldInputSchema>;

/**
 * An edit.
 *
 * `key` is absent on purpose: it is what an integration sends and what every
 * recorded value is filed under, so renaming it would silently orphan the lot.
 *
 * `entity` can change, because picking the wrong one is an easy mistake with a
 * quiet symptom: an app sends a field that belongs to the *contact*, the chat
 * only takes conversation fields from a client, and the value is dropped. What
 * can't come along is the values already recorded — they hang off records of
 * the old kind, and there is no saying which conversation a customer's value
 * belonged to. So a switch on a field that has any is refused unless
 * `discardValues` says to clear them.
 */
export const updateCustomFieldInputSchema = z.object({
  label: z.string().min(1).max(60).optional(),
  type: customFieldTypeSchema.optional(),
  entity: customFieldEntitySchema.optional(),
  discardValues: z.boolean().optional(),
  options: z.array(z.string().max(80)).max(50).optional(),
  inboxIds: z.array(z.string()).optional(),
  position: z.number().int().nonnegative().optional(),
  filterable: z.boolean().optional(),
  archived: z.boolean().optional(),
});
export type UpdateCustomFieldInput = z.infer<typeof updateCustomFieldInputSchema>;

/** One recorded value, as the panel and the API exchange it. */
export const customFieldValueSchema = z.object({
  fieldId: z.string(),
  key: customFieldKey,
  value: z.string(),
});
export type CustomFieldValue = z.infer<typeof customFieldValueSchema>;

/**
 * A write: field key → value, with null to clear.
 *
 * Keyed by the field's key rather than its id because the other caller is an
 * SDK, and an integration should name a field the way its own code does —
 * `{ order_id: "DG-88412" }` — not by an id it would have to look up first.
 */
export const setCustomFieldValuesInputSchema = z.object({
  values: z.record(z.string().max(500).nullable()),
});
export type SetCustomFieldValuesInput = z.infer<typeof setCustomFieldValuesInputSchema>;

/**
 * How an app's user id is stored as an identity.
 *
 * Namespaced by channel: the identity table is unique on (kind, value) across
 * the whole table, so two apps that both start counting users at 1 would
 * otherwise resolve to one person.
 */
export function externalIdentity(inboxId: string, externalId: string): string {
  return `${inboxId}:${externalId.trim()}`;
}

/**
 * Fold a value for matching.
 *
 * Reference numbers are read out over the phone and typed back in whatever
 * shape the person writing them down prefers, so "dg 88412", "DG-88412" and
 * "dg88412" have to be the same thing to a search. Only separators go: letters
 * and digits are the value.
 */
export function normalizeCustomFieldValue(value: string): string {
  return value.trim().toLowerCase().replace(/[\s\-_/.]+/g, "");
}

/**
 * The fields that apply to a given channel, in display order.
 *
 * An empty `inboxIds` means every channel — the common case, and the one that
 * must not require an admin to tick every box they own each time they add a
 * number.
 */
export function fieldsForInbox<T extends { inboxIds: string[]; archived: boolean; position: number }>(
  fields: T[],
  inboxId: string | null | undefined,
): T[] {
  return fields
    .filter((f) => !f.archived && (!f.inboxIds.length || (inboxId ? f.inboxIds.includes(inboxId) : true)))
    .slice()
    .sort((a, b) => a.position - b.position);
}

/**
 * The fields that get a chip in an inbox's filter row, in display order.
 *
 * Shared by the web list and the phone's, because the rule has to be the same
 * one: two copies of a predicate that must agree is how they stop agreeing.
 *
 * Two conditions, and they mean different things. `filterable` is somebody
 * having decided this field is worth a permanent chip — defining a field and
 * wanting a filter for it are different decisions, and a row that grows a chip
 * each time anybody adds a field is a row people stop reading. `archived` is
 * the field being history: the values recorded against it are kept and remain
 * searchable, but it is no longer a question the inbox offers, so it must not
 * offer one — whatever its filter switch was left on.
 */
export function filterChipFields<
  T extends { filterable: boolean; archived: boolean; position: number },
>(fields: T[]): T[] {
  return fields
    .filter((f) => f.filterable && !f.archived)
    .slice()
    .sort((a, b) => a.position - b.position);
}

/** What a message carries. "text" is the default; the rest imply attachments. */
export const messageTypeSchema = z.enum([
  "text",
  "image",
  "video",
  "audio",
  "voice",
  "document",
  "sticker",
  "location",
  "contact",
]);
export type MessageType = z.infer<typeof messageTypeSchema>;

export const attachmentKindSchema = z.enum([
  "image",
  "video",
  "audio",
  "voice",
  "document",
  "sticker",
  "file",
]);
export type AttachmentKind = z.infer<typeof attachmentKindSchema>;

/** A stored media file on a message. `url` is a same-origin served/download link;
 *  the underlying storage key never reaches the client. */
export const attachmentSchema = z.object({
  id: z.string(),
  kind: attachmentKindSchema,
  mime: z.string(),
  size: z.number().int().nonnegative(),
  filename: z.string(),
  url: z.string(),
  /** Audio/video duration (ms), image intrinsic size, voice waveform peaks (0..1). */
  durationMs: z.number().int().nonnegative().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  waveform: z.array(z.number()).optional(),
  /** Voice and audio: what was said, once someone asked (Transcribe). */
  transcript: z.string().optional(),
});
export type Attachment = z.infer<typeof attachmentSchema>;

/** What `POST /media/:id/transcript` answers: the words, made or remembered. */
export const mediaTranscriptSchema = z.object({ transcript: z.string() });
export type MediaTranscript = z.infer<typeof mediaTranscriptSchema>;

/** The speeds a voice note plays at, in the order the pill steps through them
 *  — WhatsApp's, with 1.25× between. */
export const VOICE_RATES = [1, 1.25, 1.5, 2] as const;
export type VoiceRate = (typeof VOICE_RATES)[number];

/** The next speed after this one, back to 1× after the last. */
export function nextVoiceRate(rate: number): VoiceRate {
  const i = VOICE_RATES.findIndex((r) => r === rate);
  return VOICE_RATES[(i + 1) % VOICE_RATES.length] ?? 1;
}

/** "1×", "1.25×", "1.5×", "2×". */
export function voiceRateLabel(rate: number): string {
  return `${rate}×`;
}

/** An emoji reaction on a message, by the customer ("contact") or an agent ("user"). */
export const reactionSchema = z.object({
  emoji: z.string(),
  by: z.enum(["contact", "user"]),
});
export type Reaction = z.infer<typeof reactionSchema>;

/** What an automatic message is. */
export const messageAutoSchema = z.enum(["away", "away_ask"]);
export type MessageAuto = z.infer<typeof messageAutoSchema>;

export const messageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  seq: z.number().int().nonnegative(),
  direction: messageDirectionSchema,
  authorType: authorTypeSchema,
  authorName: z.string().optional(),
  /** The authoring agent's user id (outbound messages + internal notes); absent
   *  for inbound/system. Lets the UI tell your own note from a teammate's. */
  authorUserId: z.string().nullable().optional(),
  body: z.string(),
  status: messageStatusSchema.default("sent"),
  /** Internal-lane note — never delivered to the customer. */
  internal: z.boolean().default(false),
  /** Provider-side id (e.g. WhatsApp wamid) for reconciling delivery/read status. */
  channelMsgId: z.string().nullable().optional(),
  /** The channel this message was sent/received on (a thread can span channels).
   *  Absent → the conversation's own channel. */
  channel: channelTypeSchema.nullable().optional(),
  /** Which inbox this outbound message actually went from — the number or
   *  address the customer saw. Absent on inbound, and on anything sent before
   *  this was recorded → fall back to the conversation's inbox, which is right
   *  for every message that never crossed channels. */
  inboxId: z.string().nullable().optional(),
  /** What the message carries; "text" unless it has media. */
  messageType: messageTypeSchema.default("text"),
  /** Media files attached to the message (images, files, voice notes, …). */
  attachments: z.array(attachmentSchema).default([]),
  /** Sanitized HTML body for rich email (rendered in a sandboxed iframe). The
   *  plain `body` above stays the fallback + list-preview text. */
  bodyHtml: z.string().nullable().optional(),
  /** Emoji reactions on this message (at most one per participant). */
  reactions: z.array(reactionSchema).default([]),
  /** Id of the message this one quotes/replies to (resolved within the thread). */
  quotedMsgId: z.string().nullable().optional(),
  /** This message is a forward — it was passed on from somewhere else rather than
   *  written here. Set on our own sends when an agent forwards, and on inbound
   *  when WhatsApp tells us the customer forwarded it to us. Rendered as the
   *  "Forwarded" label WhatsApp users already read as "this isn't their words". */
  forwarded: z.boolean().optional(),
  /** Sent by Nest itself rather than a person: the website chat's reply when
   *  nobody is online ("away"), or that reply asking for an email ("away_ask"). */
  auto: messageAutoSchema.optional(),
  /** Outbound send attempts made so far (absent for inbound/internal). */
  attemptCount: z.number().int().nonnegative().optional(),
  /** Human-readable reason shown in the UI once an outbound send has failed. */
  failureReason: z.string().nullable().optional(),
  /** Email headers this message carried (email channel only), surfaced on the
   *  bubble the way an email shows its subject + Cc. */
  email: z
    .object({
      subject: z.string().optional(),
      cc: z.array(z.string()).optional(),
      bcc: z.array(z.string()).optional(),
      /** Present on a forwarded email: the people it was forwarded on to, shown
       *  on the bubble as "Forwarded to …" (distinct from a reply's recipient). */
      forwardedTo: z.array(z.string()).optional(),
      /** An inbound email sent from one address with Reply-To another (a website
       *  form, say): the address it came from. The contact is the Reply-To. */
      via: z.string().optional(),
      /** Per-recipient read tracking (To/Cc). Each got their own tracked copy;
       *  `openedAt` is set once their tracking pixel is first requested. Powers
       *  the per-recipient "Seen" indicators on an outbound email. */
      recipients: z
        .array(
          z.object({
            address: z.string(),
            kind: z.enum(["to", "cc"]).default("to"),
            openedAt: z.string().nullable().optional(),
          }),
        )
        .optional(),
    })
    .optional(),
  createdAt: z.string(), // ISO-8601
});
export type Message = z.infer<typeof messageSchema>;

/** Official WhatsApp Groups API cap: a group holds at most 8 members. */
export const GROUP_MAX_MEMBERS = 8;

export const participantRoleSchema = z.enum(["member", "admin"]);
export type ParticipantRole = z.infer<typeof participantRoleSchema>;

export const participantSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  contact: contactSchema,
  role: participantRoleSchema.default("member"),
  joinedAt: z.string(),
});
export type Participant = z.infer<typeof participantSchema>;

/** WhatsApp 24-hour customer-service window state on a conversation. */
export const waWindowSchema = z.object({
  open: z.boolean(),
  /** ISO time an open window closes (24h after the last inbound); null if never opened. */
  expiresAt: z.string().nullable(),
});
export type WaWindow = z.infer<typeof waWindowSchema>;

export const noteFollowUpSchema = z.object({
  reason: z.enum(["mention", "reply"]),
  /** Who wrote the note that brought it in. */
  byUserId: z.string().nullable(),
  since: z.string(),
});
export type NoteFollowUp = z.infer<typeof noteFollowUpSchema>;

/** Why a conversation that isn't yours is in your My Inbound, in words — the
 *  same on the web and in the app. `byName` is whoever wrote the note. */
export function followUpLabel(f: NoteFollowUp, byName?: string | null): string {
  const who = byName?.trim().split(/\s+/)[0] || "Someone";
  return f.reason === "mention" ? `${who} mentioned you` : `${who} replied in the notes`;
}

export const conversationSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  inboxId: z.string(),
  channel: channelTypeSchema,
  contact: contactSchema,
  /** Email thread subject / group name. */
  subject: z.string().nullable().optional(),
  /** Group invite link (whatsapp_group only). */
  inviteLink: z.string().nullable().optional(),
  /** Provider-side reference: the WhatsApp group id (whatsapp_group only). */
  channelRef: z.string().nullable().optional(),
  status: conversationStatusSchema.default("open"),
  assigneeUserId: z.string().nullable().default(null),
  /** The assignee's display name, resolved server-side so the UI can show the
   *  real owner (e.g. "Assigned to Priya") instead of a viewer-relative "You".
   *  Null when unassigned. */
  assigneeName: z.string().nullable().default(null),
  assignedTeamId: z.string().nullable().default(null),
  priority: prioritySchema.default("normal"),
  labels: z.array(labelSchema).default([]),
  unread: z.boolean().default(false),
  /** Number of unread inbound messages (for the WhatsApp-style count badge). */
  unreadCount: z.number().int().nonnegative().default(0),
  slaDueAt: z.string().nullable().default(null),
  /** When a snoozed conversation should wake back into the queue (ISO). */
  snoozedUntil: z.string().nullable().default(null),
  lastActivityAt: z.string(),
  seq: z.number().int().nonnegative().default(0),
  preview: z.string().default(""),
  /** Channel of the most recent customer-facing message — a thread can span
   *  channels, and the list badge shows this rather than the origin `channel`.
   *  Falls back to `channel` when there are no customer messages yet. */
  lastChannel: channelTypeSchema.optional(),
  /**
   * WhatsApp's 24-hour customer-service window (whatsapp channels only; null on
   * email). `open` = you may free-type; when closed you may only send an
   * approved template. `expiresAt` is when an open window closes (ISO).
   */
  waWindow: waWindowSchema.nullable().default(null),
  /**
   * Why this is in the viewer's My Inbound when it isn't theirs: its internal
   * notes. "mention" — a note @mentioned them; "reply" — someone wrote in notes
   * they're part of. Gone once they write a note or reply here, dismiss it, or
   * the conversation closes. Per viewer: absent everywhere it doesn't apply.
   */
  followUp: noteFollowUpSchema.optional(),
});
export type Conversation = z.infer<typeof conversationSchema>;

/** A conversation plus its (most-recent page of) messages — the thread payload. */
export const conversationWithMessagesSchema = conversationSchema.extend({
  messages: z.array(messageSchema),
  /** True when older messages exist beyond the returned page (load on scroll-up). */
  hasMoreMessages: z.boolean().default(false),
  /** Group members (whatsapp_group only; empty otherwise). */
  participants: z.array(participantSchema).default([]),
});
export type ConversationWithMessages = z.infer<typeof conversationWithMessagesSchema>;

/* ------------------------------------------------------------------ */
/* Cursor pagination                                                   */
/* ------------------------------------------------------------------ */

/** A page of conversations (list/search). `nextCursor` is null on the last page. */
export const conversationPageSchema = z.object({
  items: z.array(conversationSchema),
  nextCursor: z.string().nullable().default(null),
});
export type ConversationPage = z.infer<typeof conversationPageSchema>;

/** A page of older thread messages (scroll-up history). */
export const messagePageSchema = z.object({
  items: z.array(messageSchema),
  nextCursor: z.string().nullable().default(null),
});
export type MessagePage = z.infer<typeof messagePageSchema>;

/** Default page sizes shared by the API and the client. */
export const CONVERSATIONS_PAGE_SIZE = 30;

/**
 * How many records a custom-field filter will gather before it stops.
 *
 * The filter resolves matching records to a list of ids and matches them with
 * `IN`, which is the right shape for a working set and the wrong one for a
 * whole table. The cap means a filter over a very large set shows its most
 * recent slice rather than timing out — a filter you can keep narrowing, not a
 * spinner. Somewhere past this the answer is a join, which needs the values
 * table to carry real relations rather than a polymorphic entity id.
 */
export const CUSTOM_FIELD_FILTER_MAX = 2000;
export const MESSAGES_PAGE_SIZE = 40;

/* ------------------------------------------------------------------ */
/* API request payloads                                                */
/* ------------------------------------------------------------------ */

/* ---- WhatsApp message templates (HSM) ---- */

export const templateCategorySchema = z.enum(["marketing", "utility", "authentication"]);
export type TemplateCategory = z.infer<typeof templateCategorySchema>;

/** Meta's template review states, plus our local "draft" for unsynced ones. */
export const templateApprovalSchema = z.enum([
  "approved",
  "pending",
  "rejected",
  "paused",
  "disabled",
  "draft",
]);
export type TemplateApproval = z.infer<typeof templateApprovalSchema>;

export const templateSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: templateCategorySchema,
  /** BCP-47-ish language code, e.g. "en" or "en_GB". */
  language: z.string(),
  /** Body text with {{1}}, {{2}} … positional variables. */
  body: z.string(),
  approvalStatus: templateApprovalSchema,
  /** How many {{n}} variables the body has (derived; drives the fill form). */
  variableCount: z.number().int().nonnegative().default(0),
  /**
   * The WhatsApp Business Account this template lives on.
   *
   * Templates belong to a WABA, not to a phone number — every number under one
   * account can send all of its templates, and none of another's. Absent means
   * the template has not been claimed by an account: authored here, or stored
   * before this field existed.
   */
  wabaId: z.string().optional(),
  /**
   * What each `{{1}}`, `{{2}}` … starts out as when somebody sends this.
   *
   * Index-aligned with the body's variables and free text with `{{token}}`
   * placeholders — see TEMPLATE_TOKENS. Saved once in settings so an agent is
   * not retyping their own name into every template, and pre-filled rather than
   * fixed: the boxes still open, and anything here can be changed before Send.
   */
  variableDefaults: z.array(z.string()).default([]),
  /** The default template **for its own account** — the one the composer sends
   *  behind the scenes once a 24-hour window has closed. One per WABA, because
   *  a workspace-wide default would be a template the other account cannot
   *  send, chosen automatically at the worst possible moment.
   *
   *  Per account, not per number: every number under a WABA shares it. Two
   *  numbers on one account therefore re-open a chat with the same sentence,
   *  which is the trade for having a single control rather than two. */
  isDefault: z.boolean().default(false),
});
export type Template = z.infer<typeof templateSchema>;

/* ---- Template variable pre-fill ---- */

/**
 * What can be dropped into a template variable without anybody typing it.
 *
 * Deliberately only things we hold at the moment a template is filled in, and
 * only things that cannot be subtly wrong. No dates: "your appointment on
 * {{2}}" is a tempting one to automate and a timezone away from telling a
 * customer the wrong day, which is worse than making somebody type it.
 *
 * The label is what the settings menu shows; the sample is what the preview
 * renders, so an admin can see the shape of the result before saving.
 */
export const TEMPLATE_TOKENS = [
  { token: "contact.name", label: "Customer name", sample: "Marta Kowalska" },
  { token: "contact.first_name", label: "Customer first name", sample: "Marta" },
  { token: "contact.company", label: "Customer's organisation", sample: "Northside Logistics" },
  { token: "contact.phone", label: "Customer phone", sample: "+44 7700 900123" },
  { token: "contact.email", label: "Customer email", sample: "marta@example.com" },
  { token: "agent.name", label: "Your name", sample: "Nathan A" },
  { token: "agent.first_name", label: "Your first name", sample: "Nathan" },
  { token: "channel.name", label: "Number this is sent from", sample: "Swiftee Support" },
] as const;

export type TemplateToken = (typeof TEMPLATE_TOKENS)[number]["token"];

/**
 * The facts a template variable can be filled from.
 *
 * Every field optional: a broadcast to a pasted list has no contact record, a
 * conversation may have no company on file, and a missing fact must degrade to
 * an empty string rather than putting the literal "{{contact.company}}" in
 * front of a customer.
 */
export interface TemplateFillContext {
  contactName?: string;
  contactCompany?: string;
  contactPhone?: string;
  contactEmail?: string;
  agentName?: string;
  channelName?: string;
}

/** "Marta Kowalska" → "Marta". Whitespace-split, so it is wrong for no name
 *  we can do better on without guessing at cultures we do not know. */
function firstName(full?: string): string {
  return (full ?? "").trim().split(/\s+/)[0] ?? "";
}

/**
 * The value behind a token, or `null` when the token isn't one we know.
 *
 * The two cases have to stay apart. A token we know with nothing behind it — a
 * customer with no company on file — is an empty string, and the sentence
 * closes over the gap. A token we do not know is left as written, so a typo
 * stays visible. Collapsing both into `undefined` sent the literal
 * "{{contact.company}}" to anyone whose company we didn't have.
 */
function tokenValue(token: string, ctx: TemplateFillContext): string | null {
  switch (token) {
    case "contact.name": return ctx.contactName ?? "";
    case "contact.first_name": return firstName(ctx.contactName);
    case "contact.company": return ctx.contactCompany ?? "";
    case "contact.phone": return ctx.contactPhone ?? "";
    case "contact.email": return ctx.contactEmail ?? "";
    case "agent.name": return ctx.agentName ?? "";
    case "agent.first_name": return firstName(ctx.agentName);
    case "channel.name": return ctx.channelName ?? "";
    default: return null;
  }
}

/**
 * Resolve one saved default into the text that goes in the box.
 *
 * A default is free text with `{{token}}` placeholders in it, so "Hi from
 * {{agent.name}}" and plain "Order update" and a bare "{{contact.name}}" are
 * all the same kind of thing and there is no type to choose in the UI.
 *
 * An unknown token is left exactly as written rather than blanked. If somebody
 * types `{{contact.nmae}}` the mistake stays visible in the box, where they can
 * see and fix it — silently emptying it would send a half-finished sentence to
 * a customer with nothing to show what went wrong.
 */
export function resolveTemplateDefault(pattern: string, ctx: TemplateFillContext): string {
  return pattern.replace(/\{\{\s*([a-z_.]+)\s*\}\}/gi, (whole, token: string) => {
    const value = tokenValue(token.trim().toLowerCase(), ctx);
    // `null` means we have never heard of this token, so it is left as written.
    // An empty string means we know it and have nothing — which resolves to
    // nothing, not to the word "undefined" and not to the raw token.
    return value === null ? whole : value;
  }).trim();
}

/**
 * The starting values for a template's fill form.
 *
 * Always `variableCount` long, so the form has a box per variable whether or
 * not a default was saved for it. Nothing here is final: these are what the
 * agent sees before they type, and they can change any of them.
 */
export function templateDefaults(
  template: { variableCount: number; variableDefaults?: string[] },
  ctx: TemplateFillContext,
): string[] {
  return Array.from({ length: template.variableCount }, (_, i) => {
    const pattern = template.variableDefaults?.[i];
    return pattern ? resolveTemplateDefault(pattern, ctx) : "";
  });
}

/**
 * Which variable the agent's typed message fills when the composer sends the
 * starred template by itself (a closed WhatsApp window).
 *
 * The one variable with no saved default. "Hi {{1}}, {{2}} here from Swiftee"
 * with {{2}} defaulting to the agent's name is exactly one box short of
 * complete, and that box is the message. A one-variable template keeps working
 * as it always has, default or not: its only variable is the message.
 *
 * `null` when the template can't be sent this way: no variables (nowhere to
 * put the message), or several left without a default (they'd go out blank).
 */
export function autoTemplateSlot(template: { variableCount: number; variableDefaults?: string[] }): number | null {
  if (template.variableCount === 1) return 0;
  const open: number[] = [];
  for (let i = 0; i < template.variableCount; i++) {
    if (!template.variableDefaults?.[i]?.trim()) open.push(i);
  }
  return open.length === 1 ? open[0]! : null;
}

/**
 * The parameters for that automatic send: every saved default filled in for
 * this conversation, and the agent's message in the open slot. `null` when the
 * template can't be sent this way (see `autoTemplateSlot`).
 */
export function autoTemplateParams(
  template: { variableCount: number; variableDefaults?: string[] },
  message: string,
  ctx: TemplateFillContext,
): string[] | null {
  const slot = autoTemplateSlot(template);
  if (slot === null) return null;
  const params = templateDefaults(template, ctx);
  params[slot] = message;
  return params;
}

/** The body as the customer will read it, for the composer's preview. */
export function fillTemplatePreview(body: string, params: string[]): string {
  return body.replace(/\{\{\s*(\d+)\s*\}\}/g, (whole, n: string) => params[Number(n) - 1] ?? whole);
}

/**
 * The templates a given WhatsApp account can actually send.
 *
 * Filtered by WABA rather than by channel on purpose: two numbers under one
 * account share every template, so filtering by inbox would hide templates the
 * selected number is perfectly entitled to send.
 *
 * Unclaimed templates (no `wabaId`) are not offered to a number with an
 * account. Meta has never heard of them under that account, so every send would
 * fail; Settings › Templates lists them as "Not linked to an account", to be
 * submitted to one or deleted. A sync still claims one the moment Meta says an
 * account holds a template by that name.
 *
 * A channel with no account configured gets everything, as before: there is no
 * account to filter by, and narrowing to nothing helps nobody.
 */
export function templatesForWaba<T extends { wabaId?: string }>(
  templates: T[],
  wabaId: string | undefined | null,
): T[] {
  // No account to filter by (an unconfigured channel, a non-WhatsApp one):
  // narrowing to "unclaimed only" would empty the list for no good reason.
  if (!wabaId) return templates;
  return templates.filter((t) => t.wabaId === wabaId);
}

/**
 * Star a template as its WhatsApp account's default, or unstar it.
 *
 * The template is named in both directions on purpose. Unstarring used to send
 * `null` — "no default" with nothing saying whose — and the only thing the
 * server could do with that was clear every account's. So a workspace with two
 * accounts, each with its own starred template, lost both the moment anybody
 * unstarred either one.
 *
 * Both shapes are still accepted, and that is not tidiness — it is the fix for
 * a bug this change caused. Tightening `templateId` to a bare string and
 * requiring `isDefault` rejected the old payload outright, so every browser tab
 * opened before the deploy had all of its stars fail validation. Combined with
 * a button that had no error handler, the whole screen simply stopped
 * responding, with nothing anywhere saying why.
 *
 * A deployed API is talked to by whatever code a person happens to have loaded,
 * not only by the code sitting next to it in the repo.
 */
export const setDefaultTemplateInputSchema = z.object({
  /** Null only from a pre-change client, which sent it to mean "unstar". */
  templateId: z.string().nullable(),
  /** Absent from a pre-change client, where sending an id always meant "star". */
  isDefault: z.boolean().optional(),
});
export type SetDefaultTemplateInput = z.infer<typeof setDefaultTemplateInputSchema>;

export const createTemplateInputSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9_]+$/, "Use lower-case letters, numbers and underscores only"),
  category: templateCategorySchema.default("utility"),
  language: z.string().min(2).default("en"),
  body: z.string().min(1).max(1024),
  variableDefaults: z.array(z.string().max(500)).max(20).default([]),
  /** The WhatsApp account to submit it to Meta on, for approval. Without one it
   *  is kept here only, linked to no account — and no number can send it. */
  wabaId: z.string().min(1).optional(),
});
export type CreateTemplateInput = z.infer<typeof createTemplateInputSchema>;

/** Submit a template that's linked to no account to Meta, on this account. */
export const submitTemplateInputSchema = z.object({ wabaId: z.string().min(1) });
export type SubmitTemplateInput = z.infer<typeof submitTemplateInputSchema>;

export const updateTemplateInputSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9_]+$/, "Use lower-case letters, numbers and underscores only")
    .optional(),
  category: templateCategorySchema.optional(),
  language: z.string().min(2).optional(),
  body: z.string().min(1).optional(),
  approvalStatus: templateApprovalSchema.optional(),
  /** Editable even on a template synced from Meta: the name and body are
   *  Meta's, but what we pre-fill its variables with is ours. */
  variableDefaults: z.array(z.string().max(500)).max(20).optional(),
});
export type UpdateTemplateInput = z.infer<typeof updateTemplateInputSchema>;

/* ------------------------------------------------------------------ */
/* WhatsApp management: business profile + broadcasts                   */
/* ------------------------------------------------------------------ */

/**
 * A connected WhatsApp number, as the management screens see it. Drawn from an
 * inbox's public channel config — never its secrets — so the picker can label a
 * number and tell whether it's live before a management call is made.
 */
export const whatsAppNumberSchema = z.object({
  inboxId: z.string(),
  name: z.string(),
  /** The human phone number ("+44 20 …"), when saved. */
  displayNumber: z.string().optional(),
  /** Meta's phone-number id (the API handle), when saved. */
  phoneNumberId: z.string().optional(),
  /** The WhatsApp Business Account id, when saved. */
  wabaId: z.string().optional(),
  /** Whether the number has the credentials needed to make live API calls. */
  connected: z.boolean(),
});
export type WhatsAppNumber = z.infer<typeof whatsAppNumberSchema>;

/* ---- WhatsApp Cloud API phone-number registration ---- */

/**
 * What Meta says about a number, reduced to the five things an admin can act on.
 *
 * This is deliberately not `Inbox.connected`, which only asks whether we have
 * credentials saved. A number can have a perfectly good Phone number ID and
 * token and still be unusable, because adding a number in WhatsApp Manager is
 * only half of it: until somebody calls `POST /{phone-number-id}/register` the
 * number sits at PENDING and Meta tells you to "register this phone number
 * using the registration API". That is the gap this status closes.
 */
export const whatsAppNumberStatusSchema = z.enum([
  /** Meta reports CONNECTED — the number can send and receive. */
  "connected",
  /** Meta has the number but it is not registered on the Cloud API yet. */
  "registration_required",
  /** The stored token was rejected, or lacks the permissions this needs. */
  "auth_failed",
  /** Nothing to ask Meta with: no Phone number ID / token, or the id is wrong. */
  "configuration_error",
  /** Meta answered, but with something we cannot fix from here. */
  "meta_error",
]);
export type WhatsAppNumberStatus = z.infer<typeof whatsAppNumberStatusSchema>;

/** What the channel editor shows for each status, and whether it offers the
 *  Register button. Shared so the web and native apps cannot word it
 *  differently. */
export const WHATSAPP_STATUS_LABEL: Record<WhatsAppNumberStatus, string> = {
  connected: "Connected",
  registration_required: "Registration required",
  auth_failed: "Authentication failed",
  configuration_error: "Configuration error",
  meta_error: "Meta API error",
};

/** Only one status is fixable by registering, and offering the button for any
 *  of the others would be a dead end (a banned number does not want a PIN). */
export function whatsAppCanRegister(status: WhatsAppNumberStatus): boolean {
  return status === "registration_required";
}

export const whatsAppNumberStateSchema = z.object({
  status: whatsAppNumberStatusSchema,
  /** One sentence an admin can act on. Never carries a token or a PIN. */
  detail: z.string(),
  /** Meta's own status string (CONNECTED, PENDING, FLAGGED, …) when it answered,
   *  so a support conversation can quote the real thing rather than our word
   *  for it. */
  metaStatus: z.string().optional(),
  /** Meta's `code_verification_status` (VERIFIED / NOT_VERIFIED / EXPIRED) —
   *  the difference between "register it" and "verify it in WhatsApp Manager
   *  first", which is otherwise a very confusing dead end. */
  codeVerificationStatus: z.string().optional(),
  displayNumber: z.string().optional(),
  verifiedName: z.string().optional(),
  qualityRating: z.string().optional(),
});
export type WhatsAppNumberState = z.infer<typeof whatsAppNumberStateSchema>;

/**
 * The two-step verification PIN, on its way to `POST /{id}/register`.
 *
 * Six digits exactly — Meta rejects anything else, and catching it here means
 * a typo costs a form error instead of one of the six guesses Meta allows
 * before it locks the number out for a day.
 *
 * This value is used for one request and discarded. It is never written to
 * channelConfig, never logged, and never returned in a response.
 */
export const whatsAppRegisterInputSchema = z.object({
  pin: z
    .string()
    .regex(/^[0-9]{6}$/, "The two-step verification PIN is exactly 6 digits."),
});
export type WhatsAppRegisterInput = z.infer<typeof whatsAppRegisterInputSchema>;

/** The outcome of a registration attempt: what Meta says now, plus whether this
 *  attempt is what changed it (an already-registered number reports
 *  `alreadyRegistered`, which is a success, not a failure). */
export const whatsAppRegisterResultSchema = z.object({
  ok: z.boolean(),
  alreadyRegistered: z.boolean(),
  state: whatsAppNumberStateSchema,
});
export type WhatsAppRegisterResult = z.infer<typeof whatsAppRegisterResultSchema>;

/**
 * Meta's fixed set of business categories (the `vertical` on a number's public
 * profile). Kept in Meta's own SCREAMING_CASE so the values round-trip to the
 * Graph API untouched; the UI supplies the friendly labels.
 */
export const WHATSAPP_VERTICALS = [
  "UNDEFINED",
  "OTHER",
  "AUTO",
  "BEAUTY",
  "APPAREL",
  "EDU",
  "ENTERTAIN",
  "EVENT_PLAN",
  "FINANCE",
  "GROCERY",
  "GOVT",
  "HOTEL",
  "HEALTH",
  "NONPROFIT",
  "PROF_SERVICES",
  "RETAIL",
  "TRAVEL",
  "RESTAURANT",
  "NOT_A_BIZ",
] as const;
export const whatsAppVerticalSchema = z.enum(WHATSAPP_VERTICALS);
export type WhatsAppVertical = z.infer<typeof whatsAppVerticalSchema>;

/** Opening hours are kept in NestConnect (WhatsApp's profile has no hours
 *  field); one entry per weekday, "HH:MM" 24-hour, or marked closed. */
export const OPENING_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type OpeningDay = (typeof OPENING_DAYS)[number];
export const openingHoursDaySchema = z.object({
  closed: z.boolean().default(false),
  open: z.string().regex(/^\d{2}:\d{2}$/).default("09:00"),
  close: z.string().regex(/^\d{2}:\d{2}$/).default("17:00"),
});
export type OpeningHoursDay = z.infer<typeof openingHoursDaySchema>;
export const openingHoursSchema = z.object({
  mon: openingHoursDaySchema,
  tue: openingHoursDaySchema,
  wed: openingHoursDaySchema,
  thu: openingHoursDaySchema,
  fri: openingHoursDaySchema,
  sat: openingHoursDaySchema,
  sun: openingHoursDaySchema,
});
export type OpeningHours = z.infer<typeof openingHoursSchema>;

/**
 * A WhatsApp number's public business profile — the "about" line, description,
 * address, contact details and category a customer sees on the business card.
 * Read from / written to Meta's `whatsapp_business_profile` node. The photo is
 * read-only here (Meta requires a separate resumable upload to change it).
 */
export const whatsAppBusinessProfileSchema = z.object({
  about: z.string().optional(),
  address: z.string().optional(),
  description: z.string().optional(),
  email: z.string().optional(),
  vertical: whatsAppVerticalSchema.optional(),
  websites: z.array(z.string()).optional(),
  /** Current profile photo (from Meta's `profile_picture_url`; set via upload). */
  profilePictureUrl: z.string().optional(),
  /** Kept in NestConnect, not sent to WhatsApp. */
  openingHours: openingHoursSchema.optional(),
});
export type WhatsAppBusinessProfile = z.infer<typeof whatsAppBusinessProfileSchema>;

/** The editable fields we send back to Meta (photo excluded — resumable upload). */
export const updateWhatsAppBusinessProfileInputSchema = z.object({
  about: z.string().max(139, "Keep the “about” line under 139 characters").optional(),
  address: z.string().max(256, "Keep the address under 256 characters").optional(),
  description: z.string().max(512, "Keep the description under 512 characters").optional(),
  email: z.string().max(128, "Keep the email under 128 characters").optional(),
  vertical: whatsAppVerticalSchema.optional(),
  websites: z.array(z.string()).max(2, "At most two websites").optional(),
  /** Stored in NestConnect only (WhatsApp has no hours field). */
  openingHours: openingHoursSchema.optional(),
});
export type UpdateWhatsAppBusinessProfileInput = z.infer<
  typeof updateWhatsAppBusinessProfileInputSchema
>;

/**
 * Where a number stands on WhatsApp's Official Business Account — the
 * verified badge next to the business name. Read from Meta's
 * `official_business_account` field on the phone number.
 *
 * `status` is Meta's `oba_status` as given (NOT_STARTED, PENDING, APPROVED,
 * REJECTED, CANCELLED…): kept as a string so a value Meta adds later still
 * shows rather than failing the whole read.
 */
export const whatsAppObaStatusSchema = z.object({
  status: z.string(),
  /** Meta's own explanation, when it gives one (e.g. why it was rejected). */
  message: z.string().optional(),
  checkedAt: z.string(),
});
export type WhatsAppObaStatus = z.infer<typeof whatsAppObaStatusSchema>;

/** Apply for the badge: what Meta asks for, `POST /{phone-number-id}/official_business_account`. */
export const requestWhatsAppObaInputSchema = z.object({
  /** The business's own website (https). */
  businessWebsiteUrl: z.string().trim().url("Enter the full website address, starting https://").max(500),
  /** Where the business mainly operates, e.g. "United Kingdom". */
  primaryCountryOfOperation: z.string().trim().min(2, "Say which country you mainly operate in").max(80),
  /** The language customers are mostly served in, e.g. "English". */
  primaryLanguage: z.string().trim().min(2, "Say which language you mainly use").max(60),
  /** If this business belongs to a larger brand or group. */
  parentBusinessOrBrand: z.string().trim().max(120).optional(),
  /** Press or other independent coverage of the business — Meta weighs these most. */
  supportingLinks: z.array(z.string().trim().url("Each supporting link must be a full web address")).max(5, "At most five supporting links").default([]),
  /** Anything else that shows the business is notable. */
  additionalSupportingInformation: z.string().trim().max(1000).optional(),
});
export type RequestWhatsAppObaInput = z.infer<typeof requestWhatsAppObaInputSchema>;

/**
 * Finishing Meta's sign-up for a number that stays on the WhatsApp Business
 * app (coexistence): the code the SDK gave the browser, and the account and
 * number Meta said were onboarded.
 */
export const connectCoexistenceInputSchema = z.object({
  code: z.string().min(1).max(2000),
  wabaId: z.string().regex(/^\d{5,30}$/, "That isn't a WhatsApp Business Account id"),
  phoneNumberId: z.string().regex(/^\d{5,30}$/, "That isn't a phone number id"),
  /** How Meta's sign-up said it finished. `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`
   *  is a number that stayed on the phone app; a plain `FINISH` is an ordinary
   *  API number, which Meta can hand back even from the Business-app card. */
  finishEvent: z.string().max(80).optional(),
});
export type ConnectCoexistenceInput = z.infer<typeof connectCoexistenceInputSchema>;

/** What the web needs to open Meta's sign-up (all public). */
/** The session event Meta sends when a WhatsApp Business app number was linked. */
export const BUSINESS_APP_FINISH_EVENT = "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING";

export interface CoexistenceSetup {
  /** The Meta app's id and its Embedded Signup configuration — both set in Settings › Setup. */
  appId: string;
  configId: string;
  graphVersion: string;
  /** Both are set, so the button can work. */
  ready: boolean;
  /** Local/test mode: the SDK is skipped and a fake number connects. */
  mock: boolean;
}

/** A single recipient of a broadcast — a phone number, optionally named. */
export const broadcastRecipientSchema = z.object({
  phone: z.string().min(1),
  name: z.string().optional(),
  /** Per-recipient values for the template's {{1}}, {{2}} … variables. */
  params: z.array(z.string()).optional(),
});
export type BroadcastRecipient = z.infer<typeof broadcastRecipientSchema>;

/**
 * Send an approved template to many recipients at once. WhatsApp has no true
 * one-to-many primitive, so a broadcast is a loop of individual template sends
 * (the compliant way to reach many people) — each recipient gets their own
 * 1:1 message. Capped to keep a single request bounded.
 */
export const sendBroadcastInputSchema = z.object({
  /** The WhatsApp number (inbox) the broadcast is sent from. */
  inboxId: z.string(),
  /** The approved template to send (must be APPROVED at Meta). */
  templateId: z.string(),
  /** Shared variable values, used for any recipient without their own `params`. */
  params: z.array(z.string()).optional(),
  recipients: z.array(broadcastRecipientSchema).min(1).max(500),
});
export type SendBroadcastInput = z.infer<typeof sendBroadcastInputSchema>;

/** The outcome of a broadcast run: per-recipient success/failure + totals. */
export const broadcastResultSchema = z.object({
  total: z.number().int().nonnegative(),
  sent: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  results: z.array(
    z.object({
      phone: z.string(),
      ok: z.boolean(),
      error: z.string().optional(),
    }),
  ),
});
export type BroadcastResult = z.infer<typeof broadcastResultSchema>;

/**
 * Moving a team from working in Gmail to working in Nest, in one step: the
 * email conversations Nest holds are deleted, and every Gmail thread with an
 * unread message from the last EMAIL_CUTOVER_DAYS days is brought in, history
 * and all, as an open conversation.
 */
export const EMAIL_CUTOVER_DAYS = 90;
/** What the admin types to confirm the deletion. */
export const EMAIL_CUTOVER_CONFIRM = "DELETE";

export const emailCutoverPreviewSchema = z.object({
  /** Email conversations that would be deleted. */
  emailConversations: z.number().int().nonnegative(),
  mailboxes: z.array(
    z.object({
      inboxId: z.string(),
      name: z.string(),
      address: z.string(),
      /** Gmail threads with an unread message in the window. */
      unreadThreads: z.number().int().nonnegative(),
      /** Set when the mailbox couldn't be read (e.g. its Google access lapsed). */
      error: z.string().optional(),
    }),
  ),
  days: z.number().int().positive(),
});
export type EmailCutoverPreview = z.infer<typeof emailCutoverPreviewSchema>;

export const emailCutoverJobSchema = z.object({
  status: z.enum(["idle", "running", "done", "failed"]),
  /** What it's doing now, in words. */
  step: z.string().optional(),
  deleted: z.number().int().nonnegative(),
  /** Threads found to import, across mailboxes. */
  total: z.number().int().nonnegative(),
  imported: z.number().int().nonnegative(),
  /** Already in Nest (arrived since the clear-out) or from a blocked sender. */
  skipped: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  error: z.string().optional(),
});
export type EmailCutoverJob = z.infer<typeof emailCutoverJobSchema>;

export const sendMessageInputSchema = z
  .object({
    body: z.string().default(""),
    internal: z.boolean().default(false),
    /** Ids of previously-uploaded attachments to send with this message. */
    attachmentIds: z.array(z.string()).optional(),
    /**
     * Send an approved WhatsApp template instead of free text — required to
     * re-open a conversation once its 24-hour window has closed. `params` fill
     * the template's {{1}}, {{2}} … variables in order.
     */
    template: z
      .object({ id: z.string(), params: z.array(z.string()).default([]) })
      .optional(),
    /** Quote/reply to an earlier message in the thread (by its id). */
    quotedMsgId: z.string().optional(),
    /** Reply on a specific channel the contact is reachable on (cross-channel
     *  thread). Defaults to the conversation's own channel when omitted. */
    channel: channelTypeSchema.optional(),
    /** Rich HTML body for an email reply (sanitized server-side before send). */
    bodyHtml: z.string().optional(),
    /** Subject line for an email send (email channel only). Sets the thread's
     *  subject; a reply carries "Re:" automatically, a fresh email does not. */
    subject: z.string().max(255).optional(),
    /** Additional email recipients (email channel only). */
    cc: z.array(z.string()).optional(),
    bcc: z.array(z.string()).optional(),
    /** Forward this email on to other people (email channel only). When set, the
     *  send goes to these addresses as a fresh "Fwd:" email — a new thread, not a
     *  reply to the customer — but it's still logged in the current conversation so
     *  the timeline shows the forward (Front-style). The first address is the To;
     *  any others ride as Cc. */
    forwardTo: z.array(z.string()).optional(),
    /** With `forwardTo`: the message being forwarded. Its attachments go along
     *  (as copies, so the original keeps its own). */
    forwardOfId: z.string().optional(),
  })
  // Must carry something — text, an attachment, a template, or a forward (which
  // carries the original email it's passing on).
  .refine(
    (v) =>
      v.body.trim().length > 0 ||
      (v.attachmentIds?.length ?? 0) > 0 ||
      !!v.template ||
      (v.forwardTo?.length ?? 0) > 0,
    { message: "Message needs text, an attachment, or a template", path: ["body"] },
  );
export type SendMessageInput = z.infer<typeof sendMessageInputSchema>;

/** React to a message with an emoji (empty string removes the agent's reaction). */
export const reactionInputSchema = z.object({
  emoji: z.string().max(16),
});
export type ReactionInput = z.infer<typeof reactionInputSchema>;

/** WhatsApp's own limit on how many chats one message can be forwarded to at
 *  once. Mirrored here so an agent isn't offered a bulk-send WhatsApp would
 *  read as spam — the number is theirs, and the reason for it is theirs too. */
export const FORWARD_MAX_TARGETS = 5;

/** Pass a message on to other customers' WhatsApp chats. Targets are customers,
 *  not addresses: a WhatsApp forward lands in a chat, and the thread it lands in
 *  is opened (or reused) as part of the send. */
export const forwardMessageInputSchema = z.object({
  contactIds: z.array(z.string()).min(1).max(FORWARD_MAX_TARGETS),
});
export type ForwardMessageInput = z.infer<typeof forwardMessageInputSchema>;

/** What happened for one forward target. Reported per target rather than as a
 *  single pass/fail, because the common failure — a closed 24-hour window — is
 *  per chat, and an agent needs to know *which* ones didn't go. */
export interface ForwardResult {
  contactId: string;
  /** Display name, so the caller can report the outcome without a second lookup. */
  name: string;
  ok: boolean;
  /** The thread it landed in (present on success) — lets the UI offer to open it. */
  conversationId?: string;
  /** Why it didn't go, in words an agent can act on. */
  error?: string;
}

/** Reach a customer on a channel — opens their thread there, or starts one. */
export const reachInputSchema = z.object({
  channel: z.enum(["whatsapp", "email", "sms"]),
  /** Which connected inbox to start from — needed when several of the same
   *  channel are connected. Falls back to the first of that channel when absent. */
  inboxId: z.string().optional(),
});
export type ReachInput = z.infer<typeof reachInputSchema>;

export const assignConversationInputSchema = z.object({
  assigneeUserId: z.string().nullable().optional(),
  assignedTeamId: z.string().nullable().optional(),
});
export type AssignConversationInput = z.infer<typeof assignConversationInputSchema>;

/** Change a conversation's status — e.g. close (resolve) or reopen. */
export const updateStatusInputSchema = z.object({
  status: conversationStatusSchema,
});
export type UpdateStatusInput = z.infer<typeof updateStatusInputSchema>;

/** Set a conversation's priority. */
export const updatePriorityInputSchema = z.object({
  priority: prioritySchema,
});
export type UpdatePriorityInput = z.infer<typeof updatePriorityInputSchema>;

/** Snooze a conversation until a given time (ISO); it wakes back into the queue then. */
export const snoozeInputSchema = z.object({
  until: z.string().datetime(),
});
export type SnoozeInput = z.infer<typeof snoozeInputSchema>;

export const createInboxInputSchema = z.object({
  type: channelTypeSchema,
  name: z.string().min(1),
  handle: z.string().min(1),
  teamIds: z.array(z.string()).min(1),
  routingStrategy: routingStrategySchema.default("manual"),
  /** Provider integration credentials (phone number id, tokens, …). Backend-only. */
  channelConfig: z.record(z.string()).optional(),
});
export type CreateInboxInput = z.infer<typeof createInboxInputSchema>;

/** Edit an existing channel: rename, re-route, change strategy, or update creds. */
export const updateInboxInputSchema = z.object({
  name: z.string().min(1).optional(),
  teamIds: z.array(z.string()).min(1).optional(),
  routingStrategy: routingStrategySchema.optional(),
  channelConfig: z.record(z.string()).optional(),
  /** Tag every customer who starts a conversation here. "" turns it off. */
  contactTag: z.string().trim().max(40).optional(),
  /** Label every conversation that starts here. null turns it off. */
  conversationLabelId: z.string().nullable().optional(),
});
export type UpdateInboxInput = z.infer<typeof updateInboxInputSchema>;

/** Body for POST /inboxes/:id/default — `false` clears the channel's default. */
export const setDefaultInboxInputSchema = z.object({ isDefault: z.boolean() });
export type SetDefaultInboxInput = z.infer<typeof setDefaultInboxInputSchema>;

/** A hex colour (#RGB or #RRGGBB) — a label swatch, a widget's brand colour. */
const hexColor = z.string().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "Must be a hex colour like #0FA47A");

/* ------------------------------------------------------------------ */
/* NestChat — our own live chat channel                                */
/* ------------------------------------------------------------------ */

/**
 * How a NestChat widget looks and what it says. Every string a visitor can read
 * is here rather than in the widget's source, because the business — not us —
 * decides how it greets its own customers.
 *
 * Colours are stored as authored (a `#rrggbb`, validated below) and applied as
 * CSS custom properties, so the widget never interpolates untrusted text into a
 * style rule.
 */
export const nestchatAppearanceSchema = z.object({
  /** Brand colour: the header, the launcher, and the visitor's own bubbles. */
  accent: hexColor.default("#2563eb"),
  /** Text drawn on top of `accent` — authored, because a light brand colour
   *  needs dark text and we can't guess which without a contrast calculation
   *  the business may disagree with. */
  accentText: hexColor.default("#ffffff"),
  /**
   * Run the header as a gradient from `accent` to `accentTo`.
   *
   * Off by default, and only the header: the launcher, the send button and the
   * visitor's own bubbles stay flat. A gradient is a surface — it wants room to
   * travel and reads as depth across a header-sized block. On a 26px button it
   * is two colours fighting in a space too small to tell them apart.
   */
  headerGradient: z.boolean().default(false),
  /** The far end of that gradient. Ignored while `headerGradient` is off, so it
   *  keeps a sensible value to switch on rather than turning the header black. */
  accentTo: hexColor.default("#7c3aed"),
  /** "auto" follows the visitor's own OS preference. */
  theme: z.enum(["light", "dark", "auto"]).default("light"),
  /**
   * The quiet line above the title — "Hello Marta." to the title's "How can we
   * help?".
   *
   * Two lines rather than one because they do different jobs: this one is a
   * greeting and takes the visitor's name, the title is the question. Dimmed,
   * so the eye lands on the question. Blank drops the line entirely.
   */
  headline: z.string().max(60).default("Hello {name} 👋"),
  title: z.string().max(60).default("How can we help?"),
  subtitle: z.string().max(120).default("We usually reply in a few minutes"),
  /** The first thing in the empty thread — shown before the visitor writes. */
  greeting: z.string().max(300).default("Hi 👋 How can we help today?"),
  placeholder: z.string().max(60).default("Write a message…"),
  /** The floating bubble's tooltip, for the script embed. */
  launcherLabel: z.string().max(40).default("Chat with us"),
  /** Shown in place of the subtitle when nobody who answers this channel is
   *  available (switched off, or outside their working hours). */
  awayMessage: z
    .string()
    .max(200)
    .default("We're currently offline. We'll get back to you as soon as possible."),
  /**
   * Said to the visitor when an agent closes the chat.
   *
   * Written by the business because closing means different things to
   * different ones — a resolved ticket, an ended shift, a booking confirmed —
   * and the sentence that fits is theirs. Blank says nothing and still ends the
   * session: some businesses would rather the chat simply stop than announce
   * that it has.
   */
  closedMessage: z
    .string()
    .max(300)
    .default("This chat has been closed. Thanks for getting in touch!"),
  /** The way back in, once a chat has been closed. */
  newChatLabel: z.string().max(40).default("Start a new chat"),
  /** Ask for an email before the first message, so a reply can reach someone
   *  who has closed the tab. */
  askEmail: z.boolean().default(true),
  askEmailLabel: z.string().max(80).default("Your email, so we can reply if you leave"),
  /**
   * Email a visitor the replies they haven't seen, a few minutes after they're
   * sent, when they left an email address. What the away message and the
   * email question both promise: somebody who closed the tab still hears back,
   * as they would from any other channel. Each reply is emailed once.
   */
  emailReplies: z.boolean().default(true),
  /** Ask for a phone number as well. Off by default — one field converts better
   *  than two, and most businesses only need one way back to the person. */
  askPhone: z.boolean().default(false),
  askPhoneLabel: z.string().max(80).default("Phone (optional)"),
  /** Show the faces of the team that answers this channel, the way a shop shows
   *  you who is behind the counter. */
  showTeam: z.boolean().default(true),
  showBranding: z.boolean().default(true),
  /**
   * The business's own logo, in the top-left of the header.
   *
   * A URL rather than an upload: every business embedding this already hosts a
   * logo on the site the widget is going on, and asking them to upload a second
   * copy is asking them to keep two in sync. Blank shows no logo, which is the
   * default — a widget with a broken image in the corner is worse than one
   * without a logo.
   *
   * https only. The widget is an iframe that can be embedded on a secure page,
   * and an http image there is blocked as mixed content — so it would simply
   * not appear, which is the most confusing possible outcome for a setting you
   * can see is filled in.
   */
  logoUrl: z
    .string()
    .max(500)
    .default("")
    .refine((v) => v === "" || /^https:\/\/\S+$/.test(v), "Must be an https:// address"),
  /**
   * A logo uploaded here rather than linked, which is what the settings pane
   * offers — most businesses would rather drop a file in than find a URL.
   *
   * The id of a stored attachment, not a URL. The bytes are served by the
   * channel's own public logo route, so the address is derived from the widget
   * key at read time: a logo whose URL was baked in at upload time would break
   * the day a key was rotated. Wins over `logoUrl` when both are set.
   */
  logoAttachmentId: z.string().max(64).default(""),
  /** Which corner the script embed's launcher sits in. */
  position: z.enum(["right", "left"]).default("right"),
});
export type NestChatAppearance = z.infer<typeof nestchatAppearanceSchema>;

/** The appearance every new NestChat channel starts with. */
/** The away message every channel was given before it changed — recognised so
 *  a channel that never chose it moves to the new default. */
export const LEGACY_AWAY_MESSAGE = "We're away right now — leave a message and we'll reply by email.";

export const DEFAULT_NESTCHAT_APPEARANCE: NestChatAppearance = nestchatAppearanceSchema.parse({});

/* ---- who we're talking to, and who should answer ---- */

/**
 * One field on the pre-chat form.
 *
 * Two booleans rather than one tri-state, because "we ask but you may skip" is
 * a real and common choice: an optional email converts better than a required
 * one, and a business that wants the address more than the conversation can say
 * so. `required` is meaningless while `enabled` is false, and the widget reads
 * it that way.
 */
export const nestchatFieldSchema = z.object({
  enabled: z.boolean(),
  required: z.boolean(),
});
export type NestChatField = z.infer<typeof nestchatFieldSchema>;

/**
 * What we ask before the conversation starts.
 *
 * Off by default: this is a gate in front of a chat widget, and adding one to
 * every existing channel because we shipped the feature would quietly cost
 * businesses conversations they were having yesterday.
 *
 * Asking *before* the first message rather than after it is the whole point.
 * The details are what let us find the customer we already know, and finding
 * them before the conversation exists means it is created against their record
 * — with their history, their owner and their name in the agent's queue —
 * rather than against `Visitor 4f2a1c` and merged afterwards.
 */
export const nestchatPreChatSchema = z.object({
  enabled: z.boolean().default(false),
  intro: z
    .string()
    .max(200)
    .default("Tell us who you are and we’ll get you to the right person."),
  nameLabel: z.string().max(60).default("Your name"),
  emailLabel: z.string().max(60).default("Email"),
  phoneLabel: z.string().max(60).default("Phone"),
  submitLabel: z.string().max(40).default("Start chat"),
  /** A way out when nothing on the form is required — so a visitor with a quick
   *  question isn't made to fill in a form to ask it. */
  skipLabel: z.string().max(40).default("Skip"),
  name: nestchatFieldSchema.default({ enabled: true, required: true }),
  email: nestchatFieldSchema.default({ enabled: true, required: true }),
  phone: nestchatFieldSchema.default({ enabled: false, required: false }),
});
export type NestChatPreChat = z.infer<typeof nestchatPreChatSchema>;
export const DEFAULT_NESTCHAT_PRECHAT: NestChatPreChat = nestchatPreChatSchema.parse({});

/* ---- the home screen ---- */

/**
 * The marks a home card can carry.
 *
 * Deliberately short. Every one of these is a channel a business actually
 * staffs; a picker with forty icons in it is a picker somebody has to shop in.
 */
export const NESTCHAT_CARD_ICONS = [
  "chat",
  "whatsapp",
  "email",
  "phone",
  "instagram",
  "facebook",
  "telegram",
  "link",
] as const;
export type NestChatCardIcon = (typeof NESTCHAT_CARD_ICONS)[number];

/**
 * One card on the widget's home screen — a way to reach the business that
 * isn't this chat.
 *
 * Plenty of businesses answer faster on WhatsApp than on a website widget, and
 * a visitor who would rather email should not have to hunt the footer for the
 * address. Offering those next to the chat costs a row and stops the widget
 * pretending it is the only door.
 */
export const nestchatHomeCardSchema = z.object({
  id: z.string().min(1).max(40),
  label: z.string().min(1).max(60),
  /** The quiet second line — "Usually answers within the hour". */
  sublabel: z.string().max(80).default(""),
  /**
   * Which mark to draw, from a fixed set.
   *
   * A key rather than an emoji, unlike the routing pills. An emoji is drawn by
   * the visitor's own operating system: 💬 is a different object on Windows,
   * Android and a Mac, and the row of them ends up in four styles at four
   * weights. These are drawn by us, so a WhatsApp card carries the WhatsApp
   * glyph everywhere and the set looks like one set.
   *
   * `.catch` rather than a bare enum: an unrecognised value degrades to no
   * icon, instead of failing the whole blob and taking the entire home screen
   * down with it.
   */
  icon: z.enum(NESTCHAT_CARD_ICONS).optional().catch(undefined),
  /**
   * Where it goes.
   *
   * Deliberately a three-scheme allowlist rather than a URL check. This string
   * is set by an admin and rendered as an `href` inside an iframe on a
   * customer's own website: `javascript:` there is script execution on our
   * origin, and `data:` is a page we would be hosting. Neither is a link, and
   * neither has any business in a "reach us on another channel" card.
   */
  href: z
    .string()
    .min(1)
    .max(500)
    .refine(
      (v) => /^(https:\/\/|mailto:|tel:)/i.test(v),
      "Must start with https://, mailto: or tel:",
    ),
});
export type NestChatHomeCard = z.infer<typeof nestchatHomeCardSchema>;

/** Enough for the channels a business actually staffs. */
export const NESTCHAT_MAX_HOME_CARDS = 6;

/**
 * The screen a visitor lands on before the conversation.
 *
 * Off by default, and that is a considered default rather than caution: it puts
 * a tap between somebody and the message box. A business that answers on one
 * channel doesn't need it; one that answers on four does.
 *
 * The chat card is not in `cards` because it is not a link — it is the widget's
 * own front door, always first and never removable. Its words are configurable;
 * its existence isn't.
 */
export const nestchatHomeSchema = z.object({
  enabled: z.boolean().default(false),
  chatLabel: z.string().max(60).default("Send us a message"),
  chatSublabel: z.string().max(80).default("We usually reply in a few minutes"),
  cards: z.array(nestchatHomeCardSchema).max(NESTCHAT_MAX_HOME_CARDS).default([]),
});
export type NestChatHome = z.infer<typeof nestchatHomeSchema>;
export const DEFAULT_NESTCHAT_HOME: NestChatHome = nestchatHomeSchema.parse({});

/**
 * What the website chat does when nobody who answers it is available —
 * switched off, or outside their hours.
 *
 * The header's line for it is `appearance.awayMessage`, and keeping the
 * promise is `appearance.emailReplies`; this is the rest. The automatic reply
 * is a real message in the conversation, sent once per stretch nobody is
 * there (again only after a person has replied since), so the agent who picks
 * the chat up sees what the visitor was told.
 *
 * `{name}` and `{email}` are the visitor's, when we have them.
 */
export const nestchatAwaySchema = z.object({
  autoReply: z.boolean().default(true),
  /** We already have their email. */
  withEmail: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .default("There's nobody online right now — we'll get back to you by email at {email}."),
  /** We don't: the reply asks for it, with an email box under it. */
  askEmail: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .default("There's nobody online right now. Leave your email and we'll get back to you there."),
  /** Once they've given it. */
  thanks: z.string().trim().min(1).max(200).default("Thanks — we'll reply to {email}."),
  /** The home screen's line under "Send us a message", in place of the usual one. */
  homeLine: z.string().max(80).default("We're away — we'll reply by email"),
});
export type NestChatAway = z.infer<typeof nestchatAwaySchema>;
export const DEFAULT_NESTCHAT_AWAY: NestChatAway = nestchatAwaySchema.parse({});

/** Fill `{name}` and `{email}`; a blank one takes the space before it with it. */
export function fillVisitorText(text: string, v: { name?: string | null; email?: string | null }): string {
  return text
    .replace(/\s*\{name\}/g, (m) => (v.name ? m.replace("{name}", v.name) : ""))
    .replace(/\s*\{email\}/g, (m) => (v.email ? m.replace("{email}", v.email) : ""))
    .trim();
}

/**
 * How many past conversations a visitor is offered.
 *
 * A cap rather than a page, because this is a person's own history with one
 * business: somebody with forty threads wants the recent ones, and a "load
 * more" at the bottom of their own chat list is a feature for nobody. It also
 * bounds the work — each row's preview is the last message the visitor is
 * allowed to see, which is a read per thread.
 */
export const NESTCHAT_MAX_PAST_CONVERSATIONS = 20;

/**
 * One of the visitor's own earlier conversations, as a card on the home screen.
 *
 * Deliberately not a `Conversation`. That carries assignment, labels, SLA,
 * priority and the internal notes' thread — none of which is theirs to see, and
 * all of which would arrive by default if this reused the agents' shape. What is
 * here is what a chat list row needs: what was last said, by whom, when, and
 * whether the thread is still open.
 */
export const nestchatPastConversationSchema = z.object({
  id: z.string(),
  /** Closed threads are readable and not writable; a new message starts a new
   *  conversation rather than reopening somebody's resolved ticket. */
  closed: z.boolean(),
  /** The last thing said that the visitor may see — never an internal note. */
  preview: z.string().default(""),
  /** Who said it, so the row can read "You: …". */
  from: z.enum(["visitor", "agent"]).optional(),
  /** Whose reply it was, for the face on the card. */
  authorName: z.string().optional(),
  at: z.string(),
});
export type NestChatPastConversation = z.infer<typeof nestchatPastConversationSchema>;

export const nestchatConversationsSchema = z.object({
  conversations: z.array(nestchatPastConversationSchema),
});
export type NestChatConversations = z.infer<typeof nestchatConversationsSchema>;

/* ---- the header's fill ---- */

/** A validated `#rgb`/`#rrggbb` as its three channels. */
function rgbOf(hex: string): [number, number, number] | undefined {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = Number.parseInt(full, 16);
  if (!Number.isFinite(n) || full.length !== 6) return undefined;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const hexOf = (c: number[]): string => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;

/** One of the business's colours at partial strength — a pool of light without
 *  a second setting to author. */
function withAlpha(hex: string, alpha: number): string {
  const c = rgbOf(hex);
  return c ? `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${alpha})` : hex;
}

/** Toward black (negative) or white (positive), for depth in the header. */
function shade(hex: string, amount: number): string {
  const c = rgbOf(hex);
  if (!c) return hex;
  const to = amount < 0 ? 0 : 255;
  const t = Math.abs(amount);
  return hexOf(c.map((v) => Math.round(v + (to - v) * t)));
}

/** Between two of the business's colours, for the gradient's middle stop. */
function mix(a: string, b: string, t: number): string {
  const x = rgbOf(a);
  const y = rgbOf(b);
  if (!x || !y) return a;
  return hexOf(x.map((v, i) => Math.round(v + (y[i] - v) * t)));
}

/**
 * The CSS `background` for a widget header.
 *
 * Shared rather than written twice because the settings preview has to agree
 * with the widget about what the gradient toggle actually produces, and "close
 * enough" in a preview is a preview nobody trusts.
 *
 * A gradient here is three layers, not one ramp. A single
 * `linear-gradient(135deg, a, b)` moves along exactly one axis and reads as
 * flat colour that happens to change; two off-axis pools of light over a
 * three-stop diagonal give it somewhere to come from and somewhere to go. Both
 * pools are derived from the two colours the business already chose — nobody is
 * being asked to author a mesh.
 */
export function nestchatHeaderRing(a: {
  accent: string;
  accentText: string;
  headerGradient: boolean;
}): string {
  // A flat header can ring the presence dot in its own colour, which cuts the
  // dot out of the surface. A gradient has no single colour to cut out of, so
  // it takes a soft outline in the header's own text colour instead — right at
  // both ends of the ramp.
  return a.headerGradient ? withAlpha(a.accentText, 0.4) : a.accent;
}

export function nestchatHeaderBackground(a: {
  accent: string;
  accentTo: string;
  headerGradient: boolean;
}): string {
  if (!a.headerGradient) return a.accent;
  return [
    `radial-gradient(90% 80% at 82% 8%, ${withAlpha(a.accentTo, 0.95)} 0%, transparent 62%)`,
    // The depth anchor, and the reason it is at 58% rather than in the bottom
    // corner where it started: the home screen dissolves the last 74px of this
    // header into the panel, and a dark blob sitting inside that ramp gives the
    // fade something to travel across. Contrast is what makes a dissolve
    // visible. Lifted clear of it, the bottom of the header is an even, light
    // field and the fade has almost nothing left to give away — which is how
    // the gradients this is modelled on finish.
    `radial-gradient(80% 78% at 2% 58%, ${withAlpha(shade(a.accent, -0.42), 0.92)} 0%, transparent 62%)`,
    `linear-gradient(152deg, ${a.accent} 0%, ${mix(a.accent, a.accentTo, 0.5)} 52%, ${a.accentTo} 100%)`,
  ].join(", ");
}

/**
 * One thing a visitor can say they are here about, and the team that answers it.
 *
 * This is the widget's version of "press 1 for sales" — except that unlike a
 * phone menu it costs the visitor one tap and tells us something we would
 * otherwise have to read a paragraph to learn.
 */
export const nestchatRoutingOptionSchema = z.object({
  /**
   * Minted when the option is created and never reused.
   *
   * Its own id rather than the label, because the label is what a visitor's
   * signed token would then carry — and renaming "Sales" to "New business"
   * would strand everyone who picked it and hadn't written yet.
   */
  id: z.string().min(1).max(40),
  /**
   * What the visitor reads on the pill, and all they read.
   *
   * There is no second line by design. A pill is as wide as its own label and
   * wraps with its neighbours, which is what keeps a menu of eight to two or
   * three rows; a description would put a second line inside every one of them
   * and undo exactly that. If a label needs explaining, it is the label that
   * wants rewording.
   */
  label: z.string().min(1).max(60),
  /** An emoji for the pill. Deliberately not an icon key: this is drawn on
   *  somebody else's website, where our icon set doesn't exist. */
  icon: z.string().max(8).optional(),
  /**
   * The team that answers it.
   *
   * Constrained to the channel's own teams (`inbox.teamIds`), checked where it
   * is saved rather than here — the schema can't see the channel. That
   * constraint is not bureaucracy: the widget's header shows the faces of the
   * teams a channel routes to, so an option pointing somewhere else would
   * promise a visitor one team and hand them to another.
   */
  teamId: z.string().min(1),
});
export type NestChatRoutingOption = z.infer<typeof nestchatRoutingOptionSchema>;

/** Enough for a real menu, few enough to stay a row of chips rather than a form
 *  the visitor has to read. */
export const NESTCHAT_MAX_ROUTING_OPTIONS = 8;

export const nestchatRoutingSchema = z.object({
  enabled: z.boolean().default(false),
  prompt: z.string().max(120).default("What can we help with?"),
  /** Whether a choice is needed before they can start. Optional is a real
   *  configuration: a menu can be a shortcut rather than a toll gate. */
  required: z.boolean().default(true),
  options: z
    .array(nestchatRoutingOptionSchema)
    .max(NESTCHAT_MAX_ROUTING_OPTIONS)
    .default([]),
});
export type NestChatRouting = z.infer<typeof nestchatRoutingSchema>;
export const DEFAULT_NESTCHAT_ROUTING: NestChatRouting = nestchatRoutingSchema.parse({});

/**
 * A routing option as a *visitor* may see it.
 *
 * The team id is absent, and that is the entire reason this type exists. The
 * widget runs on somebody else's website behind a public key; which internal
 * team answers "Billing" is org structure, and a visitor picking an option
 * doesn't need it to pick one.
 */
export const nestchatPublicOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  icon: z.string().optional(),
});
export type NestChatPublicOption = z.infer<typeof nestchatPublicOptionSchema>;

export const nestchatPublicRoutingSchema = z.object({
  prompt: z.string(),
  required: z.boolean(),
  options: z.array(nestchatPublicOptionSchema),
});
export type NestChatPublicRouting = z.infer<typeof nestchatPublicRoutingSchema>;

/**
 * Project a channel's routing menu down to what a visitor may see.
 *
 * Built field by field on purpose, like `toVisitorMessage`: this crosses into
 * an unauthenticated stranger's browser on somebody else's website, and
 * `teamId` — which every option carries — is internal org structure that tells
 * them nothing they need in order to press a button. A field added to the
 * option type later cannot leak by default.
 *
 * Options naming a team the channel no longer routes to are dropped rather than
 * shown: picking one would silently land the visitor in the default queue,
 * having been told they'd reached somebody in particular.
 *
 * Returns undefined for a menu that is off, or that has nothing left in it, so
 * the widget's question stays "is there a menu?" rather than "is there a menu
 * with anything in it?".
 */
export function toPublicRouting(
  routing: NestChatRouting,
  teamIds: string[],
): NestChatPublicRouting | undefined {
  if (!routing.enabled) return undefined;
  const options = routing.options
    .filter((o) => teamIds.includes(o.teamId))
    .map((o) => ({ id: o.id, label: o.label, icon: o.icon }));
  if (!options.length) return undefined;
  return { prompt: routing.prompt, required: routing.required, options };
}

/**
 * Put the visitor's name into a line the business wrote — "Hi {name} 👋".
 *
 * Shared rather than written twice because the settings preview has to agree
 * with the widget about what the admin is going to get, down to the spacing.
 *
 * A missing name leaves the sentence still readable: the token goes, and the
 * space it leaves behind goes with it, so "Hi {name} 👋" reads "Hi 👋" for a
 * visitor who never gave one rather than "Hi  👋". Only the first name is used
 * — a greeting that says "Hi Nathan Amos" reads like a letter from a bank.
 */
export function fillVisitorName(text: string, name?: string): string {
  const first = (name ?? "").trim().split(/\s+/)[0] ?? "";
  if (!first) return text.replace(/\s*\{name\}/g, "").replace(/\s{2,}/g, " ").trim();
  return text.replace(/\{name\}/g, first);
}

/**
 * One of the people who answers this chat, as a visitor may see them.
 *
 * A first name and a face — nothing else. Not their email, not their role, not
 * whether they are the one who will actually pick it up: this exists to show
 * that a person is on the other end, which is the whole reason a chat widget
 * outperforms a contact form.
 */
export const nestchatAgentFaceSchema = z.object({
  /** Display name, trimmed to a first name — a visitor doesn't need a surname. */
  name: z.string(),
  initials: z.string(),
  /** Their avatar colour, so the fallback circle is theirs and not a generic grey. */
  color: z.string().optional(),
  /** A path the widget can load their photo from, when they have one. Relative,
   *  because it is resolved against whichever origin served the widget. */
  avatarUrl: z.string().optional(),
  online: z.boolean(),
});
export type NestChatAgentFace = z.infer<typeof nestchatAgentFaceSchema>;

/** The team behind a channel: a few faces, and how many there are in all. */
export const nestchatTeamSchema = z.object({
  name: z.string().optional(),
  faces: z.array(nestchatAgentFaceSchema),
  total: z.number().int().nonnegative(),
});
export type NestChatTeam = z.infer<typeof nestchatTeamSchema>;

/** What the agent-facing settings pane reads for one NestChat channel. */
/* ---- the app surface ---- */

/**
 * How hard this channel checks who somebody says they are.
 *
 * `off` takes a name at face value, which is right for a widget on a public
 * page: nobody has signed in to anything, and the alternative is a chat that
 * refuses to start. `required` only trusts details carried by a signature this
 * channel's own secret produced, which is right the moment the client is an app
 * a customer signs into — the key is in the binary, and without a signature
 * anyone who extracts it can claim to be any customer on the workspace.
 *
 * `optional` is the migration step, and it is deliberately not a permanent
 * setting: it verifies a signature when one arrives and lets an unsigned
 * session through, so the app can ship before the backend that signs. A channel
 * left here indefinitely has all the exposure of `off` and the appearance of
 * having done something about it, which is why the pane says so.
 */
export const nestchatIdentityModeSchema = z.enum(["off", "optional", "required"]);
export type NestChatIdentityMode = z.infer<typeof nestchatIdentityModeSchema>;

export const nestchatAppSchema = z.object({
  /** Whether an SDK may open chats on this channel at all. */
  enabled: z.boolean().default(false),
  /**
   * A tag put on every contact this channel creates.
   *
   * Editable, and applied at the point a contact is first seen rather than
   * retroactively: it says where this customer came from, and rewriting it
   * later would rewrite history rather than record it.
   */
  contactTag: z.string().max(40).default(""),
  /**
   * The custom field that identifies a thread, by key.
   *
   * Set it to an order reference and each order gets its own conversation —
   * opening the messenger for one finds that order's thread or starts it.
   * Leave it empty and the customer gets a single ongoing conversation, which
   * is what a general support channel wants.
   */
  threadFieldKey: z.string().max(40).default(""),
  identity: nestchatIdentityModeSchema.default("optional"),
});
export type NestChatApp = z.infer<typeof nestchatAppSchema>;
export const DEFAULT_NESTCHAT_APP: NestChatApp = nestchatAppSchema.parse({});

export const nestchatSettingsSchema = z.object({
  inboxId: z.string(),
  /** Public id in the embed snippet. Identifies the inbox; authorises nothing. */
  widgetKey: z.string(),
  appearance: nestchatAppearanceSchema,
  preChat: nestchatPreChatSchema,
  routing: nestchatRoutingSchema,
  home: nestchatHomeSchema,
  /** When nobody's online. */
  away: nestchatAwaySchema,
  /**
   * The teams this channel routes to — the only teams a routing option may
   * name, so the pane can offer exactly those and no more.
   *
   * Sent with the settings rather than fetched separately because the pane
   * needs the *intersection* of the org's teams and this channel's, and the
   * channel is the half only the server knows without another round trip.
   */
  teams: z
    .array(z.object({ id: z.string(), name: z.string(), icon: z.string().nullable().optional() }))
    .default([]),
  /** Ready-to-paste URLs, resolved against the deployment's own public URL so
   *  the snippet is correct without the admin knowing where we're hosted. */
  embedUrl: z.string(),
  scriptUrl: z.string(),
  /** The app surface: whether an SDK may open chats here, and on what terms. */
  app: nestchatAppSchema,
  /**
   * The key that goes in the app binary. Only once the surface is on.
   *
   * Separate from `widgetKey` rather than shared, so turning the app off — or
   * rolling its key after a leak — does not take the website down with it, and
   * so app traffic can be told from web traffic without asking the client.
   */
  appKey: z.string().optional(),
  /**
   * Whether an identity secret exists. Never the secret itself.
   *
   * It is shown once, at the moment it is minted, and is not readable
   * afterwards — a settings screen that hands it back on every load is a
   * settings screen that leaks it to anyone who gets one look at a logged-in
   * browser.
   */
  hasIdentitySecret: z.boolean().default(false),
  /**
   * Whether this channel can push to its customers' phones.
   *
   * The service account behind it is a credential — stored encrypted, never
   * read back — so what a settings screen may know is the same thing it may
   * know about the identity secret: that there is one.
   */
  hasPushCredential: z.boolean().default(false),
  /** Conversation-scoped custom fields, for choosing which one keys a thread. */
  threadFields: z
    .array(z.object({ key: z.string(), label: z.string() }))
    .default([]),
  /** The same faces the widget would show, so the preview shows them too — a
   *  toggle that changes nothing on screen reads as a toggle that didn't work. */
  team: nestchatTeamSchema.optional(),
});
export type NestChatSettings = z.infer<typeof nestchatSettingsSchema>;

/**
 * A settings save.
 *
 * `appearance` is a patch, as it always was — it is a flat bag of independent
 * strings and toggles, and merging one key over the rest is well defined.
 *
 * `preChat` and `routing` are replaced whole. They contain a list and nested
 * objects, and "merge" has no honest meaning for those: patching an array of
 * routing options can't express a deletion, and a caller who sent one option
 * would find the other seven still there. The pane holds the whole structure
 * anyway, so sending it costs nothing and removes the ambiguity.
 */
export const updateNestchatInputSchema = z.object({
  appearance: nestchatAppearanceSchema.partial().optional(),
  preChat: nestchatPreChatSchema.optional(),
  routing: nestchatRoutingSchema.optional(),
  home: nestchatHomeSchema.optional(),
  away: nestchatAwaySchema.optional(),
  /** Replaced whole, like the others: it is a handful of interdependent
   *  settings, and a patch that could set `enabled` without saying what
   *  identity mode it meant would be a surface turned on by accident. */
  app: nestchatAppSchema.optional(),
});
export type UpdateNestchatInput = z.infer<typeof updateNestchatInputSchema>;

/* ---- the visitor-facing contract (public, unauthenticated) ---- */

/** What the widget fetches before it renders anything. No customer data. */
export const nestchatConfigSchema = z.object({
  appearance: nestchatAppearanceSchema,
  /** Whether anyone is at the desk right now, so the widget can set
   *  expectations instead of promising a reply nobody is there to send. */
  online: z.boolean(),
  /** The team behind this channel: a few faces, and how many there are in all. */
  team: nestchatTeamSchema.optional(),
  /**
   * The form to show before the first message, when the business asked for one.
   *
   * Absent rather than disabled when it is off: the widget's question is "is
   * there a form?", and a channel that doesn't want one shouldn't ship six
   * labels to every visitor's browser to say so.
   */
  preChat: nestchatPreChatSchema.optional(),
  /** The menu of things a visitor can say they're here about. Absent when the
   *  channel has no menu, or has one with nothing in it. */
  routing: nestchatPublicRoutingSchema.optional(),
  /** The cards to show before the conversation. Absent when the channel has no
   *  home screen, so the widget's question stays "is there one?". */
  home: nestchatHomeSchema.optional(),
  /** What the widget says itself while nobody is online (the automatic reply
   *  is the server's). Absent from an older server. */
  away: nestchatAwaySchema.pick({ homeLine: true, thanks: true }).optional(),
});
export type NestChatConfig = z.infer<typeof nestchatConfigSchema>;

/**
 * One message as a visitor may see it. Deliberately not `Message`: the internal
 * shape carries notes, assignment, delivery state and author ids, none of which
 * belong on someone else's website. Everything the widget renders is built here.
 */
/**
 * One file on a visitor-facing message.
 *
 * `kind` rather than sniffing the mime on the client: a voice note and a
 * recording someone attached from their files are both `audio/…`, and only one
 * of them should be drawn as a waveform with a play button instead of a row
 * with a download arrow.
 */
export const nestchatAttachmentSchema = z.object({
  id: z.string(),
  filename: z.string(),
  mime: z.string(),
  kind: attachmentKindSchema.optional(),
  /** Voice and video: how long it runs, so the bubble can say "0:07" before a
   *  byte of it has been fetched. */
  durationMs: z.number().int().nonnegative().optional(),
  /** Voice: the bars to draw, 0..1. Computed once when the note is recorded —
   *  the alternative is every reader decoding the whole file to draw a shape
   *  that was the same for all of them. */
  waveform: z.array(z.number()).optional(),
});
export type NestChatAttachment = z.infer<typeof nestchatAttachmentSchema>;

/**
 * The message a reply is answering, flattened onto the reply itself.
 *
 * Carried rather than looked up by id, because the quoted message may be older
 * than the window the widget holds — and a quote that renders as a blank
 * because the original scrolled out of memory is worse than no quote. The
 * preview is already trimmed to what fits.
 */
export const nestchatQuoteSchema = z.object({
  id: z.string(),
  from: z.enum(["visitor", "agent"]),
  authorName: z.string().optional(),
  /** Trimmed to {@link NESTCHAT_QUOTE_PREVIEW_MAX}; empty for a voice note or
   *  a bare file, which `kind` describes instead. */
  preview: z.string(),
  /** What the original was, when it was not words: `voice`, `image`, … */
  kind: attachmentKindSchema.optional(),
});
export type NestChatQuote = z.infer<typeof nestchatQuoteSchema>;

/** How much of a quoted message rides along on the reply. Two lines' worth. */
export const NESTCHAT_QUOTE_PREVIEW_MAX = 120;

export const nestchatMessageSchema = z.object({
  id: z.string(),
  from: z.enum(["visitor", "agent"]),
  /** The agent's display name, for the "Sarah" above a reply. Absent for the
   *  visitor's own messages. */
  authorName: z.string().optional(),
  body: z.string(),
  at: z.string(),
  attachments: z.array(nestchatAttachmentSchema).optional(),
  /** Emoji on this message. `by` is relative to the reader: "visitor" is the
   *  person holding the phone, whichever side put it there. */
  reactions: z.array(z.object({ emoji: z.string(), by: z.enum(["visitor", "agent"]) })).default([]),
  /** The message this one is answering. */
  quote: nestchatQuoteSchema.optional(),
  /** Sent by Nest itself while nobody was online; "away_ask" wants their email. */
  auto: messageAutoSchema.optional(),
});
export type NestChatMessage = z.infer<typeof nestchatMessageSchema>;

/** Opening (or resuming) a chat. The visitor id is the browser's own, so a
 *  returning visitor lands back in their existing conversation. */
export const nestchatSessionInputSchema = z.object({
  visitorId: z.string().min(8).max(64).optional(),
  name: z.string().max(80).optional(),
  /**
   * The website's own id for a signed-in user, from `NestChatSettings.user`.
   *
   * Believed only with `userHash` — HMAC-SHA256 of this id under the channel's
   * signing secret, made by the website's server. Then the chat belongs to that
   * user on every browser, and the name, email and phone below are written onto
   * their record. Without a valid one, all of it is dropped and the chat opens
   * as an anonymous visitor: a browser can say anything, and an email is what
   * joins a chat onto a customer's history.
   */
  externalId: z.string().min(1).max(120).optional(),
  userHash: z.string().max(200).optional(),
  email: z.string().email().max(200).optional(),
  phone: z.string().max(40).optional(),
  /** Conversation field values, by key — `{ order_id: "DG-88412" }`. */
  fields: z.record(z.string().max(500)).optional(),
});
export type NestChatSessionInput = z.infer<typeof nestchatSessionInputSchema>;

/**
 * An app opening a session.
 *
 * `externalId` is the app's own id for the person, and is what makes history
 * survive a reinstall. Everything else about them is a claim until a signature
 * says otherwise — see `userHash`.
 */
export const nestchatAppSessionInputSchema = z.object({
  /** The app's own user id. Absent for somebody who has not signed in. */
  externalId: z.string().min(1).max(120).optional(),
  /**
   * HMAC-SHA256 of `externalId` under the channel's signing secret, hex.
   *
   * Made by the app's *backend*, never by the app: the secret cannot be in a
   * binary, because anything in a binary can be taken out of one. Without it
   * the name and contact details below are only what the caller typed.
   */
  userHash: z.string().max(200).optional(),
  name: z.string().max(80).optional(),
  email: z.string().email().max(200).optional(),
  phone: z.string().max(40).optional(),
  /**
   * Custom field values, by key — `{ order_id: "DG-88412" }`.
   *
   * Validated against the fields this channel actually offers; anything else is
   * reported back rather than stored, so a typo in an integration is visible
   * the day it is written.
   */
  fields: z.record(z.string().max(500)).optional(),
});
export type NestChatAppSessionInput = z.infer<typeof nestchatAppSessionInputSchema>;

export const nestchatAppSessionSchema = z.object({
  token: z.string(),
  hasConversation: z.boolean(),
  messages: z.array(nestchatMessageSchema),
  /**
   * Whether the details sent were actually trusted.
   *
   * The app is told, because it is the difference between a chat that reaches
   * the customer's own record and one that starts an anonymous thread — and an
   * integrator debugging a signature needs to see which of the two happened.
   */
  identified: z.boolean(),
  /** Field keys this channel has never heard of. */
  unknownFields: z.array(z.string()).default([]),
  /** What we already have for this person (see the website session). */
  known: z.object({ name: z.boolean(), email: z.boolean(), phone: z.boolean() }).optional(),
});
export type NestChatAppSession = z.infer<typeof nestchatAppSessionSchema>;

export const nestchatSessionSchema = z.object({
  visitorId: z.string(),
  /** Bearer for every later visitor call. Scoped to one conversation. */
  token: z.string(),
  /** Whether this visitor already has a thread. False for someone who has
   *  opened the widget but never written — there is nothing to stream yet, and
   *  a widget that opens one anyway reconnects against a 400 forever. */
  hasConversation: z.boolean(),
  messages: z.array(nestchatMessageSchema),
  /** A signed-in user whose signature checked out. Absent for a visitor. */
  identified: z.boolean().optional(),
  /** Field keys this channel has never heard of. */
  unknownFields: z.array(z.string()).optional(),
  /** What we already have for this visitor, so the widget doesn't ask again. */
  known: z.object({ name: z.boolean(), email: z.boolean(), phone: z.boolean() }).optional(),
});
export type NestChatSession = z.infer<typeof nestchatSessionSchema>;

/**
 * What a customer is allowed to attach.
 *
 * An allowlist, not a blocklist. This endpoint takes files from strangers and
 * serves them back from our own domain, so the question is not "is this
 * dangerous" — it is "do we have a reason to accept it". Photographs of a wrong
 * order, a screenshot, a receipt, a short clip: yes. An installer, an archive,
 * a script: no reason, and every reason not to become the place somebody hosts
 * one.
 */
export const NESTCHAT_UPLOAD_TYPES = [
  "image/",
  "video/",
  "audio/",
  "application/pdf",
  "text/plain",
] as const;

/**
 * Types that look like they belong but are documents a browser runs script
 * from.
 *
 * SVG is the one that matters. It passes any "is it an image" test, renders as
 * a picture everywhere you would expect a picture, and can carry a `<script>`
 * — so an SVG uploaded by a stranger and opened inline from our own origin is
 * stored XSS against whoever opened it. The visitor's own download route forces
 * an attachment disposition, but an agent's does not, and the agent is the
 * person this would be aimed at.
 */
const NESTCHAT_UPLOAD_DENIED = ["image/svg+xml", "image/svg", "text/xml", "application/xml"];

/** Whether a customer may upload this type. */
export function nestchatAcceptsUpload(mime: string): boolean {
  const m = mime.trim().toLowerCase();
  if (NESTCHAT_UPLOAD_DENIED.includes(m)) return false;
  return NESTCHAT_UPLOAD_TYPES.some((t) => (t.endsWith("/") ? m.startsWith(t) : m === t));
}

/** How much a customer may attach at once, and how big one file may be. Lower
 *  than an agent's: this is an unauthenticated endpoint, and a photo of a cold
 *  curry does not need 100 MB. */
export const NESTCHAT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const NESTCHAT_MAX_ATTACHMENTS = 5;

/** What an upload hands back: enough to show a preview, plus the ticket that
 *  redeems it on send. */
export const nestchatUploadResultSchema = z.object({
  /**
   * The signed claim on a stored file.
   *
   * The file's details ride inside it rather than in a database row, so an
   * upload nobody sends leaves no orphan record — and a client cannot rename,
   * resize or re-type a file between uploading it and attaching it, because
   * none of that is theirs to say.
   */
  ticket: z.string(),
  filename: z.string(),
  mime: z.string(),
  size: z.number().int().nonnegative(),
  kind: attachmentKindSchema,
});
export type NestChatUploadResult = z.infer<typeof nestchatUploadResultSchema>;

export const nestchatSendInputSchema = z.object({
  /** Tickets from `POST /nestchat/upload`, in the order they should appear. */
  attachments: z.array(z.string()).max(NESTCHAT_MAX_ATTACHMENTS).default([]),
  /** Empty is allowed when something is attached: a photo of what turned up is
   *  a complete message, and demanding a caption for it is a form. */
  body: z.string().max(4000).default(""),
  /** The page the widget is embedded on. Recorded as the subject of the thread
   *  this message opens, so the agent can see where the visitor was standing. */
  pageUrl: z.string().max(500).optional(),
  /** The message being replied to. Checked against the conversation on arrival
   *  — an id from another thread is dropped rather than quoted, which is the
   *  difference between a reply and a way to read somebody else's messages. */
  quotedMsgId: z.string().max(64).optional(),
});
export type NestChatSendInput = z.infer<typeof nestchatSendInputSchema>;

/**
 * The visitor putting an emoji on a message, or taking theirs off.
 *
 * One per person per message, like every other reaction in this product: an
 * empty string is the removal, so the client has one call rather than two and
 * a double-tap on the same emoji is a toggle without a second endpoint.
 */
export const nestchatReactInputSchema = z.object({
  messageId: z.string().min(1).max(64),
  /** One emoji, or empty to remove. Bounded rather than validated as an
   *  emoji: the set grows every year and a widget that cannot send this
   *  year's is worse than a database holding a character we did not expect. */
  emoji: z.string().max(16),
});
export type NestChatReactInput = z.infer<typeof nestchatReactInputSchema>;

/** How many bars a voice note carries. Enough to read as a shape rather than
 *  a blur, few enough to draw on a narrow bubble without stacking. */
export const NESTCHAT_WAVEFORM_BARS = 60;

/** The longest voice note a visitor can record. Long enough to explain what
 *  went wrong with an order, short enough that nobody sends a podcast. */
export const NESTCHAT_VOICE_MAX_MS = 5 * 60_000;

/**
 * What a voice note knows about itself.
 *
 * Sent with the upload rather than derived on our side. The recorder already
 * has both — it drew the bars while the person was talking — and the
 * alternative is decoding the audio on the server to recover numbers the
 * client measured for free.
 */
export const nestchatVoiceMetaSchema = z.object({
  durationMs: z.number().int().nonnegative().max(10 * 60_000),
  /** 0..1 per bar. Capped because this is drawn at about sixty bars wide and
   *  anything beyond that is detail nobody can see. */
  waveform: z.array(z.number().min(0).max(1)).max(NESTCHAT_WAVEFORM_BARS),
});
export type NestChatVoiceMeta = z.infer<typeof nestchatVoiceMetaSchema>;

/** The visitor's widget reporting how far it has actually got through the
 *  thread — what turns an agent's ticks from sent to delivered to read. */
export const nestchatReadInputSchema = z.object({
  /** The newest message the widget has. Everything up to it moves. */
  throughMessageId: z.string().min(1),
  /** "delivered" — it arrived in their browser. "read" — the chat was actually
   *  on screen when it did, which is a different claim and the only one worth
   *  showing an agent as read. */
  status: z.enum(["delivered", "read"]),
});
export type NestChatReadInput = z.infer<typeof nestchatReadInputSchema>;

/**
 * How much of a visitor's unsent draft travels, and how often.
 *
 * The cap is a socket-traffic bound, not an editorial one: someone pasting an
 * order history into the box shouldn't push a kilobyte through the gateway on
 * every keystroke, and the agent only needs enough to know what's coming. The
 * interval is the trade between feeling live and one request per character —
 * under a second reads as live, and at this rate a solid minute of typing stays
 * inside the endpoint's rate limit.
 */
export const TYPING_PREVIEW_MAX = 500;
export const TYPING_PREVIEW_MS = 700;

export const nestchatTypingInputSchema = z.object({
  /** What they have written so far. Empty means the box is empty — still
   *  typing (they just deleted it), so the indicator stays but the text goes. */
  preview: z.string().max(TYPING_PREVIEW_MAX).optional(),
});
export type NestChatTypingInput = z.infer<typeof nestchatTypingInputSchema>;

/**
 * An app saying its chat is on screen, or that it no longer is.
 *
 * What decides whether an agent's reply rings the customer's phone. It used to
 * be decided by whether the app held the live stream open — and an app holds
 * that for as long as somebody is signed in, so a phone locked in a pocket
 * counted as a customer reading, and no reply was ever pushed to it.
 */
export const nestchatViewingInputSchema = z.object({ viewing: z.boolean() });
export type NestChatViewingInput = z.infer<typeof nestchatViewingInputSchema>;

/** Where a customer's phone is reachable, registered by the in-app SDK. */
export const nestchatDeviceInputSchema = z.object({
  /** The FCM registration token. Long, opaque, and not ours to validate beyond
   *  a sanity bound — Google changes its shape from time to time and a client
   *  that cannot register is worse than a token that fails on first send. */
  token: z.string().min(16).max(1024),
  platform: z.enum(["ios", "android", "web"]),
});
export type NestChatDeviceInput = z.infer<typeof nestchatDeviceInputSchema>;

/**
 * The Firebase service account a channel pushes through.
 *
 * Pasted whole rather than field by field: it is downloaded from the Firebase
 * console as one JSON file, and asking an admin to pick three keys out of it is
 * three chances to paste the wrong one. Validated on arrival so a bad paste is
 * a message on the screen rather than notifications that silently never come.
 */
export const nestchatPushCredentialInputSchema = z.object({
  /** The service-account JSON, or empty to stop pushing on this channel. */
  serviceAccount: z.string().max(8192),
});
export type NestChatPushCredentialInput = z.infer<typeof nestchatPushCredentialInputSchema>;

/**
 * What a "send a test push" attempt found.
 *
 * `ok` alone would be no better than the silence it replaces. The three
 * failures are genuinely different jobs for whoever is reading: register a
 * phone, save a key, or go and compare two Firebase projects — so the reason
 * is carried, and `detail` says it in words rather than in an error code.
 */
export const nestchatPushTestSchema = z.object({
  ok: z.boolean(),
  /** `no_devices` or `not_configured` when it never reached Google. */
  reason: z.string().optional(),
  /** Google's own code when it did, e.g. `SENDER_ID_MISMATCH`. */
  error: z.string().optional(),
  detail: z.string(),
  platform: z.string().optional(),
});
export type NestChatPushTest = z.infer<typeof nestchatPushTestSchema>;

export const nestchatIdentifyInputSchema = z.object({
  name: z.string().max(80).optional(),
  email: z.string().email().max(200).optional(),
  phone: z.string().max(40).optional(),
});
export type NestChatIdentifyInput = z.infer<typeof nestchatIdentifyInputSchema>;

/**
 * What came of it.
 *
 * `token` is reissued when the details turned out to belong to a customer we
 * already knew: this visitor IS that person, so their conversation moves onto
 * the existing record and the old contact — the one the visitor's token named —
 * no longer exists. A widget that kept its old token would be holding a
 * reference to a deleted row.
 *
 * `saved` is what the widget confirms back to the visitor. It used to report
 * nothing at all, which meant a details form that quietly failed looked exactly
 * like one that worked.
 */
export const nestchatIdentifyResultSchema = z.object({
  ok: z.boolean(),
  saved: z.array(z.enum(["name", "email", "phone"])),
  /** True when these details matched a customer already on file. */
  linked: z.boolean(),
  token: z.string().optional(),
});
export type NestChatIdentifyResult = z.infer<typeof nestchatIdentifyResultSchema>;

/**
 * The pre-chat form, submitted.
 *
 * Everything `identify` takes, plus which option they picked — one call rather
 * than two, because these are answers to one form and half-applying them (the
 * name saved, the routing lost) would put a visitor in front of the wrong team
 * under their own name.
 */
export const nestchatStartInputSchema = z.object({
  name: z.string().max(80).optional(),
  email: z.string().email().max(200).optional(),
  phone: z.string().max(40).optional(),
  /** The id of the routing option they chose, if the channel offers a menu. */
  optionId: z.string().max(40).optional(),
});
export type NestChatStartInput = z.infer<typeof nestchatStartInputSchema>;

/**
 * What the form produced.
 *
 * Extends the identify result because the identity half is literally the same
 * operation — including the reissued `token`, which here does double duty: it
 * carries the surviving contact after a merge AND the routing choice, so the
 * choice survives a reload and can't be swapped by editing a later request.
 */
export const nestchatStartResultSchema = nestchatIdentifyResultSchema.extend({
  /**
   * The chosen option, echoed back after the server has checked it is really
   * one of this channel's.
   *
   * Echoed rather than assumed because the server is the one that decides: an
   * option removed while a visitor sat with the widget open resolves to
   * nothing, and the widget should show what will actually happen.
   */
  option: z.object({ id: z.string(), label: z.string() }).optional(),
  /** The faces of the team that will now answer, so the header can narrow from
   *  "everyone here" to "the people who handle billing". */
  team: nestchatTeamSchema.optional(),
});
export type NestChatStartResult = z.infer<typeof nestchatStartResultSchema>;

export const createTeamInputSchema = z.object({
  name: z.string().min(1),
  icon: z.string().optional(),
  slaMinutes: z.number().int().positive().nullable().optional(),
});
export type CreateTeamInput = z.infer<typeof createTeamInputSchema>;

export const updateTeamInputSchema = z.object({
  name: z.string().min(1).optional(),
  icon: z.string().nullable().optional(),
  slaMinutes: z.number().int().positive().nullable().optional(),
});
export type UpdateTeamInput = z.infer<typeof updateTeamInputSchema>;

/** Persist a new team ordering (array of team ids in the desired order). */
export const reorderTeamsInputSchema = z.object({
  orderedIds: z.array(z.string()).min(1),
});
export type ReorderTeamsInput = z.infer<typeof reorderTeamsInputSchema>;

/** The same for channels: the ids, in the order they should be listed. */
export const reorderInboxesInputSchema = z.object({
  orderedIds: z.array(z.string()).min(1),
});
export type ReorderInboxesInput = z.infer<typeof reorderInboxesInputSchema>;

export const createLabelInputSchema = z.object({
  name: z.string().min(1).max(40),
  color: hexColor,
});
export type CreateLabelInput = z.infer<typeof createLabelInputSchema>;

export const updateLabelInputSchema = z.object({
  name: z.string().min(1).max(40).optional(),
  color: hexColor.optional(),
});
export type UpdateLabelInput = z.infer<typeof updateLabelInputSchema>;

/** Replace a conversation's labels with this exact set of label ids. */
export const setConversationLabelsInputSchema = z.object({
  labelIds: z.array(z.string()),
});
export type SetConversationLabelsInput = z.infer<typeof setConversationLabelsInputSchema>;

export const createUserInputSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  role: roleSchema.default("agent"),
  teamIds: z.array(z.string()).default([]),
  /** Job title for signatures. Optional; blank is none. */
  position: positionInputSchema.optional(),
});
export type CreateUserInput = z.infer<typeof createUserInputSchema>;

export const updateUserInputSchema = z.object({
  name: z.string().min(1).optional(),
  role: roleSchema.optional(),
  teamIds: z.array(z.string()).optional(),
  position: positionInputSchema.optional(),
});
export type UpdateUserInput = z.infer<typeof updateUserInputSchema>;

/** A user editing their OWN personal settings (no admin rights needed). */
export const updateMyPreferencesInputSchema = z.object({
  available: z.boolean().optional(),
  /** Working hours; null clears them (the switch alone decides again). */
  schedule: availabilityScheduleSchema.nullable().optional(),
});
export type UpdateMyPreferencesInput = z.infer<typeof updateMyPreferencesInputSchema>;

/** A user editing their OWN profile — name, login email, and photo. */
export const updateMyProfileInputSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  email: z.string().email().optional(),
  /** Uploaded photo URL (from POST /media). Empty string / null clears it. */
  avatarUrl: z.string().max(2000).nullable().optional(),
  /** Their own job title; blank clears it. */
  position: positionInputSchema.optional(),
});
export type UpdateMyProfileInput = z.infer<typeof updateMyProfileInputSchema>;

/** A user changing their OWN password — current is re-verified server-side. */
export const changePasswordInputSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(200),
});
export type ChangePasswordInput = z.infer<typeof changePasswordInputSchema>;

export const createContactInputSchema = z.object({
  displayName: z.string().min(1),
  company: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  tags: z.array(z.string()).optional(),
  /** Pin this customer to a team so their messages always route there. */
  ownerTeamId: z.string().nullable().optional(),
  ownerUserId: z.string().nullable().optional(),
});
export type CreateContactInput = z.infer<typeof createContactInputSchema>;

/**
 * A bulk import of customers, one entry per row of the uploaded file.
 *
 * Deliberately the same shape as a single create, so the import path and the
 * Add-customer form cannot drift into two different ideas of what a customer
 * is — including the get-or-create dedup, which is the whole reason importing
 * the same list twice is safe.
 *
 * Capped at 2000. Not a technical limit: the request is one transaction's worth
 * of work and a bigger file almost always means someone exported their whole
 * CRM by accident, which is better refused than half-applied.
 */
export const importContactsInputSchema = z.object({
  contacts: z.array(createContactInputSchema).min(1).max(2000),
  /** Applied to every row — including rows that matched a customer already on
   *  file, which is the point of tagging an import. Merged with whatever tags
   *  they have; nothing is removed. */
  tags: z.array(z.string()).default([]),
});
export type ImportContactsInput = z.infer<typeof importContactsInputSchema>;

/** What an import did, per outcome. `failed` carries the row's position in the
 *  file so a rejection can be pointed at rather than just counted. */
export const importContactsResultSchema = z.object({
  created: z.number().int().nonnegative(),
  /** Matched an existing customer by phone/email; tags were added to them. */
  matched: z.number().int().nonnegative(),
  failed: z.array(z.object({ index: z.number().int(), name: z.string(), error: z.string() })),
});
export type ImportContactsResult = z.infer<typeof importContactsResultSchema>;

export const updateContactInputSchema = z.object({
  displayName: z.string().min(1).optional(),
  company: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  tags: z.array(z.string()).optional(),
  ownerTeamId: z.string().nullable().optional(),
  ownerUserId: z.string().nullable().optional(),
  blocked: z.boolean().optional(),
});
export type UpdateContactInput = z.infer<typeof updateContactInputSchema>;

/** A contact with the conversations that belong to them (Customers › detail). */
export const contactWithConversationsSchema = contactSchema.extend({
  conversations: z.array(conversationSchema),
});
export type ContactWithConversations = z.infer<typeof contactWithConversationsSchema>;

/** A user together with the teams they belong to (Settings › People). */
export const memberSchema = z.object({
  user: userSchema,
  teamIds: z.array(z.string()),
  /** Invited, and hasn't joined yet: no password set. People shows them as
   *  "Invite pending" until they do, then "Active". */
  pending: z.boolean().optional(),
});
export type Member = z.infer<typeof memberSchema>;

export const loginInputSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  /** Native clients ask for the session as a bearer token instead of a cookie:
   *  a phone has no shared cookie jar between its HTTP client, its socket and a
   *  background push registration. Browsers omit this and keep the httpOnly
   *  cookie, which is a real defence there and doesn't change. */
  tokenAuth: z.boolean().optional(),
  /** A remembered device's pass, from an earlier `rememberDevice` sign-in.
   *  Browsers send it as a cookie instead. Skips the code, never the password. */
  trustedDeviceToken: z.string().max(2000).optional(),
});
export type LoginInput = z.infer<typeof loginInputSchema>;

/** What a tokenAuth login returns once the session is real. `token` is absent
 *  for cookie clients. */
export interface SessionGrant {
  token?: string;
  /** Seconds until the token expires, so a client can refresh ahead of it. */
  expiresIn?: number;
  /** For a token client that asked to be remembered: send it with the next
   *  login and the second factor is skipped for 30 days. */
  trustedDeviceToken?: string;
}

/* ---- workspaces: one person in several, and the platform's owners ---- */

/** One of the workspaces I'm in. */
export interface MyWorkspace {
  orgId: string;
  name: string;
  role: Role;
  sandbox: boolean;
  /** The one this session is in. */
  current: boolean;
  /** The platform's own workspace: the one that can also host an email inbox
   *  on the platform's mail service. Everyone else's email is Gmail. */
  platform: boolean;
}

export interface MyWorkspaces {
  workspaces: MyWorkspace[];
  /** Whether I own the platform: see every workspace, make new ones, open any. */
  platformOwner: boolean;
}

/** Move this session into another of my workspaces (or, for a platform owner,
 *  any workspace — which adds them to it as an admin). */
export const switchWorkspaceInputSchema = z.object({
  orgId: z.string().min(1),
  /** Native clients: return the new session token in the body. */
  tokenAuth: z.boolean().optional(),
});
export type SwitchWorkspaceInput = z.infer<typeof switchWorkspaceInputSchema>;

/** A workspace, as the platform's owners see it. */
export interface PlatformWorkspace {
  id: string;
  name: string;
  sandbox: boolean;
  createdAt: string;
  people: number;
  channels: number;
  conversations: number;
  /** Whether I'm in it already. */
  joined: boolean;
  /** The platform's own workspace: never suspended, archived or deleted. */
  platform: boolean;
  /** Anything but active is frozen: nobody signs in, its channels take nothing
   *  in and send nothing out. */
  status: WorkspaceStatus;
  statusAt: string | null;
  /** Being deleted: when it's wiped for good (restorable until then). */
  purgeAt: string | null;
}

/** active, or frozen: suspended (paused), archived (put away, kept for ever),
 *  deleting (wiped for good after 30 days). */
export const workspaceStatusSchema = z.enum(["active", "suspended", "archived", "deleting"]);
export type WorkspaceStatus = z.infer<typeof workspaceStatusSchema>;

/** How long a deleted workspace can still be restored. */
export const WORKSPACE_DELETE_GRACE_DAYS = 30;

export const renameWorkspaceInputSchema = z.object({ name: z.string().trim().min(1, "Name the workspace").max(80) });
export type RenameWorkspaceInput = z.infer<typeof renameWorkspaceInputSchema>;

/** Suspend, archive, delete (in 30 days), or make active again (reactivate,
 *  unarchive, restore). */
export const setWorkspaceStatusInputSchema = z.object({ status: workspaceStatusSchema });
export type SetWorkspaceStatusInput = z.infer<typeof setWorkspaceStatusInputSchema>;

/** Wipe now: the workspace's name, typed out, so it's never a slip. */
export const deleteWorkspaceNowInputSchema = z.object({ confirmName: z.string() });
export type DeleteWorkspaceNowInput = z.infer<typeof deleteWorkspaceNowInputSchema>;

/** Someone in a workspace, as the platform's owners manage it from outside. */
export interface PlatformPerson {
  user: User;
  /** Invited, and hasn't set a password yet. */
  pending: boolean;
}

export const addPlatformPersonInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email("That doesn't look like an email address").max(254),
  role: roleSchema,
});
export type AddPlatformPersonInput = z.infer<typeof addPlatformPersonInputSchema>;

export const setPlatformPersonRoleInputSchema = z.object({ role: roleSchema });
export type SetPlatformPersonRoleInput = z.infer<typeof setPlatformPersonRoleInputSchema>;

/** What adding someone, or re-sending their invite, came to. */
export interface PlatformPersonInvite {
  person: PlatformPerson;
  /** Already signs in elsewhere: added, and told — no invite. */
  addedExisting?: boolean;
  invite?: { url: string; emailed: boolean };
}

/** A new workspace, and the person who'll run it. */
export const createWorkspaceInputSchema = z.object({
  name: z.string().trim().min(1, "Name the workspace").max(80),
  adminName: z.string().trim().min(1, "Who'll run it?").max(120),
  adminEmail: z.string().trim().email("That doesn't look like an email address").max(254),
});
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceInputSchema>;

export interface CreatedWorkspace {
  workspace: PlatformWorkspace;
  /** The first admin: invited to set a password, or — already signing in
   *  somewhere — told they've been added. */
  admin: { name: string; email: string; invited: boolean; emailed: boolean; inviteUrl?: string };
}

/**
 * How many conversations each list filter holds, across the whole view.
 *
 * Counted by the server because the list is paged: counting the rows a client
 * happens to have loaded made every chip read low until somebody scrolled to
 * the bottom. Everything but `closed` counts live (not closed) conversations,
 * the same rule the chips filter by.
 */
export interface ConversationFilterCounts {
  all: number;
  unread: number;
  mine: number;
  unassigned: number;
  groups: number;
  closed: number;
}

/** A signed-in device/browser shown in "Where you're signed in" (personal
 *  settings). `current` marks the session making the request. */
export interface SessionInfo {
  id: string;
  current: boolean;
  ip?: string | null;
  browser?: string | null;
  os?: string | null;
  createdAt: string;
  lastSeenAt: string;
}

/* ---- Push devices ---- */

/** Register this install for push. Sent after sign-in and on every app start,
 *  because push tokens rotate — re-registering the same token is a no-op that
 *  just refreshes `lastSeenAt`. */
export const registerDeviceInputSchema = z.object({
  /** The Expo push token: "ExponentPushToken[…]". */
  pushToken: z.string().min(10).max(256),
  platform: z.enum(["ios", "android"]),
  appVersion: z.string().max(32).optional(),
  osVersion: z.string().max(32).optional(),
  /** What the person would call this phone ("Nathan's iPhone"), for the
   *  signed-in-devices list. */
  deviceName: z.string().max(120).optional(),
});
export type RegisterDeviceInput = z.infer<typeof registerDeviceInputSchema>;

/** A registered device, as its owner sees it. The push token never leaves the
 *  server — it's an address someone else could send to. */
export interface DeviceInfo {
  id: string;
  platform: string;
  deviceName?: string | null;
  appVersion?: string | null;
  osVersion?: string | null;
  createdAt: string;
  lastSeenAt: string;
  /** Set when we've stopped pushing here — a dead token, or permission revoked. */
  disabledReason?: string | null;
}

/** "HH:MM", 24-hour. */
const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM");

/**
 * What a person wants pushed to their phone.
 *
 * The defaults are the point of this shape: everything about *me* is on, and
 * all-team-inbound is off. A busy shared inbox that pushes every arrival is the
 * setting that makes people turn notifications off entirely — at which point
 * they miss the ones that mattered.
 */
export const pushPreferencesSchema = z.object({
  /** A new message in a conversation assigned to me. */
  assigned: z.boolean().default(true),
  /** An @mention of me in an internal note. */
  mentions: z.boolean().default(true),
  /** Someone assigned a conversation to me. */
  assignments: z.boolean().default(true),
  /** A conversation I snoozed has come due. */
  reminders: z.boolean().default(true),
  /**
   * A chat lands in my team's queue with nobody on it: someone transfers it to
   * my team, or a brand-new one arrives. On by default — a chat routed to a
   * team that nobody hears about just sits there.
   */
  teamChats: z.boolean().default(true),
  /** Every message in my team's inboxes — chats colleagues have taken
   *  included. Off by default, deliberately. (A chat nobody has taken yet is
   *  `teamChats`, every message of it until someone does.) */
  teamInbound: z.boolean().default(false),
  /** A new message in one of my Team Chat chats. An @mention of me there
   *  follows `mentions` instead, so it still arrives with this off. */
  chatMessages: z.boolean().default(true),
  /** Silence non-urgent pushes between these times. `end` before `start` means
   *  the window crosses midnight (22:00 → 07:00), which is the usual case. */
  quietHours: z.object({ start: timeOfDay, end: timeOfDay }).nullable().default(null),
  /** IANA zone the quiet hours are read in; the workspace's default when unset. */
  timezone: z.string().max(64).optional(),
  /**
   * Conversations this person has silenced.
   *
   * Kept here rather than in its own table because a mute belongs to a person,
   * not to the thread — two agents on the same busy group should be able to
   * disagree about whether it buzzes. Capped so a long career of muting can't
   * grow the row without bound; the oldest fall off first, which is the right
   * end to lose since a thread muted a year ago is almost certainly resolved.
   */
  mutedConversationIds: z.array(z.string()).max(200).default([]),
});
export type PushPreferences = z.infer<typeof pushPreferencesSchema>;

/** Body for PATCH /devices/mute/:conversationId. */
export const setConversationMutedInputSchema = z.object({ muted: z.boolean() });
export type SetConversationMutedInput = z.infer<typeof setConversationMutedInputSchema>;

/** Every field optional — the client sends only what changed. */
export const updatePushPreferencesInputSchema = pushPreferencesSchema.partial();
export type UpdatePushPreferencesInput = z.infer<typeof updatePushPreferencesInputSchema>;

/** The defaults, as a value. Parsing `{}` applies every `.default()` above, so
 *  this can't drift from the schema. */
export const DEFAULT_PUSH_PREFERENCES: PushPreferences = pushPreferencesSchema.parse({});

/** Set an initial password from an emailed invite link (token → new password). */
export const setPasswordInputSchema = z.object({
  token: z.string().min(10),
  password: z.string().min(8, "Use at least 8 characters"),
});
export type SetPasswordInput = z.infer<typeof setPasswordInputSchema>;

/* ---- Two-factor auth ---- */

/** A 6-digit authenticator/email code — or a one-time recovery code. */
export const twoFactorCodeInputSchema = z.object({
  code: z.string().trim().min(4).max(32),
  /** The half-authenticated token from a tokenAuth login, when there's no
   *  cookie to carry it. */
  pendingToken: z.string().optional(),
  tokenAuth: z.boolean().optional(),
  /** Don't ask this device for a code again for 30 days. */
  rememberDevice: z.boolean().optional(),
});
export type TwoFactorCodeInput = z.infer<typeof twoFactorCodeInputSchema>;

/** Starting authenticator setup: the secret to store + a QR to scan. */
export interface TotpSetup {
  /** Base32 secret, shown for manual entry when a QR can't be scanned. */
  secret: string;
  /** otpauth://… URI encoded in the QR. */
  otpauthUrl: string;
  /** data:image/png;base64,… QR image of `otpauthUrl`. */
  qrDataUrl: string;
}

/** Returned once when 2FA is switched on — the recovery codes to save. */
export interface TwoFactorEnabled {
  recoveryCodes: string[];
}

/** Current 2FA status for the settings panel. */
export interface TwoFactorStatus {
  enabled: boolean;
  method: "totp" | "email" | null;
  recoveryCodesRemaining: number;
}

/** Login when the account has 2FA on: the password step returns this instead of
 *  a session, and the client then posts the code to /auth/login/2fa. */
export interface TwoFactorChallenge {
  twoFactorRequired: true;
  method: "totp" | "email";
  /** Token clients only: the half-authenticated token to post back with the
   *  code. Browsers get the same thing as a short-lived cookie instead. */
  pendingToken?: string;
}

export const groupMemberInputSchema = z.object({
  phone: z.string().min(1),
  name: z.string().optional(),
});
export type GroupMemberInput = z.infer<typeof groupMemberInputSchema>;

export const createGroupInputSchema = z.object({
  inboxId: z.string(),
  name: z.string().min(1),
  // Optional/ignored for the real Groups API: a group is invite-only, so members
  // join via the shared invite link (there is no add-by-phone endpoint). Kept for
  // backward-compatibility with callers that still pass a roster.
  members: z.array(groupMemberInputSchema).max(GROUP_MAX_MEMBERS).optional().default([]),
});
export type CreateGroupInput = z.infer<typeof createGroupInputSchema>;

export const addParticipantInputSchema = groupMemberInputSchema;
export type AddParticipantInput = z.infer<typeof addParticipantInputSchema>;

/* ------------------------------------------------------------------ */
/* Integration settings (Settings › Setup)                             */
/* ------------------------------------------------------------------ */

/**
 * App-level integration settings surfaced to the client. The Google block
 * describes the org's OAuth app: the (non-secret) client id, whether it's fully
 * configured (id + secret present), and the exact redirect URI to register with
 * Google. The client secret is write-only — it is never returned.
 */
export const integrationSettingsSchema = z.object({
  google: z.object({
    clientId: z.string(),
    configured: z.boolean(),
    redirectUri: z.string(),
    /** Optional Pub/Sub topic for Gmail push; empty means polling-only. */
    pubsubTopic: z.string(),
    /** The URL to register as the Pub/Sub push subscription endpoint. */
    pushEndpoint: z.string(),
  }),
  meta: z.object({
    appId: z.string(),
    configured: z.boolean(),
    /** Optional Embedded Signup config id for the guided WhatsApp onboarding. */
    configId: z.string(),
    /** The exact URL to list as a Valid OAuth Redirect URI in the Meta app. */
    redirectUri: z.string(),
  }),
  /** Cloudflare R2 object storage for durable message media. */
  storage: z.object({
    /** True when all four R2 credentials are set (media is stored in R2). */
    configured: z.boolean(),
    /** Non-secret echo: the Cloudflare account id and bucket (keys never echoed). */
    accountId: z.string(),
    bucket: z.string(),
  }),
  /** SMTP (e.g. Gmail) for the app's own transactional email — invites,
   *  password resets and the test send. */
  smtp: z.object({
    /** True when host + username + password + from are all set. */
    configured: z.boolean(),
    /** Non-secret echo — the app password is never returned. */
    host: z.string(),
    port: z.number(),
    username: z.string(),
    from: z.string(),
    secure: z.boolean(),
  }),
  /** Resend (HTTPS API) for the app's own transactional email — the preferred
   *  transport when configured (works where the host blocks outbound SMTP). */
  resend: z.object({
    /** True when an API key is set. */
    configured: z.boolean(),
    /** Non-secret echo — the from-address (the API key is never returned). */
    from: z.string(),
  }),
  /** Push notifications to the phone app, and the Firebase project they travel
   *  through. `configured` is about the Expo access token, which is the only
   *  credential the API itself holds — the Firebase values are identifiers. */
  push: z.object({
    /** True when an Expo access token is set, so sends are authenticated. */
    configured: z.boolean(),
    /** The Firebase project id, e.g. "nestconnect-d5489". */
    projectId: z.string(),
    /** The FCM sender id — `project_number` in google-services.json. */
    projectNumber: z.string(),
    /** The Android app's `mobilesdk_app_id`. */
    appId: z.string(),
    storageBucket: z.string(),
  }),
  /** Claude (Anthropic) — powers the composer's one-tap Polish. */
  anthropic: z.object({
    /** True when an API key is set. */
    configured: z.boolean(),
    /** Non-secret echo — the model id (the API key is never returned). */
    model: z.string(),
    /** The system prompt Polish runs. Editable; seeded with the default below. */
    polishPrompt: z.string(),
    /** Whether new WhatsApp and website-chat conversations get an AI subject. */
    subjects: z.boolean(),
    /** The system prompt that writes them. Editable; seeded with
     *  DEFAULT_SUBJECT_PROMPT. Custom field values are put in front by Nest,
     *  not by the prompt, so they can't be lost by an edit to it. */
    subjectPrompt: z.string(),
  }),
  /** Speech to text (OpenAI) — Transcribe on voice notes. */
  transcription: z.object({
    /** True when an OpenAI API key is set. */
    configured: z.boolean(),
    /** The transcription model id. */
    model: z.string(),
  }),
});
export type IntegrationSettings = z.infer<typeof integrationSettingsSchema>;

/** The default Polish instruction, shown pre-filled in Settings so it can be
 *  tuned per workspace. The constraints are the feature: Polish rewrites HOW
 *  something is said, never WHAT is said. It must not answer the customer,
 *  invent facts (dates, prices, promises), or drop anything the agent wrote. */
export const DEFAULT_POLISH_PROMPT = `You improve a Swiftee support agent's draft reply before they send it.

You are given the recent conversation for context, then the agent's draft. Rewrite the draft into a message that is ready to send.

Do this:
- Elaborate. A draft is usually shorthand — turn it into a proper reply: full sentences, the natural connecting words, and phrasing that reads as an answer to what the customer actually asked.
- Use the conversation only to understand the situation — who they are, what they asked, what has already been said — so the reply lands in context and doesn't repeat what's been covered.
- Write in Swiftee's voice: professional and competent, but warm and human. British English. Direct and specific. Contractions are fine. No corporate filler ("we appreciate your patience at this time"), no grovelling, no exclamation-mark enthusiasm.

Never do this:
- Never invent facts. No prices, dates, times, order numbers, names, links, policies, refunds, discounts or promises that aren't in the agent's draft or in the conversation. If the draft doesn't say when something will arrive, neither does your reply.
- Never answer for the agent. If the draft leaves something the customer asked unaddressed, leave it unaddressed — elaborating a draft is not continuing the conversation.
- Never change the meaning or the level of commitment: a "no" stays a no, a "maybe" stays a maybe, "I'll check" stays "I'll check".
- Never drop anything the agent wrote.
- Leave URLs, order numbers, reference codes, @mentions and emoji exactly as written.
- Don't add a greeting or sign-off the agent didn't write, unless the channel plainly calls for one.

Reply with the finished message only — no preamble, no explanation, no quotes around it.`;

/**
 * The default instruction for a conversation's AI subject, shown pre-filled in
 * Settings › Integrations › AI so it can be tuned.
 *
 * It writes the *topic* only. Custom field values (an order number, an
 * application id) are put in front by Nest itself — "Order ID DG-88412 ·
 * Refund for damaged parcel" — which is why it is told not to repeat them.
 */
export const DEFAULT_SUBJECT_PROMPT = `You write the subject line for a customer conversation in a shared support inbox, so an agent scanning the list can tell at a glance what each chat is about.

You are given the start of the conversation. Write a subject that says what the customer wants or what has happened.

Do this:
- 3 to 7 words. For example: "Refund for damaged parcel", "Change delivery address", "Question about application status".
- Be specific: name the product, problem or request when the customer did.
- Sentence case, British English, no full stop.

Never do this:
- Never invent anything the customer didn't say.
- Never include the customer's name, phone number, email address or other personal details.
- Don't repeat the reference details you are told are already shown beside the subject.
- If the customer hasn't yet said what they want (just "Hi" or "Hello"), reply with exactly: General enquiry

Reply with the subject only — no quotes, no preamble.`;

/** Update the app-level integration credentials. Secrets are written only when
 *  a non-empty value is supplied (so they can be left blank to keep the stored
 *  one); non-secret ids/config are written whenever provided, empty to clear. */
export const updateIntegrationSettingsInputSchema = z.object({
  googleClientId: z.string().optional(),
  googleClientSecret: z.string().optional(),
  googlePubsubTopic: z.string().optional(),
  metaAppId: z.string().optional(),
  metaAppSecret: z.string().optional(),
  metaConfigId: z.string().optional(),
  /** Cloudflare R2: account id + bucket write on any change (empty clears);
   *  the access key id + secret are written only when a non-empty value is sent. */
  r2AccountId: z.string().optional(),
  r2AccessKeyId: z.string().optional(),
  r2SecretAccessKey: z.string().optional(),
  r2Bucket: z.string().optional(),
  /** SMTP transactional email. Host/port/username/from/secure write on any change
   *  (empty clears); the app password is written only when a non-empty value is
   *  sent, so it can be left blank to keep the stored one. */
  smtpHost: z.string().optional(),
  smtpPort: z.coerce.number().int().min(1).max(65535).optional(),
  smtpUsername: z.string().optional(),
  smtpPassword: z.string().optional(),
  smtpFrom: z.string().optional(),
  smtpSecure: z.boolean().optional(),
  /** Resend transactional email. `resendFrom` writes on any change (empty clears);
   *  the API key is written only when a non-empty value is sent, so it can be left
   *  blank to keep the stored one. */
  resendApiKey: z.string().optional(),
  resendFrom: z.string().optional(),
  /** Push. The Firebase identifiers write on any change (empty clears, falling
   *  back to the environment); the Expo access token is written only when a
   *  non-empty value is sent, so it can be left blank to keep the stored one. */
  expoAccessToken: z.string().optional(),
  firebaseProjectId: z.string().optional(),
  firebaseProjectNumber: z.string().optional(),
  firebaseAppId: z.string().optional(),
  firebaseStorageBucket: z.string().optional(),
  /** Claude (Anthropic). The model and prompt write on any change (empty resets
   *  to the default); the API key is written only when a non-empty value is
   *  sent, so it can be left blank to keep the stored one. */
  anthropicApiKey: z.string().optional(),
  anthropicModel: z.string().optional(),
  anthropicPolishPrompt: z.string().optional(),
  /** AI subjects for new WhatsApp and website-chat conversations: the switch,
   *  and the prompt (empty resets it to the default). */
  anthropicSubjects: z.boolean().optional(),
  anthropicSubjectPrompt: z.string().optional(),
  /** Speech to text for Transcribe. The key is written only when non-empty;
   *  the model on any change (empty resets it to the default). */
  openaiApiKey: z.string().optional(),
  transcribeModel: z.string().optional(),
});
export type UpdateIntegrationSettingsInput = z.infer<typeof updateIntegrationSettingsInputSchema>;

/* ------------------------------------------------------------------ */
/* AI assist — one-tap Polish on a draft reply.                        */
/* ------------------------------------------------------------------ */

/** Polish a draft. `channel` only tunes register (a WhatsApp line is shorter
 *  and less formal than an email); it never changes what the draft says. */
export const polishDraftInputSchema = z.object({
  text: z.string().min(1).max(5000),
  channel: channelTypeSchema.optional(),
  /** Internal notes are polished for teammates, not customers. */
  internal: z.boolean().optional(),
  /** The thread being replied to. The server loads the recent messages itself
   *  (the client never sends history) so the model can see what's actually
   *  being discussed and the reply lands in context. */
  conversationId: z.string().optional(),
});
export type PolishDraftInput = z.infer<typeof polishDraftInputSchema>;

export const polishDraftResultSchema = z.object({
  /** The polished draft. Equal to the input when the model left it alone. */
  text: z.string(),
  /** True when the model returned something different from the draft. */
  changed: z.boolean(),
});
export type PolishDraftResult = z.infer<typeof polishDraftResultSchema>;

/** A "forgot my password" request — emails a reset link if the address matches. */
export const forgotPasswordInputSchema = z.object({ email: z.string().email() });
export type ForgotPasswordInput = z.infer<typeof forgotPasswordInputSchema>;

/* ------------------------------------------------------------------ */
/* Notifications (the bell) — a per-user history of noteworthy events.  */
/* High-frequency events (a new inbound chat) stay sound-only and never */
/* land here.                                                           */
/* ------------------------------------------------------------------ */
/** mention / snooze_due / team_transfer (a chat sent to your team) open a
 *  conversation; ops_review (an SOP of yours is due for review) and
 *  ops_must_read (a must-read for your team) open the SOP; chat_mention (an
 *  @mention in Team Chat) opens the chat. */
export const notificationTypeSchema = z.enum(["mention", "snooze_due", "team_transfer", "ops_review", "ops_must_read", "chat_mention", "channel_reauth"]);
export type NotificationType = z.infer<typeof notificationTypeSchema>;

export const notificationSchema = z.object({
  id: z.string(),
  type: notificationTypeSchema,
  /** Short headline (e.g. "James mentioned you"). */
  title: z.string(),
  /** Optional detail line (e.g. the note snippet or the customer name). */
  body: z.string().default(""),
  /** The conversation to open when the notification is tapped. */
  conversationId: z.string().nullable().optional(),
  /** The Business Ops SOP to open instead. */
  opsSopId: z.string().nullable().optional(),
  /** The Team Chat chat to open instead. */
  chatRoomId: z.string().nullable().optional(),
  read: z.boolean().default(false),
  createdAt: z.string(),
});
export type Notification = z.infer<typeof notificationSchema>;

/* ------------------------------------------------------------------ */
/* Realtime event contract (Socket.IO)                                 */
/* ------------------------------------------------------------------ */

/** Event names the server emits to clients. */
export const ServerEvent = {
  MessageCreated: "message.created",
  MessageUpdated: "message.updated",
  ConversationUpdated: "conversation.updated",
  ConversationAssigned: "conversation.assigned",
  Typing: "typing",
  Presence: "presence",
  InboxCounts: "inbox.counts",
  Notification: "notification",
  MessageCue: "message.cue",
} as const;
export type ServerEventName = (typeof ServerEvent)[keyof typeof ServerEvent];

export interface CoreServerToClientEvents {
  [ServerEvent.MessageCreated]: (p: { conversationId: string; message: Message }) => void;
  /**
   * "This one is for you" — the alert half of a new message, sent only to the
   * people the notification policy picked.
   *
   * Separate from `MessageCreated` because that one is a broadcast: every open
   * client in the workspace gets it, which is right for keeping lists and
   * threads current and wrong for deciding whether to make a noise. Sounding on
   * the broadcast is what made a shared inbox chime for every arrival, whoever
   * it belonged to. This goes to `user:<id>` rooms instead, so the desktop is
   * told exactly what the phone would have been told — same preferences, same
   * mutes, same quiet hours, one rule.
   */
  [ServerEvent.MessageCue]: (p: { conversationId: string; kind: "message" | "team_message" }) => void;
  [ServerEvent.MessageUpdated]: (p: { conversationId: string; message: Message }) => void;
  [ServerEvent.ConversationUpdated]: (p: { conversation: Conversation }) => void;
  [ServerEvent.ConversationAssigned]: (p: {
    conversation: Conversation;
    by?: string;
    reason?: string;
  }) => void;
  /**
   * Somebody is writing on this thread.
   *
   * `preview` is what they have typed so far, and only ever comes from a
   * NestChat visitor: our own widget is the one place we hold the draft, and a
   * live chat is the one place seeing it early is worth anything — you can be
   * looking something up before they finish asking. WhatsApp and email give us
   * nothing to show, and an agent's own half-written reply is deliberately not
   * broadcast to their colleagues: watching a teammate type and retype is
   * surveillance, not presence. Never stored — it exists between two sockets.
   */
  [ServerEvent.Typing]: (p: {
    conversationId: string;
    who: string;
    typing: boolean;
    preview?: string;
  }) => void;
  [ServerEvent.Presence]: (p: { userId: string; online: boolean }) => void;
  [ServerEvent.InboxCounts]: (p: { inboxId: string; unread: number }) => void;
  [ServerEvent.Notification]: (p: { notification: Notification }) => void;
}

/** Everything the server sends, Team Chat included. */
export interface ServerToClientEvents extends CoreServerToClientEvents, ChatServerEvents {}

/** Event names / payloads the client emits to the server. */
export const ClientEvent = {
  JoinConversation: "conversation:join",
  LeaveConversation: "conversation:leave",
  Typing: "typing",
} as const;

export interface ClientToServerEvents extends ChatClientEvents {
  [ClientEvent.JoinConversation]: (p: { conversationId: string }) => void;
  [ClientEvent.LeaveConversation]: (p: { conversationId: string }) => void;
  /** `who` is the sender's display name, echoed to other agents on the thread. */
  [ClientEvent.Typing]: (p: { conversationId: string; typing: boolean; who?: string }) => void;
}

/* ------------------------------------------------------------------ */
/* Analytics (admin/manager insights dashboard)                        */
/* ------------------------------------------------------------------ */

/** The named time windows the dashboard offers (plus a resolved from/to). */
export const analyticsRangeSchema = z.enum(["7d", "30d", "90d", "12m"]);
export type AnalyticsRange = z.infer<typeof analyticsRangeSchema>;

/** Query params for GET /api/analytics. `channel`/`teamId`/`agentUserId` accept
 *  "all" (or omission) to mean no filter. */
export const analyticsQuerySchema = z.object({
  range: analyticsRangeSchema.default("30d"),
  channel: z.union([channelTypeSchema, z.literal("all")]).default("all"),
  teamId: z.string().default("all"),
  agentUserId: z.string().default("all"),
});
export type AnalyticsQueryInput = z.infer<typeof analyticsQuerySchema>;

/** One point on the daily volume series. */
export interface AnalyticsDailyPoint {
  date: string; // YYYY-MM-DD
  conversations: number;
  inbound: number;
  outbound: number;
}

/** The fully-computed dashboard payload returned by the analytics endpoint. */
export interface AnalyticsResult {
  range: { key: AnalyticsRange; from: string; to: string; days: number };
  filters: { channel: ChannelType | "all"; teamId: string | "all"; agentUserId: string | "all" };
  /** Headline numbers for the KPI cards, each with its previous-period value so
   *  the UI can show a delta. `firstResponse`/`resolution` are in milliseconds. */
  kpis: {
    conversations: number;
    messages: number;
    inbound: number;
    outbound: number;
    newContacts: number;
    activeAgents: number;
    avgFirstResponseMs: number | null;
    medianFirstResponseMs: number | null;
    resolved: number;
    resolutionRate: number; // 0..1
    responseRate: number; // 0..1 — share of conversations that got an agent reply
    avgMessagesPerConversation: number;
    /** Same metrics over the immediately preceding equal-length window. */
    prev: {
      conversations: number;
      messages: number;
      newContacts: number;
      avgFirstResponseMs: number | null;
    };
  };
  /** "Right now" status counts across the (filtered) conversation set. */
  snapshot: { open: number; pending: number; snoozed: number; closed: number; unassigned: number; total: number };
  daily: AnalyticsDailyPoint[];
  byChannel: Array<{ channel: ChannelType; conversations: number; messages: number }>;
  byStatus: Array<{ status: ConversationStatus; count: number }>;
  byPriority: Array<{ priority: Priority; count: number }>;
  byTeam: Array<{ teamId: string | null; name: string; conversations: number }>;
  byLabel: Array<{ labelId: string; name: string; color: string; conversations: number }>;
  /** Per-agent leaderboard, busiest first. */
  agents: Array<{
    userId: string;
    name: string;
    avatarColor: string | null;
    conversations: number;
    replies: number;
    avgFirstResponseMs: number | null;
  }>;
  /** Message volume by weekday × hour: 168 counts, index = weekday*24 + hour,
   *  weekday 0 = Monday. Drives the activity heatmap. */
  heatmap: number[];
  /** First-response-time distribution across labelled buckets. */
  responseBuckets: Array<{ label: string; count: number }>;
}
export * from "./accounts";
export * from "./macros";
export * from "./signatures";
export * from "./mentions";
export * from "./links";
export * from "./recipients";
export * from "./ops";
export * from "./conversation-log";
export * from "./sms";
export * from "./chat";

/**
 * Audio an iPhone can't play as recorded: Opus in WebM (Chrome, Edge) or Ogg
 * (Firefox), which is what a browser's recorder makes. The phone app asks the
 * server for an AAC copy of these (`/media/:id?as=m4a`); desktop browsers and
 * WhatsApp keep the original.
 */
export function needsPhoneAudio(mime: string | null | undefined): boolean {
  const base = (mime ?? "").split(";")[0]!.trim().toLowerCase();
  return base === "audio/webm" || base === "video/webm" || base === "audio/ogg" || base === "audio/opus";
}
