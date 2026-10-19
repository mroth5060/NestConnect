import type { WorkspaceStatus } from "../tenancy/workspace-status";
import type {
  ConversationFilterCounts,
  CreateCustomFieldInput,
  CustomField,
  CustomFieldEntity,
  CustomFieldValue,
  UpdateCustomFieldInput,
  Attachment,
  AttachmentKind,
  ChannelType,
  Contact,
  ContactDuplicateGroup,
  ContactIdentityKind,
  ContactWithConversations,
  Conversation,
  ConversationPage,
  ConversationStatus,
  ConversationEventType,
  ConversationWithMessages,
  CreateTemplateInput,
  Inbox,
  Label,
  Member,
  Message,
  MessageAuto,
  MessagePage,
  MessageStatus,
  MessageType,
  Notification,
  Participant,
  ParticipantRole,
  Priority,
  Role,
  RoutingStrategy,
  Team,
  Template,
  UpdateTemplateInput,
  User,
  AvailabilitySchedule,
} from "@ding/schemas";

export interface ViewItem {
  key: string;
  title: string;
  count: number;
  channel?: ChannelType;
  handle?: string;
  /** For a WhatsApp number: the group conversations it hosts (nested in the sidebar). */
  groups?: { id: string; title: string }[];
  /** For "Later": how many snoozed items are now due (wake time passed). */
  due?: number;
  /** For a label view: its swatch colour. */
  color?: string;
}

export interface SidebarViews {
  my: ViewItem[];
  shared: { teams: ViewItem[]; inboxes: ViewItem[]; labels: ViewItem[] };
}

/** A sign-in session row, as the store returns it (dates are ISO strings). */
export interface StoredSession {
  id: string;
  userId: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
}

/** A phone registered for push. `pushToken` is the address we send to and the
 *  row's real identity; `disabledAt` marks a token the push service told us is
 *  dead, or one whose owner revoked notification permission. */
export interface StoredDevice {
  id: string;
  userId: string;
  sessionId: string | null;
  pushToken: string;
  platform: string;
  appVersion: string | null;
  osVersion: string | null;
  deviceName: string | null;
  createdAt: string;
  lastSeenAt: string;
  disabledAt: string | null;
  disabledReason: string | null;
}

/**
 * A customer's phone, registered by the in-app SDK.
 *
 * `token` is the address and the row's identity — the same rule as
 * {@link StoredDevice}'s push token, for the same reason: a handset that
 * reinstalls or signs in as someone else presents the same token, and one
 * address must never ring for two people.
 */
export interface StoredCustomerDevice {
  id: string;
  orgId: string;
  contactId: string;
  /** The channel that registered it. A reply on one app must not ring another. */
  inboxId: string;
  token: string;
  platform: string;
  createdAt: string;
  lastSeenAt: string;
  disabledAt: string | null;
  disabledReason: string | null;
}

/** One of the workspaces a person is in: their place there, and the workspace. */
export interface WorkspaceMembership {
  user: User;
  orgName: string;
  sandbox: boolean;
  /** Anything but "active" is frozen: no signing in there. */
  status: WorkspaceStatus;
}

/** A workspace, as the platform's owners see it in their list. */
export interface WorkspaceSummary {
  id: string;
  name: string;
  sandbox: boolean;
  createdAt: string;
  people: number;
  channels: number;
  conversations: number;
  status: WorkspaceStatus;
  statusAt: string | null;
  /** When a workspace being deleted is wiped for good. */
  purgeAt: string | null;
}

/** Someone in a workspace, as the platform's owners manage them from outside. */
export interface WorkspacePerson {
  user: User;
  /** Invited, and hasn't set a password yet. */
  pending: boolean;
}

/** A user's two-factor state (the TOTP secret is encrypted at rest). */
export interface TwoFactorState {
  enabled: boolean;
  method: string | null; // "totp" | "email"
  totpSecret: string | null;
  emailCodeHash: string | null;
  emailCodeExpires: string | null;
}

/** Canonical inbound message handed to the store by a channel gateway. */
export interface InboundContact {
  kind: "phone" | "email" | "wa_id";
  value: string;
  displayName: string;
}

/** A media file to store on a message (the storage key is already written). */
export interface AttachmentInput {
  storageKey: string;
  kind: AttachmentKind;
  mime: string;
  size: number;
  filename: string;
  durationMs?: number;
  width?: number;
  height?: number;
  waveform?: number[];
}

export interface AppendInboundInput {
  authorName?: string;
  body: string;
  /** Sanitized HTML body for a rich inbound email (already scrubbed). */
  bodyHtml?: string;
  channelMsgId?: string;
  /** The channel this inbound message arrived on (thread may span channels). */
  channel?: ChannelType;
  messageType?: MessageType;
  attachments?: AttachmentInput[];
  /** Id of the message this inbound one quotes/replies to (already resolved). */
  quotedMsgId?: string;
  /** The customer forwarded this to us rather than writing it (WhatsApp tells us).
   *  Worth showing: it changes how an agent should read the message. */
  forwarded?: boolean;
  /** An email sent from one address with Reply-To another (a website form):
   *  the address it actually came from. Shown as "via …" on the message. */
  emailVia?: string;
}

/** One email thread brought in from a mailbox (see `importEmailThread`). */
export interface ImportEmailThreadInput {
  orgId: string;
  inboxId: string;
  contactId: string;
  subject?: string;
  /** The mailbox's own thread id, so replies go back into the same thread. */
  channelRef?: string;
  assigneeUserId?: string | null;
  assignedTeamId?: string | null;
  /** Oldest first. */
  messages: Array<{
    direction: "in" | "out";
    authorName: string;
    body: string;
    /** Already sanitized. */
    bodyHtml?: string;
    channelMsgId?: string;
    sentAt: Date;
    attachments?: AttachmentInput[];
  }>;
}

/** What the media-serving endpoint needs to stream a stored file. */
export interface StoredAttachmentRef {
  storageKey: string;
  mime: string;
  filename: string;
}

/** Channel-specific hints persisted so an outbound message can be (re)sent from
 *  the DB alone after a restart — no reliance on in-flight job payloads. */
export interface OutboundDeliveryMeta {
  template?: { name: string; language: string; params: string[] };
  /** Email subject this message was sent with (email channel only). */
  subject?: string;
  cc?: string[];
  bcc?: string[];
  /** The sender's HTML signature, snapshotted at send time. Appended to the
   *  outbound email body only — never stored on the message shown in-app. */
  signatureHtml?: string;
  /** Forward recipients (email channel). When set, the send is routed to these
   *  addresses as a fresh "Fwd:" email — a new thread, not a reply to the
   *  customer — while still logged in the current conversation. First address is
   *  the To; any others are Cc. */
  forwardTo?: string[];
}

/** A per-recipient email open-tracking row to register at send time (one per
 *  To/Cc address; `token` is the unguessable id embedded in its pixel URL). */
export interface EmailRecipientInput {
  address: string;
  kind: "to" | "cc";
  token: string;
}

/**
 * Ignore email "opens" that arrive within this SHORT window of sending. Gmail (and
 * other clients) fetch the tracking pixel when the recipient OPENS the mail — not
 * on delivery — and respect per-recipient URLs, so a genuine open is reliable and
 * essentially never lands in the first few seconds. This window only swallows the
 * send-instant race (chiefly the sender's own client rendering the just-sent Sent
 * copy). It is deliberately small: a longer window was suppressing real opens,
 * because once a client caches the pixel it won't re-fetch, so a missed early hit
 * becomes a permanently-missed open. (The complete fix for the sender viewing
 * their own Sent copy is stripping the pixel from that copy — a Gmail-API step we
 * can add if self-opens prove a problem in practice.)
 */
export const EMAIL_OPEN_GRACE_MS = 10_000;

/** The minimal record the delivery worker needs to (re)send an outbound message. */
export interface OutboundMessageRef {
  messageId: string;
  conversationId: string;
  status: MessageStatus;
  channelMsgId?: string;
  internal: boolean;
  deliveryMeta?: OutboundDeliveryMeta;
}

/** A message status change to broadcast (returned by the delivery-state writers). */
export interface MessageStatusChange {
  conversationId: string;
  message: Message;
  /** The workspace the message belongs to. Set by lookups that cross tenants
   *  (a tracking pixel), so the caller can act in it. */
  orgId?: string;
}

/** A recorded inbound-webhook problem (unmapped account, bad signature, …). */
export interface WebhookDiagnostic {
  id: string;
  channel: string;
  kind: string;
  reference?: string;
  detail?: string;
  createdAt: string;
}

/** Filter for an analytics query. Null on any field = no filter for that dimension. */
export interface AnalyticsQuery {
  from: string; // ISO, inclusive
  to: string; // ISO, exclusive
  channel?: ChannelType | null;
  teamId?: string | null;
  agentUserId?: string | null;
}

/** One conversation created in the window, with the per-thread facts analytics
 *  needs (first response, message counts, labels) already derived by the store. */
export interface AnalyticsConvo {
  id: string;
  channel: ChannelType;
  status: ConversationStatus;
  assigneeUserId: string | null;
  assignedTeamId: string | null;
  priority: Priority;
  createdAt: string;
  lastActivityAt: string;
  /** First inbound (customer) message time; null if none. */
  firstInboundAt: string | null;
  /** First agent reply (non-internal outbound) time; null if unanswered. */
  firstReplyAt: string | null;
  /** Author of that first reply, for the per-agent response-time leaderboard. */
  firstReplyUserId: string | null;
  labelIds: string[];
  inbound: number;
  outbound: number;
}

/** One message sent/received in the window (lightweight, for series + heatmap). */
export interface AnalyticsMsg {
  createdAt: string;
  direction: "in" | "out";
  internal: boolean;
  authorUserId: string | null;
  channel: ChannelType;
}

/** The raw materials the analytics service aggregates into an AnalyticsResult.
 *  `conversations` are those CREATED in the window; `messages` are those SENT in
 *  it (their conversation may be older). Both respect the query's filters. */
export interface AnalyticsBundle {
  conversations: AnalyticsConvo[];
  messages: AnalyticsMsg[];
  /** Contacts created in the window (org-wide; not channel/team filtered). */
  newContacts: number;
  /** Current status counts across the filtered conversation set (not windowed). */
  snapshot: { open: number; pending: number; snoozed: number; closed: number; unassigned: number; total: number };
}

/**
 * The data-access contract for the platform. Two implementations exist:
 * `MemoryStore` (zero-infra fixtures) and `PrismaStore` (Postgres). Services
 * depend on this abstract token, never on a concrete store — so persistence is
 * a swap in `DataModule`, nothing more.
 */
/** What the conversation log compares before and after a change. */
export interface ConversationState {
  status: ConversationStatus;
  assigneeUserId: string | null;
  assignedTeamId: string | null;
  priority: Priority;
  snoozedUntil: string | null;
}

export interface ConversationEventInput {
  type: ConversationEventType;
  actorKind: "agent" | "customer" | "system";
  actorUserId?: string | null;
  data?: Record<string, unknown>;
}

export interface ConversationEventRow extends Required<ConversationEventInput> {
  id: string;
  createdAt: string;
}

/**
 * Which side of a list view a page comes from. A view's list carries closed
 * conversations too (for the Closed chip); paged together, newest first, a
 * channel with many recently closed threads put its one open thread past the
 * first page, and the list showed nothing above an "All 1" chip.
 */
export type ListStatus = "active" | "closed";

export abstract class Store {
  /** The current demo user until real auth resolves identity per-request. */
  abstract get demoUserId(): string;

  /** Cheap liveness probe of the persistence layer (SELECT 1 / no-op). */
  abstract healthCheck(): Promise<boolean>;

  /** A user in the bound workspace. */
  abstract getUser(id: string): Promise<User | undefined>;
  /** The user a verified session token names, in whichever workspace they are —
   *  how a request learns its tenant. Cross-tenant; for authentication only. */
  abstract getUserForAuth(id: string): Promise<User | undefined>;
  /** Who an email address signs in as: one person (a Login), into the
   *  workspace they were last in. Nothing when the address signs in as
   *  nobody. Cross-tenant. */
  abstract findUserByEmail(email: string): Promise<User | undefined>;
  /** Whether this address signs in as anyone, anywhere. Cross-tenant. */
  abstract emailInUse(email: string): Promise<boolean>;
  /** Whether the bound workspace already has someone with this address. */
  abstract emailInWorkspace(email: string): Promise<boolean>;

  /* ---- one person, several workspaces ---- */

  /** Every workspace this person is in (their place in each). Cross-tenant. */
  abstract listMemberships(userId: string): Promise<WorkspaceMembership[]>;
  /** This person's place in another workspace, if they have one. Cross-tenant. */
  abstract membershipIn(userId: string, orgId: string): Promise<User | undefined>;
  /** Signing in takes them to the workspace this user is in, from now on. */
  abstract rememberWorkspace(userId: string): Promise<void>;
  /** Give this person a place in another workspace, as who they are here. */
  abstract joinWorkspace(userId: string, orgId: string, role: Role): Promise<User>;
  /** Every workspace on the platform. Cross-tenant; for its owners. */
  abstract listWorkspaces(): Promise<WorkspaceSummary[]>;
  /** A new, empty workspace. */
  abstract createWorkspace(name: string): Promise<{ id: string; name: string }>;
  abstract renameWorkspace(orgId: string, name: string): Promise<void>;
  /** Suspend, archive, schedule for deletion (with when), or make active again.
   *  Also updates which workspaces are frozen, on this node. */
  abstract setWorkspaceStatus(orgId: string, status: WorkspaceStatus, purgeAt: Date | null): Promise<void>;
  /** Load which workspaces are frozen (workspace-status.ts). */
  abstract refreshWorkspaceStatuses(): Promise<void>;
  /** Everyone in a workspace, for its management from outside. Cross-tenant. */
  abstract listWorkspacePeople(orgId: string): Promise<WorkspacePerson[]>;
  /** End every session in a workspace (and its phones' push). Cross-tenant. */
  abstract revokeWorkspaceSessions(orgId: string): Promise<number>;
  /** A fresh invite for someone who hasn't set a password yet; undefined if
   *  they have one. In the bound workspace. */
  abstract reissueInvite(userId: string): Promise<string | undefined>;
  /** Workspaces being deleted whose time has come. */
  abstract listWorkspacesDueForPurge(now: Date): Promise<string[]>;
  /** Wipe a workspace and everything in it, for good. Returns the storage keys
   *  of its files, for the caller to delete. */
  abstract purgeWorkspace(orgId: string): Promise<{ files: string[] }>;
  abstract getPasswordHash(userId: string): Promise<string | undefined>;
  abstract teamsForUser(userId: string): Promise<string[]>;
  abstract me(userId: string): Promise<{ user?: User; teams: Team[] }>;
  /**
   * Make this inbox its channel's send-from default, or clear that flag.
   *
   * Clearing the channel's previous default is part of the same operation: the
   * database refuses two defaults of one type (a partial unique index), and
   * more to the point "the default" is singular by definition. Setting one
   * never touches another channel's.
   */
  abstract setDefaultInbox(inboxId: string, on: boolean): Promise<Inbox | undefined>;

  /** Every inbox in the org, **oldest first**. The order is part of the
   *  contract: it is what makes "the channel's default inbox" the same answer
   *  twice running, which a cross-channel reply depends on to pick the number
   *  it sends from. */
  abstract listInboxes(): Promise<Inbox[]>;
  /** Every workspace's inboxes of one type, for a background job that covers
   *  them all (Gmail polling). Cross-tenant: each inbox must then be handled
   *  inside its own workspace (`runInTenant(inbox.orgId, …)`). */
  abstract listInboxesAcrossWorkspaces(type: ChannelType): Promise<Inbox[]>;
  /** The workspace an inbox belongs to. Cross-tenant: how a signed chat-widget
   *  token, which names its channel, learns which workspace it is acting in. */
  abstract inboxOrg(inboxId: string): Promise<string | undefined>;
  /** Whether a workspace is a demo sandbox (see tenancy/sandbox.ts). */
  abstract isSandboxOrg(orgId: string): Promise<boolean>;
  /** The workspace's own name — the business, as its customers know it. */
  abstract getOrganizationName(orgId: string): Promise<string | undefined>;
  /** The workspace a conversation belongs to. Cross-tenant: for a queued job
   *  recorded before jobs carried their workspace. */
  abstract conversationOrg(conversationId: string): Promise<string | undefined>;
  abstract createInbox(params: {
    orgId: string;
    type: ChannelType;
    name: string;
    handle: string;
    teamIds: string[];
    routingStrategy: RoutingStrategy;
    channelConfig?: Record<string, string>;
  }): Promise<Inbox>;
  /** Edit a channel: rename, re-route, change strategy, merge new credentials. */
  abstract updateInbox(
    id: string,
    params: {
      name?: string;
      teamIds?: string[];
      routingStrategy?: RoutingStrategy;
      channelConfig?: Record<string, string>;
      contactTag?: string;
      conversationLabelId?: string | null;
    },
  ): Promise<Inbox | undefined>;
  /** Save an email channel's signature design (already sanitised). */
  abstract setInboxSignature(
    id: string,
    signature: { layoutHtml: string | null; footerHtml: string | null },
  ): Promise<Inbox | undefined>;
  /** Delete a channel and the conversations that belong to it. */
  abstract deleteInbox(id: string): Promise<void>;
  /** A single inbox by id (includes orgId/type; channelConfig stays backend-only). */
  abstract getInbox(id: string): Promise<Inbox | undefined>;
  /** The raw integration credentials for an inbox (backend-only — tokens etc.). */
  abstract getInboxConfig(id: string): Promise<Record<string, string> | undefined>;

  /* ---- app-level settings (org-scoped key/value) ---- */
  /** Read an org-scoped app setting (e.g. the Google OAuth client id/secret). */
  abstract getAppSetting(orgId: string, key: string): Promise<string | undefined>;
  /** Create or update an org-scoped app setting. */
  abstract setAppSetting(orgId: string, key: string, value: string): Promise<void>;
  /** A platform setting (storage, system email, push, app credentials) — kept
   *  with the platform's own workspace, read the same from any workspace. */
  abstract getPlatformSetting(key: string): Promise<string | undefined>;
  abstract setPlatformSetting(key: string, value: string): Promise<void>;

  /* ---- WhatsApp message templates (org-scoped) ---- */
  abstract listTemplates(orgId: string): Promise<Template[]>;
  abstract getTemplate(id: string): Promise<Template | undefined>;
  abstract createTemplate(orgId: string, input: CreateTemplateInput): Promise<Template>;
  abstract updateTemplate(id: string, input: UpdateTemplateInput): Promise<Template | undefined>;
  abstract deleteTemplate(id: string): Promise<void>;
  /**
   * Upsert a template synced from Meta, keyed by (orgId, wabaId, name, language).
   *
   * `wabaId` is which WhatsApp account the template came from. Two accounts may
   * each hold their own "order_update" in English and they are different
   * templates, so the account is part of the key rather than a detail on the
   * row. An unclaimed row (no wabaId) matching by name and language is adopted
   * rather than duplicated — that is how templates stored before accounts were
   * tracked find out whose they are.
   */
  abstract upsertTemplateByName(
    orgId: string,
    // `variableDefaults` is deliberately not accepted: a sync brings Meta's
    // name, body and status, while what we pre-fill the variables with is
    // ours, and a re-sync must never reset it.
    input: Omit<CreateTemplateInput, "variableDefaults"> & {
      approvalStatus: Template["approvalStatus"];
      wabaId?: string;
    },
  ): Promise<Template>;

  /**
   * Delete this account's templates that Meta no longer has, naming the ones it
   * does. Returns how many went.
   *
   * Sync was append-only, so a template deleted at Meta lingered here forever
   * and an agent could still pick it — a send that fails at Meta rather than a
   * template that quietly disappears. Only rows already claimed by this account
   * are touched: unclaimed ones may belong to another account we have not
   * synced yet, and locally authored ones belong to nobody.
   */
  abstract pruneTemplatesForWaba(
    orgId: string,
    wabaId: string,
    keep: Array<{ name: string; language: string }>,
  ): Promise<number>;

  /* ---- settings: teams & people ---- */
  abstract listTeams(): Promise<Team[]>;
  abstract listMembers(): Promise<Member[]>;
  abstract createTeam(params: { orgId: string; name: string; icon?: string; slaMinutes?: number | null }): Promise<Team>;
  abstract updateTeam(
    id: string,
    params: { name?: string; icon?: string | null; slaMinutes?: number | null },
  ): Promise<Team | undefined>;
  /** Fetch a single team by id (used to resolve its SLA target). */
  abstract getTeam(id: string): Promise<Team | undefined>;
  /** Delete a team, detaching its members, inbox routing and any assignments. */
  abstract deleteTeam(id: string): Promise<void>;
  /** Persist a new team ordering; ids not present keep their relative order after. */
  abstract reorderTeams(orderedIds: string[]): Promise<Team[]>;
  /**
   * The same for channels — what the arrows in Settings write.
   *
   * Ids not in the list keep their relative order after the ones that are,
   * which is what makes a channel connected in another tab land at the end
   * rather than silently jumping to the top of somebody's sidebar.
   */
  abstract reorderInboxes(orderedIds: string[]): Promise<Inbox[]>;
  /**
   * Create a user. With `password` set (seeding) the account can log in straight
   * away; without it, a single-use invite token is minted and returned so the
   * invitee can set their own password — the account has no usable password
   * until they do.
   */
  abstract createUser(params: {
    orgId: string;
    name: string;
    email: string;
    role: Role;
    teamIds: string[];
    position?: string | null;
    password?: string;
  }): Promise<{ user: User; inviteToken?: string; joinedExisting?: boolean }>;
  /** Consume an invite token, set the user's password, and return the user. */
  abstract setPasswordByInviteToken(token: string, password: string): Promise<User | undefined>;
  /**
   * Mint a fresh single-use token for an EXISTING user by email — used by
   * "forgot password". Reuses the invite-token storage + set-password flow.
   * Returns the raw token + user, or null when no such user exists (the caller
   * still responds success either way, to avoid leaking which emails exist).
   */
  abstract createPasswordResetToken(email: string): Promise<{ user: User; token: string } | null>;
  abstract updateUser(
    id: string,
    params: { name?: string; role?: Role; teamIds?: string[]; position?: string | null },
  ): Promise<User | undefined>;
  /** A user updating their OWN personal settings (availability). */
  abstract updateMyPreferences(
    userId: string,
    params: { available?: boolean; schedule?: AvailabilitySchedule | null },
  ): Promise<User | undefined>;
  /** A user updating their OWN profile (name, login email, photo, position). Email
   *  uniqueness within the org is enforced by the caller. */
  abstract updateMyProfile(
    userId: string,
    params: { name?: string; email?: string; avatarUrl?: string | null; position?: string | null },
  ): Promise<User | undefined>;
  /** Set a user's password to a new plaintext value (hashed in the store). */
  abstract setUserPassword(userId: string, password: string): Promise<void>;
  /** Remove a person, detaching their team memberships and clearing assignments. */
  abstract deleteUser(id: string): Promise<void>;

  /* ---- sign-in sessions ("where you're logged in" + remote sign-out) ---- */

  /** Record a new signed-in device; its id becomes the JWT's `jti`. */
  abstract createSession(userId: string, meta: { ip?: string; userAgent?: string }): Promise<StoredSession>;
  /** Fetch a session by id (for the guard's revocation check). */
  abstract getSession(id: string): Promise<StoredSession | undefined>;
  /** A user's sessions, active first, newest first (for the settings list). */
  abstract listSessions(userId: string): Promise<StoredSession[]>;
  /** Bump a session's lastSeenAt (throttled by the caller). */
  abstract touchSession(id: string): Promise<void>;
  /** Revoke one of a user's own sessions. Returns false if it isn't theirs. */
  abstract revokeSession(userId: string, id: string): Promise<boolean>;
  /** Revoke all of a user's sessions except `keepId`; returns the count revoked. */
  abstract revokeOtherSessions(userId: string, keepId: string): Promise<number>;

  /* ---- push devices ---- */

  /** Register (or re-register) a device by its push token. The token is the
   *  identity: the same one always maps to the same row, and re-registering
   *  re-enables a row that was disabled, since the token proves it's alive. */
  abstract upsertDevice(params: {
    userId: string;
    sessionId?: string;
    pushToken: string;
    platform: string;
    appVersion?: string;
    osVersion?: string;
    deviceName?: string;
  }): Promise<StoredDevice>;
  /** A user's own devices (for a "signed-in devices" view and for sign-out). */
  abstract listDevices(userId: string): Promise<StoredDevice[]>;
  /** Every device that should receive a push for these users — enabled only, and
   *  skipping any whose session has been revoked. */
  abstract devicesForUsers(userIds: string[]): Promise<StoredDevice[]>;
  /** Remove a device the user signed out (returns false if it isn't theirs). */
  abstract deleteDevice(userId: string, id: string): Promise<boolean>;
  /** Delete every device registered by a session — called on remote sign-out, so
   *  a signed-out phone stops buzzing rather than being merely unable to open. */
  abstract deleteDevicesForSessions(sessionIds: string[]): Promise<number>;
  /** Stop pushing at a token the push service reported dead, or whose owner
   *  turned notifications off. Keyed by token because that's what receipts carry. */
  abstract disableDevice(pushToken: string, reason: string): Promise<void>;

  /* ---- customer devices (in-app SDK) ---- */

  /** Register, or re-register, a customer's phone. Keyed on the token, so a
   *  handset that changes hands moves to its new contact instead of leaving a
   *  row that would ring for the wrong person. Re-registering re-enables. */
  abstract registerCustomerDevice(params: {
    orgId: string;
    contactId: string;
    inboxId: string;
    token: string;
    platform: string;
  }): Promise<StoredCustomerDevice>;
  /** Every live address for this customer on this channel. */
  abstract customerDevicesFor(contactId: string, inboxId: string): Promise<StoredCustomerDevice[]>;
  /** The most recently seen live address on this channel, whoever it belongs
   *  to — what a "send a test push" button aims at. Nobody setting push up
   *  knows a contact id, and the handset that registered last is the one in
   *  the hand of the person pressing the button. */
  abstract latestCustomerDeviceFor(inboxId: string): Promise<StoredCustomerDevice | null>;
  /** Forget a token the app itself surrendered — a sign-out, or notifications
   *  turned off. Scoped to the contact so a token can only be dropped by the
   *  session that holds it. */
  abstract deleteCustomerDevice(contactId: string, token: string): Promise<boolean>;
  /** Stop pushing at an address FCM reported dead. Kept rather than deleted, so
   *  the same token coming back reads as a return and not as a new phone. */
  abstract disableCustomerDevice(token: string, reason: string): Promise<void>;

  /** A user's push preferences as stored (raw JSON, or undefined for defaults). */
  abstract getPushPrefs(userId: string): Promise<string | undefined>;
  /** Replace a user's push preferences with this JSON blob. */
  abstract setPushPrefs(userId: string, json: string): Promise<void>;

  /* ---- two-factor auth ---- */

  /** A user's 2FA state (undefined if the user doesn't exist). */
  abstract getTwoFactor(userId: string): Promise<TwoFactorState | undefined>;
  /** Patch any subset of a user's 2FA fields. */
  abstract updateTwoFactor(userId: string, patch: Partial<TwoFactorState>): Promise<void>;
  /** A user's recovery codes (hashed), for verification/counting. */
  abstract listRecoveryCodes(userId: string): Promise<{ id: string; codeHash: string; usedAt: string | null }[]>;
  /** Replace a user's recovery codes with a fresh hashed set. */
  abstract replaceRecoveryCodes(userId: string, codeHashes: string[]): Promise<void>;
  /** Mark one recovery code spent so it can't be reused. */
  abstract markRecoveryCodeUsed(id: string): Promise<void>;
  abstract views(userId: string): Promise<SidebarViews>;
  /**
   * How many conversations in this person's own inbound queue are unread — the
   * number that goes on the app icon.
   *
   * Scoped to "inbound" rather than the whole workspace on purpose: a badge is a
   * count of things waiting for *you*, and an admin who can see every team's
   * inbox would otherwise wear the workspace's entire backlog on their phone.
   */
  abstract unreadConversationCount(userId: string): Promise<number>;
  /** A cursor page of conversations for a view (most-recent first). */
  abstract listConversations(
    view: string,
    userId: string,
    opts?: {
      cursor?: string;
      limit?: number;
      /** Narrow the view to threads carrying this field — any value, or one in
       *  particular. ANDed with the view, so it can only ever show you less. */
      field?: { key: string; value?: string };
      /** Only the open side of the view ("active": anything not closed) or
       *  only its closed side. Absent: both, mixed by recency, as before. */
      status?: ListStatus;
    },
  ): Promise<ConversationPage>;
  /** Per-filter totals for a view (and field filter) — the list's chips. */
  abstract conversationFilterCounts(
    view: string,
    userId: string,
    opts?: { field?: { key: string; value?: string } },
  ): Promise<ConversationFilterCounts>;
  /** A cursor page of search results (contact, subject, preview, message body). */
  abstract searchConversations(
    query: string,
    opts?: { cursor?: string; limit?: number },
  ): Promise<ConversationPage>;
  /** A conversation with its most-recent page of messages (+ hasMoreMessages). */
  abstract getConversation(id: string): Promise<ConversationWithMessages | undefined>;
  /** Older messages in a thread, before `opts.before` (a seq cursor). For scroll-up. */
  abstract listMessages(
    conversationId: string,
    opts?: { before?: string; limit?: number },
  ): Promise<MessagePage>;

  /**
   * A message Nest sends itself (`auto`) — outbound, visible to the customer,
   * with no person behind it. Unlike `addMessage` it claims nothing: the chat
   * stays unassigned and unread, its preview stays what the customer said, and
   * it is delivered as it is written (there's no provider to wait on).
   */
  abstract addAutoMessage(
    conversationId: string,
    input: { body: string; auto: MessageAuto; authorName?: string },
  ): Promise<Message | undefined>;

  abstract addMessage(
    conversationId: string,
    input: {
      body: string;
      bodyHtml?: string;
      internal: boolean;
      attachmentIds?: string[];
      quotedMsgId?: string;
      /** Reply on a specific channel (cross-channel thread); defaults to the
       *  conversation's channel. */
      channel?: ChannelType;
      /** Dedup key for the delivery job (also the queue jobId). */
      idempotencyKey?: string;
      /** Channel-specific send hints, persisted for restart-safe (re)delivery. */
      deliveryMeta?: OutboundDeliveryMeta;
      /** This send is passing on someone else's message — show it as "Forwarded". */
      forwarded?: boolean;
    },
    author: User,
  ): Promise<Message | undefined>;

  /**
   * Stage copies of a message's attachments for re-sending, returning ids that
   * `addMessage` can claim exactly like fresh composer uploads.
   *
   * The copies point at the *same* stored object — forwarding a 12MB video
   * shouldn't move a byte of it — so this is a row clone, not a file copy. That
   * makes the blob shared by two messages, which is fine for reads and is why
   * media is never deleted on a per-message basis.
   */
  abstract stageAttachmentCopies(messageId: string): Promise<string[]>;

  /** Where one message lives and whether it's a note — for acting on a message
   *  that may be older than the conversation's loaded page (e.g. forwarding it). */
  abstract getMessagePlace(messageId: string): Promise<{ conversationId: string; internal: boolean } | undefined>;

  /** Resolve a provider message id (WhatsApp wamid) to our stored message. */
  abstract getMessageRefByChannelId(
    channelMsgId: string,
  ): Promise<{ id: string; conversationId: string } | undefined>;

  /** Set/replace/remove a reaction (empty emoji removes) for a participant. */
  abstract reactToMessage(
    messageId: string,
    emoji: string,
    by: "contact" | "user",
  ): Promise<{ conversationId: string; message: Message } | undefined>;

  /** Stage an uploaded file as an attachment not yet tied to a message. */
  abstract createUploadAttachment(orgId: string, input: AttachmentInput): Promise<Attachment>;

  abstract assign(
    conversationId: string,
    input: { assigneeUserId?: string | null; assignedTeamId?: string | null },
    byUserId?: string,
  ): Promise<Conversation | undefined>;

  /**
   * Move an inbox's open/pending conversations that sit on a team it no longer
   * routes to onto its current primary team (per-customer pins still win). Used
   * when an admin changes a channel's routing and wants existing chats to follow.
   * Returns how many were moved.
   */
  abstract rerouteInboxConversations(inboxId: string): Promise<number>;

  /** Change a conversation's status (close/resolve, reopen, snooze). */
  abstract setStatus(
    conversationId: string,
    status: ConversationStatus,
  ): Promise<Conversation | undefined>;

  /** Set a conversation's priority (low/normal/high/urgent). */
  abstract setPriority(
    conversationId: string,
    priority: Priority,
  ): Promise<Conversation | undefined>;

  /** Set (or clear, with null) a conversation's subject — the email thread's
   *  subject line, editable from the composer. */
  abstract setSubject(
    conversationId: string,
    subject: string | null,
  ): Promise<Conversation | undefined>;
  /**
   * Website-chat conversations with an agent reply the visitor hasn't seen,
   * sent between `from` and `to` — the candidates for an email follow-up.
   * Cross-tenant (a platform job); each is then handled inside its own
   * workspace. Only replies past the conversation's `visitorEmailedSeq`.
   */
  abstract listUnseenNestChatReplies(from: Date, to: Date): Promise<{ conversationId: string; orgId: string }[]>;
  /** How far through this conversation replies have been emailed to the visitor. */
  abstract getVisitorEmailedSeq(conversationId: string): Promise<number | undefined>;
  /**
   * Move the emailed marker from `prev` to `through`, only if it is still
   * `prev`. True when this call moved it — the one caller allowed to send.
   * Passing them the other way round undoes a claim whose email failed.
   */
  abstract claimVisitorEmail(conversationId: string, prev: number, through: number): Promise<boolean>;
  /** Whether Nest writes this thread's subject, and the topic half of it. */
  abstract getSubjectState(
    conversationId: string,
  ): Promise<{ auto: boolean; topic: string | null } | undefined>;
  /** Replace the topic half of an automatic subject (the caller recomposes). */
  abstract setSubjectTopic(conversationId: string, topic: string | null): Promise<void>;

  /** Set a group conversation's shareable invite link (after create/reset). */
  abstract setInviteLink(
    conversationId: string,
    inviteLink: string,
  ): Promise<Conversation | undefined>;

  /** Point a conversation at a different channel inbox — used when a customer's
   *  most-recent message arrives on another channel of the same thread, so the
   *  chat shows under the channel they're actually using now (not the origin).
   *  A no-op that returns undefined when the inbox is already set. */
  abstract setConversationInbox(
    conversationId: string,
    inboxId: string,
  ): Promise<Conversation | undefined>;

  /** Persist a provider thread reference on a conversation — for email, the Gmail
   *  server-side thread id, so an outbound reply is sent back into the same thread.
   *  A no-op returning undefined when the conversation is unknown or already set. */
  abstract setConversationChannelRef(
    conversationId: string,
    channelRef: string,
  ): Promise<Conversation | undefined>;

  /** Set (or clear) a conversation's first-response SLA due time (ISO or null). */
  abstract setSla(
    conversationId: string,
    dueAt: string | null,
  ): Promise<Conversation | undefined>;

  /** Snooze a conversation until `until` (ISO); it wakes back into the queue then. */
  abstract snooze(conversationId: string, until: string): Promise<Conversation | undefined>;

  /** Snoozed conversations whose wake time has passed — driven by the sweep that
   *  wakes them and raises a "due" notification for the assignee. */
  abstract listDueSnoozed(): Promise<Conversation[]>;
  /** Wake a due snoozed conversation back to "open" while KEEPING its snooze
   *  timestamp as a "came back from Later" marker (the list shows a badge off
   *  it; it's cleared when the agent opens the conversation). No-op unless the
   *  conversation is currently snoozed. */
  abstract wakeSnoozed(conversationId: string): Promise<Conversation | undefined>;

  /* ---- the conversation log (docs/conversation-log.md) ---- */
  /** Just what the log compares before and after a change — cheap to read. */
  abstract conversationState(conversationId: string): Promise<ConversationState | undefined>;
  /** Append one entry. The conversation must be the bound workspace's. */
  abstract logConversationEvent(conversationId: string, event: ConversationEventInput): Promise<void>;
  /** Newest first, capped. */
  abstract listConversationEvents(conversationId: string, limit?: number): Promise<ConversationEventRow[]>;

  /* ---- Notifications (the bell) ---- */
  abstract createNotification(input: {
    userId: string;
    type: Notification["type"];
    title: string;
    body?: string;
    conversationId?: string | null;
    opsSopId?: string | null;
    chatRoomId?: string | null;
  }): Promise<Notification>;
  /** A user's recent notifications, newest first (capped). */
  abstract listNotifications(userId: string, limit?: number): Promise<Notification[]>;
  /** Mark some (or, when `ids` is omitted, all) of a user's notifications read. */
  abstract markNotificationsRead(userId: string, ids?: string[]): Promise<void>;

  /** Record a provider-side id on an outbound message (for status reconciliation). */
  abstract setMessageChannelId(messageId: string, channelMsgId: string): Promise<void>;

  /* ---- durable outbound delivery ---- */

  /** Everything the delivery worker needs to (re)send a message by its id. */
  abstract getOutboundMessage(messageId: string): Promise<OutboundMessageRef | undefined>;

  /** Begin a send attempt: status→sending, attemptCount++, lastAttemptAt=now.
   *  Returns undefined if the message is gone or already past the sending stage. */
  /**
   * Record which inbox an outbound message actually went from.
   *
   * Written after the attempt rather than at compose, because that is when it
   * is known: the sending inbox is resolved against the channel the message is
   * going out on, which for a cross-channel reply is not the conversation's.
   * Stamped whether the send succeeded or failed — "which number did this try
   * to go from" is exactly the question a failure raises.
   */
  abstract setMessageInbox(messageId: string, inboxId: string): Promise<void>;

  abstract markMessageSending(messageId: string): Promise<MessageStatusChange | undefined>;

  /** Provider accepted the send: persist its channel id (if any) and advance to
   *  "sent", clearing any recorded error. Guarded by the status ladder. */
  abstract markMessageSent(
    messageId: string,
    channelMsgId?: string,
  ): Promise<MessageStatusChange | undefined>;

  /* ---- per-recipient email open tracking (read receipts) ---- */
  /** Register the tracking rows for an outbound email — one per To/Cc address,
   *  each with its own pixel token — so an open can be attributed to a person. */
  abstract registerEmailRecipients(
    messageId: string,
    recipients: EmailRecipientInput[],
  ): Promise<void>;

  /** Record an email open by its pixel token: stamp `openedAt` the first time and
   *  bump the open count. Returns the affected message (so the caller can
   *  broadcast the "Seen") ONLY on the first open of that recipient — undefined
   *  for a repeat open or an unknown token. */
  abstract recordEmailOpen(token: string): Promise<MessageStatusChange | undefined>;

  /** Record a failed send attempt. `permanent` flips the message to failed
   *  (terminal) with `reason`; otherwise it stays in flight for the queue to
   *  retry, and only the diagnostics (error/code) are recorded. */
  abstract recordSendFailure(
    messageId: string,
    info: { error?: string; code?: string; permanent: boolean; reason?: string },
  ): Promise<MessageStatusChange | undefined>;

  /** Outbound messages still in flight (queued/sending) whose last attempt is
   *  older than `olderThanMs` — used to re-enqueue after a restart/crash. The
   *  idempotency key rides along so the re-enqueue reuses the same job identity. */
  abstract listStuckOutbound(
    olderThanMs: number,
  ): Promise<Array<{ messageId: string; conversationId: string; orgId: string; idempotencyKey?: string }>>;

  /** Reset a failed message to queued for a manual retry (new idempotency key,
   *  failure fields cleared). Returns undefined if it isn't in a retryable state. */
  abstract resetMessageForRetry(
    messageId: string,
    idempotencyKey: string,
  ): Promise<MessageStatusChange | undefined>;

  /** Clear a conversation's unread flag + count (agent opened/read it). */
  abstract clearUnread(conversationId: string): Promise<Conversation | undefined>;

  /** Flag a conversation unread with no count — an agent's manual "mark unread"
   *  (WhatsApp-style empty dot); distinct from unreadCount>0 from new messages. */
  abstract markUnread(conversationId: string): Promise<Conversation | undefined>;

  /* ---- custom fields (org catalog + per-record values) ---- */
  /** Every field the org has defined, archived ones included — the settings
   *  pane has to show what is retired in order to bring it back. */
  abstract listCustomFields(orgId: string): Promise<CustomField[]>;
  abstract createCustomField(orgId: string, input: CreateCustomFieldInput): Promise<CustomField>;
  abstract updateCustomField(
    id: string,
    input: UpdateCustomFieldInput,
  ): Promise<CustomField | undefined>;
  /** Delete a field *and every value recorded against it*. Archiving is the
   *  reversible option; this one is not, which is why the pane asks. */
  abstract deleteCustomField(id: string): Promise<void>;
  /** How many values are recorded against a field, on any record. */
  abstract countCustomFieldValues(id: string): Promise<number>;
  /** Move a field to the other kind of record. Its values are cleared in the
   *  same step: they hang off records of the old kind. */
  abstract changeCustomFieldEntity(id: string, entity: CustomFieldEntity): Promise<CustomField | undefined>;
  /**
   * The values on a set of records, keyed by record id.
   *
   * Takes a list rather than one id because the caller is usually a page of
   * conversations, and one query for fifty rows is the difference between a
   * list that opens and a list that crawls.
   */
  abstract customFieldValues(
    orgId: string,
    entity: CustomFieldEntity,
    entityIds: string[],
  ): Promise<Map<string, CustomFieldValue[]>>;
  /**
   * Write values on one record. A null clears that field.
   *
   * Keyed by the field's key rather than its id: the other caller is an SDK,
   * which knows `order_id` and should not have to look up an id to send it.
   * Keys the org has not defined are ignored — returned in `unknown` so a
   * caller can complain, rather than silently stored under a typo.
   */
  abstract setCustomFieldValues(
    orgId: string,
    entity: CustomFieldEntity,
    entityId: string,
    values: Record<string, string | null>,
  ): Promise<{ values: CustomFieldValue[]; unknown: string[] }>;
  /**
   * Which records carry a value matching this text.
   *
   * Exact match on the folded value first, then prefix — an order number is
   * either the one being read out or it is not, and a partial match that
   * outranked the exact one would bury the answer.
   */
  /**
   * Records whose value for one named field is exactly this.
   *
   * Separate from the search below, and deliberately not built on it: that one
   * falls back to partial matches, which is right for somebody typing into a
   * search box and wrong for deciding which conversation an order belongs to.
   * "DG-8841" must not resume the thread for "DG-88412".
   */
  abstract findByCustomFieldExact(
    orgId: string,
    entity: CustomFieldEntity,
    fieldKey: string,
    value: string,
  ): Promise<string[]>;
/**
   * Everything carrying a value for one named field — any value, or one in
   * particular.
   *
   * The difference from the two above is the question being asked. Those answer
   * "which record is this order number", where the answer is one row and a
   * partial match is a courtesy. This answers "show me the ones with an order
   * number", where the answer is a working set: a filter, not a lookup.
   *
   * It returns both kinds because a field lives on a conversation or on a
   * contact and the caller should not have to know which — "conversations about
   * an order" and "conversations with customers who have an account number" are
   * the same gesture to whoever is filtering.
   *
   * Bounded, deliberately. The ids come back as a list and are then matched with
   * `IN`, which stops being the right shape somewhere in the low thousands; the
   * cap means a filter over a very large set silently shows the most recent
   * slice of it rather than timing out. When that ceiling starts being reached
   * in earnest the fix is a join, which needs `CustomFieldValue` to carry real
   * relations rather than a polymorphic `entityId`.
   */
  abstract findByCustomField(
    orgId: string,
    fieldKey: string,
    value?: string,
  ): Promise<{ conversationIds: string[]; contactIds: string[] }>;
    abstract findByCustomFieldValue(
    orgId: string,
    entity: CustomFieldEntity,
    query: string,
  ): Promise<string[]>;

  /* ---- labels (org catalog + per-conversation) ---- */
  /** The org's label catalog (name + colour), for the picker + sidebar filter. */
  abstract listLabels(orgId: string): Promise<Label[]>;
  abstract createLabel(input: { orgId: string; name: string; color: string }): Promise<Label>;
  abstract updateLabel(id: string, patch: { name?: string; color?: string }): Promise<Label | undefined>;
  /** Delete a label from the catalog and remove it from every conversation. */
  abstract deleteLabel(id: string): Promise<void>;
  /** Replace a conversation's labels with exactly this set of label ids. */
  abstract setConversationLabels(conversationId: string, labelIds: string[]): Promise<Conversation | undefined>;

  /* ---- channel ingestion (inbound) ---- */

  abstract getInboxByWhatsAppPhoneId(phoneNumberId: string): Promise<Inbox | undefined>;
  /** The WhatsApp inboxes on one WhatsApp Business Account, in any workspace —
   *  for Meta's account-level events, which name the account, not a number. */
  abstract getInboxesByWabaId(wabaId: string): Promise<Inbox[]>;
  abstract getInboxByEmailAddress(address: string): Promise<Inbox | undefined>;
  /** Whether a workspace other than the bound one already receives on this
   *  phone number id or email address. Checked before a channel is connected,
   *  so an inbound event can never match inboxes in two workspaces. */
  abstract channelKeyTaken(
    key: { phoneNumberId?: string; emailAddress?: string },
    exceptInboxId?: string,
  ): Promise<boolean>;
  /** The NestChat channel a widget key belongs to. The key is public (it sits in
   *  the embed snippet on the business's website), so an unknown one is simply
   *  not found — it is an identifier, not a credential. */
  abstract getInboxByWidgetKey(widgetKey: string): Promise<Inbox | undefined>;
  /** Resolve an app key to its channel. Its own key rather than the widget's,
   *  so one can be rolled without the other and so app traffic is
   *  distinguishable from web traffic. */
  abstract getInboxByAppKey(appKey: string): Promise<Inbox | undefined>;

  /* ---- webhook diagnostics (unmapped/unverified inbound) ---- */
  abstract recordWebhookDiagnostic(input: {
    channel: string;
    kind: string;
    reference?: string;
    detail?: string;
    /** The workspace concerned, if known. Unset → visible to platform operators only. */
    orgId?: string;
  }): Promise<void>;
  abstract listWebhookDiagnostics(limit?: number): Promise<WebhookDiagnostic[]>;
  abstract getMembers(teamId: string): Promise<User[]>;

  /** Threading: find the conversation owning any message with one of these provider ids. */
  /**
   * The conversation an email's References/In-Reply-To headers point at.
   *
   * `contactIds` scopes the match to those customers' threads, which matters
   * more than it looks: everyone on a CC list shares the same References chain,
   * so an unscoped lookup files a CC'd recipient's Reply-All onto the original
   * sender's conversation and silently merges two customers.
   *
   * Inbound passes the one sender. An agent's own reply, synced back from
   * Gmail, passes everyone it was addressed to — the thread it belongs to is
   * the one whose customer is on that list.
   */
  abstract findConversationByMessageChannelIds(
    channelMsgIds: string[],
    opts?: { contactIds?: string[] },
  ): Promise<string | undefined>;

  abstract upsertContactByIdentity(params: {
    orgId: string;
    kind: ContactIdentityKind;
    value: string;
    displayName: string;
    company?: string;
    avatarColor?: string;
  }): Promise<Contact>;

  /**
   * The open conversation for this contact ON THIS INBOX, or a new one if none.
   * Threading is per-inbox (channel endpoint): a customer reaching a different
   * number / email address / channel opens a SEPARATE conversation, and a closed
   * thread starts a new one — only one open per (contact, inbox) at a time.
   * (Agents can still reply cross-channel within a thread; that's the send path.)
   */
  /**
   * The open conversation a WhatsApp customer's message belongs in when it
   * isn't this number's own thread with them: the one where an agent last
   * wrote to them *from this number* as a cross-channel reply.
   *
   * A customer who came in on live chat and was answered on WhatsApp replies on
   * WhatsApp — and that reply belongs under the live-chat conversation it
   * answers, not in a brand-new WhatsApp chat. Undefined when there is no such
   * thread, or when this number's own open thread with them has moved more
   * recently (then that is the conversation they are in).
   */
  /**
   * An agent wrote to this customer first, on this inbox, and the thread was
   * closed before they answered: who wrote, so the answer goes back to them
   * rather than to the queue. Only the customer's latest conversation here
   * counts, it must have no message from the customer, and it must have moved
   * since `since`. Undefined otherwise.
   */
  abstract findRecentOutreach(params: {
    orgId: string;
    inboxId: string;
    contactId: string;
    since: string;
  }): Promise<{ userId: string; teamId: string | null } | undefined>;

  abstract findCrossChannelReplyThread(params: {
    orgId: string;
    inboxId: string;
    contactId: string;
  }): Promise<string | undefined>;

  abstract findOrCreateOpenConversation(params: {
    orgId: string;
    inboxId: string;
    contact: Contact;
    channel: ChannelType;
    subject?: string;
    assigneeUserId?: string | null;
    assignedTeamId?: string | null;
    /**
     * Who started it, for a chat that belongs to one browser or one signed-in
     * user rather than to the whole contact. Only an open conversation carrying
     * the same mark is joined, and a new one is created with it. See
     * `visitorStamp`: a contact can be merged onto a customer by a detail
     * typed into a form, and without this the next message from that browser
     * landed in the customer's own live chat.
     */
    startedBy?: string;
    /** Nest writes this thread's subject (see ConversationSubjectService).
     *  `subject` is then its starting topic, not a fixed subject. */
    autoSubject?: boolean;
    /** Open a new conversation even though one is live — a chat keyed per
     *  order, writing about an order that has no thread yet. */
    forceNew?: boolean;
  }): Promise<{ conversation: Conversation; created: boolean }>;

  abstract appendInboundMessage(
    conversationId: string,
    input: AppendInboundInput,
  ): Promise<Message | undefined>;

  /** Record an outbound email that was sent straight from Gmail (not through
   *  Nest) into its conversation, so the thread stays complete. Stored as an
   *  already-sent outgoing message — no delivery is triggered. */
  abstract appendSyncedOutbound(
    conversationId: string,
    input: {
      body: string;
      bodyHtml?: string;
      channelMsgId?: string;
      authorName?: string;
      attachments?: AttachmentInput[];
      /** Defaults to email (a reply sent straight from Gmail). WhatsApp is a
       *  message sent from the WhatsApp Business app on a coexistence number. */
      channel?: "email" | "whatsapp";
      messageType?: MessageType;
      /** Answered from elsewhere: nothing in it is waiting for anyone. */
      markRead?: boolean;
    },
  ): Promise<Message | undefined>;

  /**
   * Bring in a WhatsApp Business app number's chat history (coexistence),
   * one customer's batch at a time. It lands in that customer's one history
   * conversation on the inbox — closed and read, so nobody's queue fills up —
   * whatever order Meta sends the batches in (newest first, as it does): the
   * conversation is put back in date order after each. A message already
   * stored anywhere (by its WhatsApp id) is skipped.
   */
  abstract importWhatsAppHistory(input: {
    orgId: string;
    inboxId: string;
    contactId: string;
    /** Oldest or newest first — either; they're sorted by `sentAt`. */
    messages: Array<{
      direction: "in" | "out";
      authorName: string;
      body: string;
      channelMsgId: string;
      sentAt: Date;
      messageType?: MessageType;
      attachments?: AttachmentInput[];
    }>;
  }): Promise<{ conversationId: string; added: number }>;

  /** How many email conversations the current workspace holds. */
  abstract countEmailConversations(): Promise<number>;

  /** Delete every email conversation in the current workspace, with its
   *  messages, notes, labels and notifications. Contacts stay. Returns how many
   *  conversations went. Part of the Gmail cutover; never anything else. */
  abstract deleteEmailConversations(): Promise<number>;

  /**
   * Write a whole email thread brought in from a mailbox as one open
   * conversation, each message at the time it was actually sent. Quiet by
   * design: nothing is delivered, nobody is notified. Returns the new
   * conversation's id.
   */
  abstract importEmailThread(input: ImportEmailThreadInput): Promise<string>;

  /** Backend-only: the storage key + mime of an attachment, for serving media. */
  abstract getAttachment(id: string): Promise<StoredAttachmentRef | undefined>;

  /** A voice note's words, if anyone has asked for them yet. */
  abstract getAttachmentTranscript(id: string): Promise<string | undefined>;

  /** The words for whichever of these have been transcribed. */
  abstract getAttachmentTranscripts(ids: string[]): Promise<Map<string, string>>;

  /** Keep a voice note's words, so they're only ever made once. */
  abstract setAttachmentTranscript(id: string, transcript: string): Promise<void>;

  /** Media access info for the serving endpoint: the storage ref plus the org
   *  that owns it (via its message's conversation), for the authorization check.
   *  `orgId` is undefined for a staged upload not yet attached to a conversation. */
  abstract getAttachmentAccess(
    id: string,
  ): Promise<{ storageKey: string; mime: string; filename: string; orgId?: string } | undefined>;

  /**
   * Advance this conversation's outbound messages up to and including
   * `throughMessageId` to `status`, and report the ones that actually moved.
   *
   * By message id rather than by provider id, because the channel this exists
   * for — NestChat — has no provider and therefore no provider id: the client
   * that reports the receipt is one we wrote, and it knows our own ids. Up to
   * *and including* because a client that has message 7 on screen necessarily
   * has 1 to 6, and reporting each one separately would be six round trips to
   * say one thing.
   *
   * Guarded by the same ladder as every other status write, so a late ack can
   * never drag a read message back to delivered.
   */
  abstract markOutboundStatusUpTo(
    conversationId: string,
    throughMessageId: string,
    status: MessageStatus,
  ): Promise<MessageStatusChange[]>;

  /**
   * Apply a provider status webhook to the message it names.
   *
   * `failureReason` is Meta's own explanation of a `failed` status, and is only
   * meaningful with one: the provider tells us exactly why it gave up, and
   * without somewhere to put it that answer reached the log and nowhere else,
   * leaving the thread to say "Not delivered" about something an admin could
   * have fixed in a minute.
   */
  /** Texts sent from this channel since `since` that still wait for a delivery
   *  receipt — what an SMS channel without receipt webhooks asks after. */
  abstract listAwaitingReceipt(inboxId: string, since: Date, limit?: number): Promise<{ id: string; channelMsgId: string }[]>;
  abstract updateMessageStatusByChannelId(
    channelMsgId: string,
    status: MessageStatus,
    failureReason?: string,
  ): Promise<{ conversationId: string; message: Message } | undefined>;

  /**
   * Mark an outbound message as failed by its internal id — used when a send is
   * rejected before the provider ever returns a channel id (bad address, no
   * provider, expired token). Guarded by the status ladder so it never drags a
   * message that already reached the customer back to failed.
   */
  abstract failMessage(
    messageId: string,
  ): Promise<{ conversationId: string; message: Message } | undefined>;

  /* ---- WhatsApp groups ---- */

  /**
   * The conversation that owns a provider-side thread id (a WhatsApp group id,
   * or a Gmail thread). `contactIds` scopes it for the same reason as the
   * References lookup above: a Gmail thread can hold mail to and from several
   * customers, so "which conversation is this thread" is only answerable
   * alongside "who was this addressed to".
   */
  abstract findConversationByChannelRef(
    channelRef: string,
    opts?: { contactIds?: string[] },
  ): Promise<string | undefined>;

  /**
   * Find an existing contact by a messaging identity — without creating one.
   *
   * Distinct from {@link upsertContactByIdentity}: that is for an inbound from
   * a real person, where creating the contact is right. Here we're only asking
   * "do we already know this address?" about the recipients of an agent's own
   * email, and inventing a contact for every address they ever CC would fill
   * the customer list with colleagues and suppliers.
   */
  abstract findContactByIdentity(params: {
    orgId: string;
    kind: ContactIdentityKind;
    value: string;
  }): Promise<Contact | undefined>;

  /**
   * Create a contact (a group's synthetic contact, or a customer added by hand),
   * OR return the existing one if the phone/email already resolves to a contact
   * in this org — `created` is false when an existing contact was returned.
   */
  abstract createContact(params: {
    orgId: string;
    displayName: string;
    avatarColor?: string;
    company?: string;
    phone?: string;
    email?: string;
    tags?: string[];
    ownerUserId?: string | null;
    ownerTeamId?: string | null;
  }): Promise<{ contact: Contact; created: boolean }>;

  /** One-time (idempotent) backfill of normalizedValue/orgId on identity rows. */
  abstract backfillIdentityNormalization(): Promise<{ updated: number }>;

  /**
   * Consolidate any residual duplicate customer identities — legacy rows that
   * share a canonical phone/email but were created before get-or-create dedup,
   * or missed in a manual merge — and then enforce the hard guarantee that no
   * two identities of the same kind in an org can share a normalised value.
   * Idempotent and safe to run on every boot; never removes a customer's only
   * copy of an identity. `constraintApplied` is false only if a residual
   * cross-contact collision blocked the unique index (app-level dedup still
   * prevents new duplicates in that case).
   */
  abstract reconcileIdentityUniqueness(): Promise<{
    mergedContacts: number;
    collapsedIdentities: number;
    constraintApplied: boolean;
  }>;

  /* ---- analytics (admin/manager insights) ---- */
  /** Raw analytics materials for an org over a window, filtered by
   *  channel/team/agent. Aggregation into the dashboard payload lives in the
   *  AnalyticsService so both stores share one set of derivations. */
  abstract getAnalytics(orgId: string, q: AnalyticsQuery): Promise<AnalyticsBundle>;

  /* ---- customers directory ---- */
  abstract listContacts(): Promise<Contact[]>;
  /** Clusters of contacts that probably represent the same customer (shared
   *  normalised phone/email), surfaced for review before merging. */
  abstract findDuplicateContacts(): Promise<ContactDuplicateGroup[]>;
  /** Merge duplicate contacts into `winnerId`: move the losers' identities,
   *  conversations and participations onto the winner, blank-fill its fields and
   *  union tags, then delete the losers. Returns the surviving contact. */
  abstract mergeContacts(params: { winnerId: string; loserIds: string[] }): Promise<Contact>;
  /** One customer, without their conversations — for the paths that only need
   *  the person (a visitor's display name, an ownership check). */
  abstract getContact(id: string): Promise<Contact | undefined>;
  abstract getContactWithConversations(id: string): Promise<ContactWithConversations | undefined>;
  abstract updateContact(
    id: string,
    params: {
      displayName?: string;
      company?: string;
      phone?: string;
      email?: string;
      tags?: string[];
      ownerUserId?: string | null;
      ownerTeamId?: string | null;
      blocked?: boolean;
    },
  ): Promise<Contact | undefined>;

  /** Permanently delete a customer and everything attached to them
   *  (conversations, messages, identities, participations). */
  abstract deleteContact(id: string): Promise<void>;

  abstract createGroupConversation(params: {
    orgId: string;
    inboxId: string;
    contact: Contact;
    subject: string;
    channelRef: string;
    inviteLink: string;
    memberContacts: Contact[];
    assigneeUserId?: string | null;
    assignedTeamId?: string | null;
  }): Promise<Conversation>;

  abstract listParticipants(conversationId: string): Promise<Participant[]>;
  abstract countParticipants(conversationId: string): Promise<number>;
  abstract addParticipant(conversationId: string, contact: Contact, role?: ParticipantRole): Promise<Participant>;
  abstract removeParticipant(conversationId: string, contactId: string): Promise<void>;
}
