import { Injectable } from "@nestjs/common";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { hashInviteToken, newInviteToken } from "../auth/invite-token";
import { normalizeIdentity, type IdentityKind } from "../contacts/identity";
import { groupDuplicateContacts } from "../contacts/duplicates";
import type {
  Attachment,
  CreateCustomFieldInput,
  CustomField,
  CustomFieldEntity,
  CustomFieldValue,
  UpdateCustomFieldInput,
  ChannelType,
  Contact,
  ContactDuplicateGroup,
  ContactIdentityKind,
  ContactWithConversations,
  Conversation,
  ConversationFilterCounts,
  ConversationPage,
  ConversationStatus,
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
  NoteFollowUp,
} from "@ding/schemas";
import {
  CONVERSATIONS_PAGE_SIZE,
  inboxStatus,
  MESSAGES_PAGE_SIZE,
  normalizeCustomFieldValue,
  publicChannelConfig,
  THREADABLE_STATUSES,
} from "@ding/schemas";
import { env } from "../config/env";
import { threadsTogether } from "./email-threading";
import { canAdvanceStatus, canonicalLang, computeWaWindow, isWaChannel, messageTypeForKind, previewFromBody, previewForType, sameTemplateLang, templateVariableCount } from "./mappers";
import { DEMO_USER_ID, ORG_ID, makeSeed, type ConversationRecord } from "./fixtures";

/** The one workspace the in-memory demo holds. */
let memoryWorkspaceName = "Swiftee";
import { PLATFORM_ORG_ID } from "../tenancy/platform";
import { boundOrgId } from "../tenancy/tenant-scope";
import {
  Store,
  EMAIL_OPEN_GRACE_MS,
  type AnalyticsBundle,
  type AnalyticsConvo,
  type AnalyticsMsg,
  type AnalyticsQuery,
  type AppendInboundInput,
  type AttachmentInput,
  type WorkspacePerson,
  type ImportEmailThreadInput,
  type MessageStatusChange,
  type OutboundDeliveryMeta,
  type EmailRecipientInput,
  type OutboundMessageRef,
  type SidebarViews,
  type StoredAttachmentRef,
  type StoredDevice,
  type StoredCustomerDevice,
  type StoredSession,
  type TwoFactorState,
  type ViewItem,
  type WebhookDiagnostic,
  type ConversationState,
  type ConversationEventInput,
  type ConversationEventRow,
  type WorkspaceMembership,
  type WorkspaceSummary,
  type ListStatus,
} from "./store";

const AVATAR_PALETTE = [
  "#F97316",
  "#0EA5E9",
  "#10B981",
  "#6366F1",
  "#F59E0B",
  "#14B8A6",
];

/** Recency ordering matching the Postgres store: lastActivityAt desc, id desc. */
function byRecencyDesc(a: { lastActivityAt: string; id: string }, b: { lastActivityAt: string; id: string }): number {
  return b.lastActivityAt.localeCompare(a.lastActivityAt) || b.id.localeCompare(a.id);
}
function encodeMemCursor(r: { lastActivityAt: string; id: string }): string {
  return Buffer.from(`${r.lastActivityAt}::${r.id}`).toString("base64url");
}
function safeDecode(cursor: string): string {
  try {
    return Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    return "";
  }
}
function clampLimit(requested: number | undefined, fallback: number): number {
  const n = requested ?? fallback;
  return Math.min(Math.max(Math.trunc(n) || fallback, 1), 100);
}

/**
 * Which field on a Contact an identity kind is kept in, and which kind to
 * canonicalise it as when matching.
 *
 * Phone and wa_id share the phone field on purpose — they are the same number
 * in two notations, and matching across both is what stops one customer forking
 * into two contacts. A `nestchat` visitor id shares nothing with either: it is a
 * browser's random id, so it gets a field of its own. (It used to fall through
 * to `phone`, which showed an agent a 32-hex "phone number" and offered to
 * message it on WhatsApp.)
 */
function identityField(kind: ContactIdentityKind): {
  field: "phone" | "email" | "visitorId";
  matchAs: IdentityKind;
} {
  if (kind === "email") return { field: "email", matchAs: "email" };
  if (kind === "nestchat") return { field: "visitorId", matchAs: "nestchat" };
  // A signed-in app user. Shares the opaque-id field with a NestChat visitor —
  // both are a channel-scoped handle rather than a way to reach somebody — but
  // matched as itself, because the two normalise differently and must not be
  // mistaken for one another.
  //
  // It fell through to `phone` until this was written, which is the exact
  // failure the note above describes: an app user's id filed as a phone number,
  // and — because an `inbox:uid` string normalises to nothing as a number — a
  // fresh contact every single time they signed in.
  if (kind === "external") return { field: "visitorId", matchAs: "external" };
  return { field: "phone", matchAs: "phone" };
}

/**
 * Zero-infrastructure store backed by in-memory fixtures. Default in dev.
 *
 * Single-workspace by design: it holds one org's fixtures and does not confine
 * reads to the bound tenant the way the Postgres store does. That is why a
 * production deployment refuses to start on it (see assertProdSecrets) — tenant
 * isolation is a property of PrismaStore, and is tested there.
 */
@Injectable()
export class MemoryStore extends Store {
  private users: User[];
  private teams: Team[];
  private membership: Record<string, string[]>;
  private inboxes: Inbox[];
  private conversations: ConversationRecord[];
  private contacts: Contact[];
  private templates: Template[];
  private labels: Label[];
  private passwords: Map<string, string>;
  // Pending emailed invites: userId → { sha256(token), expiry ms }.
  private invites = new Map<string, { hash: string; exp: number }>();
  /** Invited and not joined yet. An invitee holds a random guard password
   *  here, so "has a password" can't say it — this does. */
  private invited = new Set<string>();
  /** Per-inbox provider credentials, kept server-side only (never serialised). */
  private inboxConfig = new Map<string, Record<string, string>>();
  /** Org-scoped app settings, keyed by `${orgId}::${key}` (e.g. Google OAuth creds). */
  private appSettings = new Map<string, string>();
  private customFields: CustomField[] = [];
  /** Values keyed `entity:entityId:fieldId`, so a write is a single lookup. */
  /** Website chat: how far replies have been emailed to the visitor. */
  private visitorEmailed = new Map<string, number>();
  /** Automatic-subject state per conversation (see getSubjectState). */
  private subjectState = new Map<string, { auto: boolean; topic: string | null }>();
  private fieldValues = new Map<string, { fieldId: string; entityId: string; entity: string; value: string }>();
  /** Backend-only attachment storage refs, keyed by attachment id (for serving). */
  private mediaRefs = new Map<string, StoredAttachmentRef>();
  /** Uploaded-but-not-yet-sent attachments (composer staging), keyed by id. */
  private pendingUploads = new Map<string, Attachment>();
  /** In-memory webhook diagnostics log (newest first, bounded). */
  private webhookDiagnostics: WebhookDiagnostic[] = [];
  /** Backend-only outbound delivery bookkeeping, keyed by message id. */
  private outboundMeta = new Map<
    string,
    {
      idempotencyKey?: string;
      deliveryMeta?: OutboundDeliveryMeta;
      lastAttemptAt?: number;
      providerError?: string;
      providerErrorCode?: string;
    }
  >();
  /** Email tracking-pixel token → the message + recipient address it belongs to
   *  (plus the send time, for the open grace window), so an open (which only
   *  knows the token) resolves to a person. */
  private emailTokenIndex = new Map<string, { messageId: string; address: string; sentAt: number }>();
  private idSeq = 10_000;
  private sessions: StoredSession[] = [];
  private devices: StoredDevice[] = [];
  private customerDevices: StoredCustomerDevice[] = [];
  private pushPrefs = new Map<string, string>();
  private twoFactor = new Map<string, TwoFactorState>();
  private recoveryCodes: Array<{ id: string; userId: string; codeHash: string; usedAt: string | null }> = [];

  constructor() {
    super();
    const seed = makeSeed();
    this.users = seed.users;
    this.teams = seed.teams;
    this.membership = seed.membership;
    this.inboxes = seed.inboxes;
    this.conversations = seed.conversations;
    this.templates = seed.templates;
    this.labels = seed.labels;
    this.contacts = seed.conversations.map((c) => ({ ...c.contact }));
    // Every demo user shares the dev password (real bcrypt hashing).
    const hash = bcrypt.hashSync(env.auth.devPassword, 8);
    this.passwords = new Map(this.users.map((u) => [u.id, hash]));
  }

  get demoUserId(): string {
    return DEMO_USER_ID;
  }

  async healthCheck(): Promise<boolean> {
    return true; // in-memory store is healthy whenever the process is up
  }

  async getUser(id: string): Promise<User | undefined> {
    return this.users.find((u) => u.id === id);
  }

  async getUserForAuth(id: string): Promise<User | undefined> {
    return this.users.find((u) => u.id === id);
  }

  async findUserByEmail(email: string): Promise<User | undefined> {
    const e = email.trim().toLowerCase();
    const hits = this.users.filter((u) => u.email.toLowerCase() === e);
    return hits.length === 1 ? hits[0] : undefined;
  }

  async emailInUse(email: string): Promise<boolean> {
    const e = email.trim().toLowerCase();
    return this.users.some((u) => u.email.toLowerCase() === e);
  }

  async emailInWorkspace(email: string): Promise<boolean> {
    return this.emailInUse(email);
  }

  /* ---- one person, several workspaces ----
   * The in-memory store is the single demo workspace, so everyone is in
   * exactly one and there are no others to make or join. */

  async listMemberships(userId: string): Promise<WorkspaceMembership[]> {
    const user = this.users.find((u) => u.id === userId);
    return user ? [{ user, orgName: memoryWorkspaceName, sandbox: false, status: "active" }] : [];
  }

  async membershipIn(userId: string, orgId: string): Promise<User | undefined> {
    const user = this.users.find((u) => u.id === userId);
    return user && user.orgId === orgId ? user : undefined;
  }

  async rememberWorkspace(): Promise<void> {}

  async joinWorkspace(userId: string, orgId: string): Promise<User> {
    const user = await this.membershipIn(userId, orgId);
    if (!user) throw new Error("The demo has one workspace; there are no others to join");
    return user;
  }

  async listWorkspaces(): Promise<WorkspaceSummary[]> {
    return [
      {
        id: ORG_ID,
        name: memoryWorkspaceName,
        sandbox: false,
        createdAt: new Date(0).toISOString(),
        people: this.users.length,
        channels: this.inboxes.length,
        conversations: this.conversations.length,
        status: "active",
        statusAt: null,
        purgeAt: null,
      },
    ];
  }

  async createWorkspace(): Promise<{ id: string; name: string }> {
    throw new Error("New workspaces need the database");
  }

  async renameWorkspace(_orgId: string, name: string): Promise<void> {
    memoryWorkspaceName = name;
  }

  // The demo's one workspace is the platform's own: never frozen, never wiped.
  async setWorkspaceStatus(): Promise<void> {
    throw new Error("Suspending or deleting a workspace needs the database");
  }

  async refreshWorkspaceStatuses(): Promise<void> {}

  async listWorkspacePeople(): Promise<WorkspacePerson[]> {
    return this.users.map((user) => ({ user, pending: this.invited.has(user.id) }));
  }

  async revokeWorkspaceSessions(): Promise<number> {
    const live = this.sessions.filter((s) => !s.revokedAt);
    for (const s of live) s.revokedAt = new Date().toISOString();
    return live.length;
  }

  async reissueInvite(userId: string): Promise<string | undefined> {
    if (!this.users.some((u) => u.id === userId) || !this.invited.has(userId)) return undefined;
    const inv = newInviteToken();
    this.invites.set(userId, { hash: inv.hash, exp: inv.expiresAt.getTime() });
    return inv.token;
  }

  async listWorkspacesDueForPurge(): Promise<string[]> {
    return [];
  }

  async purgeWorkspace(): Promise<{ files: string[] }> {
    throw new Error("Deleting a workspace needs the database");
  }

  async getPasswordHash(userId: string): Promise<string | undefined> {
    return this.passwords.get(userId);
  }

  async createInbox(params: {
    orgId: string;
    type: ChannelType;
    name: string;
    handle: string;
    teamIds: string[];
    routingStrategy: RoutingStrategy;
    channelConfig?: Record<string, string>;
  }): Promise<Inbox> {
    const id = `inbox_${++this.idSeq}`;
    if (params.channelConfig) this.inboxConfig.set(id, params.channelConfig);
    const inbox: Inbox = {
      id,
      orgId: params.orgId,
      type: params.type,
      name: params.name,
      handle: params.handle,
      teamIds: params.teamIds,
      routingStrategy: params.routingStrategy,
      // Last in the list, not first. A channel connected while somebody is
      // looking at their sidebar should appear at the end of the channels they
      // have arranged, rather than shouldering its way to the top of them.
      order: this.inboxes.reduce((max, i) => Math.max(max, i.order ?? 0), 0) + 1,
      // A new channel never steals the default from one already carrying it.
      isDefault: false,
      unread: 0,
      ...(params.type === "email" ? { signature: { layoutHtml: null, footerHtml: null } } : {}),
    };
    this.inboxes.push(inbox);
    return {
      ...inbox,
      ...inboxStatus(params.type, params.channelConfig ?? null),
      channelConfigPublic: publicChannelConfig(params.channelConfig ?? null),
    };
  }

  async updateInbox(
    id: string,
    params: {
      name?: string;
      teamIds?: string[];
      routingStrategy?: RoutingStrategy;
      channelConfig?: Record<string, string>;
      contactTag?: string;
      conversationLabelId?: string | null;
    },
  ): Promise<Inbox | undefined> {
    const inbox = this.inboxes.find((i) => i.id === id);
    if (!inbox) return undefined;
    if (params.name !== undefined) inbox.name = params.name;
    if (params.teamIds !== undefined) inbox.teamIds = params.teamIds;
    if (params.routingStrategy !== undefined) inbox.routingStrategy = params.routingStrategy;
    if (params.contactTag !== undefined) inbox.contactTag = params.contactTag;
    if (params.conversationLabelId !== undefined) inbox.conversationLabelId = params.conversationLabelId;
    if (params.channelConfig !== undefined) {
      const merged = { ...(this.inboxConfig.get(id) ?? {}), ...params.channelConfig };
      this.inboxConfig.set(id, merged);
    }
    return {
      ...inbox,
      ...inboxStatus(inbox.type, this.inboxConfig.get(id) ?? null),
      channelConfigPublic: publicChannelConfig(this.inboxConfig.get(id) ?? null),
    };
  }

  async setInboxSignature(
    id: string,
    signature: { layoutHtml: string | null; footerHtml: string | null },
  ): Promise<Inbox | undefined> {
    const inbox = this.inboxes.find((i) => i.id === id);
    if (!inbox) return undefined;
    inbox.signature = { ...signature };
    return this.getInbox(id);
  }

  async deleteInbox(id: string): Promise<void> {
    this.inboxes = this.inboxes.filter((i) => i.id !== id);
    this.inboxConfig.delete(id);
    this.conversations = this.conversations.filter((c) => c.inboxId !== id);
  }

  async getInbox(id: string): Promise<Inbox | undefined> {
    const inbox = this.inboxes.find((i) => i.id === id);
    if (!inbox) return undefined;
    return {
      ...inbox,
      ...inboxStatus(inbox.type, this.inboxConfig.get(id) ?? null),
      channelConfigPublic: publicChannelConfig(this.inboxConfig.get(id) ?? null),
    };
  }

  async getInboxConfig(id: string): Promise<Record<string, string> | undefined> {
    return this.inboxConfig.get(id);
  }

  async getAppSetting(orgId: string, key: string): Promise<string | undefined> {
    return this.appSettings.get(`${orgId}::${key}`);
  }

  async setAppSetting(orgId: string, key: string, value: string): Promise<void> {
    this.appSettings.set(`${orgId}::${key}`, value);
  }

  async getPlatformSetting(key: string): Promise<string | undefined> {
    return this.appSettings.get(`${PLATFORM_ORG_ID}::${key}`);
  }

  async setPlatformSetting(key: string, value: string): Promise<void> {
    this.appSettings.set(`${PLATFORM_ORG_ID}::${key}`, value);
  }

  /* ---- message templates ---- */

  async listTemplates(_orgId: string): Promise<Template[]> {
    return [...this.templates].sort(
      (a, b) => a.name.localeCompare(b.name) || a.language.localeCompare(b.language),
    );
  }

  async getTemplate(id: string): Promise<Template | undefined> {
    return this.templates.find((t) => t.id === id);
  }

  async createTemplate(_orgId: string, input: CreateTemplateInput): Promise<Template> {
    const tpl: Template = {
      id: `tpl_${++this.idSeq}`,
      // The per-account default is an org setting, applied by TemplatesService.
      isDefault: false,
      name: input.name,
      category: input.category,
      language: input.language,
      body: input.body,
      approvalStatus: "draft",
      variableCount: templateVariableCount(input.body),
      variableDefaults: input.variableDefaults ?? [],
    };
    this.templates.push(tpl);
    return tpl;
  }

  async updateTemplate(id: string, input: UpdateTemplateInput): Promise<Template | undefined> {
    const tpl = this.templates.find((t) => t.id === id);
    if (!tpl) return undefined;
    if (input.name !== undefined) tpl.name = input.name;
    if (input.category !== undefined) tpl.category = input.category;
    if (input.language !== undefined) tpl.language = input.language;
    if (input.body !== undefined) {
      tpl.body = input.body;
      tpl.variableCount = templateVariableCount(input.body);
    }
    if (input.variableDefaults !== undefined) tpl.variableDefaults = input.variableDefaults;
    if (input.approvalStatus !== undefined) tpl.approvalStatus = input.approvalStatus;
    return tpl;
  }

  async deleteTemplate(id: string): Promise<void> {
    this.templates = this.templates.filter((t) => t.id !== id);
  }

  async upsertTemplateByName(
    _orgId: string,
    // `variableDefaults` is deliberately not accepted: a sync brings Meta's
    // name, body and status, while what we pre-fill the variables with is
    // ours, and a re-sync must never reset it.
    input: Omit<CreateTemplateInput, "variableDefaults"> & {
      approvalStatus: Template["approvalStatus"];
      wabaId?: string;
    },
  ): Promise<Template> {
    // Only this account's rows and the unclaimed ones: another account's
    // "order_update" is a different template and must not be overwritten.
    // Within that, a row already claimed by this account beats an unclaimed one.
    const candidates = this.templates
      .filter((t) => t.name === input.name && (!input.wabaId || !t.wabaId || t.wabaId === input.wabaId))
      .sort((a, b) => Number(b.wabaId === input.wabaId) - Number(a.wabaId === input.wabaId));
    // Exact (name, language) first; fall back to the same primary language so
    // Meta's locale-qualified "en_US" updates a locally-stored "en" copy rather
    // than inserting a stale duplicate.
    const existing =
      candidates.find((t) => t.language === input.language) ??
      candidates.find((t) => sameTemplateLang(t.language, input.language));
    if (existing) {
      // Adopt Meta's exact language code so outbound template sends use the code
      // the template is actually approved under — and claim the row for this
      // account, which is how a pre-existing template learns whose it is.
      existing.language = input.language;
      existing.category = input.category;
      existing.body = input.body;
      existing.approvalStatus = input.approvalStatus;
      existing.variableCount = templateVariableCount(input.body);
      if (input.wabaId) existing.wabaId = input.wabaId;
      return existing;
    }
    const tpl: Template = {
      id: `tpl_${++this.idSeq}`,
      // The per-account default is an org setting, applied by TemplatesService.
      isDefault: false,
      name: input.name,
      category: input.category,
      language: input.language,
      body: input.body,
      approvalStatus: input.approvalStatus,
      variableCount: templateVariableCount(input.body),
      // A sync brings Meta's name, body and status. The pre-fill defaults are
      // ours, so a re-sync must never reset them — hence they are set only when
      // the row is created, and left alone on every update above.
      variableDefaults: [],
      ...(input.wabaId ? { wabaId: input.wabaId } : {}),
    };
    this.templates.push(tpl);
    return tpl;
  }

  async pruneTemplatesForWaba(
    _orgId: string,
    wabaId: string,
    keep: Array<{ name: string; language: string }>,
  ): Promise<number> {
    // Compare on the primary language subtag, as the upsert does: Meta may
    // answer "en_US" for a row we hold as "en", and treating that as missing
    // would delete a template that is very much still there.
    const wanted = new Set(keep.map((k) => `${k.name}\u0000${canonicalLang(k.language)}`));
    const before = this.templates.length;
    // Only rows this account has claimed. Unclaimed ones may belong to an
    // account we have not synced yet; locally authored ones belong to nobody.
    this.templates = this.templates.filter(
      (t) => t.wabaId !== wabaId || wanted.has(`${t.name}\u0000${canonicalLang(t.language)}`),
    );
    return before - this.templates.length;
  }

  async listTeams(): Promise<Team[]> {
    return [...this.teams].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  async listMembers(): Promise<Member[]> {
    return this.users.map((u) => ({ user: u, teamIds: this.membership[u.id] ?? [], pending: this.invited.has(u.id) }));
  }

  async createTeam(params: { orgId: string; name: string; icon?: string; slaMinutes?: number | null }): Promise<Team> {
    const order = this.teams.reduce((m, t) => Math.max(m, t.order ?? 0), -1) + 1;
    const team: Team = {
      id: `team_${++this.idSeq}`,
      orgId: params.orgId,
      name: params.name,
      icon: params.icon ?? null,
      order,
      slaMinutes: params.slaMinutes ?? null,
    };
    this.teams.push(team);
    return team;
  }

  async updateTeam(
    id: string,
    params: { name?: string; icon?: string | null; slaMinutes?: number | null },
  ): Promise<Team | undefined> {
    const team = this.teams.find((t) => t.id === id);
    if (!team) return undefined;
    if (params.name !== undefined) team.name = params.name;
    if (params.icon !== undefined) team.icon = params.icon;
    if (params.slaMinutes !== undefined) team.slaMinutes = params.slaMinutes;
    return team;
  }

  async getTeam(id: string): Promise<Team | undefined> {
    return this.teams.find((t) => t.id === id);
  }

  async reorderTeams(orderedIds: string[]): Promise<Team[]> {
    orderedIds.forEach((id, i) => {
      const team = this.teams.find((t) => t.id === id);
      if (team) team.order = i;
    });
    return this.listTeams();
  }

  async reorderInboxes(orderedIds: string[]): Promise<Inbox[]> {
    orderedIds.forEach((id, i) => {
      const inbox = this.inboxes.find((x) => x.id === id);
      if (inbox) inbox.order = i;
    });
    return this.listInboxes();
  }

  async deleteTeam(id: string): Promise<void> {
    this.teams = this.teams.filter((t) => t.id !== id);
    for (const uid of Object.keys(this.membership)) {
      this.membership[uid] = this.membership[uid].filter((t) => t !== id);
    }
    for (const inbox of this.inboxes) inbox.teamIds = inbox.teamIds.filter((t) => t !== id);
    for (const c of this.conversations) if (c.assignedTeamId === id) c.assignedTeamId = null;
  }

  async createUser(params: {
    orgId: string;
    name: string;
    email: string;
    role: Role;
    teamIds: string[];
    position?: string | null;
    password?: string;
  }): Promise<{ user: User; inviteToken?: string }> {
    const id = `usr_${++this.idSeq}`;
    const user: User = {
      id,
      orgId: params.orgId,
      name: params.name,
      email: params.email,
      role: params.role,
      avatarColor: AVATAR_PALETTE[this.users.length % AVATAR_PALETTE.length],
      online: false,
      available: true,
      position: params.position ?? null,
    };
    this.users.push(user);
    this.membership[id] = params.teamIds;
    if (params.password) {
      this.passwords.set(id, bcrypt.hashSync(params.password, 8));
      return { user };
    }
    // No password given → mint an invite token; the account can't log in with a
    // known password until the invitee sets one (guard with a random hash).
    this.passwords.set(id, bcrypt.hashSync(randomBytes(24).toString("hex"), 8));
    const inv = newInviteToken();
    this.invites.set(id, { hash: inv.hash, exp: inv.expiresAt.getTime() });
    this.invited.add(id);
    return { user, inviteToken: inv.token };
  }

  async setPasswordByInviteToken(token: string, password: string): Promise<User | undefined> {
    const hash = hashInviteToken(token);
    for (const [userId, inv] of this.invites) {
      if (inv.hash !== hash) continue;
      if (Date.now() > inv.exp) return undefined; // expired
      this.passwords.set(userId, bcrypt.hashSync(password, 8));
      this.invites.delete(userId);
      this.invited.delete(userId);
      return this.users.find((u) => u.id === userId);
    }
    return undefined;
  }

  async createPasswordResetToken(email: string): Promise<{ user: User; token: string } | null> {
    const user = this.users.find((u) => u.email.toLowerCase() === email.toLowerCase());
    if (!user) return null;
    const inv = newInviteToken();
    this.invites.set(user.id, { hash: inv.hash, exp: inv.expiresAt.getTime() });
    return { user, token: inv.token };
  }

  async updateUser(
    id: string,
    params: { name?: string; role?: Role; teamIds?: string[]; position?: string | null },
  ): Promise<User | undefined> {
    const user = this.users.find((u) => u.id === id);
    if (!user) return undefined;
    if (params.position !== undefined) user.position = params.position;
    if (params.name !== undefined) user.name = params.name;
    if (params.role !== undefined) user.role = params.role;
    if (params.teamIds !== undefined) this.membership[id] = params.teamIds;
    return user;
  }

  async updateMyPreferences(
    userId: string,
    params: { available?: boolean; schedule?: AvailabilitySchedule | null },
  ): Promise<User | undefined> {
    const user = this.users.find((u) => u.id === userId);
    if (!user) return undefined;
    if (params.available !== undefined) user.available = params.available;
    if (params.schedule !== undefined) user.schedule = params.schedule;
    return user;
  }

  async updateMyProfile(
    userId: string,
    params: { name?: string; email?: string; avatarUrl?: string | null; position?: string | null },
  ): Promise<User | undefined> {
    const user = this.users.find((u) => u.id === userId);
    if (!user) return undefined;
    if (params.position !== undefined) user.position = params.position;
    if (params.name !== undefined) user.name = params.name;
    if (params.email !== undefined) user.email = params.email;
    if (params.avatarUrl !== undefined) user.avatarUrl = params.avatarUrl ?? undefined;
    return user;
  }

  async setUserPassword(userId: string, password: string): Promise<void> {
    this.passwords.set(userId, bcrypt.hashSync(password, 8));
  }

  async deleteUser(id: string): Promise<void> {
    this.users = this.users.filter((u) => u.id !== id);
    delete this.membership[id];
    this.passwords.delete(id);
    this.sessions = this.sessions.filter((s) => s.userId !== id);
    this.devices = this.devices.filter((d) => d.userId !== id);
    this.pushPrefs.delete(id);
    this.twoFactor.delete(id);
    this.recoveryCodes = this.recoveryCodes.filter((c) => c.userId !== id);
    for (const c of this.conversations) if (c.assigneeUserId === id) c.assigneeUserId = null;
  }

  async createSession(userId: string, meta: { ip?: string; userAgent?: string }): Promise<StoredSession> {
    const now = new Date().toISOString();
    const s: StoredSession = {
      id: `sess_${++this.idSeq}`,
      userId,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      createdAt: now,
      lastSeenAt: now,
      revokedAt: null,
    };
    this.sessions.push(s);
    return s;
  }

  async getSession(id: string): Promise<StoredSession | undefined> {
    return this.sessions.find((s) => s.id === id);
  }

  async listSessions(userId: string): Promise<StoredSession[]> {
    return this.sessions
      .filter((s) => s.userId === userId)
      // Active first, then most-recently-seen first.
      .sort((a, b) => (a.revokedAt ? 1 : 0) - (b.revokedAt ? 1 : 0) || b.lastSeenAt.localeCompare(a.lastSeenAt));
  }

  async touchSession(id: string): Promise<void> {
    const s = this.sessions.find((x) => x.id === id);
    if (s && !s.revokedAt) s.lastSeenAt = new Date().toISOString();
  }

  async revokeSession(userId: string, id: string): Promise<boolean> {
    const s = this.sessions.find((x) => x.id === id && x.userId === userId);
    if (!s) return false;
    if (!s.revokedAt) s.revokedAt = new Date().toISOString();
    await this.deleteDevicesForSessions([id]);
    return true;
  }

  async revokeOtherSessions(userId: string, keepId: string): Promise<number> {
    let n = 0;
    const now = new Date().toISOString();
    const revoked: string[] = [];
    for (const s of this.sessions) {
      if (s.userId === userId && s.id !== keepId && !s.revokedAt) {
        s.revokedAt = now;
        revoked.push(s.id);
        n++;
      }
    }
    await this.deleteDevicesForSessions(revoked);
    return n;
  }

  /* ---- push devices ---- */

  async upsertDevice(params: {
    userId: string;
    sessionId?: string;
    pushToken: string;
    platform: string;
    appVersion?: string;
    osVersion?: string;
    deviceName?: string;
  }): Promise<StoredDevice> {
    const now = new Date().toISOString();
    const existing = this.devices.find((d) => d.pushToken === params.pushToken);
    if (existing) {
      // A re-registration proves the token is live and says who holds it now —
      // so it moves to this user/session and clears any earlier disable.
      Object.assign(existing, {
        userId: params.userId,
        sessionId: params.sessionId ?? null,
        platform: params.platform,
        appVersion: params.appVersion ?? existing.appVersion,
        osVersion: params.osVersion ?? existing.osVersion,
        deviceName: params.deviceName ?? existing.deviceName,
        lastSeenAt: now,
        disabledAt: null,
        disabledReason: null,
      });
      return existing;
    }
    const d: StoredDevice = {
      id: `dev_${++this.idSeq}`,
      userId: params.userId,
      sessionId: params.sessionId ?? null,
      pushToken: params.pushToken,
      platform: params.platform,
      appVersion: params.appVersion ?? null,
      osVersion: params.osVersion ?? null,
      deviceName: params.deviceName ?? null,
      createdAt: now,
      lastSeenAt: now,
      disabledAt: null,
      disabledReason: null,
    };
    this.devices.push(d);
    return d;
  }

  async listDevices(userId: string): Promise<StoredDevice[]> {
    return this.devices
      .filter((d) => d.userId === userId)
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  }

  async devicesForUsers(userIds: string[]): Promise<StoredDevice[]> {
    const wanted = new Set(userIds);
    return this.devices.filter((d) => {
      if (!wanted.has(d.userId) || d.disabledAt) return false;
      if (!d.sessionId) return true;
      const s = this.sessions.find((x) => x.id === d.sessionId);
      return !!s && !s.revokedAt;
    });
  }

  async deleteDevice(userId: string, id: string): Promise<boolean> {
    const i = this.devices.findIndex((d) => d.id === id && d.userId === userId);
    if (i === -1) return false;
    this.devices.splice(i, 1);
    return true;
  }

  async deleteDevicesForSessions(sessionIds: string[]): Promise<number> {
    if (!sessionIds.length) return 0;
    const ids = new Set(sessionIds);
    const before = this.devices.length;
    this.devices = this.devices.filter((d) => !d.sessionId || !ids.has(d.sessionId));
    return before - this.devices.length;
  }

  async disableDevice(pushToken: string, reason: string): Promise<void> {
    const d = this.devices.find((x) => x.pushToken === pushToken);
    if (!d || d.disabledAt) return;
    d.disabledAt = new Date().toISOString();
    d.disabledReason = reason;
  }

  /* ---- customer devices (in-app SDK) ---- */

  async registerCustomerDevice(params: {
    orgId: string;
    contactId: string;
    inboxId: string;
    token: string;
    platform: string;
  }): Promise<StoredCustomerDevice> {
    const now = new Date().toISOString();
    const existing = this.customerDevices.find((d) => d.token === params.token);
    if (existing) {
      // Presenting the token proves the address is live and says who holds it
      // now, so it moves and any earlier disable is lifted.
      Object.assign(existing, {
        orgId: params.orgId,
        contactId: params.contactId,
        inboxId: params.inboxId,
        platform: params.platform,
        lastSeenAt: now,
        disabledAt: null,
        disabledReason: null,
      });
      return existing;
    }
    const d: StoredCustomerDevice = {
      id: `cdev_${++this.idSeq}`,
      orgId: params.orgId,
      contactId: params.contactId,
      inboxId: params.inboxId,
      token: params.token,
      platform: params.platform,
      createdAt: now,
      lastSeenAt: now,
      disabledAt: null,
      disabledReason: null,
    };
    this.customerDevices.push(d);
    return d;
  }

  async customerDevicesFor(contactId: string, inboxId: string): Promise<StoredCustomerDevice[]> {
    return this.customerDevices.filter(
      (d) => d.contactId === contactId && d.inboxId === inboxId && !d.disabledAt,
    );
  }

  async latestCustomerDeviceFor(inboxId: string): Promise<StoredCustomerDevice | null> {
    const live = this.customerDevices.filter((d) => d.inboxId === inboxId && !d.disabledAt);
    if (!live.length) return null;
    return live.reduce((newest, d) => (d.lastSeenAt > newest.lastSeenAt ? d : newest));
  }

  async deleteCustomerDevice(contactId: string, token: string): Promise<boolean> {
    const i = this.customerDevices.findIndex((d) => d.token === token && d.contactId === contactId);
    if (i === -1) return false;
    this.customerDevices.splice(i, 1);
    return true;
  }

  async disableCustomerDevice(token: string, reason: string): Promise<void> {
    const d = this.customerDevices.find((x) => x.token === token);
    if (!d || d.disabledAt) return;
    d.disabledAt = new Date().toISOString();
    d.disabledReason = reason;
  }

  async getPushPrefs(userId: string): Promise<string | undefined> {
    return this.pushPrefs.get(userId);
  }

  async setPushPrefs(userId: string, json: string): Promise<void> {
    this.pushPrefs.set(userId, json);
  }

  private emptyTwoFactor(): TwoFactorState {
    return { enabled: false, method: null, totpSecret: null, emailCodeHash: null, emailCodeExpires: null };
  }

  async getTwoFactor(userId: string): Promise<TwoFactorState | undefined> {
    if (!this.users.some((u) => u.id === userId)) return undefined;
    return this.twoFactor.get(userId) ?? this.emptyTwoFactor();
  }

  async updateTwoFactor(userId: string, patch: Partial<TwoFactorState>): Promise<void> {
    const next = { ...(this.twoFactor.get(userId) ?? this.emptyTwoFactor()), ...patch };
    this.twoFactor.set(userId, next);
    // Mirror the public flags onto the user so me()/mapUser reflect them.
    const user = this.users.find((u) => u.id === userId);
    if (user) {
      user.twoFactorEnabled = next.enabled;
      user.twoFactorMethod = (next.method as "totp" | "email" | null) ?? null;
    }
  }

  async listRecoveryCodes(userId: string): Promise<{ id: string; codeHash: string; usedAt: string | null }[]> {
    return this.recoveryCodes
      .filter((c) => c.userId === userId)
      .map((c) => ({ id: c.id, codeHash: c.codeHash, usedAt: c.usedAt }));
  }

  async replaceRecoveryCodes(userId: string, codeHashes: string[]): Promise<void> {
    this.recoveryCodes = this.recoveryCodes.filter((c) => c.userId !== userId);
    for (const h of codeHashes) this.recoveryCodes.push({ id: `rc_${++this.idSeq}`, userId, codeHash: h, usedAt: null });
  }

  async markRecoveryCodeUsed(id: string): Promise<void> {
    const c = this.recoveryCodes.find((x) => x.id === id);
    if (c && !c.usedAt) c.usedAt = new Date().toISOString();
  }

  async teamsForUser(userId: string): Promise<string[]> {
    return this.membership[userId] ?? [];
  }

  async me(userId: string) {
    const user = this.users.find((u) => u.id === userId);
    const teamIds = this.membership[userId] ?? [];
    return { user, teams: this.teams.filter((t) => teamIds.includes(t.id)) };
  }

  async setDefaultInbox(inboxId: string, on: boolean): Promise<Inbox | undefined> {
    const target = this.inboxes.find((i) => i.id === inboxId);
    if (!target) return undefined;
    for (const i of this.inboxes) if (i.type === target.type) i.isDefault = false;
    target.isDefault = on;
    return target;
  }

  async isSandboxOrg(_orgId: string): Promise<boolean> {
    return false; // the in-memory store holds one, ordinary, workspace
  }

  async conversationOrg(conversationId: string): Promise<string | undefined> {
    return this.conversations.find((c) => c.id === conversationId)?.orgId;
  }

  async inboxOrg(inboxId: string): Promise<string | undefined> {
    return this.inboxes.find((i) => i.id === inboxId)?.orgId;
  }

  async listInboxesAcrossWorkspaces(type: ChannelType): Promise<Inbox[]> {
    return (await this.listInboxes()).filter((i) => i.type === type);
  }

  async listInboxes(): Promise<Inbox[]> {
    // Sorted rather than returned in insertion order, so this store answers
    // the same question the Postgres one does. A memory store that happens to
    // be right because nothing has moved is a store that stops being right the
    // first time somebody presses an arrow.
    return [...this.inboxes]
      .sort(byChosenOrder)
      .map((i) => ({
        ...i,
        ...inboxStatus(i.type, this.inboxConfig.get(i.id) ?? null),
        channelConfigPublic: publicChannelConfig(this.inboxConfig.get(i.id) ?? null),
      }));
  }

  async getMembers(teamId: string): Promise<User[]> {
    const ids = Object.entries(this.membership)
      .filter(([, teams]) => teams.includes(teamId))
      .map(([userId]) => userId);
    return this.users.filter((u) => ids.includes(u.id));
  }

  private inbox(id: string): Inbox | undefined {
    return this.inboxes.find((i) => i.id === id);
  }

  private mentionToken(userId: string): string {
    const u = this.users.find((x) => x.id === userId);
    return "@" + (u?.email.split("@")[0].toLowerCase() ?? "");
  }

  private isUpForGrabs(rec: ConversationRecord, userTeams: string[]): boolean {
    if (rec.assigneeUserId) return false;
    if (rec.status === "closed" || rec.status === "snoozed") return false;
    // A conversation explicitly routed to a team is grabbable only by that team;
    // otherwise it falls to the team(s) its inbox routes to.
    if (rec.assignedTeamId) return userTeams.includes(rec.assignedTeamId);
    const inbox = this.inbox(rec.inboxId);
    return !!inbox && inbox.teamIds.some((t) => userTeams.includes(t));
  }

  /**
   * `forCount` distinguishes the sidebar badge (active work only) from the
   * conversation list (which also carries closed items so the "Closed" filter
   * has something to show). Personal queues (inbound/grabs) stay active-only.
   */
  private matchesView(
    rec: ConversationRecord,
    view: string,
    userId: string,
    userTeams: string[],
    forCount = false,
  ): boolean {
    const active = rec.status === "open" || rec.status === "pending";
    // Lists carry closed items (for the Closed filter) but never snoozed ones —
    // those live only in "Later". Counts (badges) are active-only.
    const inList = forCount ? active : rec.status !== "snoozed";
    if (view === "mine") return rec.assigneeUserId === userId && inList;
    if (view === "grabs") return this.isUpForGrabs(rec, userTeams);
    if (view === "inbound")
      return (
        (rec.assigneeUserId === userId && inList) ||
        this.isUpForGrabs(rec, userTeams) ||
        // Someone else's conversation, here because of its notes (see PrismaStore).
        (inList && this.followUps.has(followUpKey(rec.id, userId)))
      );
    if (view === "snoozed") return rec.status === "snoozed";
    if (view === "mentions") {
      const token = this.mentionToken(userId);
      // Open work only in the badge, like the other queues (see PrismaStore).
      return inList && rec.messages.some((m) => m.internal && m.body.toLowerCase().includes(token));
    }
    if (view.startsWith("team:")) {
      const teamId = view.slice(5);
      // A team's inbox = conversations routed to it (assignedTeamId), plus the
      // unrouted ones whose channel points at the team.
      const inbox = this.inbox(rec.inboxId);
      const belongs = rec.assignedTeamId
        ? rec.assignedTeamId === teamId
        : !!inbox && inbox.teamIds.includes(teamId);
      return belongs && inList;
    }
    if (view.startsWith("inbox:")) return rec.inboxId === view.slice(6) && inList;
    if (view.startsWith("label:")) return rec.labels.some((l) => l.id === view.slice(6)) && inList;
    return false;
  }

  private summary(rec: ConversationRecord): Conversation {
    const { messages, participants: _participants, lastInboundAt, ...rest } = rec;
    void _participants;
    // Derive the last inbound time from history when not explicitly tracked, so
    // the WhatsApp window is right for seeded threads too (no inbound → closed).
    const lastInbound =
      lastInboundAt ??
      [...messages].reverse().find((m) => m.direction === "in")?.createdAt ??
      null;
    // The most recent customer-facing message's channel drives the list badge.
    const lastMsg = [...messages].reverse().find((m) => !m.internal);
    return {
      ...rest,
      snoozedUntil: rest.snoozedUntil ?? null,
      unreadCount: rest.unreadCount ?? 0,
      // Resolve the assignee's name so the UI shows the real owner, not just "You".
      assigneeName: rest.assigneeUserId
        ? this.users.find((u) => u.id === rest.assigneeUserId)?.name ?? null
        : null,
      lastChannel: lastMsg?.channel ?? rest.channel,
      waWindow: computeWaWindow(rest.channel, lastInbound),
    };
  }

  /** How many snoozed conversations are now due (wake time passed). */
  private dueSnoozeCount(): number {
    const now = Date.now();
    return this.conversations.filter(
      (r) => r.status === "snoozed" && r.snoozedUntil && new Date(r.snoozedUntil).getTime() <= now,
    ).length;
  }

  async listConversations(
    view: string,
    userId: string,
    opts?: { cursor?: string; limit?: number; field?: { key: string; value?: string }; status?: ListStatus },
  ): Promise<ConversationPage> {
    const sorted = (await this.viewRows(view, userId, opts?.field))
      .filter((c) => (opts?.status === "active" ? c.status !== "closed" : opts?.status === "closed" ? c.status === "closed" : true))
      .sort(byRecencyDesc);
    return this.pageConversations(sorted, opts);
  }

  /** Every conversation a view (and field filter) holds — the list, unpaged. */
  private async viewRows(
    view: string,
    userId: string,
    field?: { key: string; value?: string },
  ): Promise<ConversationRecord[]> {
    const userTeams = this.membership[userId] ?? [];
    let matchesField: (r: ConversationRecord) => boolean = () => true;
    if (field) {
      const { conversationIds, contactIds } = await this.findByCustomField("", field.key, field.value);
      const convs = new Set(conversationIds);
      const contacts = new Set(contactIds);
      matchesField = (r) => convs.has(r.id) || contacts.has(r.contact.id);
    }
    return this.conversations.filter(
      (r) => this.matchesView(r, view, userId, userTeams) && matchesField(r),
    );
  }

  async conversationFilterCounts(
    view: string,
    userId: string,
    opts?: { field?: { key: string; value?: string } },
  ): Promise<ConversationFilterCounts> {
    const rows = await this.viewRows(view, userId, opts?.field);
    const live = rows.filter((r) => r.status !== "closed");
    return {
      all: live.length,
      unread: live.filter((r) => r.unread || (r.unreadCount ?? 0) > 0).length,
      mine: live.filter((r) => r.assigneeUserId === userId).length,
      unassigned: live.filter((r) => !r.assigneeUserId).length,
      groups: live.filter((r) => r.channel === "whatsapp_group").length,
      closed: rows.length - live.length,
    };
  }

  async searchConversations(
    query: string,
    opts?: { cursor?: string; limit?: number; view?: string; userId?: string },
  ): Promise<ConversationPage> {
    const q = query.trim().toLowerCase();
    if (!q) return { items: [], nextCursor: null };
    // Scoped to the inbox you're searching from, when one is given. Searching
    // inside "My Inbound" and getting a hit from a team inbox you don't work is
    // a result you can't act on and can't explain — the field is inside the
    // view, so its results belong to the view.
    const teams = opts?.userId ? (this.membership[opts.userId] ?? []) : [];
    const inView = (r: ConversationRecord) =>
      !opts?.view || !opts.userId || this.matchesView(r, opts.view, opts.userId, teams);
    // Custom fields, both kinds: one recorded on the thread (the order this chat
    // is about) and one on the person (their account number). Resolved to ids
    // first, the same way the Prisma store does, so the two agree on what a
    // reference number matches.
    const convHits = new Set(await this.findByCustomFieldValue("", "conversation", query));
    const contactHits = new Set(await this.findByCustomFieldValue("", "contact", query));
    const sorted = this.conversations
      .filter(
        (r) =>
          inView(r) &&
          (
          r.contact.displayName.toLowerCase().includes(q) ||
          (r.contact.company ?? "").toLowerCase().includes(q) ||
          (r.subject ?? "").toLowerCase().includes(q) ||
          (r.preview ?? "").toLowerCase().includes(q) ||
          convHits.has(r.id) ||
          contactHits.has(r.contact.id) ||
            r.messages.some((m) => (m.body ?? "").toLowerCase().includes(q))),
      )
      .sort(byRecencyDesc);
    return this.pageConversations(sorted, opts);
  }

  /** Slice a pre-sorted record list into one cursor page. */
  private pageConversations(
    sorted: ConversationRecord[],
    opts?: { cursor?: string; limit?: number },
  ): ConversationPage {
    const limit = clampLimit(opts?.limit, CONVERSATIONS_PAGE_SIZE);
    let start = 0;
    if (opts?.cursor) {
      const decoded = safeDecode(opts.cursor);
      const idx = sorted.findIndex((r) => `${r.lastActivityAt}::${r.id}` === decoded);
      start = idx >= 0 ? idx + 1 : 0;
    }
    const page = sorted.slice(start, start + limit);
    const hasMore = start + limit < sorted.length;
    const last = page[page.length - 1];
    return {
      items: page.map((r) => this.summary(r)),
      nextCursor: hasMore && last ? encodeMemCursor(last) : null,
    };
  }

  /** conversationId|userId → why it's in that person's My Inbound. */
  private readonly followUps = new Map<string, NoteFollowUp>();

  async addNoteFollowUps(
    conversationId: string,
    entries: { userId: string; reason: NoteFollowUp["reason"]; byUserId: string | null }[],
  ): Promise<void> {
    for (const e of entries) {
      this.followUps.set(followUpKey(conversationId, e.userId), { reason: e.reason, byUserId: e.byUserId, since: new Date().toISOString() });
    }
  }

  async clearNoteFollowUps(conversationId: string, userId?: string): Promise<number> {
    let n = 0;
    for (const key of [...this.followUps.keys()]) {
      const [c, u] = key.split("|");
      if (c === conversationId && (!userId || u === userId)) {
        this.followUps.delete(key);
        n++;
      }
    }
    return n;
  }

  async noteFollowUpsFor(userId: string, conversationIds: string[]): Promise<Map<string, NoteFollowUp>> {
    const out = new Map<string, NoteFollowUp>();
    for (const id of conversationIds) {
      const f = this.followUps.get(followUpKey(id, userId));
      if (f) out.set(id, f);
    }
    return out;
  }

  async unreadConversationCount(userId: string): Promise<number> {
    const userTeams = this.membership[userId] ?? [];
    return this.conversations.filter(
      (r) =>
        this.matchesView(r, "inbound", userId, userTeams, true) &&
        (r.unread || (r.unreadCount ?? 0) > 0 || this.followUps.has(followUpKey(r.id, userId))),
    ).length;
  }

  async views(userId: string): Promise<SidebarViews> {
    const userTeams = this.membership[userId] ?? [];
    // Admins & managers oversee the whole workspace: they see every team and
    // channel in the shared section, regardless of their own team memberships.
    // Personal queues (My Inbound / Mine / Queue) stay membership-scoped for all.
    const role = this.users.find((u) => u.id === userId)?.role;
    const elevated = role === "admin" || role === "manager";
    const count = (view: string) =>
      this.conversations.filter((r) => this.matchesView(r, view, userId, userTeams, true)).length;
    const my: ViewItem[] = [
      { key: "inbound", title: "My Inbound", count: count("inbound") },
      { key: "mine", title: "Mine", count: count("mine") },
      { key: "grabs", title: "Queue", count: count("grabs") },
      { key: "mentions", title: "@ Mentions", count: count("mentions") },
      { key: "snoozed", title: "Later", count: count("snoozed"), due: this.dueSnoozeCount() },
    ];
    const teams: ViewItem[] = [...this.teams]
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .filter((t) => elevated || userTeams.includes(t.id))
      .map((t) => ({ key: `team:${t.id}`, title: t.name, count: count(`team:${t.id}`) }));
    const inboxes: ViewItem[] = [...this.inboxes]
      .sort(byChosenOrder)
      .filter((i) => elevated || i.teamIds.some((t) => userTeams.includes(t)))
      .map((i) => {
        const groups =
          i.type === "whatsapp"
            ? this.conversations
                .filter((c) => c.inboxId === i.id && c.channel === "whatsapp_group")
                .map((c) => ({ id: c.id, title: c.contact.displayName }))
            : [];
        return {
          key: `inbox:${i.id}`,
          title: i.name,
          count: count(`inbox:${i.id}`),
          channel: i.type,
          handle: i.handle,
          groups: groups.length ? groups : undefined,
        };
      });
    // Labels the viewer can filter by — only those actually in use (tidy sidebar);
    // the full catalogue lives in Settings + the per-conversation picker.
    const labels: ViewItem[] = [...this.labels]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((l) => ({ key: `label:${l.id}`, title: l.name, count: count(`label:${l.id}`), color: l.color }))
      .filter((v) => v.count > 0);
    return { my, shared: { teams, inboxes, labels } };
  }

  async getConversation(id: string): Promise<ConversationWithMessages | undefined> {
    const rec = this.conversations.find((c) => c.id === id);
    if (!rec) return undefined;
    // Only the most-recent page of messages — never the full lifetime thread.
    const hasMoreMessages = rec.messages.length > MESSAGES_PAGE_SIZE;
    const messages = hasMoreMessages ? rec.messages.slice(-MESSAGES_PAGE_SIZE) : rec.messages;
    return { ...this.summary(rec), messages, hasMoreMessages, participants: rec.participants ?? [] };
  }

  async listMessages(
    conversationId: string,
    opts?: { before?: string; limit?: number },
  ): Promise<MessagePage> {
    const rec = this.conversations.find((c) => c.id === conversationId);
    if (!rec) return { items: [], nextCursor: null };
    const limit = clampLimit(opts?.limit, MESSAGES_PAGE_SIZE);
    const beforeSeq = opts?.before != null ? Number(opts.before) : Infinity;
    const older = rec.messages.filter((m) => m.seq < beforeSeq); // ascending by seq
    const hasMore = older.length > limit;
    const page = older.slice(Math.max(0, older.length - limit)); // most-recent `limit` older msgs
    const oldest = page[0];
    return { items: page, nextCursor: hasMore && oldest ? String(oldest.seq) : null };
  }

  async addMessage(
    conversationId: string,
    input: {
      body: string;
      bodyHtml?: string;
      internal: boolean;
      attachmentIds?: string[];
      quotedMsgId?: string;
      channel?: ChannelType;
      idempotencyKey?: string;
      deliveryMeta?: OutboundDeliveryMeta;
      forwarded?: boolean;
    },
    author: User,
  ): Promise<Message | undefined> {
    const rec = this.conversations.find((c) => c.id === conversationId);
    if (!rec) return undefined;
    // Claim staged uploads (attached in the composer, not yet tied to a message).
    const attachments = this.takePendingAttachments(input.attachmentIds);
    const messageType = attachments.length ? messageTypeForKind(attachments[0].kind) : "text";
    const message: Message = {
      id: `msg_live_${++this.idSeq}`,
      conversationId,
      seq: ++rec.seq,
      direction: "out",
      authorType: "user",
      authorName: author.name,
      authorUserId: author.id,
      body: input.body,
      bodyHtml: input.bodyHtml,
      // A real reply starts queued and climbs the ladder as the channel confirms
      // it (queued → sending → sent → delivered → read); notes have no ladder.
      status: input.internal ? "sent" : "queued",
      internal: input.internal,
      messageType,
      channel: input.channel,
      attachments,
      reactions: [],
      quotedMsgId: input.quotedMsgId,
      ...(input.forwarded ? { forwarded: true } : {}),
      // Surface the email headers on the message so the bubble can show them.
      email:
        input.deliveryMeta &&
        (input.deliveryMeta.subject ||
          input.deliveryMeta.cc?.length ||
          input.deliveryMeta.bcc?.length ||
          input.deliveryMeta.forwardTo?.length)
          ? {
              subject: input.deliveryMeta.subject,
              cc: input.deliveryMeta.cc,
              bcc: input.deliveryMeta.bcc,
              forwardedTo: input.deliveryMeta.forwardTo,
            }
          : undefined,
      ...(input.internal ? {} : { attemptCount: 0 }),
      createdAt: new Date().toISOString(),
    };
    if (!input.internal && (input.idempotencyKey || input.deliveryMeta)) {
      this.outboundMeta.set(message.id, {
        idempotencyKey: input.idempotencyKey,
        deliveryMeta: input.deliveryMeta,
      });
    }
    rec.messages.push(message);
    rec.unread = false;
    rec.unreadCount = 0;
    if (!input.internal) {
      // Only a real (non-note) message advances the card's time + list order.
      rec.lastActivityAt = message.createdAt;
      rec.preview = previewFromBody(input.body) || previewForType(messageType);
      // Replying to a snoozed conversation wakes it back into the active queue.
      if (rec.status === "snoozed") rec.status = "open";
      // A real reply clears any snooze state: it un-snoozes a still-snoozed chat
      // and drops the "Back from Later" marker (a past snooze time the wake sweep
      // left on an active chat) now that the agent has actually responded.
      rec.snoozedUntil = null;
      // Replying to an unclaimed chat takes ownership of it.
      if (!rec.assigneeUserId && rec.status !== "closed") rec.assigneeUserId = author.id;
    }
    return message;
  }

  async addAutoMessage(
    conversationId: string,
    input: { body: string; auto: MessageAuto; authorName?: string },
  ): Promise<Message | undefined> {
    const rec = this.conversations.find((c) => c.id === conversationId);
    if (!rec) return undefined;
    const message: Message = {
      id: `msg_live_${++this.idSeq}`,
      conversationId,
      seq: ++rec.seq,
      direction: "out",
      authorType: "user",
      authorName: input.authorName,
      authorUserId: null,
      body: input.body,
      status: "delivered",
      internal: false,
      messageType: "text",
      channel: rec.channel,
      attachments: [],
      reactions: [],
      auto: input.auto,
      createdAt: new Date().toISOString(),
    };
    rec.messages.push(message);
    return message;
  }

  async createUploadAttachment(_orgId: string, input: AttachmentInput): Promise<Attachment> {
    const id = `att_${++this.idSeq}`;
    this.mediaRefs.set(id, { storageKey: input.storageKey, mime: input.mime, filename: input.filename });
    const att: Attachment = {
      id,
      kind: input.kind,
      mime: input.mime,
      size: input.size,
      filename: input.filename,
      url: `/api/media/${id}`,
      durationMs: input.durationMs,
      width: input.width,
      height: input.height,
      waveform: input.waveform,
    };
    this.pendingUploads.set(id, att);
    return att;
  }

  async getMessagePlace(messageId: string): Promise<{ conversationId: string; internal: boolean } | undefined> {
    const orgId = boundOrgId();
    for (const c of this.conversations) {
      if (orgId && c.orgId !== orgId) continue;
      const m = c.messages.find((x) => x.id === messageId);
      if (m) return { conversationId: c.id, internal: m.internal };
    }
    return undefined;
  }

  async stageAttachmentCopies(messageId: string): Promise<string[]> {
    let source: Attachment[] | undefined;
    for (const rec of this.conversations) {
      const m = rec.messages.find((x) => x.id === messageId);
      if (m) {
        source = m.attachments;
        break;
      }
    }
    if (!source?.length) return [];
    const ids: string[] = [];
    for (const att of source) {
      // The copy re-uses the original's storage ref, so the same object is served
      // for both messages and forwarding a large file costs nothing.
      const ref = this.mediaRefs.get(att.id);
      const id = `att_${++this.idSeq}`;
      if (ref) this.mediaRefs.set(id, ref);
      // Only re-point the URL when there's a ref behind it. Seeded demo media is
      // an inline data: URI with nothing in `mediaRefs`, and rewriting that to
      // /api/media/<newId> would produce a copy whose URL 404s.
      this.pendingUploads.set(id, { ...att, id, ...(ref ? { url: `/api/media/${id}` } : {}) });
      ids.push(id);
    }
    return ids;
  }

  /** Pull staged uploads out of the pending map (they now belong to a message). */
  private takePendingAttachments(ids?: string[]): Attachment[] {
    if (!ids?.length) return [];
    const out: Attachment[] = [];
    for (const id of ids) {
      const att = this.pendingUploads.get(id);
      if (att) {
        out.push(att);
        this.pendingUploads.delete(id);
      }
    }
    return out;
  }

  async assign(
    conversationId: string,
    input: { assigneeUserId?: string | null; assignedTeamId?: string | null },
  ): Promise<Conversation | undefined> {
    const rec = this.conversations.find((c) => c.id === conversationId);
    if (!rec) return undefined;
    if (input.assigneeUserId !== undefined) rec.assigneeUserId = input.assigneeUserId;
    if (input.assignedTeamId !== undefined) rec.assignedTeamId = input.assignedTeamId;
    // Assignment must not reorder the list or reset the card time.
    return this.summary(rec);
  }

  async rerouteInboxConversations(inboxId: string): Promise<number> {
    const inbox = this.inbox(inboxId);
    if (!inbox) return 0;
    const valid = new Set(inbox.teamIds);
    const primary = inbox.teamIds[0] ?? null;
    let moved = 0;
    for (const c of this.conversations) {
      if (c.inboxId !== inboxId) continue;
      if (c.status !== "open" && c.status !== "pending") continue;
      // Leave chats already sitting on a team the channel still serves.
      if (c.assignedTeamId && valid.has(c.assignedTeamId)) continue;
      const ownerTeam = c.contact.ownerTeamId ?? null;
      const ownerUser = c.contact.ownerUserId ?? null;
      if (ownerTeam) {
        c.assignedTeamId = ownerTeam;
        c.assigneeUserId = ownerUser;
      } else {
        c.assignedTeamId = primary;
        c.assigneeUserId = ownerUser; // a pinned person keeps the chat; else queue
      }
      moved++;
    }
    return moved;
  }

  async setStatus(conversationId: string, status: ConversationStatus): Promise<Conversation | undefined> {
    const rec = this.conversations.find((c) => c.id === conversationId);
    if (!rec) return undefined;
    rec.status = status;
    // Closing clears the unread flag; a status change doesn't reorder the list.
    if (status === "closed") { rec.unread = false; rec.unreadCount = 0; }
    // …and closed is done for everyone: nothing about it waits in anyone's inbound.
    if (status === "closed") await this.clearNoteFollowUps(conversationId);
    if (status !== "snoozed") rec.snoozedUntil = null;
    return this.summary(rec);
  }

  // ---- the conversation log ----
  private conversationEvents: Array<ConversationEventRow & { conversationId: string }> = [];

  async conversationState(conversationId: string): Promise<ConversationState | undefined> {
    const rec = this.conversations.find((c) => c.id === conversationId);
    if (!rec) return undefined;
    return {
      status: rec.status,
      assigneeUserId: rec.assigneeUserId ?? null,
      assignedTeamId: rec.assignedTeamId ?? null,
      priority: rec.priority ?? "normal",
      snoozedUntil: rec.snoozedUntil ?? null,
    };
  }

  async logConversationEvent(conversationId: string, e: ConversationEventInput): Promise<void> {
    if (!this.conversations.some((c) => c.id === conversationId)) return;
    this.conversationEvents.push({
      id: `cev_${++this.idSeq}`,
      conversationId,
      type: e.type,
      actorKind: e.actorKind,
      actorUserId: e.actorUserId ?? null,
      data: { ...(e.data ?? {}) },
      createdAt: new Date().toISOString(),
    });
  }

  async listConversationEvents(conversationId: string, limit = 500): Promise<ConversationEventRow[]> {
    return this.conversationEvents
      .filter((e) => e.conversationId === conversationId)
      .map((e, i) => ({ e, i }))
      // Newest first; entries written in the same millisecond keep their order.
      .sort((a, b) => b.e.createdAt.localeCompare(a.e.createdAt) || b.i - a.i)
      .slice(0, limit)
      .map(({ e: { conversationId: _c, ...row } }) => ({ ...row, data: { ...row.data } }));
  }

  async wakeSnoozed(conversationId: string): Promise<Conversation | undefined> {
    const rec = this.conversations.find((c) => c.id === conversationId);
    if (!rec) return undefined;
    // Wake into the active queue but KEEP snoozedUntil as the "back from Later"
    // marker (cleared when the agent opens it — see clearUnread).
    if (rec.status === "snoozed") rec.status = "open";
    return this.summary(rec);
  }

  async setPriority(conversationId: string, priority: Priority): Promise<Conversation | undefined> {
    const rec = this.conversations.find((c) => c.id === conversationId);
    if (!rec) return undefined;
    rec.priority = priority;
    return this.summary(rec);
  }

  async listUnseenNestChatReplies(from: Date, to: Date): Promise<{ conversationId: string; orgId: string }[]> {
    const out: { conversationId: string; orgId: string }[] = [];
    for (const c of this.conversations) {
      if (c.channel !== "nestchat") continue;
      const emailed = this.visitorEmailed.get(c.id) ?? 0;
      const due = c.messages.some((m) => {
        const at = new Date(m.createdAt).getTime();
        return (
          m.direction === "out" &&
          !m.internal &&
          m.authorType !== "system" &&
          (m.status === "sent" || m.status === "delivered") &&
          at >= from.getTime() &&
          at <= to.getTime() &&
          m.seq > emailed
        );
      });
      if (due) out.push({ conversationId: c.id, orgId: c.orgId });
    }
    return out;
  }

  async getOrganizationName(_orgId: string): Promise<string | undefined> {
    return "Swiftee";
  }

  async getVisitorEmailedSeq(conversationId: string): Promise<number | undefined> {
    if (!this.conversations.some((c) => c.id === conversationId)) return undefined;
    return this.visitorEmailed.get(conversationId) ?? 0;
  }

  async claimVisitorEmail(conversationId: string, prev: number, through: number): Promise<boolean> {
    if ((this.visitorEmailed.get(conversationId) ?? 0) !== prev) return false;
    this.visitorEmailed.set(conversationId, through);
    return true;
  }

  async getSubjectState(conversationId: string): Promise<{ auto: boolean; topic: string | null } | undefined> {
    if (!this.conversations.some((c) => c.id === conversationId)) return undefined;
    return this.subjectState.get(conversationId) ?? { auto: false, topic: null };
  }

  async setSubjectTopic(conversationId: string, topic: string | null): Promise<void> {
    const state = this.subjectState.get(conversationId);
    if (state) state.topic = topic;
  }

  async setSubject(conversationId: string, subject: string | null): Promise<Conversation | undefined> {
    const rec = this.conversations.find((c) => c.id === conversationId);
    if (!rec) return undefined;
    rec.subject = subject ?? undefined;
    return this.summary(rec);
  }

  async setInviteLink(conversationId: string, inviteLink: string): Promise<Conversation | undefined> {
    const rec = this.conversations.find((c) => c.id === conversationId);
    if (!rec) return undefined;
    rec.inviteLink = inviteLink;
    return this.summary(rec);
  }

  async setConversationInbox(conversationId: string, inboxId: string): Promise<Conversation | undefined> {
    const rec = this.conversations.find((c) => c.id === conversationId);
    if (!rec || rec.inboxId === inboxId) return undefined; // unknown or already there
    rec.inboxId = inboxId;
    return this.summary(rec);
  }

  async setConversationChannelRef(
    conversationId: string,
    channelRef: string,
  ): Promise<Conversation | undefined> {
    const rec = this.conversations.find((c) => c.id === conversationId);
    if (!rec || rec.channelRef === channelRef) return undefined; // unknown or unchanged
    rec.channelRef = channelRef;
    return this.summary(rec);
  }

  async setSla(conversationId: string, dueAt: string | null): Promise<Conversation | undefined> {
    const rec = this.conversations.find((c) => c.id === conversationId);
    if (!rec) return undefined;
    rec.slaDueAt = dueAt;
    return this.summary(rec);
  }

  async snooze(conversationId: string, until: string): Promise<Conversation | undefined> {
    const rec = this.conversations.find((c) => c.id === conversationId);
    if (!rec) return undefined;
    rec.status = "snoozed";
    rec.snoozedUntil = until;
    rec.unread = false;
    rec.unreadCount = 0;
    return this.summary(rec);
  }

  async listDueSnoozed(): Promise<Conversation[]> {
    const now = Date.now();
    return this.conversations
      .filter((r) => r.status === "snoozed" && r.snoozedUntil && new Date(r.snoozedUntil).getTime() <= now)
      .map((r) => this.summary(r));
  }

  // ---- Notifications ----
  private notifications: Array<Notification & { userId: string }> = [];

  async createNotification(input: {
    userId: string;
    type: Notification["type"];
    title: string;
    body?: string;
    conversationId?: string | null;
    opsSopId?: string | null;
    chatRoomId?: string | null;
  }): Promise<Notification> {
    const notif: Notification & { userId: string } = {
      id: `notif_${++this.idSeq}`,
      userId: input.userId,
      type: input.type,
      title: input.title,
      body: input.body ?? "",
      conversationId: input.conversationId ?? undefined,
      opsSopId: input.opsSopId ?? undefined,
      chatRoomId: input.chatRoomId ?? undefined,
      read: false,
      createdAt: new Date().toISOString(),
    };
    this.notifications.unshift(notif);
    return notif;
  }

  async listNotifications(userId: string, limit = 50): Promise<Notification[]> {
    return this.notifications.filter((n) => n.userId === userId).slice(0, limit);
  }

  async markNotificationsRead(userId: string, ids?: string[]): Promise<void> {
    for (const n of this.notifications) {
      if (n.userId !== userId) continue;
      if (!ids || ids.includes(n.id)) n.read = true;
    }
  }

  async setMessageChannelId(messageId: string, channelMsgId: string): Promise<void> {
    for (const rec of this.conversations) {
      const m = rec.messages.find((x) => x.id === messageId);
      if (m) {
        m.channelMsgId = channelMsgId;
        return;
      }
    }
  }

  /* ---- durable outbound delivery ---- */

  private findMsg(messageId: string): { rec: ConversationRecord; m: Message } | undefined {
    for (const rec of this.conversations) {
      const m = rec.messages.find((x) => x.id === messageId);
      if (m) return { rec, m };
    }
    return undefined;
  }

  async getOutboundMessage(messageId: string): Promise<OutboundMessageRef | undefined> {
    const hit = this.findMsg(messageId);
    if (!hit) return undefined;
    return {
      messageId,
      conversationId: hit.rec.id,
      status: hit.m.status,
      channelMsgId: hit.m.channelMsgId ?? undefined,
      internal: hit.m.internal,
      deliveryMeta: this.outboundMeta.get(messageId)?.deliveryMeta,
    };
  }

  async setMessageInbox(messageId: string, inboxId: string): Promise<void> {
    const hit = this.findMsg(messageId);
    if (hit) hit.m.inboxId = inboxId;
  }

  async markMessageSending(messageId: string): Promise<MessageStatusChange | undefined> {
    const hit = this.findMsg(messageId);
    if (!hit) return undefined;
    if (hit.m.status !== "queued" && hit.m.status !== "sending") return undefined;
    hit.m.status = "sending";
    hit.m.attemptCount = (hit.m.attemptCount ?? 0) + 1;
    const meta = this.outboundMeta.get(messageId) ?? {};
    meta.lastAttemptAt = Date.now();
    this.outboundMeta.set(messageId, meta);
    return { conversationId: hit.rec.id, message: hit.m };
  }

  async markMessageSent(
    messageId: string,
    channelMsgId?: string,
  ): Promise<MessageStatusChange | undefined> {
    const hit = this.findMsg(messageId);
    if (!hit) return undefined;
    if (hit.m.status === "failed") return undefined;
    if (channelMsgId && !hit.m.channelMsgId) hit.m.channelMsgId = channelMsgId;
    if (canAdvanceStatus(hit.m.status, "sent")) hit.m.status = "sent";
    hit.m.failureReason = undefined;
    const meta = this.outboundMeta.get(messageId);
    if (meta) {
      meta.providerError = undefined;
      meta.providerErrorCode = undefined;
    }
    return { conversationId: hit.rec.id, message: hit.m };
  }

  async registerEmailRecipients(
    messageId: string,
    recipients: EmailRecipientInput[],
  ): Promise<void> {
    const hit = this.findMsg(messageId);
    if (!hit || !recipients.length) return;
    // Attach the recipient list to the message's email meta (openedAt starts null)
    // and index each token so an open can be traced back to the person.
    const existing = hit.m.email ?? {};
    hit.m.email = {
      ...existing,
      recipients: recipients.map((r) => ({ address: r.address, kind: r.kind, openedAt: null })),
    };
    const sentAt = Date.now();
    for (const r of recipients) {
      this.emailTokenIndex.set(r.token, { messageId, address: r.address, sentAt });
    }
  }

  async recordEmailOpen(token: string): Promise<MessageStatusChange | undefined> {
    const ref = this.emailTokenIndex.get(token);
    if (!ref) return undefined;
    // A hit within the grace window is a proxy pre-cache (e.g. Gmail), not a read.
    if (Date.now() - ref.sentAt < EMAIL_OPEN_GRACE_MS) return undefined;
    const hit = this.findMsg(ref.messageId);
    const rcpt = hit?.m.email?.recipients?.find((r) => r.address === ref.address);
    if (!hit || !rcpt) return undefined;
    // First open of this recipient → stamp the time and broadcast the "Seen".
    // Re-opens (Gmail proxy re-fetches, etc.) are silently ignored for realtime.
    if (rcpt.openedAt) return undefined;
    rcpt.openedAt = new Date().toISOString();
    return { conversationId: hit.rec.id, message: hit.m };
  }

  async recordSendFailure(
    messageId: string,
    info: { error?: string; code?: string; permanent: boolean; reason?: string },
  ): Promise<MessageStatusChange | undefined> {
    const hit = this.findMsg(messageId);
    if (!hit) return undefined;
    const meta = this.outboundMeta.get(messageId) ?? {};
    meta.providerError = info.error ? info.error.slice(0, 500) : undefined;
    meta.providerErrorCode = info.code;
    this.outboundMeta.set(messageId, meta);
    if (info.permanent && canAdvanceStatus(hit.m.status, "failed")) {
      hit.m.status = "failed";
      hit.m.failureReason = info.reason ?? "Message could not be delivered";
    }
    return { conversationId: hit.rec.id, message: hit.m };
  }

  async listStuckOutbound(
    olderThanMs: number,
  ): Promise<Array<{ messageId: string; conversationId: string; orgId: string; idempotencyKey?: string }>> {
    const cutoff = Date.now() - olderThanMs;
    const out: Array<{ messageId: string; conversationId: string; orgId: string; idempotencyKey?: string }> = [];
    for (const rec of this.conversations) {
      for (const m of rec.messages) {
        if (m.direction !== "out" || m.internal) continue;
        if (m.status !== "queued" && m.status !== "sending") continue;
        const meta = this.outboundMeta.get(m.id);
        if (meta?.lastAttemptAt == null || meta.lastAttemptAt <= cutoff) {
          out.push({ messageId: m.id, conversationId: rec.id, orgId: rec.orgId, idempotencyKey: meta?.idempotencyKey });
        }
      }
    }
    return out;
  }

  async resetMessageForRetry(
    messageId: string,
    idempotencyKey: string,
  ): Promise<MessageStatusChange | undefined> {
    const hit = this.findMsg(messageId);
    if (!hit) return undefined;
    if (hit.m.direction !== "out" || hit.m.internal || hit.m.status !== "failed") return undefined;
    hit.m.status = "queued";
    hit.m.failureReason = undefined;
    const meta = this.outboundMeta.get(messageId) ?? {};
    meta.idempotencyKey = idempotencyKey;
    meta.providerError = undefined;
    meta.providerErrorCode = undefined;
    meta.lastAttemptAt = undefined;
    this.outboundMeta.set(messageId, meta);
    return { conversationId: hit.rec.id, message: hit.m };
  }

  /* ---- ingestion ---- */

  async getInboxByWhatsAppPhoneId(phoneNumberId: string): Promise<Inbox | undefined> {
    const wa = this.inboxes.filter((i) => i.type === "whatsapp" || i.type === "whatsapp_group");
    const byConfig = wa.find((i) => this.inboxConfig.get(i.id)?.phoneNumberId === phoneNumberId);
    if (byConfig) return byConfig;
    // Dev convenience: a single WhatsApp inbox with no configured number handles
    // simulated inbound (the simulate tools don't send a real phone id). If more
    // than one is unconfigured it's ambiguous — don't guess.
    const unconfigured = wa.filter((i) => !this.inboxConfig.get(i.id)?.phoneNumberId);
    return unconfigured.length === 1 ? unconfigured[0] : undefined;
  }

  async getInboxesByWabaId(wabaId: string): Promise<Inbox[]> {
    if (!wabaId) return [];
    return this.inboxes.filter(
      (i) => (i.type === "whatsapp" || i.type === "whatsapp_group") && this.inboxConfig.get(i.id)?.wabaId === wabaId,
    );
  }

  async getInboxByWidgetKey(widgetKey: string): Promise<Inbox | undefined> {
    const key = widgetKey.trim();
    if (!key) return undefined;
    return this.inboxes.find(
      (i) => i.type === "nestchat" && this.inboxConfig.get(i.id)?.widgetKey === key,
    );
  }

  async getInboxByAppKey(appKey: string): Promise<Inbox | undefined> {
    const key = appKey.trim();
    if (!key) return undefined;
    return this.inboxes.find(
      (i) => i.type === "nestchat" && this.inboxConfig.get(i.id)?.appKey === key,
    );
  }

  async getInboxByEmailAddress(address: string): Promise<Inbox | undefined> {
    const a = address.trim().toLowerCase();
    // Deterministic match on the inbox address only — no arbitrary fallback.
    const hits = this.inboxes.filter((i) => i.type === "email" && i.handle.toLowerCase() === a);
    return hits.length === 1 ? hits[0] : undefined;
  }

  async channelKeyTaken(
    key: { phoneNumberId?: string; emailAddress?: string },
    exceptInboxId?: string,
  ): Promise<boolean> {
    const orgId = boundOrgId();
    return this.inboxes.some((i) => {
      if (i.orgId === orgId || i.id === exceptInboxId) return false;
      if (key.phoneNumberId && this.inboxConfig.get(i.id)?.phoneNumberId === key.phoneNumberId) return true;
      return !!key.emailAddress && i.type === "email" && i.handle.toLowerCase() === key.emailAddress.trim().toLowerCase();
    });
  }

  async recordWebhookDiagnostic(input: {
    channel: string;
    kind: string;
    reference?: string;
    detail?: string;
  }): Promise<void> {
    this.webhookDiagnostics.unshift({
      id: `whd_${++this.idSeq}`,
      channel: input.channel,
      kind: input.kind,
      reference: input.reference,
      detail: input.detail,
      createdAt: new Date().toISOString(),
    });
    // Keep the in-memory log bounded.
    if (this.webhookDiagnostics.length > 200) this.webhookDiagnostics.length = 200;
  }

  async listWebhookDiagnostics(limit = 100): Promise<WebhookDiagnostic[]> {
    return this.webhookDiagnostics.slice(0, Math.min(Math.max(limit, 1), 500));
  }

  async findConversationByMessageChannelIds(
    channelMsgIds: string[],
    opts: { contactIds?: string[] } = {},
  ): Promise<string | undefined> {
    if (!channelMsgIds.length) return undefined;
    const set = new Set(channelMsgIds);
    const scope = opts.contactIds?.length ? new Set(opts.contactIds) : undefined;
    for (const rec of this.conversations) {
      if (scope && !scope.has(rec.contact.id)) continue;
      if (rec.messages.some((m) => m.channelMsgId && set.has(m.channelMsgId))) return rec.id;
    }
    return undefined;
  }

  async upsertContactByIdentity(params: {
    orgId: string;
    kind: ContactIdentityKind;
    value: string;
    displayName: string;
    company?: string;
    avatarColor?: string;
  }): Promise<Contact> {
    const { field: key, matchAs: matchKind } = identityField(params.kind);
    const normalized = normalizeIdentity(params.kind, params.value)?.normalized ?? params.value;
    // Match on the canonical value so number formats / wa_id all resolve to one.
    const matches = this.contacts.filter((c) => {
      if (c.orgId !== params.orgId) return false;
      const cv = (c as Record<string, unknown>)[key] as string | undefined;
      if (!cv) return false;
      return (normalizeIdentity(matchKind, cv)?.normalized ?? cv) === normalized;
    });
    if (matches.length) {
      if (matches.length > 1) {
        // Auto-merge legacy duplicates that share this messaging identity — an
        // inbound proves they're the same customer (oldest record wins).
        const [winner, ...losers] = matches;
        return this.mergeContacts({ winnerId: winner.id, loserIds: losers.map((c) => c.id) });
      }
      return matches[0];
    }
    const contact: Contact = {
      id: `ct_${++this.idSeq}`,
      orgId: params.orgId,
      displayName: params.displayName,
      company: params.company,
      tags: [],
      avatarColor: params.avatarColor ?? AVATAR_PALETTE[this.contacts.length % AVATAR_PALETTE.length],
      [key]: params.value,
    } as Contact;
    this.contacts.push(contact);
    return contact;
  }

  async findRecentOutreach(params: {
    orgId: string;
    inboxId: string;
    contactId: string;
    since: string;
  }): Promise<{ userId: string; teamId: string | null } | undefined> {
    const last = this.conversations
      .filter((c) => c.orgId === params.orgId && c.inboxId === params.inboxId && c.contact.id === params.contactId && c.messages.length)
      .sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : -1))[0];
    if (!last?.assigneeUserId || last.lastActivityAt < params.since) return undefined;
    const theirs = last.messages.some((m) => m.direction === "in");
    const ours = last.messages.some((m) => m.direction === "out" && !m.internal);
    return !theirs && ours ? { userId: last.assigneeUserId, teamId: last.assignedTeamId ?? null } : undefined;
  }

  async findCrossChannelReplyThread(params: { orgId: string; inboxId: string; contactId: string }): Promise<string | undefined> {
    const live = (c: ConversationRecord) =>
      c.orgId === params.orgId && c.contact.id === params.contactId && (THREADABLE_STATUSES as readonly string[]).includes(c.status);
    let best: { id: string; at: string } | undefined;
    for (const c of this.conversations) {
      if (!live(c) || c.inboxId === params.inboxId) continue;
      for (const m of c.messages) {
        if (m.direction !== "out" || m.internal || m.channel !== "whatsapp" || m.inboxId !== params.inboxId) continue;
        if (!best || m.createdAt > best.at) best = { id: c.id, at: m.createdAt };
      }
    }
    if (!best) return undefined;
    const ownNewer = this.conversations.some((c) => live(c) && c.inboxId === params.inboxId && c.lastActivityAt > best!.at);
    return ownNewer ? undefined : best.id;
  }

  async findOrCreateOpenConversation(params: {
    orgId: string;
    inboxId: string;
    contact: Contact;
    channel: ChannelType;
    subject?: string;
    assigneeUserId?: string | null;
    assignedTeamId?: string | null;
    startedBy?: string;
    autoSubject?: boolean;
    forceNew?: boolean;
  }): Promise<{ conversation: Conversation; created: boolean }> {
    // One live conversation per contact PER INBOX (channel endpoint): a different
    // inbox — another number, email address, or channel — starts a separate
    // conversation, and a closed thread starts a new one. (Agents still reply
    // cross-channel inside a thread via the send path; this governs inbound + reach.)
    //
    // "Live" includes snoozed — see THREADABLE_STATUSES. That is the whole rule,
    // and it lives in the schemas package because this used to be written out
    // here and again in the Prisma store, and both copies left snoozed out.
    //
    // Email adds a second condition: the subject has to match. A mailbox thread
    // is a topic, not a person, so a customer writing about something new gets a
    // new conversation rather than having it filed under whatever they last
    // wrote about. See email-threading.ts — and note this only decides what
    // happens when the mail carried no usable References chain, which the ingest
    // path has already tried.
    const open = params.forceNew ? undefined : [...this.conversations]
      .sort(byRecencyDesc)
      .find(
        (c) =>
          c.orgId === params.orgId &&
          c.inboxId === params.inboxId &&
          c.contact.id === params.contact.id &&
          (THREADABLE_STATUSES as readonly string[]).includes(c.status) &&
          threadsTogether(params.channel, params.subject, c.subject) &&
          (params.startedBy === undefined || c.channelRef === params.startedBy),
      );
    if (open) return { conversation: this.summary(open), created: false };

    const now = new Date().toISOString();
    const rec: ConversationRecord = {
      id: `conv_${++this.idSeq}`,
      orgId: params.orgId,
      inboxId: params.inboxId,
      channel: params.channel,
      contact: params.contact,
      subject: params.subject,
      status: "open",
      assigneeUserId: params.assigneeUserId ?? null,
      assignedTeamId: params.assignedTeamId ?? null,
      priority: "normal",
      labels: [],
      unread: true,
      slaDueAt: null,
      ...(params.startedBy !== undefined ? { channelRef: params.startedBy } : {}),
      lastActivityAt: now,
      seq: 0,
      preview: "",
      messages: [],
    };
    this.conversations.push(rec);
    if (params.autoSubject) this.subjectState.set(rec.id, { auto: true, topic: params.subject ?? null });
    return { conversation: this.summary(rec), created: true };
  }

  async appendInboundMessage(
    conversationId: string,
    input: AppendInboundInput,
  ): Promise<Message | undefined> {
    const rec = this.conversations.find((c) => c.id === conversationId);
    if (!rec) return undefined;
    const message: Message = {
      id: `msg_in_${++this.idSeq}`,
      conversationId,
      seq: ++rec.seq,
      direction: "in",
      authorType: "contact",
      authorName: input.authorName,
      body: input.body,
      bodyHtml: input.bodyHtml,
      status: "delivered",
      internal: false,
      channelMsgId: input.channelMsgId,
      channel: input.channel,
      messageType: input.messageType ?? "text",
      attachments: this.storeAttachments(input.attachments),
      reactions: [],
      quotedMsgId: input.quotedMsgId,
      ...(input.forwarded ? { forwarded: true } : {}),
      ...(input.emailVia ? { email: { via: input.emailVia } } : {}),
      createdAt: new Date().toISOString(),
    };
    rec.messages.push(message);
    rec.lastActivityAt = message.createdAt;
    // Only a WhatsApp inbound (re)opens the WhatsApp 24-hour window.
    if (isWaChannel(input.channel ?? rec.channel)) rec.lastInboundAt = message.createdAt;
    rec.unread = true;
    rec.unreadCount = (rec.unreadCount ?? 0) + 1;
    rec.preview = previewFromBody(input.body) || previewForType(input.messageType);
    // A new customer message on a closed or snoozed chat wakes it back up.
    if (rec.status === "closed" || rec.status === "snoozed") {
      const wasClosed = rec.status === "closed";
      rec.status = "open";
      rec.snoozedUntil = null;
      if (wasClosed) rec.assigneeUserId = null;
    }
    return message;
  }

  async appendSyncedOutbound(
    conversationId: string,
    input: {
      body: string;
      bodyHtml?: string;
      channelMsgId?: string;
      authorName?: string;
      attachments?: AttachmentInput[];
      channel?: "email" | "whatsapp";
      messageType?: MessageType;
      markRead?: boolean;
    },
  ): Promise<Message | undefined> {
    const rec = this.conversations.find((c) => c.id === conversationId);
    if (!rec) return undefined;
    const channel = input.channel ?? "email";
    const message: Message = {
      id: `msg_out_${++this.idSeq}`,
      conversationId,
      seq: ++rec.seq,
      direction: "out",
      authorType: "system",
      authorName: input.authorName ?? (channel === "email" ? "Gmail" : "WhatsApp Business app"),
      body: input.body,
      bodyHtml: input.bodyHtml,
      status: "sent",
      internal: false,
      channelMsgId: input.channelMsgId,
      channel,
      messageType: input.messageType ?? "text",
      attachments: this.storeAttachments(input.attachments),
      reactions: [],
      createdAt: new Date().toISOString(),
    };
    rec.messages.push(message);
    rec.lastActivityAt = message.createdAt;
    rec.preview = previewFromBody(input.body) || (channel === "email" ? "Email" : "Message");
    if (input.markRead) {
      rec.unread = false;
      rec.unreadCount = 0;
    }
    // A reply sent straight from Gmail is still a reply → clear the "Back from
    // Later" marker (a past snooze time left on an active chat), same as an
    // in-app reply. A still-snoozed chat's future timer is left untouched.
    if (rec.status !== "snoozed" && rec.snoozedUntil) rec.snoozedUntil = null;
    return message;
  }

  async getAttachment(id: string): Promise<StoredAttachmentRef | undefined> {
    return this.mediaRefs.get(id);
  }

  private transcripts = new Map<string, string>();

  async getAttachmentTranscript(id: string): Promise<string | undefined> {
    return this.transcripts.get(id);
  }

  async getAttachmentTranscripts(ids: string[]): Promise<Map<string, string>> {
    return new Map(ids.flatMap((id) => (this.transcripts.has(id) ? [[id, this.transcripts.get(id) as string] as const] : [])));
  }

  async setAttachmentTranscript(id: string, transcript: string): Promise<void> {
    this.transcripts.set(id, transcript);
    // A thread read afterwards carries it, as Postgres's does.
    for (const rec of this.conversations) {
      for (const m of rec.messages) {
        for (const a of m.attachments ?? []) if (a.id === id) a.transcript = transcript;
      }
    }
  }

  async getAttachmentAccess(
    id: string,
  ): Promise<{ storageKey: string; mime: string; filename: string; orgId?: string } | undefined> {
    const ref = this.mediaRefs.get(id);
    if (!ref) return undefined;
    // A sent attachment belongs to its conversation's org (the access boundary);
    // a staged upload isn't attached to a conversation yet → no org.
    for (const rec of this.conversations) {
      if (rec.messages.some((m) => m.attachments?.some((a) => a.id === id))) {
        return { ...ref, orgId: rec.orgId };
      }
    }
    return { ...ref };
  }

  /** Persist attachment refs (for serving) and return the client-facing shape. */
  async countEmailConversations(): Promise<number> {
    return this.conversations.filter((c) => c.channel === "email").length;
  }

  async deleteEmailConversations(): Promise<number> {
    const before = this.conversations.length;
    this.conversations = this.conversations.filter((c) => c.channel !== "email");
    return before - this.conversations.length;
  }

  async importWhatsAppHistory(input: {
    orgId: string;
    inboxId: string;
    contactId: string;
    messages: Array<{
      direction: "in" | "out";
      authorName: string;
      body: string;
      channelMsgId: string;
      sentAt: Date;
      messageType?: MessageType;
      attachments?: AttachmentInput[];
    }>;
  }): Promise<{ conversationId: string; added: number }> {
    const contact = this.contacts.find((c) => c.id === input.contactId);
    if (!contact) throw new Error(`No contact ${input.contactId}`);
    const ref = `wa-history:${input.inboxId}`;
    let rec = this.conversations.find(
      (c) => c.orgId === input.orgId && c.inboxId === input.inboxId && c.contact.id === input.contactId && c.channelRef === ref,
    );
    if (!rec) {
      rec = {
        id: `conv_${++this.idSeq}`,
        orgId: input.orgId,
        inboxId: input.inboxId,
        channel: "whatsapp",
        contact,
        status: "closed",
        assigneeUserId: null,
        assignedTeamId: null,
        priority: "normal",
        labels: [],
        unread: false,
        unreadCount: 0,
        slaDueAt: null,
        channelRef: ref,
        lastActivityAt: new Date().toISOString(),
        seq: 0,
        preview: "",
        messages: [],
      } as unknown as (typeof this.conversations)[number];
      this.conversations.push(rec);
    }
    const stored = new Set(this.conversations.filter((c) => c.orgId === input.orgId).flatMap((c) => c.messages.map((m) => m.channelMsgId)));
    let added = 0;
    for (const m of input.messages) {
      if (stored.has(m.channelMsgId)) continue;
      stored.add(m.channelMsgId);
      rec.messages.push({
        id: `msg_hist_${++this.idSeq}`,
        conversationId: rec.id,
        seq: 0,
        direction: m.direction,
        authorType: m.direction === "in" ? "contact" : "system",
        authorName: m.authorName,
        body: m.body,
        status: m.direction === "in" ? "delivered" : "sent",
        internal: false,
        channelMsgId: m.channelMsgId,
        channel: "whatsapp",
        messageType: m.messageType ?? "text",
        attachments: this.storeAttachments(m.attachments),
        reactions: [],
        createdAt: m.sentAt.toISOString(),
      });
      added++;
    }
    // Back into date order: Meta sends the newest history first.
    rec.messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    rec.messages.forEach((m, i) => (m.seq = i + 1));
    rec.seq = rec.messages.length;
    const last = rec.messages.at(-1);
    rec.preview = last ? previewFromBody(last.body) || "Message" : "";
    if (last) rec.lastActivityAt = last.createdAt;
    return { conversationId: rec.id, added };
  }

  async importEmailThread(input: ImportEmailThreadInput): Promise<string> {
    const contact = this.contacts.find((c) => c.id === input.contactId);
    if (!contact) throw new Error(`No contact ${input.contactId}`);
    const id = `conv_${++this.idSeq}`;
    const messages: Message[] = input.messages.map((m, i) => ({
      id: `msg_imp_${++this.idSeq}`,
      conversationId: id,
      seq: i + 1,
      direction: m.direction,
      authorType: m.direction === "in" ? "contact" : "system",
      authorName: m.authorName,
      body: m.body,
      bodyHtml: m.bodyHtml,
      status: m.direction === "in" ? "delivered" : "sent",
      internal: false,
      channelMsgId: m.channelMsgId,
      channel: "email",
      messageType: "text",
      attachments: this.storeAttachments(m.attachments),
      reactions: [],
      createdAt: m.sentAt.toISOString(),
    }));
    const last = messages[messages.length - 1];
    const lastOut = messages.reduce((n, m, i) => (m.direction === "out" ? i : n), -1);
    this.conversations.push({
      id,
      orgId: input.orgId,
      inboxId: input.inboxId,
      channel: "email",
      contact,
      subject: input.subject,
      status: "open",
      assigneeUserId: input.assigneeUserId ?? null,
      assignedTeamId: input.assignedTeamId ?? null,
      priority: "normal",
      labels: [],
      unread: true,
      unreadCount: messages.slice(lastOut + 1).filter((m) => m.direction === "in").length,
      slaDueAt: null,
      ...(input.channelRef ? { channelRef: input.channelRef } : {}),
      lastActivityAt: last?.createdAt ?? new Date().toISOString(),
      seq: messages.length,
      preview: last ? previewFromBody(last.body) || "Email" : "",
      messages,
    });
    return id;
  }

  private storeAttachments(inputs?: AttachmentInput[]): Attachment[] {
    if (!inputs?.length) return [];
    return inputs.map((a) => {
      const id = `att_${++this.idSeq}`;
      this.mediaRefs.set(id, { storageKey: a.storageKey, mime: a.mime, filename: a.filename });
      return {
        id,
        kind: a.kind,
        mime: a.mime,
        size: a.size,
        filename: a.filename,
        url: `/api/media/${id}`,
        durationMs: a.durationMs,
        width: a.width,
        height: a.height,
        waveform: a.waveform,
      };
    });
  }

  async markOutboundStatusUpTo(
    conversationId: string,
    throughMessageId: string,
    status: MessageStatus,
  ): Promise<MessageStatusChange[]> {
    const rec = this.conversations.find((c) => c.id === conversationId);
    if (!rec) return [];
    const upTo = rec.messages.findIndex((m) => m.id === throughMessageId);
    if (upTo === -1) return [];
    const changed: MessageStatusChange[] = [];
    for (const m of rec.messages.slice(0, upTo + 1)) {
      // Outbound only, and never an internal note: neither is something the
      // visitor could have received or read.
      if (m.direction !== "out" || m.internal) continue;
      if (!canAdvanceStatus(m.status, status)) continue;
      m.status = status;
      changed.push({ conversationId: rec.id, message: m });
    }
    return changed;
  }

  async listAwaitingReceipt(inboxId: string, since: Date, limit = 50): Promise<{ id: string; channelMsgId: string }[]> {
    const out: { id: string; channelMsgId: string; at: string }[] = [];
    for (const rec of this.conversations) {
      for (const m of rec.messages) {
        if (m.inboxId === inboxId && m.direction === "out" && !m.internal && m.status === "sent" && m.channelMsgId && m.createdAt >= since.toISOString()) {
          out.push({ id: m.id, channelMsgId: m.channelMsgId, at: m.createdAt });
        }
      }
    }
    return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit).map(({ id, channelMsgId }) => ({ id, channelMsgId }));
  }

  async updateMessageStatusByChannelId(
    channelMsgId: string,
    status: MessageStatus,
    failureReason?: string,
  ): Promise<{ conversationId: string; message: Message } | undefined> {
    for (const rec of this.conversations) {
      const m = rec.messages.find((x) => x.channelMsgId === channelMsgId);
      if (m) {
        // Never regress the ladder (out-of-order/duplicate webhooks are common).
        if (!canAdvanceStatus(m.status, status)) return undefined;
        m.status = status;
        // Only on the way to "failed", and only when the provider said why:
        // a later "delivered" must not leave a stale explanation under a
        // message that arrived perfectly well.
        if (status === "failed" && failureReason) m.failureReason = failureReason;
        return { conversationId: rec.id, message: m };
      }
    }
    return undefined;
  }

  async clearUnread(conversationId: string): Promise<Conversation | undefined> {
    const rec = this.conversations.find((c) => c.id === conversationId);
    if (!rec) return undefined;
    rec.unread = false;
    rec.unreadCount = 0;
    // NB: opening a chat does NOT clear the "Back from Later" marker — it persists
    // until the agent actually replies (see addMessage) or resolves the chat.
    return this.summary(rec);
  }

  async markUnread(conversationId: string): Promise<Conversation | undefined> {
    const rec = this.conversations.find((c) => c.id === conversationId);
    if (!rec) return undefined;
    rec.unread = true;
    rec.unreadCount = 0; // manual mark → empty dot, not a message count
    return this.summary(rec);
  }

  /* ---- custom fields ---- */
  async listCustomFields(_orgId: string): Promise<CustomField[]> {
    return [...this.customFields].sort(
      (a, b) => a.position - b.position || a.label.localeCompare(b.label),
    );
  }

  async createCustomField(_orgId: string, input: CreateCustomFieldInput): Promise<CustomField> {
    const existing = this.customFields.find((f) => f.key === input.key);
    // The key is the identity — a second field claiming it would make an SDK
    // payload naming that key mean two different things.
    if (existing) throw new Error(`A field with the key "${input.key}" already exists`);
    const field: CustomField = {
      id: `cf_${++this.idSeq}`,
      key: input.key,
      label: input.label,
      type: input.type,
      entity: input.entity,
      options: input.options,
      inboxIds: input.inboxIds,
      position: this.customFields.length,
      filterable: input.filterable ?? false,
      archived: false,
    };
    this.customFields.push(field);
    return field;
  }

  async updateCustomField(
    id: string,
    input: UpdateCustomFieldInput,
  ): Promise<CustomField | undefined> {
    const field = this.customFields.find((f) => f.id === id);
    if (!field) return undefined;
    // Never the entity — see changeCustomFieldEntity.
    const { entity: _entity, discardValues: _discard, ...changes } = input;
    Object.assign(field, changes);
    return field;
  }

  async deleteCustomField(id: string): Promise<void> {
    this.customFields = this.customFields.filter((f) => f.id !== id);
    for (const [k, v] of this.fieldValues) if (v.fieldId === id) this.fieldValues.delete(k);
  }

  async countCustomFieldValues(id: string): Promise<number> {
    return [...this.fieldValues.values()].filter((v) => v.fieldId === id).length;
  }

  async changeCustomFieldEntity(id: string, entity: CustomFieldEntity): Promise<CustomField | undefined> {
    const field = this.customFields.find((f) => f.id === id);
    if (!field) return undefined;
    for (const [k, v] of this.fieldValues) if (v.fieldId === id) this.fieldValues.delete(k);
    field.entity = entity;
    return field;
  }

  async customFieldValues(
    _orgId: string,
    entity: CustomFieldEntity,
    entityIds: string[],
  ): Promise<Map<string, CustomFieldValue[]>> {
    const wanted = new Set(entityIds);
    const out = new Map<string, CustomFieldValue[]>();
    for (const v of this.fieldValues.values()) {
      if (v.entity !== entity || !wanted.has(v.entityId)) continue;
      const field = this.customFields.find((f) => f.id === v.fieldId);
      if (!field) continue;
      const list = out.get(v.entityId) ?? [];
      list.push({ fieldId: field.id, key: field.key, value: v.value });
      out.set(v.entityId, list);
    }
    return out;
  }

  async setCustomFieldValues(
    orgId: string,
    entity: CustomFieldEntity,
    entityId: string,
    values: Record<string, string | null>,
  ): Promise<{ values: CustomFieldValue[]; unknown: string[] }> {
    const unknown: string[] = [];
    for (const [key, raw] of Object.entries(values)) {
      const field = this.customFields.find((f) => f.key === key && f.entity === entity);
      // A key nobody defined is reported rather than stored: a typo in an
      // integration should fail where somebody can see it, not accumulate
      // values under a name no screen will ever read.
      if (!field || field.archived) {
        unknown.push(key);
        continue;
      }
      const slot = `${entity}:${entityId}:${field.id}`;
      const value = raw?.trim();
      if (!value) this.fieldValues.delete(slot);
      else this.fieldValues.set(slot, { fieldId: field.id, entity, entityId, value });
    }
    const current = await this.customFieldValues(orgId, entity, [entityId]);
    return { values: current.get(entityId) ?? [], unknown };
  }

  async findByCustomFieldExact(
    _orgId: string,
    entity: CustomFieldEntity,
    fieldKey: string,
    value: string,
  ): Promise<string[]> {
    const field = this.customFields.find((f) => f.key === fieldKey && f.entity === entity);
    const wanted = normalizeCustomFieldValue(value);
    if (!field || !wanted) return [];
    return [...this.fieldValues.values()]
      .filter(
        (v) =>
          v.fieldId === field.id &&
          v.entity === entity &&
          normalizeCustomFieldValue(v.value) === wanted,
      )
      .map((v) => v.entityId);
  }

  async findByCustomField(
    _orgId: string,
    fieldKey: string,
    value?: string,
  ): Promise<{ conversationIds: string[]; contactIds: string[] }> {
    const wanted = value === undefined ? undefined : normalizeCustomFieldValue(value);
    // "restaurant is ''" is not "restaurant is set" — a value that folds away
    // filters for nothing rather than for everything.
    if (value !== undefined && !wanted) return { conversationIds: [], contactIds: [] };
    const field = this.customFields.find((f) => f.key === fieldKey && !f.archived);
    if (!field) return { conversationIds: [], contactIds: [] };
    const conversationIds: string[] = [];
    const contactIds: string[] = [];
    for (const v of this.fieldValues.values()) {
      if (v.fieldId !== field.id) continue;
      if (wanted && normalizeCustomFieldValue(v.value) !== wanted) continue;
      (v.entity === "conversation" ? conversationIds : contactIds).push(v.entityId);
    }
    return { conversationIds, contactIds };
  }

  async findByCustomFieldValue(
    _orgId: string,
    entity: CustomFieldEntity,
    query: string,
  ): Promise<string[]> {
    const q = normalizeCustomFieldValue(query);
    if (!q) return [];
    const exact: string[] = [];
    const partial: string[] = [];
    for (const v of this.fieldValues.values()) {
      if (v.entity !== entity) continue;
      const folded = normalizeCustomFieldValue(v.value);
      if (folded === q) exact.push(v.entityId);
      else if (folded.includes(q)) partial.push(v.entityId);
    }
    // Exact first: a reference number is either the one being read out or it
    // isn't, and a partial match that outranked it would bury the answer.
    return [...new Set([...exact, ...partial])];
  }

  /* ---- labels ---- */
  async listLabels(_orgId: string): Promise<Label[]> {
    return [...this.labels].sort((a, b) => a.name.localeCompare(b.name));
  }

  async createLabel(input: { orgId: string; name: string; color: string }): Promise<Label> {
    const existing = this.labels.find((l) => l.name.toLowerCase() === input.name.trim().toLowerCase());
    if (existing) return existing; // names are unique per org — reuse rather than duplicate
    const label: Label = { id: `lbl_${++this.idSeq}`, name: input.name.trim(), color: input.color };
    this.labels.push(label);
    return label;
  }

  async updateLabel(id: string, patch: { name?: string; color?: string }): Promise<Label | undefined> {
    const label = this.labels.find((l) => l.id === id);
    if (!label) return undefined;
    if (patch.name !== undefined) label.name = patch.name.trim();
    if (patch.color !== undefined) label.color = patch.color;
    // Reflect the rename/recolour on every conversation already carrying it.
    for (const c of this.conversations) {
      const idx = c.labels.findIndex((l) => l.id === id);
      if (idx >= 0) c.labels[idx] = { ...label };
    }
    return label;
  }

  async deleteLabel(id: string): Promise<void> {
    this.labels = this.labels.filter((l) => l.id !== id);
    for (const c of this.conversations) c.labels = c.labels.filter((l) => l.id !== id);
  }

  async setConversationLabels(conversationId: string, labelIds: string[]): Promise<Conversation | undefined> {
    const rec = this.conversations.find((c) => c.id === conversationId);
    if (!rec) return undefined;
    const wanted = new Set(labelIds);
    rec.labels = this.labels.filter((l) => wanted.has(l.id)).map((l) => ({ ...l }));
    return this.summary(rec);
  }

  async getMessageRefByChannelId(
    channelMsgId: string,
  ): Promise<{ id: string; conversationId: string } | undefined> {
    for (const rec of this.conversations) {
      const m = rec.messages.find((x) => x.channelMsgId === channelMsgId);
      if (m) return { id: m.id, conversationId: rec.id };
    }
    return undefined;
  }

  async failMessage(
    messageId: string,
  ): Promise<{ conversationId: string; message: Message } | undefined> {
    for (const rec of this.conversations) {
      const m = rec.messages.find((x) => x.id === messageId);
      if (!m) continue;
      if (!canAdvanceStatus(m.status, "failed")) return undefined;
      m.status = "failed";
      return { conversationId: rec.id, message: m };
    }
    return undefined;
  }

  async reactToMessage(
    messageId: string,
    emoji: string,
    by: "contact" | "user",
  ): Promise<{ conversationId: string; message: Message } | undefined> {
    for (const rec of this.conversations) {
      const m = rec.messages.find((x) => x.id === messageId);
      if (!m) continue;
      // At most one reaction per participant.
      const kept = (m.reactions ?? []).filter((r) => r.by !== by);
      m.reactions = emoji.trim() ? [...kept, { emoji: emoji.trim(), by }] : kept;
      return { conversationId: rec.id, message: m };
    }
    return undefined;
  }

  /* ---- groups ---- */

  async findConversationByChannelRef(
    channelRef: string,
    opts: { contactIds?: string[] } = {},
  ): Promise<string | undefined> {
    const scope = opts.contactIds?.length ? new Set(opts.contactIds) : undefined;
    return this.conversations.find(
      (c) => c.channelRef === channelRef && (!scope || scope.has(c.contact.id)),
    )?.id;
  }

  async findContactByIdentity(params: {
    orgId: string;
    kind: ContactIdentityKind;
    value: string;
  }): Promise<Contact | undefined> {
    // Same canonicalisation as upsertContactByIdentity, so "+44 7911…" and
    // "07911…" resolve to the same person here too — just without creating one.
    const { field: key, matchAs: matchKind } = identityField(params.kind);
    const normalized = normalizeIdentity(params.kind, params.value)?.normalized ?? params.value;
    return this.contacts.find((c) => {
      if (c.orgId !== params.orgId) return false;
      const cv = (c as Record<string, unknown>)[key] as string | undefined;
      if (!cv) return false;
      return (normalizeIdentity(matchKind, cv)?.normalized ?? cv) === normalized;
    });
  }

  async createContact(params: {
    orgId: string;
    displayName: string;
    avatarColor?: string;
    company?: string;
    phone?: string;
    email?: string;
    tags?: string[];
    ownerUserId?: string | null;
    ownerTeamId?: string | null;
  }): Promise<{ contact: Contact; created: boolean }> {
    // Get-or-create: reuse an existing contact whose phone/email canonicalizes
    // to the same value, rather than forking a duplicate.
    const pnorm = params.phone ? normalizeIdentity("phone", params.phone)?.normalized : undefined;
    const enorm = params.email ? normalizeIdentity("email", params.email)?.normalized : undefined;
    if (pnorm || enorm) {
      const hit = this.contacts.find((c) => {
        if (c.orgId !== params.orgId) return false;
        if (pnorm && c.phone && (normalizeIdentity("phone", c.phone)?.normalized ?? c.phone) === pnorm) return true;
        if (enorm && c.email && (normalizeIdentity("email", c.email)?.normalized ?? c.email) === enorm) return true;
        return false;
      });
      if (hit) return { contact: hit, created: false };
    }
    const contact: Contact = {
      id: `ct_${++this.idSeq}`,
      orgId: params.orgId,
      displayName: params.displayName,
      company: params.company,
      phone: params.phone,
      email: params.email,
      tags: params.tags ?? [],
      ownerUserId: params.ownerUserId ?? undefined,
      ownerTeamId: params.ownerTeamId ?? undefined,
      avatarColor: params.avatarColor ?? AVATAR_PALETTE[this.contacts.length % AVATAR_PALETTE.length],
    };
    this.contacts.push(contact);
    return { contact, created: true };
  }

  /** Memory store normalizes on the fly, so there's nothing to backfill. */
  async backfillIdentityNormalization(): Promise<{ updated: number }> {
    return { updated: 0 };
  }

  async reconcileIdentityUniqueness(): Promise<{ mergedContacts: number; collapsedIdentities: number; constraintApplied: boolean }> {
    // Fold any contacts that share a canonical phone/email into one. In-memory
    // uniqueness is otherwise enforced live by upsertContactByIdentity's
    // get-or-create, so there is no separate DB index to apply here.
    let mergedContacts = 0;
    for (const g of await this.findDuplicateContacts()) {
      const ids = g.contacts.map((c) => c.id);
      if (ids.length < 2) continue;
      await this.mergeContacts({ winnerId: ids[0], loserIds: ids.slice(1) });
      mergedContacts += ids.length - 1;
    }
    return { mergedContacts, collapsedIdentities: 0, constraintApplied: true };
  }

  async getAnalytics(orgId: string, q: AnalyticsQuery): Promise<AnalyticsBundle> {
    const from = new Date(q.from).getTime();
    const to = new Date(q.to).getTime();
    const inRange = (iso: string) => {
      const t = new Date(iso).getTime();
      return t >= from && t < to;
    };
    const matches = (c: ConversationRecord) =>
      c.orgId === orgId &&
      (!q.channel || c.channel === q.channel) &&
      (!q.teamId || c.assignedTeamId === q.teamId) &&
      (!q.agentUserId || c.assigneeUserId === q.agentUserId);

    const matched = this.conversations.filter(matches);

    // Fixtures don't carry a conversation createdAt (the schema has none), so
    // approximate it by the earliest message time, falling back to lastActivityAt.
    // (Postgres uses the real Conversation.createdAt column.)
    const createdAtOf = (c: ConversationRecord): string => {
      let min: string | null = null;
      for (const m of c.messages) if (min === null || m.createdAt < min) min = m.createdAt;
      return min ?? c.lastActivityAt;
    };

    // "Right now" status counts across the filtered set.
    const snapshot = { open: 0, pending: 0, snoozed: 0, closed: 0, unassigned: 0, total: 0 };
    for (const c of matched) {
      snapshot.total++;
      if (c.status === "open") snapshot.open++;
      else if (c.status === "pending") snapshot.pending++;
      else if (c.status === "snoozed") snapshot.snoozed++;
      else if (c.status === "closed") snapshot.closed++;
      if (!c.assigneeUserId) snapshot.unassigned++;
    }

    // Conversations created in the window — derive per-thread response facts.
    const conversations: AnalyticsConvo[] = [];
    for (const c of matched) {
      const createdAt = createdAtOf(c);
      if (!inRange(createdAt)) continue;
      let firstInboundAt: string | null = null;
      let firstReplyAt: string | null = null;
      let firstReplyUserId: string | null = null;
      let inbound = 0;
      let outbound = 0;
      const msgs = [...c.messages].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
      for (const m of msgs) {
        if (m.direction === "in") {
          inbound++;
          if (!firstInboundAt) firstInboundAt = m.createdAt;
        } else {
          if (m.internal) continue; // internal notes aren't customer-facing replies
          outbound++;
          if (!firstReplyAt) {
            firstReplyAt = m.createdAt;
            firstReplyUserId = m.authorUserId ?? null;
          }
        }
      }
      conversations.push({
        id: c.id,
        channel: c.channel,
        status: c.status,
        assigneeUserId: c.assigneeUserId ?? null,
        assignedTeamId: c.assignedTeamId ?? null,
        priority: c.priority,
        createdAt,
        lastActivityAt: c.lastActivityAt,
        firstInboundAt,
        firstReplyAt,
        firstReplyUserId,
        labelIds: (c.labels ?? []).map((l) => l.id),
        inbound,
        outbound,
      });
    }

    // Messages sent in the window whose conversation matches the filter.
    const messages: AnalyticsMsg[] = [];
    for (const c of matched) {
      for (const m of c.messages) {
        if (!inRange(m.createdAt)) continue;
        messages.push({
          createdAt: m.createdAt,
          direction: m.direction,
          internal: !!m.internal,
          authorUserId: m.authorUserId ?? null,
          channel: c.channel,
        });
      }
    }

    // New customers: the demo Contact fixtures carry no createdAt, so proxy it by
    // the contact's earliest conversation falling in the window (Postgres uses the
    // real Contact.createdAt instead).
    const earliestByContact = new Map<string, number>();
    for (const c of this.conversations) {
      if (c.orgId !== orgId) continue;
      const t = new Date(createdAtOf(c)).getTime();
      const prev = earliestByContact.get(c.contact.id);
      if (prev === undefined || t < prev) earliestByContact.set(c.contact.id, t);
    }
    let newContacts = 0;
    for (const t of earliestByContact.values()) if (t >= from && t < to) newContacts++;

    return { conversations, messages, newContacts, snapshot };
  }

  async listContacts(): Promise<Contact[]> {
    return [...this.contacts]
      .map((c) => ({ ...c, tags: c.tags ?? [] }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  async findDuplicateContacts(): Promise<ContactDuplicateGroup[]> {
    return groupDuplicateContacts(await this.listContacts());
  }

  async mergeContacts(params: { winnerId: string; loserIds: string[] }): Promise<Contact> {
    const loserIds = [...new Set(params.loserIds)].filter((id) => id !== params.winnerId);
    const winner = this.contacts.find((c) => c.id === params.winnerId);
    if (!winner) throw new Error("Winner contact not found");
    if (!loserIds.length) return { ...winner, tags: winner.tags ?? [] };
    const loserSet = new Set(loserIds);
    const losers = this.contacts.filter((c) => loserSet.has(c.id));

    // Fill the winner's blanks from the losers (first non-empty wins) + union tags.
    for (const l of losers) {
      winner.company ??= l.company;
      winner.phone ??= l.phone;
      winner.email ??= l.email;
      winner.avatarColor ??= l.avatarColor;
      winner.ownerUserId ??= l.ownerUserId;
      winner.ownerTeamId ??= l.ownerTeamId;
    }
    winner.tags = [...new Set([...(winner.tags ?? []), ...losers.flatMap((l) => l.tags ?? [])])];

    // Repoint every conversation/participant that referenced the winner or a
    // loser onto the single merged winner object; a contact appears once per
    // conversation's participant list.
    for (const r of this.conversations) {
      if (r.contact.id === winner.id || loserSet.has(r.contact.id)) r.contact = winner;
      if (r.participants?.length) {
        const seen = new Set<string>();
        r.participants = r.participants
          .map((p) => (p.contact.id === winner.id || loserSet.has(p.contact.id) ? { ...p, contact: winner } : p))
          .filter((p) => {
            if (seen.has(p.contact.id)) return false;
            seen.add(p.contact.id);
            return true;
          });
      }
    }
    this.contacts = this.contacts.filter((c) => !loserSet.has(c.id));
    return { ...winner, tags: winner.tags ?? [] };
  }

  async getContact(id: string): Promise<Contact | undefined> {
    return this.contacts.find((c) => c.id === id);
  }

  async getContactWithConversations(id: string): Promise<ContactWithConversations | undefined> {
    const contact = this.contacts.find((c) => c.id === id);
    if (!contact) return undefined;
    const conversations = this.conversations
      .filter((r) => r.contact.id === id)
      .sort((a, b) => +new Date(b.lastActivityAt) - +new Date(a.lastActivityAt))
      .map((r) => this.summary(r));
    return { ...contact, tags: contact.tags ?? [], conversations };
  }

  async updateContact(
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
  ): Promise<Contact | undefined> {
    const contact = this.contacts.find((c) => c.id === id);
    if (!contact) return undefined;
    if (params.displayName !== undefined) contact.displayName = params.displayName;
    if (params.company !== undefined) contact.company = params.company || undefined;
    if (params.phone !== undefined) contact.phone = params.phone || undefined;
    if (params.email !== undefined) contact.email = params.email || undefined;
    if (params.tags !== undefined) contact.tags = params.tags;
    if (params.ownerUserId !== undefined) contact.ownerUserId = params.ownerUserId ?? undefined;
    if (params.ownerTeamId !== undefined) contact.ownerTeamId = params.ownerTeamId ?? undefined;
    if (params.blocked !== undefined) contact.blocked = params.blocked;
    // Keep the copy embedded in each conversation in sync so the UI updates too.
    for (const r of this.conversations) if (r.contact.id === id) r.contact = { ...contact, tags: contact.tags ?? [] };
    return contact;
  }

  async deleteContact(id: string): Promise<void> {
    this.contacts = this.contacts.filter((c) => c.id !== id);
    // Drop the customer's own conversations (their messages ride on the record).
    this.conversations = this.conversations.filter((r) => r.contact.id !== id);
    // Remove them from any group they were a participant of.
    for (const r of this.conversations) {
      if (r.participants?.length) r.participants = r.participants.filter((p) => p.contact.id !== id);
    }
  }

  async createGroupConversation(params: {
    orgId: string;
    inboxId: string;
    contact: Contact;
    subject: string;
    channelRef: string;
    inviteLink: string;
    memberContacts: Contact[];
    assigneeUserId?: string | null;
    assignedTeamId?: string | null;
  }): Promise<Conversation> {
    const now = new Date().toISOString();
    const id = `conv_${++this.idSeq}`;
    const participants: Participant[] = params.memberContacts.map((ct) => ({
      id: `part_${++this.idSeq}`,
      conversationId: id,
      contact: ct,
      role: "member",
      joinedAt: now,
    }));
    const rec: ConversationRecord = {
      id,
      orgId: params.orgId,
      inboxId: params.inboxId,
      channel: "whatsapp_group",
      contact: params.contact,
      subject: params.subject,
      channelRef: params.channelRef,
      inviteLink: params.inviteLink,
      status: "open",
      assigneeUserId: params.assigneeUserId ?? null,
      assignedTeamId: params.assignedTeamId ?? null,
      priority: "normal",
      labels: [],
      unread: false,
      slaDueAt: null,
      lastActivityAt: now,
      seq: 0,
      preview: `Group created · ${params.memberContacts.length} members`,
      messages: [],
      participants,
    };
    this.conversations.push(rec);
    return this.summary(rec);
  }

  async listParticipants(conversationId: string): Promise<Participant[]> {
    return this.conversations.find((c) => c.id === conversationId)?.participants ?? [];
  }

  async countParticipants(conversationId: string): Promise<number> {
    return (this.conversations.find((c) => c.id === conversationId)?.participants ?? []).length;
  }

  async addParticipant(conversationId: string, contact: Contact, role: ParticipantRole = "member"): Promise<Participant> {
    const rec = this.conversations.find((c) => c.id === conversationId);
    if (!rec) throw new Error(`Conversation ${conversationId} not found`);
    rec.participants ??= [];
    const existing = rec.participants.find((p) => p.contact.id === contact.id);
    if (existing) return existing;
    const p: Participant = {
      id: `part_${++this.idSeq}`,
      conversationId,
      contact,
      role,
      joinedAt: new Date().toISOString(),
    };
    rec.participants.push(p);
    return p;
  }

  async removeParticipant(conversationId: string, contactId: string): Promise<void> {
    const rec = this.conversations.find((c) => c.id === conversationId);
    if (rec) rec.participants = (rec.participants ?? []).filter((p) => p.contact.id !== contactId);
  }
}

/**
 * Channels in the order somebody chose, oldest first among those that tie.
 *
 * The tie-break is implicit and worth saying out loud: `Array.prototype.sort`
 * is stable, and this store appends on create, so rows sharing an order keep
 * insertion order — which here *is* creation order. That matches the Postgres
 * store's explicit `createdAt` tie-break without this store having to carry a
 * timestamp the domain type does not have.
 *
 * It matters because every row starts at order 0: a workspace that has never
 * touched the arrows is entirely ties, and the whole ordering is the tie-break.
 */
function byChosenOrder(a: { order?: number }, b: { order?: number }): number {
  return (a.order ?? 0) - (b.order ?? 0);
}

const followUpKey = (conversationId: string, userId: string) => `${conversationId}|${userId}`;
