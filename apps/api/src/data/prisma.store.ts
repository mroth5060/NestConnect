import { Injectable } from "@nestjs/common";
import bcrypt from "bcryptjs";
import { hashInviteToken, newInviteToken } from "../auth/invite-token";
import { IDENTITY_NORMALIZATION_VERSION, normalizeIdentity, type IdentityKind } from "../contacts/identity";
import { groupDuplicateContacts } from "../contacts/duplicates";
import { threadsTogether } from "./email-threading";
import { Prisma } from "@prisma/client";
import type {
  CreateCustomFieldInput,
  CustomField,
  CustomFieldEntity,
  CustomFieldValue,
  UpdateCustomFieldInput,
  Attachment,
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
  MessageType,
  NoteFollowUp,
} from "@ding/schemas";
import {
  CONVERSATIONS_PAGE_SIZE,
  CUSTOM_FIELD_FILTER_MAX,
  MESSAGES_PAGE_SIZE,
  normalizeCustomFieldValue,
  THREADABLE_STATUSES,
} from "@ding/schemas";
import { env } from "../config/env";
import { DEMO_USER_ID } from "./fixtures";
import { currentOrgId, runInTenant } from "../tenancy/tenant-scope";
import { PLATFORM_ORG_ID } from "../tenancy/platform";
import { tenantScoped, TenantViolationError, type TenantPrisma } from "./tenant-prisma";
import { purgeWorkspaceData } from "./workspace-purge";
import { noteWorkspaceStatus, replaceFrozenWorkspaces, type WorkspaceStatus } from "../tenancy/workspace-status";

/** Which normalisation wrote the identity keys currently in the table. A
 *  platform setting: it describes the data in every workspace, not any one
 *  workspace's configuration. */
const IDENTITY_VERSION_KEY = "identity_normalization_version";
/** Per-org uniqueness on (orgId, kind, normalizedValue). Created at runtime
 *  rather than by a Prisma migration, because it can only be applied after the
 *  data is clean — see reconcileIdentityUniqueness. */
const IDENTITY_UNIQUE_INDEX = "ContactIdentity_orgId_kind_normalizedValue_key";
import {
  canAdvanceStatus,
  isWaChannel,
  mapAttachment,
  mapContact,
  mapCustomField,
  mapConversation,
  mapCustomerDevice,
  mapDevice,
  mapInbox,
  mapMessage,
  mapNotification,
  mapParticipant,
  mapSession,
  mapTeam,
  mapTemplate,
  mapUser,
  messageTypeForKind,
  parseReactions,
  previewFromBody, previewForType,
  canonicalLang,
  sameTemplateLang,
} from "./mappers";
import { PrismaService } from "./prisma.service";
import { SecretEncryptionService } from "../crypto/secret-encryption.service";
import {
  Store,
  EMAIL_OPEN_GRACE_MS,
  type WorkspacePerson,
  type AnalyticsBundle,
  type AnalyticsConvo,
  type AnalyticsMsg,
  type AnalyticsQuery,
  type AppendInboundInput,
  type AttachmentInput,
  type ImportEmailThreadInput,
  type MessageStatusChange,
  type OutboundDeliveryMeta,
  type EmailRecipientInput,
  type OutboundMessageRef,
  type SidebarViews,
  type StoredAttachmentRef,
  type StoredCustomerDevice,
  type StoredDevice,
  type StoredSession,
  type TwoFactorState,
  type WorkspaceMembership,
  type WorkspaceSummary,
  type ViewItem,
  type WebhookDiagnostic,
  type ConversationState,
  type ConversationEventInput,
  type ConversationEventRow,
  type ListStatus,
} from "./store";

/**
 * A contact as every read loads it: their identities, and the organisation
 * they're shown under (their primary one, else the first; archived ones don't
 * count). That organisation's name is what `contact.company` means now — the
 * old free-text Company field is no longer read.
 */
const CONTACT_INCLUDE = {
  identities: true,
  accountLinks: {
    where: { account: { archivedAt: null } },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
    take: 1,
    select: { account: { select: { name: true } } },
  },
} satisfies Prisma.ContactInclude;

const convInclude = {
  contact: { include: CONTACT_INCLUDE },
  labels: { include: { label: true } },
  // The assignee's name, so the summary can show the real owner (not just "You").
  assignee: { select: { name: true } },
  // The most recent customer-facing message, purely so the summary can report
  // its channel (the list badge shows the last channel used, not the origin).
  messages: { where: { internal: false }, orderBy: { seq: "desc" }, take: 1 },
} satisfies Prisma.ConversationInclude;

/** Keyset cursor for the (lastActivityAt desc, id desc) conversation ordering. */
function encodeConvCursor(row: { lastActivityAt: Date; id: string }): string {
  return Buffer.from(`${row.lastActivityAt.toISOString()}::${row.id}`).toString("base64url");
}
function decodeConvCursor(cursor?: string): { t: Date; id: string } | undefined {
  if (!cursor) return undefined;
  try {
    const [t, id] = Buffer.from(cursor, "base64url").toString("utf8").split("::");
    const date = new Date(t);
    return id && !Number.isNaN(date.getTime()) ? { t: date, id } : undefined;
  } catch {
    return undefined;
  }
}
/** Clamp a requested page size into a sane range. */
function pageLimit(requested: number | undefined, fallback: number): number {
  const n = requested ?? fallback;
  return Math.min(Math.max(Math.trunc(n) || fallback, 1), 100);
}
/** Keyset predicate: rows strictly after the cursor in (lastActivityAt, id) desc. */
function keysetBefore(cur: { t: Date; id: string }): Prisma.ConversationWhereInput {
  return {
    OR: [
      { lastActivityAt: { lt: cur.t } },
      { AND: [{ lastActivityAt: cur.t }, { id: { lt: cur.id } }] },
    ],
  };
}

/** The one row an inbox lookup names, or nothing when it names several. */
function unambiguous<R extends Parameters<typeof mapInbox>[0]>(rows: R[]): Inbox | undefined {
  return rows.length === 1 ? mapInbox(rows[0]) : undefined;
}

const AVATAR_PALETTE = [
  "linear-gradient(135deg,#F97316,#DB2777)",
  "linear-gradient(135deg,#0EA5E9,#2563EB)",
  "linear-gradient(135deg,#10B981,#059669)",
  "linear-gradient(135deg,#6366F1,#A855F7)",
  "linear-gradient(135deg,#F59E0B,#EF4444)",
  "linear-gradient(135deg,#14B8A6,#0EA5E9)",
];

/** Postgres-backed store (active when DATABASE_URL is set). */
@Injectable()
export class PrismaStore extends Store {
  /**
   * Every query below goes through `prisma`, which confines it to the tenant
   * bound for the current request or job (see tenant-prisma.ts). `root` is the
   * unscoped client, used only where a lookup has to cross workspaces — each use
   * says why. Search for `this.root` to see every one.
   */
  private readonly prisma: TenantPrisma;

  constructor(
    private readonly root: PrismaService,
    private readonly crypto: SecretEncryptionService,
  ) {
    super();
    this.prisma = tenantScoped(root);
  }

  get demoUserId(): string {
    return DEMO_USER_ID;
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.root.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  async getUser(id: string): Promise<User | undefined> {
    const u = await this.prisma.user.findUnique({ where: { id } });
    return u ? mapUser(u) : undefined;
  }

  // Cross-tenant by necessity: the verified session token names a user, and the
  // user is how the request learns which workspace it is in.
  async getUserForAuth(id: string): Promise<User | undefined> {
    const u = await this.root.user.findUnique({ where: { id } });
    return u ? mapUser(u) : undefined;
  }

  // Cross-tenant by necessity: an email address is what somebody signs in with,
  // before anything says which workspace they're going into. It names one
  // Login; of that Login's workspaces, the one they were last in.
  async findUserByEmail(email: string): Promise<User | undefined> {
    const login = await this.loginByEmail(email);
    if (!login) return undefined;
    const rows = await this.root.user.findMany({
      where: { loginId: login.id },
      include: { org: { select: { status: true } } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    // A suspended or closed workspace is passed over for one that's open; with
    // none open, signing in reaches the frozen one and is refused there.
    const open = rows.filter((u) => u.org.status === "active");
    const pool = open.length ? open : rows;
    const row = pool.find((u) => u.orgId === login.lastOrgId) ?? pool[0];
    return row ? mapUser(row) : undefined;
  }

  // Cross-tenant by necessity: whether this address signs in as anyone, on the
  // whole platform — an address belongs to one person wherever they are.
  async emailInUse(email: string): Promise<boolean> {
    if (await this.root.login.findUnique({ where: { email: email.trim().toLowerCase() } })) return true;
    const n = await this.root.user.count({ where: { email: { equals: email.trim(), mode: "insensitive" } } });
    return n > 0;
  }

  async emailInWorkspace(email: string): Promise<boolean> {
    const n = await this.prisma.user.count({ where: { email: { equals: email.trim(), mode: "insensitive" } } });
    return n > 0;
  }

  async getPasswordHash(userId: string): Promise<string | undefined> {
    return (await this.loginOf(userId))?.passwordHash ?? undefined;
  }

  /* ---- sign-in (Login) ----
   *
   * One Login per address, holding the password and the second factor; each
   * workspace the person is in is a User pointing at it. Logins belong to no
   * workspace, so all of this goes through the unscoped client — and only
   * ever starting from a user, an address, or a token the person holds.
   */

  /** The Login with this address — linking any account with it that has none
   *  yet (made by a script, or before Logins), so that account signs in too. */
  private async loginByEmail(email: string) {
    const address = email.trim().toLowerCase();
    const loose = await this.root.user.findMany({
      where: { loginId: null, email: { equals: address, mode: "insensitive" } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    for (const u of loose) await this.ensureLogin(u.id);
    return (await this.root.login.findUnique({ where: { email: address } })) ?? undefined;
  }

  /** A user's Login, made (from the user's own credentials) or joined (by
   *  address) if the user predates Logins. The user must be in the workspace
   *  this request acts for: a password or a second factor is only ever read
   *  or changed through the person's place here. */
  private async loginOf(userId: string) {
    if (!(await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } }))) return undefined;
    return this.ensureLogin(userId);
  }

  /** The same, for the workspaces-of-one-person calls below, which start from
   *  a signed-in user and look across workspaces by design. */
  private async loginOfAnywhere(userId: string) {
    return this.ensureLogin(userId);
  }

  private async ensureLogin(userId: string) {
    const u = await this.root.user.findUnique({ where: { id: userId } });
    if (!u) return undefined;
    if (u.loginId) return (await this.root.login.findUnique({ where: { id: u.loginId } })) ?? undefined;
    const address = u.email.trim().toLowerCase();
    const existing = await this.root.login.findUnique({ where: { email: address } });
    // An address already signing in elsewhere: this account is that person's
    // place in one more workspace — unless that workspace already has them.
    if (existing) {
      const taken = await this.root.user.findFirst({ where: { orgId: u.orgId, loginId: existing.id } });
      if (taken) return undefined;
      await this.root.user.update({
        where: { id: u.id },
        data: { loginId: existing.id, twoFactorEnabled: existing.twoFactorEnabled, twoFactorMethod: existing.twoFactorMethod },
      });
      return existing;
    }
    const created = await this.root.login.create({
      data: {
        email: address,
        passwordHash: u.passwordHash,
        twoFactorEnabled: u.twoFactorEnabled,
        twoFactorMethod: u.twoFactorMethod,
        totpSecret: u.totpSecret,
        lastOrgId: u.orgId,
      },
    });
    await this.root.user.update({ where: { id: u.id }, data: { loginId: created.id } });
    await this.root.recoveryCode.updateMany({ where: { userId: u.id, loginId: null }, data: { loginId: created.id } });
    return created;
  }

  // Cross-tenant by necessity: the workspaces one person is in.
  async listMemberships(userId: string): Promise<WorkspaceMembership[]> {
    const login = await this.loginOfAnywhere(userId);
    if (!login) {
      const me = await this.getUserForAuth(userId);
      if (!me) return [];
      const org = await this.root.organization.findUnique({ where: { id: me.orgId } });
      return [{ user: me, orgName: org?.name ?? "", sandbox: org?.sandbox ?? false, status: (org?.status ?? "active") as WorkspaceStatus }];
    }
    const rows = await this.root.user.findMany({
      where: { loginId: login.id },
      include: { org: { select: { name: true, sandbox: true, status: true } } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return rows.map((r) => ({ user: mapUser(r), orgName: r.org.name, sandbox: r.org.sandbox, status: r.org.status as WorkspaceStatus }));
  }

  // Cross-tenant by necessity: the same person's place in another workspace.
  async membershipIn(userId: string, orgId: string): Promise<User | undefined> {
    const login = await this.loginOfAnywhere(userId);
    if (!login) return undefined;
    const row = await this.root.user.findFirst({ where: { loginId: login.id, orgId } });
    return row ? mapUser(row) : undefined;
  }

  async rememberWorkspace(userId: string): Promise<void> {
    const u = await this.root.user.findUnique({ where: { id: userId }, select: { orgId: true } });
    const login = await this.loginOfAnywhere(userId);
    if (u && login && login.lastOrgId !== u.orgId) {
      await this.root.login.update({ where: { id: login.id }, data: { lastOrgId: u.orgId } });
    }
  }

  // Cross-tenant by necessity: the same person, given a place in another
  // workspace — copied from who they are here.
  async joinWorkspace(userId: string, orgId: string, role: Role): Promise<User> {
    const login = await this.loginOfAnywhere(userId);
    const me = await this.root.user.findUnique({ where: { id: userId } });
    if (!login || !me) throw new Error("No such person");
    const already = await this.root.user.findFirst({ where: { loginId: login.id, orgId } });
    if (already) return mapUser(already);
    const row = await this.root.user.create({
      data: {
        orgId,
        loginId: login.id,
        name: me.name,
        email: me.email,
        role,
        avatarColor: me.avatarColor,
        avatarUrl: me.avatarUrl,
        position: me.position,
        twoFactorEnabled: login.twoFactorEnabled,
        twoFactorMethod: login.twoFactorMethod,
      },
    });
    return mapUser(row);
  }

  // Cross-tenant by necessity: every workspace on the platform, for its owners.
  async listWorkspaces(): Promise<WorkspaceSummary[]> {
    const orgs = await this.root.organization.findMany({
      orderBy: { createdAt: "asc" },
      include: { _count: { select: { users: true, inboxes: true, conversations: true } } },
    });
    return orgs.map((o) => ({
      id: o.id,
      name: o.name,
      sandbox: o.sandbox,
      createdAt: o.createdAt.toISOString(),
      people: o._count.users,
      channels: o._count.inboxes,
      conversations: o._count.conversations,
      status: o.status as WorkspaceStatus,
      statusAt: o.statusAt?.toISOString() ?? null,
      purgeAt: o.purgeAt?.toISOString() ?? null,
    }));
  }

  // Cross-tenant by necessity, as is all of the below: the platform's owners
  // manage a workspace from outside it.
  async renameWorkspace(orgId: string, name: string): Promise<void> {
    await this.root.organization.update({ where: { id: orgId }, data: { name } });
  }

  async setWorkspaceStatus(orgId: string, status: WorkspaceStatus, purgeAt: Date | null): Promise<void> {
    await this.root.organization.update({ where: { id: orgId }, data: { status, statusAt: new Date(), purgeAt } });
    noteWorkspaceStatus(orgId, status);
  }

  async refreshWorkspaceStatuses(): Promise<void> {
    replaceFrozenWorkspaces(await this.root.organization.findMany({ where: { status: { not: "active" } }, select: { id: true, status: true } }));
  }

  async listWorkspacePeople(orgId: string): Promise<WorkspacePerson[]> {
    const rows = await this.root.user.findMany({
      where: { orgId },
      include: { login: { select: { passwordHash: true } } },
      orderBy: { name: "asc" },
    });
    return rows.map((u) => ({ user: mapUser(u), pending: !(u.login?.passwordHash ?? u.passwordHash) }));
  }

  async revokeWorkspaceSessions(orgId: string): Promise<number> {
    const where = { user: { orgId }, revokedAt: null };
    const doomed = await this.root.session.findMany({ where, select: { id: true } });
    if (!doomed.length) return 0;
    await this.root.session.updateMany({ where: { id: { in: doomed.map((d) => d.id) } }, data: { revokedAt: new Date() } });
    await this.root.device.deleteMany({ where: { OR: [{ sessionId: { in: doomed.map((d) => d.id) } }, { user: { orgId } }] } });
    return doomed.length;
  }

  async listWorkspacesDueForPurge(now: Date): Promise<string[]> {
    const rows = await this.root.organization.findMany({ where: { status: "deleting", purgeAt: { lte: now } }, select: { id: true } });
    return rows.map((r) => r.id);
  }

  async purgeWorkspace(orgId: string): Promise<{ files: string[] }> {
    const { files } = await purgeWorkspaceData(this.root, orgId);
    noteWorkspaceStatus(orgId, "active");
    return { files };
  }

  // Cross-tenant by necessity: a new workspace has no tenant to be made in.
  async createWorkspace(name: string): Promise<{ id: string; name: string }> {
    const org = await this.root.organization.create({ data: { name } });
    return { id: org.id, name: org.name };
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
    // Last in the list, not first. The column defaults to 0, which is fine
    // while every row is 0 — but once somebody has used the arrows, a new
    // channel left at 0 would shoulder its way to the top of the sidebar they
    // arranged. It goes on the end instead, where a new thing belongs.
    const last = await this.prisma.inbox.aggregate({
      where: { orgId: params.orgId },
      _max: { order: true },
    });
    const created = await this.prisma.inbox.create({
      data: {
        orgId: params.orgId,
        type: params.type,
        name: params.name,
        handle: params.handle,
        order: (last._max.order ?? 0) + 1,
        routingStrategy: params.routingStrategy,
        // Encrypt credential fields (accessToken/providerToken/refreshToken) at rest.
        channelConfig: params.channelConfig
          ? this.crypto.encryptChannelConfig(params.channelConfig)
          : undefined,
        teams: { create: params.teamIds.map((teamId) => ({ teamId })) },
      },
      include: { teams: true },
    });
    return mapInbox(created);
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
    const existing = await this.prisma.inbox.findUnique({ where: { id } });
    if (!existing) return undefined;
    // Merge new (plaintext) fields over the stored config, encrypting the
    // incoming secret fields. Existing secret fields are already ciphertext and
    // are preserved as-is (encrypt() is idempotent, so no double-encryption).
    const mergedConfig =
      params.channelConfig !== undefined
        ? {
            ...((existing.channelConfig as Record<string, string> | null) ?? {}),
            ...this.crypto.encryptChannelConfig(params.channelConfig),
          }
        : undefined;
    const updated = await this.prisma.inbox.update({
      where: { id },
      data: {
        name: params.name ?? undefined,
        routingStrategy: params.routingStrategy ?? undefined,
        ...(params.contactTag !== undefined ? { contactTag: params.contactTag } : {}),
        ...(params.conversationLabelId !== undefined ? { conversationLabelId: params.conversationLabelId } : {}),
        ...(mergedConfig !== undefined ? { channelConfig: mergedConfig } : {}),
        ...(params.teamIds !== undefined
          ? { teams: { deleteMany: {}, create: params.teamIds.map((teamId) => ({ teamId })) } }
          : {}),
      },
      include: { teams: true },
    });
    return mapInbox(updated);
  }

  async setInboxSignature(
    id: string,
    signature: { layoutHtml: string | null; footerHtml: string | null },
  ): Promise<Inbox | undefined> {
    const existing = await this.prisma.inbox.findUnique({ where: { id }, select: { id: true } });
    if (!existing) return undefined;
    const updated = await this.prisma.inbox.update({
      where: { id },
      data: { signatureHtml: signature.layoutHtml, signatureFooterHtml: signature.footerHtml },
      include: { teams: true },
    });
    return mapInbox(updated);
  }

  async deleteInbox(id: string): Promise<void> {
    const convs = await this.prisma.conversation.findMany({ where: { inboxId: id }, select: { id: true } });
    const convIds = convs.map((c) => c.id);
    const msgs = convIds.length
      ? await this.prisma.message.findMany({ where: { conversationId: { in: convIds } }, select: { id: true } })
      : [];
    const msgIds = msgs.map((m) => m.id);
    // No DB-level cascade, so tear down children before the inbox, in FK order.
    await this.prisma.$transaction([
      ...(msgIds.length ? [this.prisma.attachment.deleteMany({ where: { messageId: { in: msgIds } } })] : []),
      ...(convIds.length
        ? [
            this.prisma.message.deleteMany({ where: { conversationId: { in: convIds } } }),
            this.prisma.participant.deleteMany({ where: { conversationId: { in: convIds } } }),
            this.prisma.note.deleteMany({ where: { conversationId: { in: convIds } } }),
            this.prisma.conversationLabel.deleteMany({ where: { conversationId: { in: convIds } } }),
            this.prisma.assignmentEvent.deleteMany({ where: { conversationId: { in: convIds } } }),
            this.prisma.conversation.deleteMany({ where: { inboxId: id } }),
          ]
        : []),
      this.prisma.inboxTeam.deleteMany({ where: { inboxId: id } }),
      this.prisma.inbox.delete({ where: { id } }),
    ]);
  }

  async getInbox(id: string): Promise<Inbox | undefined> {
    const row = await this.prisma.inbox.findUnique({ where: { id }, include: { teams: true } });
    return row ? mapInbox(row) : undefined;
  }

  async getInboxConfig(id: string): Promise<Record<string, string> | undefined> {
    const row = await this.prisma.inbox.findUnique({
      where: { id },
      select: { channelConfig: true },
    });
    const config = (row?.channelConfig as Record<string, string> | null) ?? undefined;
    // Decrypt credential fields so callers (providers) get plaintext tokens.
    return config ? this.crypto.decryptChannelConfig(config) : undefined;
  }

  async getAppSetting(orgId: string, key: string): Promise<string | undefined> {
    const row = await this.prisma.appSetting.findUnique({
      where: { orgId_key: { orgId, key } },
    });
    if (row?.value == null) return undefined;
    return this.crypto.decryptAppSetting(key, row.value);
  }

  async setAppSetting(orgId: string, key: string, value: string): Promise<void> {
    const stored = this.crypto.encryptAppSetting(key, value);
    await this.prisma.appSetting.upsert({
      where: { orgId_key: { orgId, key } },
      create: { orgId, key, value: stored },
      update: { value: stored },
    });
  }

  // Platform settings live with the platform's own workspace and are read from
  // there whichever workspace is asking — see tenancy/platform.ts. Who may
  // change them is decided by the controller, not here.
  async getPlatformSetting(key: string): Promise<string | undefined> {
    const row = await this.root.appSetting.findUnique({
      where: { orgId_key: { orgId: PLATFORM_ORG_ID, key } },
    });
    if (row?.value == null) return undefined;
    return this.crypto.decryptAppSetting(key, row.value);
  }

  async setPlatformSetting(key: string, value: string): Promise<void> {
    const stored = this.crypto.encryptAppSetting(key, value);
    await this.root.appSetting.upsert({
      where: { orgId_key: { orgId: PLATFORM_ORG_ID, key } },
      create: { orgId: PLATFORM_ORG_ID, key, value: stored },
      update: { value: stored },
    });
  }

  /* ---- message templates ---- */

  async listTemplates(orgId: string): Promise<Template[]> {
    const rows = await this.prisma.template.findMany({
      where: { orgId },
      orderBy: [{ name: "asc" }, { language: "asc" }],
    });
    return rows.map(mapTemplate);
  }

  async getTemplate(id: string): Promise<Template | undefined> {
    const row = await this.prisma.template.findUnique({ where: { id } });
    return row ? mapTemplate(row) : undefined;
  }

  async createTemplate(orgId: string, input: CreateTemplateInput): Promise<Template> {
    const row = await this.prisma.template.create({
      data: {
        orgId,
        name: input.name,
        category: input.category,
        language: input.language,
        body: input.body,
        approvalStatus: "draft",
        variableDefaults: input.variableDefaults ?? [],
      },
    });
    return mapTemplate(row);
  }

  async updateTemplate(id: string, input: UpdateTemplateInput): Promise<Template | undefined> {
    try {
      const row = await this.prisma.template.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.category !== undefined ? { category: input.category } : {}),
          ...(input.language !== undefined ? { language: input.language } : {}),
          ...(input.body !== undefined ? { body: input.body } : {}),
          ...(input.variableDefaults !== undefined ? { variableDefaults: input.variableDefaults } : {}),
          ...(input.approvalStatus !== undefined ? { approvalStatus: input.approvalStatus } : {}),
        },
      });
      return mapTemplate(row);
    } catch {
      return undefined;
    }
  }

  async deleteTemplate(id: string): Promise<void> {
    await this.prisma.template.delete({ where: { id } }).catch(() => {});
  }

  async upsertTemplateByName(
    orgId: string,
    // `variableDefaults` is deliberately not accepted: a sync brings Meta's
    // name, body and status, while what we pre-fill the variables with is
    // ours, and a re-sync must never reset it.
    input: Omit<CreateTemplateInput, "variableDefaults"> & {
      approvalStatus: Template["approvalStatus"];
      wabaId?: string;
    },
  ): Promise<Template> {
    // Only this account's rows, plus the unclaimed ones. Another account's
    // "order_update" is a different template and must not be overwritten by
    // this one — which is the whole reason the column exists.
    const sameName = await this.prisma.template.findMany({
      where: {
        orgId,
        name: input.name,
        ...(input.wabaId ? { OR: [{ wabaId: input.wabaId }, { wabaId: null }] } : {}),
      },
    });
    // Exact (name, language) first; then the same primary language, so Meta's
    // locale-qualified "en_US" updates a locally-stored "en" copy rather than
    // inserting a stale duplicate. Within each pass a row already claimed by
    // this account beats an unclaimed one, so a sync never adopts a stranger
    // when it has its own row sitting right there.
    const claimedFirst = [...sameName].sort(
      (a, b) => Number(b.wabaId === input.wabaId) - Number(a.wabaId === input.wabaId),
    );
    const match =
      claimedFirst.find((t) => t.language === input.language) ??
      claimedFirst.find((t) => sameTemplateLang(t.language, input.language));
    const fields = {
      category: input.category,
      body: input.body,
      approvalStatus: input.approvalStatus,
    };
    const row = match
      ? await this.prisma.template.update({
          where: { id: match.id },
          // Adopt Meta's exact language code so outbound template sends use the
          // code the template is actually approved under — and claim the row for
          // this account, which is how a pre-existing template learns whose it is.
          data: { language: input.language, ...(input.wabaId ? { wabaId: input.wabaId } : {}), ...fields },
        })
      : await this.prisma.template.create({
          data: {
            orgId,
            name: input.name,
            language: input.language,
            ...(input.wabaId ? { wabaId: input.wabaId } : {}),
            ...fields,
          },
        });
    return mapTemplate(row);
  }

  async pruneTemplatesForWaba(
    orgId: string,
    wabaId: string,
    keep: Array<{ name: string; language: string }>,
  ): Promise<number> {
    const mine = await this.prisma.template.findMany({ where: { orgId, wabaId } });
    // Compare on the primary language subtag for the same reason the upsert
    // does: Meta may answer "en_US" for a row we hold as "en", and deleting it
    // as missing would drop a template that is very much still there.
    const wanted = keep.map((k) => `${k.name}\u0000${canonicalLang(k.language)}`);
    const doomed = mine.filter((t) => !wanted.includes(`${t.name}\u0000${canonicalLang(t.language)}`));
    if (!doomed.length) return 0;
    await this.prisma.template.deleteMany({ where: { id: { in: doomed.map((t) => t.id) } } });
    return doomed.length;
  }

  async listTeams(): Promise<Team[]> {
    const rows = await this.prisma.team.findMany({
      where: { orgId: currentOrgId() },
      orderBy: [{ order: "asc" }, { name: "asc" }],
    });
    return rows.map(mapTeam);
  }

  async listMembers(): Promise<Member[]> {
    const rows = await this.prisma.user.findMany({
      where: { orgId: currentOrgId() },
      include: { memberships: true, login: { select: { passwordHash: true } } },
      orderBy: { name: "asc" },
    });
    // Joined means a password is set — on their sign-in, or (before sign-ins
    // were shared across workspaces) on the user row. The same test as the
    // platform's own list of a workspace's people.
    return rows.map((u) => ({
      user: mapUser(u),
      teamIds: u.memberships.map((m) => m.teamId),
      pending: !(u.login?.passwordHash ?? u.passwordHash),
    }));
  }

  async createTeam(params: { orgId: string; name: string; icon?: string; slaMinutes?: number | null }): Promise<Team> {
    const max = await this.prisma.team.aggregate({ where: { orgId: params.orgId }, _max: { order: true } });
    const t = await this.prisma.team.create({
      data: {
        orgId: params.orgId,
        name: params.name,
        icon: params.icon ?? null,
        order: (max._max.order ?? -1) + 1,
        slaMinutes: params.slaMinutes ?? null,
      },
    });
    return mapTeam(t);
  }

  async updateTeam(
    id: string,
    params: { name?: string; icon?: string | null; slaMinutes?: number | null },
  ): Promise<Team | undefined> {
    try {
      const t = await this.prisma.team.update({
        where: { id },
        data: {
          name: params.name ?? undefined,
          ...(params.icon !== undefined ? { icon: params.icon } : {}),
          ...(params.slaMinutes !== undefined ? { slaMinutes: params.slaMinutes } : {}),
        },
      });
      return mapTeam(t);
    } catch {
      return undefined;
    }
  }

  async getTeam(id: string): Promise<Team | undefined> {
    const t = await this.prisma.team.findUnique({ where: { id } });
    return t ? mapTeam(t) : undefined;
  }

  async reorderTeams(orderedIds: string[]): Promise<Team[]> {
    await this.prisma.$transaction(
      orderedIds.map((id, i) => this.prisma.team.update({ where: { id }, data: { order: i } })),
    );
    return this.listTeams();
  }

  async reorderInboxes(orderedIds: string[]): Promise<Inbox[]> {
    // `updateMany` with the org in the filter rather than `update` keyed on the
    // id alone: these ids come from a request, and an id belonging to another
    // workspace would otherwise be taken at its word.
    await this.prisma.$transaction(
      orderedIds.map((id, i) =>
        this.prisma.inbox.updateMany({ where: { id, orgId: currentOrgId() }, data: { order: i } }),
      ),
    );
    return this.listInboxes();
  }

  async deleteTeam(id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.teamMember.deleteMany({ where: { teamId: id } });
      await tx.inboxTeam.deleteMany({ where: { teamId: id } });
      await tx.conversation.updateMany({ where: { assignedTeamId: id }, data: { assignedTeamId: null } });
      await tx.team.delete({ where: { id } });
    });
  }

  async createUser(params: {
    orgId: string;
    name: string;
    email: string;
    role: Role;
    teamIds: string[];
    position?: string | null;
    password?: string;
  }): Promise<{ user: User; inviteToken?: string; joinedExisting?: boolean }> {
    // Somebody who already signs in (in another workspace) joins with the
    // sign-in they have: no invite to set a password, just word that they've
    // been added. Anyone new gets a Login with no password yet and an invite
    // to set one — unless a password is given (seeding).
    const address = params.email.trim().toLowerCase();
    let login = await this.root.login.findUnique({ where: { email: address } });
    const joinedExisting = !!login?.passwordHash;
    if (!login) {
      login = await this.root.login.create({
        data: { email: address, passwordHash: params.password ? bcrypt.hashSync(params.password, 8) : null, lastOrgId: params.orgId },
      });
    } else if (params.password && !login.passwordHash) {
      login = await this.root.login.update({ where: { id: login.id }, data: { passwordHash: bcrypt.hashSync(params.password, 8) } });
    }
    const invite = joinedExisting || params.password ? null : newInviteToken();
    const u = await this.prisma.user.create({
      data: {
        orgId: params.orgId,
        name: params.name,
        email: params.email,
        role: params.role,
        position: params.position ?? null,
        loginId: login.id,
        twoFactorEnabled: login.twoFactorEnabled,
        twoFactorMethod: login.twoFactorMethod,
        inviteTokenHash: invite?.hash ?? null,
        inviteExpiresAt: invite?.expiresAt ?? null,
        memberships: { create: params.teamIds.map((teamId) => ({ teamId })) },
      },
    });
    return { user: mapUser(u), inviteToken: invite?.token, joinedExisting };
  }

  // Cross-tenant by necessity: the single-use token is the only thing the
  // person holds, and it is what identifies their account.
  // An invite is to one workspace (it's on the User); a reset is for the
  // person (it's on the Login). Either sets the one password they sign in with.
  async setPasswordByInviteToken(token: string, password: string): Promise<User | undefined> {
    const hash = hashInviteToken(token);
    const invited = await this.root.user.findFirst({ where: { inviteTokenHash: hash } });
    if (invited) {
      if (!invited.inviteExpiresAt || invited.inviteExpiresAt.getTime() < Date.now()) return undefined;
      const login = await this.ensureLogin(invited.id);
      if (!login) return undefined;
      await this.root.login.update({ where: { id: login.id }, data: { passwordHash: bcrypt.hashSync(password, 8), lastOrgId: invited.orgId } });
      const updated = await this.root.user.update({ where: { id: invited.id }, data: { inviteTokenHash: null, inviteExpiresAt: null } });
      return mapUser(updated);
    }
    const login = await this.root.login.findFirst({ where: { resetTokenHash: hash } });
    if (!login || !login.resetExpiresAt || login.resetExpiresAt.getTime() < Date.now()) return undefined;
    await this.root.login.update({
      where: { id: login.id },
      data: { passwordHash: bcrypt.hashSync(password, 8), resetTokenHash: null, resetExpiresAt: null },
    });
    return this.findUserByEmail(login.email);
  }

  // Cross-tenant by necessity: a reset is asked for by email address alone.
  async createPasswordResetToken(email: string): Promise<{ user: User; token: string } | null> {
    const login = await this.loginByEmail(email);
    const user = login ? await this.findUserByEmail(login.email) : undefined;
    if (!login || !user) return null;
    const inv = newInviteToken();
    await this.root.login.update({ where: { id: login.id }, data: { resetTokenHash: inv.hash, resetExpiresAt: inv.expiresAt } });
    return { user, token: inv.token };
  }

  async updateUser(
    id: string,
    params: { name?: string; role?: Role; teamIds?: string[]; position?: string | null },
  ): Promise<User | undefined> {
    try {
      await this.prisma.$transaction(async (tx) => {
        const data: Prisma.UserUpdateInput = {};
        if (params.name !== undefined) data.name = params.name;
        if (params.position !== undefined) data.position = params.position;
        if (params.role !== undefined) data.role = params.role;
        if (Object.keys(data).length) await tx.user.update({ where: { id }, data });
        if (params.teamIds !== undefined) {
          await tx.teamMember.deleteMany({ where: { userId: id } });
          if (params.teamIds.length) {
            await tx.teamMember.createMany({
              data: params.teamIds.map((teamId) => ({ userId: id, teamId })),
              skipDuplicates: true,
            });
          }
        }
      });
      const u = await this.prisma.user.findUnique({ where: { id } });
      return u ? mapUser(u) : undefined;
    } catch {
      return undefined;
    }
  }

  async updateMyPreferences(
    userId: string,
    params: { available?: boolean; schedule?: AvailabilitySchedule | null },
  ): Promise<User | undefined> {
    try {
      const data: Prisma.UserUpdateInput = {};
      if (params.available !== undefined) data.available = params.available;
      if (params.schedule !== undefined) {
        data.availabilitySchedule = params.schedule === null ? Prisma.DbNull : (params.schedule as Prisma.InputJsonValue);
      }
      const u = await this.prisma.user.update({ where: { id: userId }, data });
      return mapUser(u);
    } catch {
      return undefined;
    }
  }

  async updateMyProfile(
    userId: string,
    params: { name?: string; email?: string; avatarUrl?: string | null; position?: string | null },
  ): Promise<User | undefined> {
    try {
      const data: Prisma.UserUpdateInput = {};
      if (params.name !== undefined) data.name = params.name;
      if (params.position !== undefined) data.position = params.position;
      if (params.email !== undefined) data.email = params.email;
      if (params.avatarUrl !== undefined) data.avatarUrl = params.avatarUrl;
      const u = await this.prisma.user.update({ where: { id: userId }, data });
      // The address is who they sign in as, everywhere: the Login and their
      // place in every other workspace follow it.
      if (params.email !== undefined) {
        const login = await this.loginOf(userId);
        if (login) {
          await this.root.login.update({ where: { id: login.id }, data: { email: params.email.trim().toLowerCase() } });
          await this.root.user.updateMany({ where: { loginId: login.id, id: { not: userId } }, data: { email: params.email } });
        }
      }
      return mapUser(u);
    } catch {
      return undefined;
    }
  }

  async reissueInvite(userId: string): Promise<string | undefined> {
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!u) return undefined;
    const login = await this.loginOf(userId);
    if (login?.passwordHash) return undefined;
    const invite = newInviteToken();
    await this.prisma.user.update({ where: { id: userId }, data: { inviteTokenHash: invite.hash, inviteExpiresAt: invite.expiresAt } });
    return invite.token;
  }

  async setUserPassword(userId: string, password: string): Promise<void> {
    const login = await this.loginOf(userId);
    if (login) await this.root.login.update({ where: { id: login.id }, data: { passwordHash: bcrypt.hashSync(password, 8) } });
  }

  async deleteUser(id: string): Promise<void> {
    const loginId = (await this.prisma.user.findUnique({ where: { id }, select: { loginId: true } }))?.loginId;
    await this.prisma.$transaction(async (tx) => {
      await tx.teamMember.deleteMany({ where: { userId: id } });
      await tx.note.deleteMany({ where: { authorUserId: id } });
      await tx.conversation.updateMany({ where: { assigneeUserId: id }, data: { assigneeUserId: null } });
      await tx.message.updateMany({ where: { authorUserId: id }, data: { authorUserId: null } });
      await tx.user.delete({ where: { id } });
    });
    // Removed from their last workspace, they no longer sign in as anyone: the
    // Login goes too, so the address starts afresh if it's ever added again.
    if (loginId && !(await this.root.user.count({ where: { loginId } }))) {
      await this.root.login.delete({ where: { id: loginId } }).catch(() => undefined);
    }
  }

  async createSession(userId: string, meta: { ip?: string; userAgent?: string }): Promise<StoredSession> {
    const row = await this.prisma.session.create({
      data: { userId, ip: meta.ip ?? null, userAgent: meta.userAgent ?? null },
    });
    return mapSession(row);
  }

  async getSession(id: string): Promise<StoredSession | undefined> {
    const row = await this.prisma.session.findUnique({ where: { id } });
    return row ? mapSession(row) : undefined;
  }

  async listSessions(userId: string): Promise<StoredSession[]> {
    const rows = await this.prisma.session.findMany({ where: { userId }, orderBy: { lastSeenAt: "desc" } });
    // Active first, then most-recently-seen first.
    return rows
      .map(mapSession)
      .sort((a, b) => (a.revokedAt ? 1 : 0) - (b.revokedAt ? 1 : 0) || b.lastSeenAt.localeCompare(a.lastSeenAt));
  }

  async touchSession(id: string): Promise<void> {
    await this.prisma.session.updateMany({ where: { id, revokedAt: null }, data: { lastSeenAt: new Date() } });
  }

  async revokeSession(userId: string, id: string): Promise<boolean> {
    const res = await this.prisma.session.updateMany({
      where: { id, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    // Signing a device out has to stop its notifications too, or a phone someone
    // deliberately signed out keeps buzzing at them.
    if (res.count > 0) {
      await this.deleteDevicesForSessions([id]);
      return true;
    }
    // It may exist but already be revoked — still "theirs", so report success.
    return (await this.prisma.session.count({ where: { id, userId } })) > 0;
  }

  // Cross-tenant by necessity: one person's sessions in every workspace they're
  // in — what a password change or reset has to end, wherever it was opened.
  async revokeOtherSessions(userId: string, keepId: string): Promise<number> {
    // Only ever starting from the person's place in this workspace.
    if (!(await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } }))) return 0;
    const login = await this.loginOf(userId);
    const userIds = login ? (await this.root.user.findMany({ where: { loginId: login.id }, select: { id: true } })).map((u) => u.id) : [userId];
    const where = { userId: { in: userIds }, id: { not: keepId }, revokedAt: null };
    const doomed = await this.root.session.findMany({ where, select: { id: true } });
    const res = await this.root.session.updateMany({ where, data: { revokedAt: new Date() } });
    if (doomed.length) await this.root.device.deleteMany({ where: { sessionId: { in: doomed.map((s) => s.id) } } });
    return res.count;
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
    // The push token is the row's identity, so a reinstall or a different
    // account on the same handset resolves to one row. A re-registration also
    // proves the token is live, which is why it clears any earlier disable.
    const common = {
      userId: params.userId,
      sessionId: params.sessionId ?? null,
      platform: params.platform,
      appVersion: params.appVersion ?? null,
      osVersion: params.osVersion ?? null,
      deviceName: params.deviceName ?? null,
    };
    // Cross-tenant by necessity: the same handset last signed in to an account
    // in another workspace. The token now belongs to this sign-in, so the old
    // row goes — that account must stop being notified on a phone it is no
    // longer signed in on. Nothing of the other workspace is read.
    const elsewhere = await this.root.device.count({
      where: { pushToken: params.pushToken, user: { orgId: { not: currentOrgId() } } },
    });
    if (elsewhere) await this.root.device.deleteMany({ where: { pushToken: params.pushToken } });
    const row = await this.prisma.device.upsert({
      where: { pushToken: params.pushToken },
      create: { ...common, pushToken: params.pushToken },
      update: { ...common, lastSeenAt: new Date(), disabledAt: null, disabledReason: null },
    });
    return mapDevice(row);
  }

  async listDevices(userId: string): Promise<StoredDevice[]> {
    const rows = await this.prisma.device.findMany({ where: { userId }, orderBy: { lastSeenAt: "desc" } });
    return rows.map(mapDevice);
  }

  async devicesForUsers(userIds: string[]): Promise<StoredDevice[]> {
    if (!userIds.length) return [];
    const rows = await this.prisma.device.findMany({
      where: {
        userId: { in: userIds },
        disabledAt: null,
        // A device registered by a session that has since been revoked must not
        // be pushed to; one with no session (legacy) is left addressable.
        OR: [{ sessionId: null }, { session: { is: { revokedAt: null } } }],
      },
    });
    return rows.map(mapDevice);
  }

  async deleteDevice(userId: string, id: string): Promise<boolean> {
    const res = await this.prisma.device.deleteMany({ where: { id, userId } });
    return res.count > 0;
  }

  async deleteDevicesForSessions(sessionIds: string[]): Promise<number> {
    if (!sessionIds.length) return 0;
    const res = await this.prisma.device.deleteMany({ where: { sessionId: { in: sessionIds } } });
    return res.count;
  }

  // Cross-tenant by necessity: Expo reports a dead token by the token alone.
  async disableDevice(pushToken: string, reason: string): Promise<void> {
    await this.root.device.updateMany({
      where: { pushToken, disabledAt: null },
      data: { disabledAt: new Date(), disabledReason: reason },
    });
  }

  /* ---- customer devices (in-app SDK) ---- */

  async registerCustomerDevice(params: {
    orgId: string;
    contactId: string;
    inboxId: string;
    token: string;
    platform: string;
  }): Promise<StoredCustomerDevice> {
    // The token is the identity, so a handset that reinstalls or signs in as
    // somebody else resolves to one row rather than two addresses for one
    // phone. Presenting it also proves it is live, which lifts any disable.
    const common = {
      orgId: params.orgId,
      contactId: params.contactId,
      inboxId: params.inboxId,
      platform: params.platform,
    };
    const row = await this.prisma.customerDevice.upsert({
      where: { token: params.token },
      create: { ...common, token: params.token },
      update: { ...common, lastSeenAt: new Date(), disabledAt: null, disabledReason: null },
    });
    return mapCustomerDevice(row);
  }

  async customerDevicesFor(contactId: string, inboxId: string): Promise<StoredCustomerDevice[]> {
    const rows = await this.prisma.customerDevice.findMany({
      where: { contactId, inboxId, disabledAt: null },
    });
    return rows.map(mapCustomerDevice);
  }

  async latestCustomerDeviceFor(inboxId: string): Promise<StoredCustomerDevice | null> {
    const row = await this.prisma.customerDevice.findFirst({
      where: { inboxId, disabledAt: null },
      orderBy: { lastSeenAt: "desc" },
    });
    return row ? mapCustomerDevice(row) : null;
  }

  async deleteCustomerDevice(contactId: string, token: string): Promise<boolean> {
    const res = await this.prisma.customerDevice.deleteMany({ where: { token, contactId } });
    return res.count > 0;
  }

  // Cross-tenant by necessity: FCM/Expo report a dead token by the token alone.
  async disableCustomerDevice(token: string, reason: string): Promise<void> {
    await this.root.customerDevice.updateMany({
      where: { token, disabledAt: null },
      data: { disabledAt: new Date(), disabledReason: reason },
    });
  }

  async getPushPrefs(userId: string): Promise<string | undefined> {
    const row = await this.prisma.user.findUnique({ where: { id: userId }, select: { pushPrefs: true } });
    return row?.pushPrefs ?? undefined;
  }

  async setPushPrefs(userId: string, json: string): Promise<void> {
    await this.prisma.user.update({ where: { id: userId }, data: { pushPrefs: json } });
  }

  async getTwoFactor(userId: string): Promise<TwoFactorState | undefined> {
    const u = await this.loginOf(userId);
    if (!u) return undefined;
    return {
      enabled: u.twoFactorEnabled,
      method: u.twoFactorMethod,
      totpSecret: u.totpSecret,
      emailCodeHash: u.twoFactorEmailCodeHash,
      emailCodeExpires: u.twoFactorEmailCodeExpires ? u.twoFactorEmailCodeExpires.toISOString() : null,
    };
  }

  async updateTwoFactor(userId: string, patch: Partial<TwoFactorState>): Promise<void> {
    const login = await this.loginOf(userId);
    if (!login) return;
    const data: Prisma.LoginUpdateInput = {};
    if (patch.enabled !== undefined) data.twoFactorEnabled = patch.enabled;
    if (patch.method !== undefined) data.twoFactorMethod = patch.method;
    if (patch.totpSecret !== undefined) data.totpSecret = patch.totpSecret;
    if (patch.emailCodeHash !== undefined) data.twoFactorEmailCodeHash = patch.emailCodeHash;
    if (patch.emailCodeExpires !== undefined)
      data.twoFactorEmailCodeExpires = patch.emailCodeExpires ? new Date(patch.emailCodeExpires) : null;
    if (!Object.keys(data).length) return;
    await this.root.login.update({ where: { id: login.id }, data });
    // Every workspace's copy of "has a second factor" follows, which is what
    // the guard and the people lists read.
    if (patch.enabled !== undefined || patch.method !== undefined) {
      await this.root.user.updateMany({
        where: { loginId: login.id },
        data: {
          ...(patch.enabled !== undefined ? { twoFactorEnabled: patch.enabled } : {}),
          ...(patch.method !== undefined ? { twoFactorMethod: patch.method } : {}),
        },
      });
    }
  }

  async listRecoveryCodes(userId: string): Promise<{ id: string; codeHash: string; usedAt: string | null }[]> {
    const login = await this.loginOf(userId);
    if (!login) return [];
    const rows = await this.root.recoveryCode.findMany({ where: { loginId: login.id } });
    return rows.map((r) => ({ id: r.id, codeHash: r.codeHash, usedAt: r.usedAt ? r.usedAt.toISOString() : null }));
  }

  async replaceRecoveryCodes(userId: string, codeHashes: string[]): Promise<void> {
    const login = await this.loginOf(userId);
    if (!login) return;
    await this.root.$transaction([
      this.root.recoveryCode.deleteMany({ where: { loginId: login.id } }),
      ...(codeHashes.length
        ? [this.root.recoveryCode.createMany({ data: codeHashes.map((h) => ({ loginId: login.id, codeHash: h })) })]
        : []),
    ]);
  }

  // Only ever called with an id read back by `listRecoveryCodes` for this person.
  async markRecoveryCodeUsed(id: string): Promise<void> {
    await this.root.recoveryCode.updateMany({ where: { id, usedAt: null }, data: { usedAt: new Date() } });
  }

  async teamsForUser(userId: string): Promise<string[]> {
    const rows = await this.prisma.teamMember.findMany({ where: { userId } });
    return rows.map((r) => r.teamId);
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const memberships = await this.prisma.teamMember.findMany({
      where: { userId },
      include: { team: true },
    });
    return {
      user: user ? mapUser(user) : undefined,
      teams: memberships.map((m) => mapTeam(m.team)),
    };
  }

  async setDefaultInbox(inboxId: string, on: boolean): Promise<Inbox | undefined> {
    const target = await this.prisma.inbox.findUnique({ where: { id: inboxId } });
    if (!target) return undefined;
    await this.prisma.$transaction([
      // Clear first, always. The partial unique index refuses a second default
      // of the same type, so setting before clearing would collide with the row
      // being replaced — and clearing when turning off is the whole operation.
      this.prisma.inbox.updateMany({
        where: { orgId: target.orgId, type: target.type, isDefault: true },
        data: { isDefault: false },
      }),
      ...(on
        ? [this.prisma.inbox.update({ where: { id: inboxId }, data: { isDefault: true } })]
        : []),
    ]);
    return this.getInbox(inboxId);
  }

  // Cross-tenant by necessity: see the Store contract — background jobs only.
  async listInboxesAcrossWorkspaces(type: ChannelType): Promise<Inbox[]> {
    const rows = await this.root.inbox.findMany({
      // A frozen workspace's channels are left alone: no polling, no syncing.
      where: { type, org: { status: "active" } },
      include: { teams: true },
      orderBy: [{ orgId: "asc" }, { order: "asc" }, { createdAt: "asc" }],
    });
    return rows.map(mapInbox);
  }

  // Cross-tenant by necessity: asked by policy code (the auth guard, the
  // dispatcher) about a workspace by id, sometimes before one is bound.
  async isSandboxOrg(orgId: string): Promise<boolean> {
    const row = await this.root.organization.findUnique({ where: { id: orgId }, select: { sandbox: true } });
    return row?.sandbox === true;
  }

  // Cross-tenant by necessity: see the Store contract.
  async conversationOrg(conversationId: string): Promise<string | undefined> {
    const row = await this.root.conversation.findUnique({ where: { id: conversationId }, select: { orgId: true } });
    return row?.orgId;
  }

  // Cross-tenant by necessity: see the Store contract.
  async inboxOrg(inboxId: string): Promise<string | undefined> {
    const row = await this.root.inbox.findUnique({ where: { id: inboxId }, select: { orgId: true } });
    return row?.orgId;
  }

  async listInboxes(): Promise<Inbox[]> {
    const rows = await this.prisma.inbox.findMany({
      where: { orgId: currentOrgId() },
      include: { teams: true },
      // Oldest first, and never left to the database's own idea of row order —
      // see the contract on Store.listInboxes. `id` breaks a same-millisecond tie.
      orderBy: [{ order: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    });
    return rows.map(mapInbox);
  }

  async getMembers(teamId: string): Promise<User[]> {
    const rows = await this.prisma.teamMember.findMany({ where: { teamId }, include: { user: true } });
    return rows.map((r) => mapUser(r.user));
  }

  private async mentionToken(userId: string): Promise<string> {
    const u = await this.prisma.user.findUnique({ where: { id: userId } });
    return "@" + (u?.email.split("@")[0].toLowerCase() ?? "");
  }

  /**
   * `forCount` distinguishes the sidebar badge (active work only) from the
   * conversation list (which also carries closed items so the "Closed" filter
   * has something to show). Personal queues (inbound/grabs) stay active-only.
   */
  private buildWhere(
    view: string,
    userId: string,
    userTeams: string[],
    token: string,
    forCount = false,
  ): Prisma.ConversationWhereInput {
    const org = { orgId: currentOrgId() };
    const active: Prisma.ConversationWhereInput = { status: { in: ["open", "pending"] } };
    // Lists carry closed items (for the Closed filter) but never snoozed ones —
    // those live only in "Later". Counts (badges) are active-only.
    const activeOnly: Prisma.ConversationWhereInput = forCount ? active : { status: { not: "snoozed" } };
    const mine: Prisma.ConversationWhereInput = { ...org, ...activeOnly, assigneeUserId: userId };
    const grabs: Prisma.ConversationWhereInput = {
      ...org,
      ...active,
      assigneeUserId: null,
      // routed to one of my teams, or unrouted on a channel that points at them
      OR: [
        { assignedTeamId: { in: userTeams } },
        { assignedTeamId: null, inbox: { teams: { some: { teamId: { in: userTeams } } } } },
      ],
    };
    // Someone else's conversation, in my inbound because of its notes (a note
    // mentioned me, or someone wrote in notes I'm part of) until I answer,
    // dismiss it, or it closes — closing deletes the row.
    const followUps: Prisma.ConversationWhereInput = { ...org, ...activeOnly, noteFollowUps: { some: { userId } } };
    if (view === "mine") return mine;
    if (view === "grabs") return grabs;
    if (view === "inbound") return { OR: [mine, grabs, followUps] };
    if (view === "snoozed") return { ...org, status: "snoozed" };
    if (view === "mentions") {
      // Like every other queue: the badge counts open work only, so a mention
      // in a chat that has since been closed doesn't keep it lit.
      return {
        ...org,
        ...activeOnly,
        messages: { some: { internal: true, body: { contains: token, mode: "insensitive" } } },
      };
    }
    if (view.startsWith("team:")) {
      const teamId = view.slice(5);
      // Routed to this team, or unrouted on a channel that points at it.
      return {
        ...org,
        ...activeOnly,
        OR: [
          { assignedTeamId: teamId },
          { assignedTeamId: null, inbox: { teams: { some: { teamId } } } },
        ],
      };
    }
    if (view.startsWith("inbox:")) return { ...org, ...activeOnly, inboxId: view.slice(6) };
    if (view.startsWith("label:"))
      return { ...org, ...activeOnly, labels: { some: { labelId: view.slice(6) } } };
    return { id: "__none__" };
  }

  async listConversations(
    view: string,
    userId: string,
    opts?: { cursor?: string; limit?: number; field?: { key: string; value?: string }; status?: ListStatus },
  ): Promise<ConversationPage> {
    const userTeams = await this.teamsForUser(userId);
    const token = await this.mentionToken(userId);
    const limit = pageLimit(opts?.limit, CONVERSATIONS_PAGE_SIZE);
    const cur = decodeConvCursor(opts?.cursor);
    const base = this.buildWhere(view, userId, userTeams, token);
    const parts: Prisma.ConversationWhereInput[] = [base];
    if (opts?.status === "active") parts.push({ status: { not: "closed" } });
    if (opts?.status === "closed") parts.push({ status: "closed" });
    if (opts?.field) {
      const { conversationIds, contactIds } = await this.findByCustomField(
        currentOrgId(),
        opts.field.key,
        opts.field.value,
      );
      // ANDed with the view, and with no arm when nothing matched — an empty
      // `OR: []` matches everything in Prisma, which would turn a filter that
      // found nothing into the unfiltered list.
      parts.push(
        conversationIds.length || contactIds.length
          ? {
              OR: [
                ...(conversationIds.length ? [{ id: { in: conversationIds } }] : []),
                ...(contactIds.length ? [{ contactId: { in: contactIds } }] : []),
              ],
            }
          : { id: { in: [] } },
      );
    }
    if (cur) parts.push(keysetBefore(cur));
    const where: Prisma.ConversationWhereInput = parts.length === 1 ? parts[0]! : { AND: parts };
    return this.pageConversations(where, limit);
  }

  async conversationFilterCounts(
    view: string,
    userId: string,
    opts?: { field?: { key: string; value?: string } },
  ): Promise<ConversationFilterCounts> {
    // The list's own scope — the same view and field filter, built the same
    // way — so a chip can never count something its list would not show.
    const parts: Prisma.ConversationWhereInput[] = [
      this.buildWhere(view, userId, await this.teamsForUser(userId), await this.mentionToken(userId)),
    ];
    if (opts?.field) {
      const { conversationIds, contactIds } = await this.findByCustomField(
        currentOrgId(),
        opts.field.key,
        opts.field.value,
      );
      parts.push(
        conversationIds.length || contactIds.length
          ? {
              OR: [
                ...(conversationIds.length ? [{ id: { in: conversationIds } }] : []),
                ...(contactIds.length ? [{ contactId: { in: contactIds } }] : []),
              ],
            }
          : { id: { in: [] } },
      );
    }
    const count = (extra: Prisma.ConversationWhereInput) =>
      this.prisma.conversation.count({ where: { AND: [...parts, extra] } });
    const live: Prisma.ConversationWhereInput = { status: { not: "closed" } };
    const [all, unread, mine, unassigned, groups, closed] = await Promise.all([
      count(live),
      count({ ...live, OR: [{ unread: true }, { unreadCount: { gt: 0 } }] }),
      count({ ...live, assigneeUserId: userId }),
      count({ ...live, assigneeUserId: null }),
      count({ ...live, channel: "whatsapp_group" }),
      count({ status: "closed" }),
    ]);
    return { all, unread, mine, unassigned, groups, closed };
  }

  async searchConversations(
    query: string,
    opts?: { cursor?: string; limit?: number; view?: string; userId?: string },
  ): Promise<ConversationPage> {
    const q = query.trim();
    if (!q) return { items: [], nextCursor: null };
    const limit = pageLimit(opts?.limit, CONVERSATIONS_PAGE_SIZE);
    const cur = decodeConvCursor(opts?.cursor);
    // Scoped to the inbox you're searching from, when one is given — the same
    // `buildWhere` the list uses, so a search inside a view can only return
    // things that view would have shown you.
    const scope =
      opts?.view && opts.userId
        ? this.buildWhere(
            opts.view,
            opts.userId,
            await this.teamsForUser(opts.userId),
            await this.mentionToken(opts.userId),
          )
        : null;
    // Custom fields, both kinds: one recorded on the thread (the order this
    // chat is about) and one recorded on the person (their account number).
    // Resolved to ids first because they live in their own table — which is
    // what makes an order number an index hit rather than a scan, and the
    // reason this is a separate query instead of a join through JSON.
    const [convIds, contactIds] = await Promise.all([
      this.findByCustomFieldValue(currentOrgId(), "conversation", q),
      this.findByCustomFieldValue(currentOrgId(), "contact", q),
    ]);
    const match: Prisma.ConversationWhereInput = {
      orgId: currentOrgId(),
      ...(scope ? { AND: [scope] } : {}),
      OR: [
        { subject: { contains: q, mode: "insensitive" } },
        { preview: { contains: q, mode: "insensitive" } },
        { contact: { displayName: { contains: q, mode: "insensitive" } } },
        { contact: { accountLinks: { some: { account: { name: { contains: q, mode: "insensitive" } } } } } },
        { messages: { some: { body: { contains: q, mode: "insensitive" } } } },
        ...(convIds.length ? [{ id: { in: convIds } }] : []),
        ...(contactIds.length ? [{ contactId: { in: contactIds } }] : []),
      ],
    };
    const where: Prisma.ConversationWhereInput = cur ? { AND: [match, keysetBefore(cur)] } : match;
    return this.pageConversations(where, limit);
  }

  /** Run one keyset page of conversations and derive the next cursor. */
  private async pageConversations(
    where: Prisma.ConversationWhereInput,
    limit: number,
  ): Promise<ConversationPage> {
    const rows = await this.prisma.conversation.findMany({
      where,
      include: convInclude,
      orderBy: [{ lastActivityAt: "desc" }, { id: "desc" }],
      take: limit + 1, // one extra row tells us whether another page exists
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return {
      items: page.map(mapConversation),
      nextCursor: hasMore && last ? encodeConvCursor(last) : null,
    };
  }

  async addNoteFollowUps(
    conversationId: string,
    entries: { userId: string; reason: NoteFollowUp["reason"]; byUserId: string | null }[],
  ): Promise<void> {
    for (const e of entries) {
      const data = { reason: e.reason, byUserId: e.byUserId, createdAt: new Date() };
      await this.prisma.noteFollowUp.upsert({
        where: { conversationId_userId: { conversationId, userId: e.userId } },
        create: { conversationId, userId: e.userId, ...data },
        update: data,
      });
    }
  }

  async clearNoteFollowUps(conversationId: string, userId?: string): Promise<number> {
    const res = await this.prisma.noteFollowUp.deleteMany({ where: { conversationId, ...(userId ? { userId } : {}) } });
    return res.count;
  }

  async noteFollowUpsFor(userId: string, conversationIds: string[]): Promise<Map<string, NoteFollowUp>> {
    if (!conversationIds.length) return new Map();
    const rows = await this.prisma.noteFollowUp.findMany({ where: { userId, conversationId: { in: conversationIds } } });
    return new Map(
      rows.map((r) => [
        r.conversationId,
        { reason: r.reason === "mention" ? "mention" : "reply", byUserId: r.byUserId, since: r.createdAt.toISOString() },
      ]),
    );
  }

  async unreadConversationCount(userId: string): Promise<number> {
    const userTeams = await this.teamsForUser(userId);
    const token = await this.mentionToken(userId);
    return this.prisma.conversation.count({
      where: {
        // AND, not a spread: buildWhere("inbound") is itself `{ OR: [mine,
        // grabs] }`, so spreading it beside a second `OR` would overwrite the
        // visibility scope and count the whole workspace.
        AND: [
          this.buildWhere("inbound", userId, userTeams, token, true),
          // Two shapes count as unread: a real backlog of new messages, and an
          // agent's manual "mark unread", which carries no count. A note
          // follow-up is waiting on me by definition, so it counts too.
          { OR: [{ unread: true }, { unreadCount: { gt: 0 } }, { noteFollowUps: { some: { userId } } }] },
        ],
      },
    });
  }

  async views(userId: string): Promise<SidebarViews> {
    const userTeams = await this.teamsForUser(userId);
    const token = await this.mentionToken(userId);
    // Admins & managers oversee the whole workspace: they see every team and
    // channel in the shared section, regardless of their own team memberships.
    // Personal queues (My Inbound / Mine / Queue) stay membership-scoped for all.
    const me = await this.prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    const elevated = me?.role === "admin" || me?.role === "manager";
    const count = (view: string) =>
      this.prisma.conversation.count({ where: this.buildWhere(view, userId, userTeams, token, true) });
    const dueSnoozed = () =>
      this.prisma.conversation.count({
        where: { orgId: currentOrgId(), status: "snoozed", snoozedUntil: { lte: new Date() } },
      });

    const my: ViewItem[] = [
      { key: "inbound", title: "My Inbound", count: await count("inbound") },
      { key: "mine", title: "Mine", count: await count("mine") },
      { key: "grabs", title: "Queue", count: await count("grabs") },
      { key: "mentions", title: "@ Mentions", count: await count("mentions") },
      { key: "snoozed", title: "Later", count: await count("snoozed"), due: await dueSnoozed() },
    ];

    const teamRows = await this.prisma.team.findMany({
      where: elevated ? { orgId: currentOrgId() } : { id: { in: userTeams } },
      orderBy: [{ order: "asc" }, { name: "asc" }],
    });
    const teams: ViewItem[] = [];
    for (const t of teamRows) {
      teams.push({ key: `team:${t.id}`, title: t.name, count: await count(`team:${t.id}`) });
    }

    const inboxRows = await this.prisma.inbox.findMany({
      where: elevated ? { orgId: currentOrgId() } : { teams: { some: { teamId: { in: userTeams } } } },
      include: { teams: true },
      // This had no ordering at all, which is why the sidebar's channels came
      // back in whatever order the database felt like — and changed between
      // page loads, because an updated row moves within the heap.
      orderBy: [{ order: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    });
    const inboxes: ViewItem[] = [];
    for (const i of inboxRows) {
      let groups: { id: string; title: string }[] | undefined;
      if (i.type === "whatsapp") {
        const gs = await this.prisma.conversation.findMany({
          where: { inboxId: i.id, channel: "whatsapp_group" },
          include: { contact: true },
          orderBy: { lastActivityAt: "desc" },
        });
        if (gs.length) groups = gs.map((g) => ({ id: g.id, title: g.contact.displayName }));
      }
      inboxes.push({
        key: `inbox:${i.id}`,
        title: i.name,
        count: await count(`inbox:${i.id}`),
        channel: i.type as ChannelType,
        handle: i.handle,
        groups,
      });
    }

    const labelRows = await this.prisma.label.findMany({ where: { orgId: currentOrgId() }, orderBy: { name: "asc" } });
    const labels: ViewItem[] = [];
    for (const l of labelRows) {
      const c = await count(`label:${l.id}`);
      if (c > 0) labels.push({ key: `label:${l.id}`, title: l.name, count: c, color: l.color });
    }

    return { my, shared: { teams, inboxes, labels } };
  }

  async getConversation(id: string): Promise<ConversationWithMessages | undefined> {
    const row = await this.prisma.conversation.findUnique({
      where: { id },
      include: {
        ...convInclude,
        participants: { include: { contact: { include: CONTACT_INCLUDE } } },
      },
    });
    if (!row) return undefined;
    // Load only the most-recent page of messages (one extra row reveals whether
    // older history exists) — never the full lifetime thread.
    const latest = await this.prisma.message.findMany({
      where: { conversationId: id },
      include: { attachments: true, emailRecipients: true },
      orderBy: { seq: "desc" },
      take: MESSAGES_PAGE_SIZE + 1,
    });
    const hasMoreMessages = latest.length > MESSAGES_PAGE_SIZE;
    const page = (hasMoreMessages ? latest.slice(0, MESSAGES_PAGE_SIZE) : latest).reverse();
    return {
      ...mapConversation(row),
      messages: page.map(mapMessage),
      hasMoreMessages,
      participants: row.participants.map(mapParticipant),
    };
  }

  async listMessages(
    conversationId: string,
    opts?: { before?: string; limit?: number },
  ): Promise<MessagePage> {
    const limit = pageLimit(opts?.limit, MESSAGES_PAGE_SIZE);
    const beforeSeq = opts?.before != null ? Number(opts.before) : undefined;
    const older = await this.prisma.message.findMany({
      where: {
        conversationId,
        ...(beforeSeq != null && Number.isFinite(beforeSeq) ? { seq: { lt: beforeSeq } } : {}),
      },
      include: { attachments: true, emailRecipients: true },
      orderBy: { seq: "desc" },
      take: limit + 1,
    });
    const hasMore = older.length > limit;
    const page = (hasMore ? older.slice(0, limit) : older).reverse(); // ascending for prepend
    const oldest = page[0];
    return {
      items: page.map(mapMessage),
      nextCursor: hasMore && oldest ? String(oldest.seq) : null,
    };
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
    const conv = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conv) return undefined;
    const seq = conv.seq + 1;
    // Claim staged uploads (attached in the composer, not yet tied to a message).
    const staged = input.attachmentIds?.length
      ? await this.prisma.attachment.findMany({
          where: { id: { in: input.attachmentIds }, messageId: null },
        })
      : [];
    const messageType = staged.length ? messageTypeForKind(staged[0].kind) : "text";
    const preview = input.body || previewForType(messageType);
    // Replying to an unclaimed chat takes ownership of it.
    const assignOnReply = !input.internal && !conv.assigneeUserId && conv.status !== "closed";
    // Replying to a snoozed conversation wakes it back into the active queue.
    const wakeSnooze = !input.internal && conv.status === "snoozed";
    const [message] = await this.prisma.$transaction([
      this.prisma.message.create({
        data: {
          conversationId,
          seq,
          direction: "out",
          authorType: "user",
          authorUserId: author.id,
          authorName: author.name,
          body: input.body,
          bodyHtml: input.bodyHtml ?? null,
          // A real reply starts queued and climbs the delivery ladder as the
          // channel confirms it (queued → sending → sent → delivered → read);
          // notes have no ladder.
          status: input.internal ? "sent" : "queued",
          internal: input.internal,
          messageType,
          channel: input.channel ?? null,
          quotedMsgId: input.quotedMsgId ?? null,
          forwarded: input.forwarded ?? false,
          idempotencyKey: input.idempotencyKey ?? null,
          deliveryMeta: (input.deliveryMeta as Prisma.InputJsonValue) ?? undefined,
          ...(staged.length ? { attachments: { connect: staged.map((a) => ({ id: a.id })) } } : {}),
        },
        include: { attachments: true },
      }),
      this.prisma.conversation.update({
        where: { id: conversationId },
        data: {
          seq,
          unread: false,
          unreadCount: 0,
          // Only a real (non-note) message advances the card's time + list order.
          ...(input.internal ? {} : { lastActivityAt: new Date(), preview }),
          ...(wakeSnooze ? { status: "open" } : {}),
          // A real reply clears any snooze state: un-snoozes a still-snoozed chat
          // (status above) and drops the "Back from Later" marker (a past snooze
          // time the wake sweep left on an active chat) now that the agent replied.
          ...(input.internal ? {} : { snoozedUntil: null }),
          ...(assignOnReply ? { assigneeUserId: author.id } : {}),
        },
      }),
    ]);
    return mapMessage(message);
  }

  async addAutoMessage(
    conversationId: string,
    input: { body: string; auto: MessageAuto; authorName?: string },
  ): Promise<Message | undefined> {
    const conv = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conv) return undefined;
    const seq = conv.seq + 1;
    const [message] = await this.prisma.$transaction([
      this.prisma.message.create({
        data: {
          conversationId,
          seq,
          direction: "out",
          authorType: "user",
          authorName: input.authorName ?? null,
          body: input.body,
          status: "delivered",
          internal: false,
          messageType: "text",
          channel: conv.channel,
          auto: input.auto,
        },
        include: { attachments: true },
      }),
      // Only the sequence moves: unread, preview, time and owner are the
      // customer's message's, which is still the one waiting for a person.
      this.prisma.conversation.update({ where: { id: conversationId }, data: { seq } }),
    ]);
    return mapMessage(message);
  }

  async createUploadAttachment(_orgId: string, input: AttachmentInput): Promise<Attachment> {
    const row = await this.prisma.attachment.create({ data: toAttachmentCreate(input) });
    return mapAttachment(row);
  }

  async getMessagePlace(messageId: string): Promise<{ conversationId: string; internal: boolean } | undefined> {
    const m = await this.prisma.message.findUnique({ where: { id: messageId }, select: { conversationId: true, internal: true } });
    return m ?? undefined;
  }

  async stageAttachmentCopies(messageId: string): Promise<string[]> {
    const source = await this.prisma.attachment.findMany({ where: { messageId } });
    if (!source.length) return [];
    const ids: string[] = [];
    for (const a of source) {
      // messageId stays null so the copy reads as a staged upload and the normal
      // claim step in addMessage picks it up. r2Key is shared with the original —
      // forwarding re-points at the stored object rather than duplicating it.
      const row = await this.prisma.attachment.create({
        data: {
          r2Key: a.r2Key,
          mime: a.mime,
          size: a.size,
          filename: a.filename,
          kind: a.kind,
          durationMs: a.durationMs,
          width: a.width,
          height: a.height,
          waveform: a.waveform,
        },
      });
      ids.push(row.id);
    }
    return ids;
  }

  async assign(
    conversationId: string,
    input: { assigneeUserId?: string | null; assignedTeamId?: string | null },
    byUserId?: string,
  ): Promise<Conversation | undefined> {
    // Assignment must NOT reorder the list or reset the card's time — only real
    // messages do that.
    const data: Prisma.ConversationUpdateInput = {};
    if (input.assigneeUserId !== undefined)
      data.assignee = input.assigneeUserId
        ? { connect: { id: input.assigneeUserId } }
        : { disconnect: true };
    if (input.assignedTeamId !== undefined)
      data.team = input.assignedTeamId ? { connect: { id: input.assignedTeamId } } : { disconnect: true };
    try {
      const row = await this.prisma.conversation.update({
        where: { id: conversationId },
        data,
        include: convInclude,
      });
      await this.prisma.assignmentEvent.create({
        data: {
          conversationId,
          toUserId: input.assigneeUserId ?? null,
          toTeamId: input.assignedTeamId ?? null,
          byUserId: byUserId ?? null,
        },
      });
      return mapConversation(row);
    } catch {
      return undefined;
    }
  }

  async rerouteInboxConversations(inboxId: string): Promise<number> {
    const inbox = await this.prisma.inbox.findUnique({ where: { id: inboxId }, include: { teams: true } });
    if (!inbox) return 0;
    const teamIds = inbox.teams.map((t) => t.teamId);
    const valid = new Set(teamIds);
    const primary = teamIds[0] ?? null;
    const rows = await this.prisma.conversation.findMany({
      where: { inboxId, status: { in: ["open", "pending"] } },
      include: { contact: true },
    });
    let moved = 0;
    for (const c of rows) {
      // Leave chats already sitting on a team the channel still serves.
      if (c.assignedTeamId && valid.has(c.assignedTeamId)) continue;
      const ownerTeam = c.contact.ownerTeamId ?? null;
      const ownerUser = c.contact.ownerUserId ?? null;
      const teamId = ownerTeam ?? primary;
      const userId = ownerUser; // a pinned person keeps the chat; else it queues
      try {
        await this.prisma.conversation.update({
          where: { id: c.id },
          data: {
            team: teamId ? { connect: { id: teamId } } : { disconnect: true },
            assignee: userId ? { connect: { id: userId } } : { disconnect: true },
          },
        });
        moved++;
      } catch {
        // Skip a conversation that fails to update rather than aborting the batch.
      }
    }
    return moved;
  }

  async setStatus(conversationId: string, status: ConversationStatus): Promise<Conversation | undefined> {
    try {
      // Closed is done for everyone: nothing about it waits in anyone's inbound.
      if (status === "closed") await this.prisma.noteFollowUp.deleteMany({ where: { conversationId } });
      const row = await this.prisma.conversation.update({
        where: { id: conversationId },
        data: {
          status,
          ...(status === "closed" ? { unread: false, unreadCount: 0 } : {}),
          ...(status !== "snoozed" ? { snoozedUntil: null } : {}),
        },
        include: convInclude,
      });
      return mapConversation(row);
    } catch {
      return undefined;
    }
  }

  async wakeSnoozed(conversationId: string): Promise<Conversation | undefined> {
    const row = await this.prisma.conversation.findUnique({ where: { id: conversationId }, include: convInclude });
    if (!row) return undefined;
    if (row.status !== "snoozed") return mapConversation(row);
    // Wake into the active queue but KEEP snoozedUntil as the "back from Later"
    // marker (cleared when the agent opens it — see clearUnread).
    const updated = await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { status: "open" },
      include: convInclude,
    });
    return mapConversation(updated);
  }

  // ---- the conversation log ----

  async conversationState(conversationId: string): Promise<ConversationState | undefined> {
    const r = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { status: true, assigneeUserId: true, assignedTeamId: true, priority: true, snoozedUntil: true },
    });
    if (!r) return undefined;
    return {
      status: r.status as ConversationStatus,
      assigneeUserId: r.assigneeUserId,
      assignedTeamId: r.assignedTeamId,
      priority: r.priority as Priority,
      snoozedUntil: r.snoozedUntil ? r.snoozedUntil.toISOString() : null,
    };
  }

  async logConversationEvent(conversationId: string, e: ConversationEventInput): Promise<void> {
    await this.prisma.conversationEvent.create({
      data: {
        conversationId,
        type: e.type,
        actorKind: e.actorKind,
        actorUserId: e.actorUserId ?? null,
        data: (e.data ?? {}) as Prisma.InputJsonValue,
      },
    });
  }

  async listConversationEvents(conversationId: string, limit = 500): Promise<ConversationEventRow[]> {
    const rows = await this.prisma.conversationEvent.findMany({
      where: { conversationId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
    });
    return rows.map((r) => ({
      id: r.id,
      type: r.type as ConversationEventRow["type"],
      actorKind: r.actorKind as ConversationEventRow["actorKind"],
      actorUserId: r.actorUserId,
      data: (r.data as Record<string, unknown>) ?? {},
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async setPriority(conversationId: string, priority: Priority): Promise<Conversation | undefined> {
    try {
      const row = await this.prisma.conversation.update({
        where: { id: conversationId },
        data: { priority },
        include: convInclude,
      });
      return mapConversation(row);
    } catch {
      return undefined;
    }
  }

  async listUnseenNestChatReplies(from: Date, to: Date): Promise<{ conversationId: string; orgId: string }[]> {
    // Root: a platform job looking across workspaces. Each candidate is then
    // handled inside its own workspace, through the scoped client.
    const rows = await this.root.message.findMany({
      where: {
        direction: "out",
        internal: false,
        authorType: { not: "system" },
        status: { in: ["sent", "delivered"] },
        createdAt: { gte: from, lte: to },
        conversation: { channel: "nestchat" },
      },
      select: { seq: true, conversationId: true, conversation: { select: { orgId: true, visitorEmailedSeq: true } } },
      orderBy: { createdAt: "asc" },
      take: 500,
    });
    const out = new Map<string, string>();
    for (const r of rows) {
      if (r.seq > r.conversation.visitorEmailedSeq) out.set(r.conversationId, r.conversation.orgId);
    }
    return [...out].map(([conversationId, orgId]) => ({ conversationId, orgId }));
  }

  async getOrganizationName(orgId: string): Promise<string | undefined> {
    const org = await this.prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } });
    return org?.name ?? undefined;
  }

  async getVisitorEmailedSeq(conversationId: string): Promise<number | undefined> {
    const row = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { visitorEmailedSeq: true },
    });
    return row?.visitorEmailedSeq;
  }

  async claimVisitorEmail(conversationId: string, prev: number, through: number): Promise<boolean> {
    const { count } = await this.prisma.conversation.updateMany({
      where: { id: conversationId, visitorEmailedSeq: prev },
      data: { visitorEmailedSeq: through },
    });
    return count === 1;
  }

  async getSubjectState(conversationId: string): Promise<{ auto: boolean; topic: string | null } | undefined> {
    const row = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { subjectAuto: true, subjectTopic: true },
    });
    return row ? { auto: row.subjectAuto, topic: row.subjectTopic } : undefined;
  }

  async setSubjectTopic(conversationId: string, topic: string | null): Promise<void> {
    await this.prisma.conversation
      .update({ where: { id: conversationId }, data: { subjectTopic: topic } })
      .catch(() => undefined);
  }

  async setSubject(conversationId: string, subject: string | null): Promise<Conversation | undefined> {
    try {
      const row = await this.prisma.conversation.update({
        where: { id: conversationId },
        data: { subject },
        include: convInclude,
      });
      return mapConversation(row);
    } catch {
      return undefined;
    }
  }

  async setInviteLink(conversationId: string, inviteLink: string): Promise<Conversation | undefined> {
    try {
      const row = await this.prisma.conversation.update({
        where: { id: conversationId },
        data: { inviteLink },
        include: convInclude,
      });
      return mapConversation(row);
    } catch {
      return undefined;
    }
  }

  async setConversationInbox(conversationId: string, inboxId: string): Promise<Conversation | undefined> {
    const cur = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { inboxId: true },
    });
    if (!cur || cur.inboxId === inboxId) return undefined; // unknown or already there
    const row = await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { inboxId },
      include: convInclude,
    });
    return mapConversation(row);
  }

  async setConversationChannelRef(
    conversationId: string,
    channelRef: string,
  ): Promise<Conversation | undefined> {
    const cur = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { channelRef: true },
    });
    if (!cur || cur.channelRef === channelRef) return undefined; // unknown or unchanged
    const row = await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { channelRef },
      include: convInclude,
    });
    return mapConversation(row);
  }

  async setSla(conversationId: string, dueAt: string | null): Promise<Conversation | undefined> {
    try {
      const row = await this.prisma.conversation.update({
        where: { id: conversationId },
        data: { slaDueAt: dueAt ? new Date(dueAt) : null },
        include: convInclude,
      });
      return mapConversation(row);
    } catch {
      return undefined;
    }
  }

  async snooze(conversationId: string, until: string): Promise<Conversation | undefined> {
    try {
      const row = await this.prisma.conversation.update({
        where: { id: conversationId },
        data: { status: "snoozed", snoozedUntil: new Date(until), unread: false, unreadCount: 0 },
        include: convInclude,
      });
      return mapConversation(row);
    } catch {
      return undefined;
    }
  }

  // Cross-tenant by necessity: the sweep wakes every workspace's snoozes. The
  // caller handles each conversation inside its own workspace (conv.orgId).
  async listDueSnoozed(): Promise<Conversation[]> {
    const rows = await this.root.conversation.findMany({
      where: { status: "snoozed", snoozedUntil: { lte: new Date() }, org: { status: "active" } },
      include: convInclude,
      orderBy: { snoozedUntil: "asc" },
    });
    return rows.map(mapConversation);
  }

  async createNotification(input: {
    userId: string;
    type: Notification["type"];
    title: string;
    body?: string;
    conversationId?: string | null;
    opsSopId?: string | null;
    chatRoomId?: string | null;
  }): Promise<Notification> {
    const row = await this.prisma.notification.create({
      data: {
        userId: input.userId,
        type: input.type,
        title: input.title,
        body: input.body ?? "",
        conversationId: input.conversationId ?? null,
        opsSopId: input.opsSopId ?? null,
        chatRoomId: input.chatRoomId ?? null,
      },
    });
    return mapNotification(row);
  }

  async listNotifications(userId: string, limit = 50): Promise<Notification[]> {
    const rows = await this.prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows.map(mapNotification);
  }

  async markNotificationsRead(userId: string, ids?: string[]): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { userId, ...(ids ? { id: { in: ids } } : {}) },
      data: { read: true },
    });
  }

  async setMessageChannelId(messageId: string, channelMsgId: string): Promise<void> {
    try {
      await this.prisma.message.update({ where: { id: messageId }, data: { channelMsgId } });
    } catch {
      /* message gone — nothing to reconcile */
    }
  }

  /* ---- durable outbound delivery ---- */

  async getOutboundMessage(messageId: string): Promise<OutboundMessageRef | undefined> {
    const m = await this.prisma.message.findUnique({
      where: { id: messageId },
      select: {
        id: true,
        conversationId: true,
        status: true,
        channelMsgId: true,
        internal: true,
        deliveryMeta: true,
      },
    });
    if (!m) return undefined;
    return {
      messageId: m.id,
      conversationId: m.conversationId,
      status: m.status as MessageStatus,
      channelMsgId: m.channelMsgId ?? undefined,
      internal: m.internal,
      deliveryMeta: (m.deliveryMeta as OutboundDeliveryMeta | null) ?? undefined,
    };
  }

  async setMessageInbox(messageId: string, inboxId: string): Promise<void> {
    // Best-effort: a message that vanished between the attempt and this write
    // is not worth failing a send that already went out.
    await this.prisma.message.update({ where: { id: messageId }, data: { inboxId } }).catch(() => undefined);
  }

  async markMessageSending(messageId: string): Promise<MessageStatusChange | undefined> {
    const msg = await this.prisma.message.findUnique({ where: { id: messageId } });
    if (!msg) return undefined;
    const current = msg.status as MessageStatus;
    // Only a queued message (or one already mid-attempt on a retry) enters "sending".
    if (current !== "queued" && current !== "sending") return undefined;
    const updated = await this.prisma.message.update({
      where: { id: messageId },
      data: { status: "sending", attemptCount: { increment: 1 }, lastAttemptAt: new Date() },
      include: { attachments: true },
    });
    return { conversationId: updated.conversationId, message: mapMessage(updated) };
  }

  async markMessageSent(
    messageId: string,
    channelMsgId?: string,
  ): Promise<MessageStatusChange | undefined> {
    const msg = await this.prisma.message.findUnique({ where: { id: messageId } });
    if (!msg) return undefined;
    const current = msg.status as MessageStatus;
    if (current === "failed") return undefined; // never resurrect a failed message
    const data: Prisma.MessageUpdateInput = {
      providerError: null,
      providerErrorCode: null,
      failureReason: null,
    };
    // Set the channel id once so out-of-order status webhooks can reconcile.
    if (channelMsgId && !msg.channelMsgId) data.channelMsgId = channelMsgId;
    // Advance to "sent" unless a delivered/read webhook already beat us there.
    if (canAdvanceStatus(current, "sent")) data.status = "sent";
    const updated = await this.prisma.message.update({
      where: { id: messageId },
      data,
      include: { attachments: true },
    });
    return { conversationId: updated.conversationId, message: mapMessage(updated) };
  }

  async registerEmailRecipients(
    messageId: string,
    recipients: EmailRecipientInput[],
  ): Promise<void> {
    if (!recipients.length) return;
    await this.prisma.emailRecipient.createMany({
      data: recipients.map((r) => ({ messageId, address: r.address, kind: r.kind, token: r.token })),
      skipDuplicates: true,
    });
  }

  // Cross-tenant by necessity: a tracking pixel carries only its token. The
  // workspace is read off the message it belongs to and returned, so the
  // caller can act in it.
  async recordEmailOpen(token: string): Promise<MessageStatusChange | undefined> {
    const rcpt = await this.root.emailRecipient.findUnique({ where: { token } });
    if (!rcpt) return undefined;
    // A hit within the grace window of sending is a proxy pre-cache (e.g. Gmail's
    // GoogleImageProxy), not a human read — bump the count but don't call it seen.
    const withinGrace = Date.now() - rcpt.createdAt.getTime() < EMAIL_OPEN_GRACE_MS;
    const firstOpen = rcpt.openedAt == null;
    await this.root.emailRecipient.update({
      where: { token },
      data: {
        openCount: { increment: 1 },
        ...(firstOpen && !withinGrace ? { openedAt: new Date() } : {}),
      },
    });
    // Re-opens (Gmail proxy re-fetches, etc.) and early pre-caches don't broadcast.
    if (!firstOpen || withinGrace) return undefined;
    const message = await this.root.message.findUnique({
      where: { id: rcpt.messageId },
      include: { attachments: true, emailRecipients: true, conversation: { select: { orgId: true } } },
    });
    if (!message) return undefined;
    return { conversationId: message.conversationId, message: mapMessage(message), orgId: message.conversation.orgId };
  }

  async recordSendFailure(
    messageId: string,
    info: { error?: string; code?: string; permanent: boolean; reason?: string },
  ): Promise<MessageStatusChange | undefined> {
    const msg = await this.prisma.message.findUnique({ where: { id: messageId } });
    if (!msg) return undefined;
    const current = msg.status as MessageStatus;
    const data: Prisma.MessageUpdateInput = {
      providerError: info.error ? info.error.slice(0, 500) : null,
      providerErrorCode: info.code ?? null,
    };
    // A permanent failure flips the message to failed — but only if the ladder
    // allows it (a delivered/read message stays; we just keep the diagnostics).
    if (info.permanent && canAdvanceStatus(current, "failed")) {
      data.status = "failed";
      data.failureReason = info.reason ?? "Message could not be delivered";
    }
    const updated = await this.prisma.message.update({
      where: { id: messageId },
      data,
      include: { attachments: true },
    });
    return { conversationId: updated.conversationId, message: mapMessage(updated) };
  }

  // Cross-tenant by necessity: the recovery sweep covers every workspace. Each
  // row carries its org so the retry runs inside it.
  async listStuckOutbound(
    olderThanMs: number,
  ): Promise<Array<{ messageId: string; conversationId: string; orgId: string; idempotencyKey?: string }>> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const rows = await this.root.message.findMany({
      where: {
        direction: "out",
        internal: false,
        status: { in: ["queued", "sending"] },
        OR: [{ lastAttemptAt: null }, { lastAttemptAt: { lte: cutoff } }],
      },
      select: { id: true, conversationId: true, idempotencyKey: true, conversation: { select: { orgId: true } } },
      orderBy: { createdAt: "asc" },
      take: 500,
    });
    return rows.map((r) => ({
      messageId: r.id,
      conversationId: r.conversationId,
      orgId: r.conversation.orgId,
      idempotencyKey: r.idempotencyKey ?? undefined,
    }));
  }

  async resetMessageForRetry(
    messageId: string,
    idempotencyKey: string,
  ): Promise<MessageStatusChange | undefined> {
    const msg = await this.prisma.message.findUnique({ where: { id: messageId } });
    if (!msg) return undefined;
    // Only a failed outbound message may be manually retried.
    if (msg.direction !== "out" || msg.internal || (msg.status as MessageStatus) !== "failed") {
      return undefined;
    }
    const updated = await this.prisma.message.update({
      where: { id: messageId },
      data: {
        status: "queued",
        failureReason: null,
        providerError: null,
        providerErrorCode: null,
        idempotencyKey,
      },
      include: { attachments: true },
    });
    return { conversationId: updated.conversationId, message: mapMessage(updated) };
  }

  /* ---- ingestion ---- */

  /*
   * Which inbox an incoming event is addressed to.
   *
   * Cross-tenant by necessity — this is how a webhook learns which workspace it
   * is for — and so each is strict about ambiguity: a key that matches inboxes
   * in two workspaces matches neither, because delivering a customer's message
   * to the wrong business is worse than not delivering it. Connecting a channel
   * refuses a key another workspace already holds (see `channelKeyTaken`), so
   * ambiguity should never arise; this is the backstop.
   */

  // Only an active workspace's channels take anything in: to a suspended,
  // archived or deleting one, an inbound message is for no channel we know.

  async getInboxByWhatsAppPhoneId(phoneNumberId: string): Promise<Inbox | undefined> {
    const rows = await this.root.inbox.findMany({
      where: { type: { in: ["whatsapp", "whatsapp_group"] }, org: { status: "active" } },
      include: { teams: true },
    });
    // Deterministic: the inbox whose configured number matches this one.
    const byConfig = rows.filter(
      (i) => (i.channelConfig as { phoneNumberId?: string } | null)?.phoneNumberId === phoneNumberId,
    );
    if (byConfig.length === 1) return mapInbox(byConfig[0]);
    if (byConfig.length > 1) {
      // Two workspaces holding one number is refused at connect time, and stays
      // a non-match here: a customer's message must not reach the wrong business.
      if (new Set(byConfig.map((i) => i.orgId)).size > 1) return undefined;
      // Two channels in the *same* workspace on one number (connected twice) is
      // still that workspace's message. Dropping it, as this once did, lost every
      // inbound message to the number without a trace in the inbox. The first
      // channel connected keeps receiving; adding a duplicate is now refused.
      const first = [...byConfig].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0]!;
      return mapInbox(first);
    }
    // Single-number env fallback: the deployment-wide number maps to the one
    // WhatsApp inbox that has no per-inbox number of its own — and only in the
    // platform's own workspace, whose number the environment describes. Another
    // workspace's unconfigured inbox is never a match for it.
    if (env.whatsapp.phoneNumberId && env.whatsapp.phoneNumberId === phoneNumberId) {
      const envInbox = rows.filter(
        (i) => i.orgId === PLATFORM_ORG_ID && !(i.channelConfig as { phoneNumberId?: string } | null)?.phoneNumberId,
      );
      if (envInbox.length) return mapInbox(envInbox[0]);
    }
    return undefined; // no deterministic match — caller records a diagnostic
  }

  async getInboxesByWabaId(wabaId: string): Promise<Inbox[]> {
    if (!wabaId) return [];
    const rows = await this.root.inbox.findMany({
      where: { type: { in: ["whatsapp", "whatsapp_group"] }, org: { status: "active" } },
      include: { teams: true },
    });
    return rows.filter((i) => (i.channelConfig as { wabaId?: string } | null)?.wabaId === wabaId).map(mapInbox);
  }

  async getInboxByWidgetKey(widgetKey: string): Promise<Inbox | undefined> {
    const key = widgetKey.trim();
    if (!key) return undefined;
    // Matched in code rather than in the query: the key lives inside the
    // channelConfig JSON, and there are a handful of channels in an org — a JSON
    // path index would be machinery for a list that fits on a screen.
    const rows = await this.root.inbox.findMany({
      where: { type: "nestchat", org: { status: "active" } },
      include: { teams: true },
    });
    return unambiguous(rows.filter((i) => (i.channelConfig as Record<string, string> | null)?.widgetKey === key));
  }

  async getInboxByAppKey(appKey: string): Promise<Inbox | undefined> {
    const key = appKey.trim();
    if (!key) return undefined;
    // Same shape as the widget key above, and matched in code for the same
    // reason: a handful of channels per org, and the key lives inside the
    // channelConfig JSON.
    const rows = await this.root.inbox.findMany({
      where: { type: "nestchat", org: { status: "active" } },
      include: { teams: true },
    });
    return unambiguous(rows.filter((i) => (i.channelConfig as Record<string, string> | null)?.appKey === key));
  }

  async getInboxByEmailAddress(address: string): Promise<Inbox | undefined> {
    const rows = await this.root.inbox.findMany({
      where: { type: "email", org: { status: "active" } },
      include: { teams: true },
    });
    const a = address.trim().toLowerCase();
    // Deterministic match on the inbox address only — never fall back to an
    // arbitrary inbox for mail addressed to an account we don't manage.
    return unambiguous(rows.filter((i) => i.handle.toLowerCase() === a));
  }

  // Cross-tenant by necessity: whether another workspace already receives on
  // this channel key, checked before a channel is connected.
  async channelKeyTaken(
    key: { phoneNumberId?: string; emailAddress?: string },
    exceptInboxId?: string,
  ): Promise<boolean> {
    const orgId = currentOrgId();
    if (key.phoneNumberId) {
      const rows = await this.root.inbox.findMany({
        where: { type: { in: ["whatsapp", "whatsapp_group"] }, NOT: { orgId } },
        select: { id: true, channelConfig: true },
      });
      if (
        rows.some(
          (i) =>
            i.id !== exceptInboxId &&
            (i.channelConfig as { phoneNumberId?: string } | null)?.phoneNumberId === key.phoneNumberId,
        )
      )
        return true;
    }
    if (key.emailAddress) {
      const n = await this.root.inbox.count({
        where: {
          type: "email",
          NOT: { orgId },
          handle: { equals: key.emailAddress.trim(), mode: "insensitive" },
          ...(exceptInboxId ? { id: { not: exceptInboxId } } : {}),
        },
      });
      if (n > 0) return true;
    }
    return false;
  }

  // Cross-tenant by necessity: most diagnostics are about an event no workspace
  // could be found for. Those are kept against no workspace (orgId null) and
  // shown only to the platform's operators; one about a known inbox is kept
  // against that inbox's workspace.
  async recordWebhookDiagnostic(input: {
    channel: string;
    kind: string;
    reference?: string;
    detail?: string;
    orgId?: string;
  }): Promise<void> {
    await this.root.webhookDiagnostic.create({
      data: {
        orgId: input.orgId ?? null,
        channel: input.channel,
        kind: input.kind,
        reference: input.reference ?? null,
        detail: input.detail ?? null,
      },
    });
  }

  async listWebhookDiagnostics(limit = 100): Promise<WebhookDiagnostic[]> {
    const orgId = currentOrgId();
    // A workspace sees its own; the platform's operators also see the ones no
    // workspace could be matched to, which is where a misrouted channel shows up.
    const rows = await this.root.webhookDiagnostic.findMany({
      where: orgId === PLATFORM_ORG_ID ? { OR: [{ orgId }, { orgId: null }] } : { orgId },
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(limit, 1), 500),
    });
    return rows.map((r) => ({
      id: r.id,
      channel: r.channel,
      kind: r.kind,
      reference: r.reference ?? undefined,
      detail: r.detail ?? undefined,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async findConversationByMessageChannelIds(
    channelMsgIds: string[],
    opts: { contactIds?: string[] } = {},
  ): Promise<string | undefined> {
    if (!channelMsgIds.length) return undefined;
    const msg = await this.prisma.message.findFirst({
      where: {
        channelMsgId: { in: channelMsgIds },
        ...(opts.contactIds?.length
          ? { conversation: { is: { contactId: { in: opts.contactIds } } } }
          : {}),
      },
      orderBy: { createdAt: "desc" },
    });
    return msg?.conversationId;
  }

  async upsertContactByIdentity(params: {
    orgId: string;
    kind: ContactIdentityKind;
    value: string;
    displayName: string;
    company?: string;
    avatarColor?: string;
  }): Promise<Contact> {
    // A phone number can arrive as either `phone` or `wa_id` — match across both
    // so we don't fork one customer into two contacts (mirrors setIdentity).
    // phone and wa_id are the same number in two notations, so they match each
    // other; everything else matches only itself.
    //
    // Listed as "which kinds pair up" rather than "which are on their own",
    // because the previous spelling made *self-matching* the special case and
    // the pair the default. `external` was added for the in-app SDK and fell
    // into the default, so a signed-in app user was looked up among phone
    // numbers: never found, re-created on every login, and from the second one
    // onwards a unique-constraint violation that surfaced as a 500 on the
    // session endpoint. Anonymous sessions were unaffected — `nestchat` was in
    // the list — which is why this only appeared the day an app started
    // signing its users.
    const PAIRED = ["phone", "wa_id"];
    const matchKinds = PAIRED.includes(params.kind) ? PAIRED : [params.kind];
    // Match on the CANONICAL value (scoped to the org): "+44 7911…", "07911…"
    // and WhatsApp's "447911…" all resolve to one contact.
    const normalized = normalizeIdentity(params.kind, params.value)?.normalized ?? params.value;
    const idents = await this.prisma.contactIdentity.findMany({
      where: { orgId: params.orgId, kind: { in: matchKinds }, normalizedValue: normalized },
      include: { contact: { include: CONTACT_INCLUDE } },
    });
    if (idents.length) {
      const byId = new Map<string, (typeof idents)[number]["contact"]>();
      for (const i of idents) if (!byId.has(i.contactId)) byId.set(i.contactId, i.contact);
      const contacts = [...byId.values()];
      let found: Contact;
      if (contacts.length > 1) {
        // Auto-merge: several contacts share this messaging identity. An inbound
        // from it proves they're the same customer, so consolidate (oldest wins).
        const winner = contacts.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b));
        found = await this.mergeContacts({ winnerId: winner.id, loserIds: contacts.filter((c) => c.id !== winner.id).map((c) => c.id) });
      } else {
        found = mapContact(contacts[0]);
      }
      // Matched on their phone number, but this came from WhatsApp: keep the
      // WhatsApp id too. It's what says the number is on WhatsApp
      // (`Contact.onWhatsApp`), and a customer first added by hand, or met by
      // text, would otherwise never get it however often they wrote there.
      if (params.kind === "wa_id" && !found.onWhatsApp) {
        await this.prisma.contactIdentity
          .create({ data: { contactId: found.id, orgId: params.orgId, kind: "wa_id", value: params.value, normalizedValue: normalized } })
          // Another delivery of the same message got there first.
          .catch((err) => {
            if (err instanceof TenantViolationError) throw err;
          });
        found = { ...found, onWhatsApp: true };
      }
      return found;
    }

    try {
      const contact = await this.prisma.contact.create({
        data: {
          orgId: params.orgId,
          displayName: params.displayName,
          company: params.company,
          avatarColor: params.avatarColor,
          identities: {
            create: [{ orgId: params.orgId, kind: params.kind, value: params.value, normalizedValue: normalized }],
          },
        },
        include: CONTACT_INCLUDE,
      });
      return mapContact(contact);
    } catch (err) {
      // A write for another workspace is refused, not retried as a race.
      if (err instanceof TenantViolationError) throw err;
      // Concurrent webhook raced us to the same identity (per-workspace
      // [orgId,kind,value] unique) — re-fetch and return the contact that won.
      const raced = await this.prisma.contactIdentity.findFirst({
        where: { orgId: params.orgId, kind: { in: matchKinds }, normalizedValue: normalized },
        include: { contact: { include: CONTACT_INCLUDE } },
      });
      if (raced) return mapContact(raced.contact);
      // One more look, on the exact row the unique index is over. The lookup
      // above searches `matchKinds` and a normalized value; if those disagree
      // with what is actually stored — which is the mistake that caused this —
      // the re-fetch misses and a working contact is reported as a failure.
      const exact = await this.prisma.contactIdentity.findFirst({
        where: { kind: params.kind, value: params.value },
        include: { contact: { include: CONTACT_INCLUDE } },
      });
      if (exact) return mapContact(exact.contact);
      // The original cause, not a sentence replacing it. Swallowing it is what
      // turned a one-line constraint violation into an afternoon.
      throw new Error(`Failed to create or resolve contact identity: ${String(err)}`);
    }
  }

  async findRecentOutreach(params: {
    orgId: string;
    inboxId: string;
    contactId: string;
    since: string;
  }): Promise<{ userId: string; teamId: string | null } | undefined> {
    // The latest conversation with anything in it — the one being created for
    // this reply has nothing yet, so it's never the one found.
    const last = await this.prisma.conversation.findFirst({
      where: { orgId: params.orgId, inboxId: params.inboxId, contactId: params.contactId, messages: { some: {} } },
      orderBy: { lastActivityAt: "desc" },
      select: { id: true, assigneeUserId: true, assignedTeamId: true, lastActivityAt: true },
    });
    if (!last?.assigneeUserId || last.lastActivityAt < new Date(params.since)) return undefined;
    const [theirs, ours] = await Promise.all([
      this.prisma.message.count({ where: { conversationId: last.id, direction: "in" } }),
      this.prisma.message.count({ where: { conversationId: last.id, direction: "out", internal: false } }),
    ]);
    return theirs === 0 && ours > 0 ? { userId: last.assigneeUserId, teamId: last.assignedTeamId } : undefined;
  }

  async findCrossChannelReplyThread(params: { orgId: string; inboxId: string; contactId: string }): Promise<string | undefined> {
    const sent = await this.prisma.message.findFirst({
      where: {
        direction: "out",
        internal: false,
        channel: { in: ["whatsapp"] },
        inboxId: params.inboxId,
        conversation: {
          orgId: params.orgId,
          contactId: params.contactId,
          inboxId: { not: params.inboxId },
          status: { in: [...THREADABLE_STATUSES] },
        },
      },
      orderBy: { createdAt: "desc" },
      select: { conversationId: true, createdAt: true },
    });
    if (!sent) return undefined;
    const ownNewer = await this.prisma.conversation.findFirst({
      where: {
        orgId: params.orgId,
        contactId: params.contactId,
        inboxId: params.inboxId,
        status: { in: [...THREADABLE_STATUSES] },
        lastActivityAt: { gt: sent.createdAt },
      },
      select: { id: true },
    });
    return ownNewer ? undefined : sent.conversationId;
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
    // One open conversation per contact PER INBOX (channel endpoint): an inbound
    // to this inbox threads into the customer's open thread here; a different inbox
    // — another number, email address, or channel — is a separate conversation,
    // and a closed thread starts a new one. (Agents still reply cross-channel
    // inside a thread via the send path; this governs inbound + reach.)
    //
    // Email adds a second condition: the subject has to match. A mailbox thread
    // is a topic, not a person, so a customer writing about something new gets a
    // new conversation rather than having it filed under whatever they last
    // wrote about. See email-threading.ts — and note this only decides what
    // happens when the mail carried no usable References chain, which the ingest
    // path has already tried.
    //
    // Matched in JS rather than SQL because the comparison strips "Re:"/"Fwd:"
    // and folds case, which no index can express — and because the alternative
    // is two implementations of the same rule drifting apart from each other.
    // The candidate set is a single contact's open threads in one inbox, so it
    // is a handful of rows; the take() is a bound, not a page.
    const candidates = params.forceNew ? [] : await this.prisma.conversation.findMany({
      // Snoozed included: a customer writing back is exactly the event that
      // should end a snooze, and `appendInboundMessage` below already wakes the
      // conversation it lands on. Leaving it out of this WHERE made that branch
      // unreachable and opened a second thread with the same customer instead.
      where: {
        orgId: params.orgId,
        inboxId: params.inboxId,
        contactId: params.contact.id,
        status: { in: [...THREADABLE_STATUSES] },
        ...(params.startedBy !== undefined ? { channelRef: params.startedBy } : {}),
      },
      include: convInclude,
      orderBy: { lastActivityAt: "desc" },
      take: 25,
    });
    const open = candidates.find((c) => threadsTogether(params.channel, params.subject, c.subject));
    if (open) return { conversation: mapConversation(open), created: false };

    const created = await this.prisma.conversation.create({
      data: {
        orgId: params.orgId,
        inboxId: params.inboxId,
        contactId: params.contact.id,
        channel: params.channel,
        subject: params.subject,
        status: "open",
        assigneeUserId: params.assigneeUserId ?? null,
        assignedTeamId: params.assignedTeamId ?? null,
        priority: "normal",
        unread: true,
        seq: 0,
        preview: "",
        ...(params.startedBy !== undefined ? { channelRef: params.startedBy } : {}),
        ...(params.autoSubject ? { subjectAuto: true, subjectTopic: params.subject ?? null } : {}),
      },
      include: convInclude,
    });
    return { conversation: mapConversation(created), created: true };
  }

  async appendInboundMessage(
    conversationId: string,
    input: AppendInboundInput,
  ): Promise<Message | undefined> {
    const conv = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conv) return undefined;
    const seq = conv.seq + 1;
    // A new customer message on a closed or snoozed chat wakes it back up.
    const wasClosed = conv.status === "closed";
    const reopen = wasClosed || conv.status === "snoozed";
    const [message] = await this.prisma.$transaction([
      this.prisma.message.create({
        data: {
          conversationId,
          seq,
          direction: "in",
          authorType: "contact",
          authorName: input.authorName,
          body: input.body,
          bodyHtml: input.bodyHtml ?? null,
          status: "delivered",
          channelMsgId: input.channelMsgId,
          channel: input.channel ?? null,
          messageType: input.messageType ?? "text",
          quotedMsgId: input.quotedMsgId ?? null,
          forwarded: input.forwarded ?? false,
          ...(input.emailVia ? { deliveryMeta: { via: input.emailVia } } : {}),
          ...(input.attachments?.length
            ? { attachments: { create: input.attachments.map(toAttachmentCreate) } }
            : {}),
        },
        include: { attachments: true },
      }),
      this.prisma.conversation.update({
        where: { id: conversationId },
        data: {
          seq,
          lastActivityAt: new Date(),
          // Only a WhatsApp inbound (re)opens the WhatsApp 24-hour window — an
          // email arriving in a cross-channel thread must not extend it.
          ...(isWaChannel(input.channel ?? (conv.channel as ChannelType))
            ? { lastInboundAt: new Date() }
            : {}),
          unread: true,
          unreadCount: { increment: 1 },
          preview: previewFromBody(input.body) || previewForType(input.messageType),
          ...(reopen ? { status: "open", snoozedUntil: null, ...(wasClosed ? { assigneeUserId: null } : {}) } : {}),
        },
      }),
    ]);
    return mapMessage(message);
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
    const conv = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conv) return undefined;
    const seq = conv.seq + 1;
    const channel = input.channel ?? "email";
    const [message] = await this.prisma.$transaction([
      this.prisma.message.create({
        data: {
          conversationId,
          seq,
          direction: "out",
          authorType: "system",
          authorName: input.authorName ?? (channel === "email" ? "Gmail" : "WhatsApp Business app"),
          body: input.body,
          bodyHtml: input.bodyHtml ?? null,
          status: "sent",
          channelMsgId: input.channelMsgId,
          channel,
          messageType: input.messageType ?? "text",
          ...(input.attachments?.length
            ? { attachments: { create: input.attachments.map(toAttachmentCreate) } }
            : {}),
        },
        include: { attachments: true },
      }),
      this.prisma.conversation.update({
        where: { id: conversationId },
        data: {
          seq,
          lastActivityAt: new Date(),
          preview: previewFromBody(input.body) || (channel === "email" ? "Email" : "Message"),
          ...(input.markRead ? { unread: false, unreadCount: 0 } : {}),
          // A reply sent straight from Gmail is still a reply → clear the "Back
          // from Later" marker, same as an in-app reply. A still-snoozed chat's
          // future timer is left untouched.
          ...(conv.status !== "snoozed" && conv.snoozedUntil ? { snoozedUntil: null } : {}),
        },
      }),
    ]);
    return mapMessage(message);
  }

  async countEmailConversations(): Promise<number> {
    return this.prisma.conversation.count({ where: { channel: "email" } });
  }

  async deleteEmailConversations(): Promise<number> {
    let deleted = 0;
    // In batches: a workspace can hold thousands, and one statement with tens
    // of thousands of bound ids is past what Postgres will take.
    for (;;) {
      const batch = await this.prisma.conversation.findMany({
        where: { channel: "email" },
        select: { id: true },
        take: 200,
      });
      if (!batch.length) return deleted;
      const convIds = batch.map((c) => c.id);
      await this.prisma.$transaction(async (tx) => {
        const msgs = await tx.message.findMany({ where: { conversationId: { in: convIds } }, select: { id: true } });
        const msgIds = msgs.map((m) => m.id);
        // By message id on the unscoped client: these are this workspace's own
        // messages (just read through the scoped one), and an attachment stored
        // before attachments carried an orgId is invisible to the scoped client
        // yet still holds its message in place.
        if (msgIds.length) await this.root.attachment.deleteMany({ where: { messageId: { in: msgIds } } });
        await tx.message.deleteMany({ where: { conversationId: { in: convIds } } });
        await tx.note.deleteMany({ where: { conversationId: { in: convIds } } });
        await tx.conversationLabel.deleteMany({ where: { conversationId: { in: convIds } } });
        await tx.assignmentEvent.deleteMany({ where: { conversationId: { in: convIds } } });
        await tx.participant.deleteMany({ where: { conversationId: { in: convIds } } });
        await tx.notification.deleteMany({ where: { conversationId: { in: convIds } } });
        await tx.conversation.deleteMany({ where: { id: { in: convIds } } });
      });
      deleted += convIds.length;
    }
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
    // One history conversation per customer per number, found by its marker.
    const ref = `wa-history:${input.inboxId}`;
    let conv = await this.prisma.conversation.findFirst({
      where: { orgId: input.orgId, inboxId: input.inboxId, contactId: input.contactId, channelRef: ref },
    });
    const sorted = [...input.messages].sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
    if (!conv) {
      conv = await this.prisma.conversation.create({
        data: {
          orgId: input.orgId,
          inboxId: input.inboxId,
          contactId: input.contactId,
          channel: "whatsapp",
          channelRef: ref,
          // Past chats, already dealt with on the phone: closed and read, so
          // nothing lands in anyone's queue, timer or badge.
          status: "closed",
          priority: "normal",
          unread: false,
          unreadCount: 0,
          seq: 0,
          preview: "",
          lastActivityAt: sorted.at(-1)?.sentAt ?? new Date(),
          createdAt: sorted[0]?.sentAt ?? new Date(),
        },
      });
    }
    // Skip anything already stored — a batch sent twice, or a message that
    // also came in live.
    const ids = sorted.map((m) => m.channelMsgId);
    const have = new Set(
      (
        await this.prisma.message.findMany({
          where: { channelMsgId: { in: ids }, conversation: { orgId: input.orgId } },
          select: { channelMsgId: true },
        })
      ).map((r) => r.channelMsgId),
    );
    const fresh = sorted.filter((m, i) => !have.has(m.channelMsgId) && ids.indexOf(m.channelMsgId) === i);
    for (const m of fresh) {
      await this.prisma.message.create({
        data: {
          conversationId: conv.id,
          seq: 0,
          direction: m.direction,
          authorType: m.direction === "in" ? "contact" : "system",
          authorName: m.authorName,
          body: m.body,
          status: m.direction === "in" ? "delivered" : "sent",
          channelMsgId: m.channelMsgId,
          channel: "whatsapp",
          messageType: m.messageType ?? "text",
          createdAt: m.sentAt,
          ...(m.attachments?.length ? { attachments: { create: m.attachments.map(toAttachmentCreate) } } : {}),
        },
      });
    }
    // Back into date order: Meta sends the newest history first.
    const all = await this.prisma.message.findMany({
      where: { conversationId: conv.id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, seq: true, body: true, createdAt: true },
    });
    for (const [i, m] of all.entries()) {
      if (m.seq !== i + 1) await this.prisma.message.update({ where: { id: m.id }, data: { seq: i + 1 } });
    }
    const first = all[0];
    const last = all.at(-1);
    await this.prisma.conversation.update({
      where: { id: conv.id },
      data: {
        seq: all.length,
        preview: last ? previewFromBody(last.body) || "Message" : "",
        ...(last ? { lastActivityAt: last.createdAt } : {}),
        ...(first ? { createdAt: first.createdAt } : {}),
      },
    });
    return { conversationId: conv.id, added: fresh.length };
  }

  async importEmailThread(input: ImportEmailThreadInput): Promise<string> {
    const msgs = input.messages;
    const last = msgs[msgs.length - 1];
    const lastOut = msgs.reduce((n, m, i) => (m.direction === "out" ? i : n), -1);
    const conv = await this.prisma.conversation.create({
      data: {
        orgId: input.orgId,
        inboxId: input.inboxId,
        contactId: input.contactId,
        channel: "email",
        subject: input.subject,
        channelRef: input.channelRef ?? null,
        status: "open",
        assigneeUserId: input.assigneeUserId ?? null,
        assignedTeamId: input.assignedTeamId ?? null,
        priority: "normal",
        unread: true,
        // What the customer has written since we last did.
        unreadCount: msgs.slice(lastOut + 1).filter((m) => m.direction === "in").length,
        seq: msgs.length,
        preview: last ? previewFromBody(last.body) || "Email" : "",
        lastActivityAt: last?.sentAt ?? new Date(),
        createdAt: msgs[0]?.sentAt ?? new Date(),
      },
    });
    for (const [i, m] of msgs.entries()) {
      await this.prisma.message.create({
        data: {
          conversationId: conv.id,
          seq: i + 1,
          direction: m.direction,
          // A reply from the mailbox is recorded the way a reply sent straight
          // from Gmail is: by name, not as a Nest user.
          authorType: m.direction === "in" ? "contact" : "system",
          authorName: m.authorName,
          body: m.body,
          bodyHtml: m.bodyHtml ?? null,
          status: m.direction === "in" ? "delivered" : "sent",
          channelMsgId: m.channelMsgId,
          channel: "email",
          messageType: "text",
          createdAt: m.sentAt,
          ...(m.attachments?.length ? { attachments: { create: m.attachments.map(toAttachmentCreate) } } : {}),
        },
      });
    }
    return conv.id;
  }

  async getAttachment(id: string): Promise<StoredAttachmentRef | undefined> {
    const a = await this.prisma.attachment.findUnique({ where: { id } });
    return a ? { storageKey: a.r2Key, mime: a.mime, filename: a.filename } : undefined;
  }

  async getAttachmentTranscript(id: string): Promise<string | undefined> {
    const a = await this.prisma.attachment.findUnique({ where: { id }, select: { transcript: true } });
    return a?.transcript ?? undefined;
  }

  async getAttachmentTranscripts(ids: string[]): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    const rows = await this.prisma.attachment.findMany({
      where: { id: { in: [...new Set(ids)] }, transcript: { not: null } },
      select: { id: true, transcript: true },
    });
    return new Map(rows.map((r) => [r.id, r.transcript ?? ""]));
  }

  async setAttachmentTranscript(id: string, transcript: string): Promise<void> {
    await this.prisma.attachment.updateMany({ where: { id }, data: { transcript } });
  }

  async getAttachmentAccess(
    id: string,
  ): Promise<{ storageKey: string; mime: string; filename: string; orgId?: string } | undefined> {
    const a = await this.prisma.attachment.findUnique({
      where: { id },
      select: {
        r2Key: true,
        mime: true,
        filename: true,
        message: { select: { conversation: { select: { orgId: true } } } },
      },
    });
    if (!a) return undefined;
    return {
      storageKey: a.r2Key,
      mime: a.mime,
      filename: a.filename,
      orgId: a.message?.conversation.orgId,
    };
  }

  async markOutboundStatusUpTo(
    conversationId: string,
    throughMessageId: string,
    status: MessageStatus,
  ): Promise<MessageStatusChange[]> {
    const through = await this.prisma.message.findFirst({
      where: { id: throughMessageId, conversationId },
      select: { seq: true },
    });
    if (!through) return [];
    // Outbound, not a note, at or before the acknowledged message. The ladder
    // is checked per row rather than in the query so a late ack can't drag a
    // read message back to delivered.
    const candidates = await this.prisma.message.findMany({
      where: {
        conversationId,
        direction: "out",
        internal: false,
        seq: { lte: through.seq },
      },
      include: { attachments: true },
      orderBy: { seq: "asc" },
    });
    const changed: MessageStatusChange[] = [];
    for (const row of candidates) {
      if (!canAdvanceStatus(row.status as MessageStatus, status)) continue;
      const updated = await this.prisma.message.update({
        where: { id: row.id },
        data: { status },
        include: { attachments: true },
      });
      changed.push({ conversationId, message: mapMessage(updated) });
    }
    return changed;
  }

  async listAwaitingReceipt(inboxId: string, since: Date, limit = 50): Promise<{ id: string; channelMsgId: string }[]> {
    const rows = await this.prisma.message.findMany({
      where: { inboxId, direction: "out", internal: false, status: "sent", channelMsgId: { not: null }, createdAt: { gte: since } },
      select: { id: true, channelMsgId: true },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows.map((r) => ({ id: r.id, channelMsgId: r.channelMsgId! }));
  }

  async updateMessageStatusByChannelId(
    channelMsgId: string,
    status: MessageStatus,
    failureReason?: string,
  ): Promise<{ conversationId: string; message: Message } | undefined> {
    const msg = await this.prisma.message.findFirst({ where: { channelMsgId } });
    if (!msg) return undefined;
    // Never regress the ladder (out-of-order/duplicate webhooks are common).
    if (!canAdvanceStatus(msg.status as MessageStatus, status)) return undefined;
    const updated = await this.prisma.message.update({
      where: { id: msg.id },
      data: {
        status,
        // Only on the way to "failed", and only when the provider said why: a
        // later "delivered" must not leave a stale explanation under a message
        // that arrived perfectly well.
        ...(status === "failed" && failureReason ? { failureReason } : {}),
      },
      include: { attachments: true },
    });
    return { conversationId: updated.conversationId, message: mapMessage(updated) };
  }

  async clearUnread(conversationId: string): Promise<Conversation | undefined> {
    try {
      const row = await this.prisma.conversation.update({
        where: { id: conversationId },
        data: { unread: false, unreadCount: 0 },
        include: convInclude,
      });
      // NB: opening a chat does NOT clear the "Back from Later" marker — it
      // persists until the agent actually replies (see addMessage) or resolves
      // the chat (setStatus/reopen clear snoozedUntil on a non-snoozed status).
      return mapConversation(row);
    } catch {
      return undefined;
    }
  }

  async markUnread(conversationId: string): Promise<Conversation | undefined> {
    try {
      const row = await this.prisma.conversation.update({
        where: { id: conversationId },
        data: { unread: true, unreadCount: 0 }, // manual mark → empty dot
        include: convInclude,
      });
      return mapConversation(row);
    } catch {
      return undefined;
    }
  }

  /* ---- custom fields ---- */
  async listCustomFields(orgId: string): Promise<CustomField[]> {
    const rows = await this.prisma.customField.findMany({
      where: { orgId },
      orderBy: [{ position: "asc" }, { label: "asc" }],
    });
    return rows.map(mapCustomField);
  }

  async createCustomField(orgId: string, input: CreateCustomFieldInput): Promise<CustomField> {
    // New fields go to the end of the panel rather than the top: an existing
    // order is one somebody arranged, and inserting above it rearranges a
    // screen they are used to reading.
    const count = await this.prisma.customField.count({ where: { orgId } });
    const row = await this.prisma.customField.create({
      data: {
        orgId,
        key: input.key,
        label: input.label,
        type: input.type,
        entity: input.entity,
        options: input.options,
        inboxIds: input.inboxIds,
        position: count,
        filterable: input.filterable ?? false,
      },
    });
    return mapCustomField(row);
  }

  async updateCustomField(
    id: string,
    input: UpdateCustomFieldInput,
  ): Promise<CustomField | undefined> {
    // Never the entity: that goes through changeCustomFieldEntity, which
    // clears the values a move would otherwise strand.
    const { entity: _entity, discardValues: _discard, ...data } = input;
    const row = await this.prisma.customField
      .update({ where: { id }, data })
      .catch(() => null);
    return row ? mapCustomField(row) : undefined;
  }

  async deleteCustomField(id: string): Promise<void> {
    // The values go with it, by the cascade on the foreign key. That is the
    // point of the confirmation on the screen that calls this.
    await this.prisma.customField.delete({ where: { id } }).catch(() => undefined);
  }

  async countCustomFieldValues(id: string): Promise<number> {
    return this.prisma.customFieldValue.count({ where: { fieldId: id } });
  }

  async changeCustomFieldEntity(id: string, entity: CustomFieldEntity): Promise<CustomField | undefined> {
    const row = await this.prisma
      .$transaction(async (tx) => {
        await tx.customFieldValue.deleteMany({ where: { fieldId: id } });
        return tx.customField.update({ where: { id }, data: { entity } });
      })
      .catch(() => null);
    return row ? mapCustomField(row) : undefined;
  }

  async customFieldValues(
    orgId: string,
    entity: CustomFieldEntity,
    entityIds: string[],
  ): Promise<Map<string, CustomFieldValue[]>> {
    if (!entityIds.length) return new Map();
    const rows = await this.prisma.customFieldValue.findMany({
      where: { orgId, entity, entityId: { in: entityIds } },
      include: { field: true },
      orderBy: { field: { position: "asc" } },
    });
    const out = new Map<string, CustomFieldValue[]>();
    for (const r of rows) {
      const list = out.get(r.entityId) ?? [];
      list.push({ fieldId: r.fieldId, key: r.field.key, value: r.value });
      out.set(r.entityId, list);
    }
    return out;
  }

  async setCustomFieldValues(
    orgId: string,
    entity: CustomFieldEntity,
    entityId: string,
    values: Record<string, string | null>,
  ): Promise<{ values: CustomFieldValue[]; unknown: string[] }> {
    const keys = Object.keys(values);
    if (!keys.length) return { values: [], unknown: [] };
    const fields = await this.prisma.customField.findMany({
      where: { orgId, entity, key: { in: keys }, archived: false },
    });
    const byKey = new Map(fields.map((f) => [f.key, f]));
    // A key nobody defined is reported rather than stored. A typo in an
    // integration should fail where somebody can see it, instead of quietly
    // filling a table with values no screen will ever read.
    const unknown = keys.filter((k) => !byKey.has(k));

    for (const [key, raw] of Object.entries(values)) {
      const field = byKey.get(key);
      if (!field) continue;
      const value = raw?.trim();
      const where = {
        fieldId_entity_entityId: { fieldId: field.id, entity, entityId },
      };
      if (!value) {
        await this.prisma.customFieldValue.delete({ where }).catch(() => undefined);
        continue;
      }
      const data = { value, normalizedValue: normalizeCustomFieldValue(value) };
      await this.prisma.customFieldValue.upsert({
        where,
        update: data,
        create: { orgId, fieldId: field.id, entity, entityId, ...data },
      });
    }
    const current = await this.customFieldValues(orgId, entity, [entityId]);
    return { values: current.get(entityId) ?? [], unknown };
  }

  async findByCustomFieldExact(
    orgId: string,
    entity: CustomFieldEntity,
    fieldKey: string,
    value: string,
  ): Promise<string[]> {
    const wanted = normalizeCustomFieldValue(value);
    if (!wanted) return [];
    const rows = await this.prisma.customFieldValue.findMany({
      where: { orgId, entity, normalizedValue: wanted, field: { key: fieldKey } },
      select: { entityId: true },
      take: 20,
    });
    return rows.map((r) => r.entityId);
  }

  async findByCustomField(
    orgId: string,
    fieldKey: string,
    value?: string,
  ): Promise<{ conversationIds: string[]; contactIds: string[] }> {
    const wanted = value === undefined ? undefined : normalizeCustomFieldValue(value);
    // A filter for a value that normalises to nothing is a filter for nothing,
    // not a filter for everything — the difference between "restaurant is ''"
    // and "restaurant is set".
    if (value !== undefined && !wanted) return { conversationIds: [], contactIds: [] };
    const rows = await this.prisma.customFieldValue.findMany({
      where: {
        orgId,
        field: { key: fieldKey, archived: false },
        ...(wanted ? { normalizedValue: wanted } : {}),
      },
      select: { entity: true, entityId: true },
      // Newest first, so a set larger than the cap shows the recent slice
      // rather than an arbitrary one.
      orderBy: { id: "desc" },
      take: CUSTOM_FIELD_FILTER_MAX,
    });
    return {
      conversationIds: rows.filter((r) => r.entity === "conversation").map((r) => r.entityId),
      contactIds: rows.filter((r) => r.entity === "contact").map((r) => r.entityId),
    };
  }

  async findByCustomFieldValue(
    orgId: string,
    entity: CustomFieldEntity,
    query: string,
  ): Promise<string[]> {
    const q = normalizeCustomFieldValue(query);
    if (!q) return [];
    // Two queries rather than one ordered by a CASE: the exact one is an index
    // equality and answers instantly, and when it hits there is usually nothing
    // more worth saying. The contains scan only matters when it misses.
    const exact = await this.prisma.customFieldValue.findMany({
      where: { orgId, entity, normalizedValue: q },
      select: { entityId: true },
      take: 50,
    });
    const partial = await this.prisma.customFieldValue.findMany({
      where: { orgId, entity, normalizedValue: { contains: q }, NOT: { normalizedValue: q } },
      select: { entityId: true },
      take: 50,
    });
    return [...new Set([...exact, ...partial].map((r) => r.entityId))];
  }

  /* ---- labels ---- */
  async listLabels(orgId: string): Promise<Label[]> {
    const rows = await this.prisma.label.findMany({ where: { orgId }, orderBy: { name: "asc" } });
    return rows.map((l) => ({ id: l.id, name: l.name, color: l.color }));
  }

  async createLabel(input: { orgId: string; name: string; color: string }): Promise<Label> {
    const name = input.name.trim();
    // Names are unique per org — reuse an existing one rather than error.
    const row = await this.prisma.label.upsert({
      where: { orgId_name: { orgId: input.orgId, name } },
      update: { color: input.color },
      create: { orgId: input.orgId, name, color: input.color },
    });
    return { id: row.id, name: row.name, color: row.color };
  }

  async updateLabel(id: string, patch: { name?: string; color?: string }): Promise<Label | undefined> {
    try {
      const row = await this.prisma.label.update({
        where: { id },
        data: {
          ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
          ...(patch.color !== undefined ? { color: patch.color } : {}),
        },
      });
      return { id: row.id, name: row.name, color: row.color };
    } catch {
      return undefined;
    }
  }

  async deleteLabel(id: string): Promise<void> {
    // Remove the join rows first, then the label (no cascade in the schema).
    await this.prisma.conversationLabel.deleteMany({ where: { labelId: id } });
    await this.prisma.label.delete({ where: { id } }).catch(() => undefined);
  }

  async setConversationLabels(conversationId: string, labelIds: string[]): Promise<Conversation | undefined> {
    const unique = [...new Set(labelIds)];
    try {
      await this.prisma.$transaction([
        this.prisma.conversationLabel.deleteMany({ where: { conversationId } }),
        ...(unique.length
          ? [
              this.prisma.conversationLabel.createMany({
                data: unique.map((labelId) => ({ conversationId, labelId })),
                skipDuplicates: true,
              }),
            ]
          : []),
      ]);
      const row = await this.prisma.conversation.findUnique({ where: { id: conversationId }, include: convInclude });
      return row ? mapConversation(row) : undefined;
    } catch {
      return undefined;
    }
  }

  async getMessageRefByChannelId(
    channelMsgId: string,
  ): Promise<{ id: string; conversationId: string } | undefined> {
    const m = await this.prisma.message.findFirst({
      where: { channelMsgId },
      select: { id: true, conversationId: true },
      orderBy: { createdAt: "desc" },
    });
    return m ?? undefined;
  }

  async failMessage(
    messageId: string,
  ): Promise<{ conversationId: string; message: Message } | undefined> {
    const msg = await this.prisma.message.findUnique({ where: { id: messageId } });
    if (!msg) return undefined;
    if (!canAdvanceStatus(msg.status as MessageStatus, "failed")) return undefined;
    const updated = await this.prisma.message.update({
      where: { id: messageId },
      data: { status: "failed" },
      include: { attachments: true },
    });
    return { conversationId: updated.conversationId, message: mapMessage(updated) };
  }

  async reactToMessage(
    messageId: string,
    emoji: string,
    by: "contact" | "user",
  ): Promise<{ conversationId: string; message: Message } | undefined> {
    const m = await this.prisma.message.findUnique({ where: { id: messageId } });
    if (!m) return undefined;
    // At most one reaction per participant: drop theirs, then add the new one.
    const kept = parseReactions(m.reactions).filter((r) => r.by !== by);
    const next = emoji.trim() ? [...kept, { emoji: emoji.trim(), by }] : kept;
    const updated = await this.prisma.message.update({
      where: { id: messageId },
      data: { reactions: next as unknown as Prisma.InputJsonValue },
      include: { attachments: true },
    });
    return { conversationId: updated.conversationId, message: mapMessage(updated) };
  }

  /* ---- groups ---- */

  async findConversationByChannelRef(
    channelRef: string,
    opts: { contactIds?: string[] } = {},
  ): Promise<string | undefined> {
    const c = await this.prisma.conversation.findFirst({
      where: { channelRef, ...(opts.contactIds?.length ? { contactId: { in: opts.contactIds } } : {}) },
      select: { id: true },
    });
    return c?.id;
  }

  async findContactByIdentity(params: {
    orgId: string;
    kind: ContactIdentityKind;
    value: string;
  }): Promise<Contact | undefined> {
    // Same matching as upsertContactByIdentity — canonical value, and phone/wa_id
    // treated as one identity — but lookup only, never creating.
    // phone and wa_id are the same number in two notations, so they match each
    // other; email and a NestChat visitor id each match only themselves.
    const matchKinds =
      params.kind === "email" || params.kind === "nestchat"
        ? [params.kind]
        : ["phone", "wa_id"];
    const normalized = normalizeIdentity(params.kind, params.value)?.normalized ?? params.value;
    const ident = await this.prisma.contactIdentity.findFirst({
      where: { orgId: params.orgId, kind: { in: matchKinds }, normalizedValue: normalized },
      include: { contact: { include: CONTACT_INCLUDE } },
    });
    return ident ? mapContact(ident.contact) : undefined;
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
    // Get-or-create: if the phone or email already resolves to a contact in this
    // org, return that one instead of forking a duplicate.
    const phone = params.phone ? normalizeIdentity("phone", params.phone) : null;
    const email = params.email ? normalizeIdentity("email", params.email) : null;
    const or: Prisma.ContactIdentityWhereInput[] = [];
    if (phone) or.push({ kind: { in: ["phone", "wa_id"] }, normalizedValue: phone.normalized });
    if (email) or.push({ kind: "email", normalizedValue: email.normalized });
    if (or.length) {
      const hit = await this.prisma.contactIdentity.findFirst({
        where: { orgId: params.orgId, OR: or },
        include: { contact: { include: CONTACT_INCLUDE } },
      });
      if (hit) return { contact: mapContact(hit.contact), created: false };
    }

    const count = await this.prisma.contact.count({ where: { orgId: params.orgId } });
    const created = await this.prisma.contact.create({
      data: {
        orgId: params.orgId,
        displayName: params.displayName,
        company: params.company ?? null,
        avatarColor: params.avatarColor ?? AVATAR_PALETTE[count % AVATAR_PALETTE.length],
        tags: params.tags ?? [],
        ownerUserId: params.ownerUserId ?? null,
        ownerTeamId: params.ownerTeamId ?? null,
      },
    });
    await this.setIdentity(created.id, params.orgId, ["phone", "wa_id"], "phone", params.phone);
    await this.setIdentity(created.id, params.orgId, ["email"], "email", params.email);
    const full = await this.prisma.contact.findUnique({
      where: { id: created.id },
      include: CONTACT_INCLUDE,
    });
    return { contact: mapContact(full!), created: true };
  }

  /**
   * Give every identity row a canonical `normalizedValue`, and re-canonicalise
   * them all when the rule itself has changed.
   *
   * Two jobs, one pass:
   *
   * 1. Rows that never had a key (the original post-migration backfill).
   * 2. Rows whose key was written by an *older* normalisation. A stored key is
   *    only useful if it equals what today's code would compute for the same
   *    input — otherwise an inbound message fails to match the contact it
   *    belongs to and forks a duplicate, which is the exact failure the
   *    normalisation exists to prevent. {@link IDENTITY_NORMALIZATION_VERSION}
   *    is how we know, and the version is stamped only after the rewrite
   *    succeeds, so an interrupted pass simply runs again next boot.
   *
   * Re-canonicalising can make two rows collide that previously didn't — that
   * is the point — so the unique index is dropped here and
   * {@link reconcileIdentityUniqueness} rebuilds it after merging whatever
   * collapsed together.
   */
  async backfillIdentityNormalization(): Promise<{ updated: number }> {
    const stored = Number((await this.getPlatformSetting(IDENTITY_VERSION_KEY)) ?? 0);
    const stale = stored < IDENTITY_NORMALIZATION_VERSION;

    const rows = await this.root.contactIdentity.findMany({
      where: stale ? {} : { OR: [{ normalizedValue: null }, { orgId: null }] },
      include: { contact: { select: { orgId: true } } },
    });

    if (stale && rows.length) {
      // The index is keyed on normalizedValue; rewriting those values can
      // transiently violate it, and the collisions it would reject are exactly
      // the duplicates reconcile is about to merge.
      await this.root.$executeRawUnsafe(`DROP INDEX IF EXISTS "${IDENTITY_UNIQUE_INDEX}"`).catch(() => {});
    }

    let updated = 0;
    for (const r of rows) {
      const normalized = normalizeIdentity(r.kind as IdentityKind, r.value)?.normalized ?? r.value;
      const orgId = r.orgId ?? r.contact.orgId;
      // Skip rows already holding the right answer, so a version bump that only
      // moves a handful of keys doesn't rewrite the whole table.
      if (r.normalizedValue === normalized && r.orgId === orgId) continue;
      await this.root.contactIdentity
        .update({ where: { id: r.id }, data: { normalizedValue: normalized, orgId } })
        .catch(() => {});
      updated++;
    }

    if (stale) {
      await this.setPlatformSetting(IDENTITY_VERSION_KEY, String(IDENTITY_NORMALIZATION_VERSION));
    }
    return { updated };
  }

  /**
   * Consolidate residual duplicate identities and enforce per-org uniqueness.
   * See the Store interface for the contract. Runs at boot, after the
   * normalization backfill has given every row a canonical normalizedValue.
   */
  async reconcileIdentityUniqueness(): Promise<{ mergedContacts: number; collapsedIdentities: number; constraintApplied: boolean }> {
    const INDEX = IDENTITY_UNIQUE_INDEX;
    // Fast path: once the unique index is in place, the data is already clean.
    // The normalisation backfill drops it when the rule changed, which is what
    // brings us back through the full pass below.
    const already = await this.root.$queryRawUnsafe<{ exists: boolean }[]>(
      `SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = $1) AS "exists"`,
      INDEX,
    );
    if (already[0]?.exists) return { mergedContacts: 0, collapsedIdentities: 0, constraintApplied: true };

    // 1) Merge every set of contacts that collide on the MATCH key — the same
    //    key upsertContactByIdentity looks a customer up by, which folds `phone`
    //    and `wa_id` into one slot because a number is a number however it
    //    reached us. It also catches a collision hidden on a contact's 2nd+
    //    identity row, which the manual merge tool's phone/email view misses.
    //
    //    Deliberately WIDER than the unique index, which includes `kind` and so
    //    would happily leave one customer split across a `wa_id` row and a
    //    `phone` row holding the same digits — two contacts, two threads, one
    //    person, and no constraint violation to reveal it. Merging more than the
    //    constraint demands is safe: it can only remove collisions, never create
    //    them. Oldest contact wins; mergeContacts moves the conversations across.
    const rows = await this.root.contactIdentity.findMany({
      where: { normalizedValue: { not: null }, orgId: { not: null } },
      select: { contactId: true, orgId: true, kind: true, normalizedValue: true },
    });
    // Union-find: contacts that co-occur on any key are the same customer.
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let root = x;
      while (parent.has(root) && parent.get(root) !== root) root = parent.get(root)!;
      return root;
    };
    const union = (a: string, b: string) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };
    const byKey = new Map<string, string[]>();
    for (const r of rows) {
      const key = `${r.orgId} ${r.kind === "email" ? "email" : "phone"} ${r.normalizedValue}`;
      const list = byKey.get(key);
      if (list) list.push(r.contactId);
      else byKey.set(key, [r.contactId]);
    }
    for (const ids of byKey.values()) for (let i = 1; i < ids.length; i++) union(ids[0], ids[i]);
    const orgOf = new Map(rows.map((r) => [r.contactId, r.orgId as string]));
    const clusters = new Map<string, string[]>();
    for (const cid of new Set(rows.map((r) => r.contactId))) {
      const root = find(cid);
      const arr = clusters.get(root);
      if (arr) arr.push(cid);
      else clusters.set(root, [cid]);
    }
    let mergedContacts = 0;
    for (const ids of clusters.values()) {
      if (ids.length < 2) continue;
      const meta = await this.root.contact.findMany({ where: { id: { in: ids } }, select: { id: true, createdAt: true } });
      if (meta.length < 2) continue;
      const winner = meta.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b));
      // Every contact in a cluster shares a workspace — the key the cluster was
      // built from includes the org — so the merge runs as that workspace.
      const clusterOrg = orgOf.get(winner.id);
      if (!clusterOrg) continue;
      await runInTenant(clusterOrg, () =>
        this.mergeContacts({ winnerId: winner.id, loserIds: meta.filter((m) => m.id !== winner.id).map((m) => m.id) }),
      );
      mergedContacts += meta.length - 1;
    }

    // 2) Collapse redundant rows now left on a SINGLE contact — same
    //    (orgId, kind, normalizedValue) but a different raw format (e.g.
    //    "+447700900123" and "07700 900123"). The contactId guard keeps this
    //    lossless: only a same-contact twin is removed, the customer keeps one.
    const collapsedIdentities = await this.root.$executeRawUnsafe(`
      DELETE FROM "ContactIdentity" AS a
      USING "ContactIdentity" AS b
      WHERE a."orgId" = b."orgId"
        AND a."kind" = b."kind"
        AND a."normalizedValue" = b."normalizedValue"
        AND a."normalizedValue" IS NOT NULL
        AND a."contactId" = b."contactId"
        AND a."id" > b."id"
    `);

    // 3) Apply the hard guarantee. Created at runtime (NOT a Prisma migration)
    //    so it lands AFTER the cleanup above — a migration runs before boot and
    //    would fail on any legacy duplicate. Idempotent; never blocks boot.
    let constraintApplied = false;
    try {
      await this.root.$executeRawUnsafe(
        `CREATE UNIQUE INDEX IF NOT EXISTS "${INDEX}" ON "ContactIdentity" ("orgId", "kind", "normalizedValue") WHERE "normalizedValue" IS NOT NULL`,
      );
      constraintApplied = true;
    } catch {
      // A residual cross-contact collision the merge above couldn't resolve —
      // leave the data intact; get-or-create dedup still blocks new duplicates.
    }
    return { mergedContacts, collapsedIdentities: Number(collapsedIdentities) || 0, constraintApplied };
  }

  /* ---- customers directory ---- */

  /**
   * Reconcile a single identity (phone/email) on a contact. `matchKinds` are the
   * kinds that count as "the same slot" when looking for an existing row (phone
   * matches a legacy wa_id too); `writeKind` is used only when creating a fresh
   * one. `undefined` value = field not supplied (leave as-is); empty = clear it.
   */
  private async setIdentity(
    contactId: string,
    orgId: string,
    matchKinds: string[],
    writeKind: string,
    value: string | undefined,
  ): Promise<void> {
    if (value === undefined) return;
    const existing = await this.prisma.contactIdentity.findFirst({
      where: { contactId, kind: { in: matchKinds } },
    });
    const v = value.trim();
    if (!v) {
      if (existing) await this.prisma.contactIdentity.delete({ where: { id: existing.id } }).catch(() => {});
      return;
    }
    const normalized = normalizeIdentity(writeKind as IdentityKind, v)?.normalized ?? v;
    try {
      if (existing) {
        if (existing.value !== v || existing.normalizedValue !== normalized || existing.orgId !== orgId)
          await this.prisma.contactIdentity.update({
            where: { id: existing.id },
            data: { value: v, normalizedValue: normalized, orgId },
          });
      } else {
        await this.prisma.contactIdentity.create({
          data: { contactId, orgId, kind: writeKind, value: v, normalizedValue: normalized },
        });
      }
    } catch {
      /* [kind,value] is globally unique — another contact already owns it; skip */
    }
  }

  async getAnalytics(orgId: string, q: AnalyticsQuery): Promise<AnalyticsBundle> {
    const from = new Date(q.from);
    const to = new Date(q.to);
    // The channel/team/agent filter, shared by every query below.
    const convWhere: Prisma.ConversationWhereInput = {
      orgId,
      ...(q.channel ? { channel: q.channel as ChannelType } : {}),
      ...(q.teamId ? { assignedTeamId: q.teamId } : {}),
      ...(q.agentUserId ? { assigneeUserId: q.agentUserId } : {}),
    };

    // "Right now" status counts across the filtered set.
    const [statusGroups, unassigned] = await Promise.all([
      this.prisma.conversation.groupBy({ by: ["status"], where: convWhere, _count: { _all: true } }),
      this.prisma.conversation.count({ where: { ...convWhere, assigneeUserId: null } }),
    ]);
    const snapshot = { open: 0, pending: 0, snoozed: 0, closed: 0, unassigned, total: 0 };
    for (const g of statusGroups) {
      const n = g._count._all;
      snapshot.total += n;
      if (g.status === "open") snapshot.open = n;
      else if (g.status === "pending") snapshot.pending = n;
      else if (g.status === "snoozed") snapshot.snoozed = n;
      else if (g.status === "closed") snapshot.closed = n;
    }

    // Conversations created in the window (+ their labels + messages), so we can
    // derive first-response facts per thread.
    const rangeConvs = await this.prisma.conversation.findMany({
      where: { ...convWhere, createdAt: { gte: from, lt: to } },
      select: {
        id: true,
        channel: true,
        status: true,
        assigneeUserId: true,
        assignedTeamId: true,
        priority: true,
        createdAt: true,
        lastActivityAt: true,
        labels: { select: { labelId: true } },
        messages: {
          select: { direction: true, internal: true, authorUserId: true, createdAt: true },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    const conversations: AnalyticsConvo[] = rangeConvs.map((c) => {
      let firstInboundAt: string | null = null;
      let firstReplyAt: string | null = null;
      let firstReplyUserId: string | null = null;
      let inbound = 0;
      let outbound = 0;
      for (const m of c.messages) {
        if (m.direction === "in") {
          inbound++;
          if (!firstInboundAt) firstInboundAt = m.createdAt.toISOString();
        } else {
          if (m.internal) continue;
          outbound++;
          if (!firstReplyAt) {
            firstReplyAt = m.createdAt.toISOString();
            firstReplyUserId = m.authorUserId ?? null;
          }
        }
      }
      return {
        id: c.id,
        channel: c.channel as ChannelType,
        status: c.status as ConversationStatus,
        assigneeUserId: c.assigneeUserId ?? null,
        assignedTeamId: c.assignedTeamId ?? null,
        priority: c.priority as Priority,
        createdAt: c.createdAt.toISOString(),
        lastActivityAt: c.lastActivityAt.toISOString(),
        firstInboundAt,
        firstReplyAt,
        firstReplyUserId,
        labelIds: c.labels.map((l) => l.labelId),
        inbound,
        outbound,
      };
    });

    // Messages sent in the window whose conversation matches the filter.
    const msgRows = await this.prisma.message.findMany({
      where: { createdAt: { gte: from, lt: to }, conversation: convWhere },
      select: {
        createdAt: true,
        direction: true,
        internal: true,
        authorUserId: true,
        conversation: { select: { channel: true } },
      },
    });
    const messages: AnalyticsMsg[] = msgRows.map((m) => ({
      createdAt: m.createdAt.toISOString(),
      direction: m.direction as "in" | "out",
      internal: m.internal,
      authorUserId: m.authorUserId ?? null,
      channel: m.conversation.channel as ChannelType,
    }));

    const newContacts = await this.prisma.contact.count({
      where: { orgId, createdAt: { gte: from, lt: to } },
    });

    return { conversations, messages, newContacts, snapshot };
  }

  async listContacts(): Promise<Contact[]> {
    const rows = await this.prisma.contact.findMany({
      where: { orgId: currentOrgId() },
      include: CONTACT_INCLUDE,
    });
    return rows.map(mapContact).sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  async findDuplicateContacts(): Promise<ContactDuplicateGroup[]> {
    return groupDuplicateContacts(await this.listContacts());
  }

  async mergeContacts(params: { winnerId: string; loserIds: string[] }): Promise<Contact> {
    const loserIds = [...new Set(params.loserIds)].filter((id) => id !== params.winnerId);
    if (loserIds.length) {
      await this.prisma.$transaction(async (tx) => {
        const winner = await tx.contact.findUnique({ where: { id: params.winnerId }, include: CONTACT_INCLUDE });
        if (!winner) throw new Error("Winner contact not found");
        const losers = await tx.contact.findMany({ where: { id: { in: loserIds } }, include: CONTACT_INCLUDE });
        for (const l of losers) {
          if (l.orgId !== winner.orgId) throw new Error("Cannot merge contacts across organisations");
        }

        // Conversations (and their messages/notes/labels) move to the winner.
        await tx.conversation.updateMany({ where: { contactId: { in: loserIds } }, data: { contactId: params.winnerId } });

        // Participants move too, but a conversation can list a contact only once
        // (@@unique conversationId+contactId) — drop the loser's row if the
        // winner is already a participant there.
        const winnerConvs = new Set(
          (await tx.participant.findMany({ where: { contactId: params.winnerId }, select: { conversationId: true } })).map((p) => p.conversationId),
        );
        for (const p of await tx.participant.findMany({ where: { contactId: { in: loserIds } } })) {
          if (winnerConvs.has(p.conversationId)) await tx.participant.delete({ where: { id: p.id } });
          else {
            await tx.participant.update({ where: { id: p.id }, data: { contactId: params.winnerId } });
            winnerConvs.add(p.conversationId);
          }
        }

        // Identities move too, honouring the global @@unique(kind,value): drop a
        // loser identity the winner already carries verbatim.
        const winnerKeys = new Set(winner.identities.map((i) => `${i.kind}::${i.value}`));
        for (const l of losers) {
          for (const idn of l.identities) {
            const key = `${idn.kind}::${idn.value}`;
            if (winnerKeys.has(key)) await tx.contactIdentity.delete({ where: { id: idn.id } });
            else {
              await tx.contactIdentity.update({ where: { id: idn.id }, data: { contactId: params.winnerId, orgId: winner.orgId } });
              winnerKeys.add(key);
            }
          }
        }

        // Fill the winner's blank fields from the losers and union their tags.
        const pick = (get: (c: (typeof losers)[number]) => string | null): string | null => {
          for (const l of losers) { const v = get(l); if (v) return v; }
          return null;
        };
        await tx.contact.update({
          where: { id: params.winnerId },
          data: {
            company: winner.company ?? pick((l) => l.company),
            avatarColor: winner.avatarColor ?? pick((l) => l.avatarColor),
            ownerUserId: winner.ownerUserId ?? pick((l) => l.ownerUserId),
            ownerTeamId: winner.ownerTeamId ?? pick((l) => l.ownerTeamId),
            tags: [...new Set([...(winner.tags ?? []), ...losers.flatMap((l) => l.tags ?? [])])],
          },
        });

        // Their organisations come with them (the links would otherwise go with
        // the deleted contacts), unless the winner is already linked there.
        const winnerAccounts = new Set(
          (await tx.accountContact.findMany({ where: { contactId: params.winnerId }, select: { accountId: true } })).map((l) => l.accountId),
        );
        for (const link of await tx.accountContact.findMany({ where: { contactId: { in: loserIds } } })) {
          if (winnerAccounts.has(link.accountId)) continue;
          await tx.accountContact.update({ where: { id: link.id }, data: { contactId: params.winnerId } });
          winnerAccounts.add(link.accountId);
        }

        await tx.contact.deleteMany({ where: { id: { in: loserIds } } });
      });
    }
    const merged = await this.prisma.contact.findUnique({ where: { id: params.winnerId }, include: CONTACT_INCLUDE });
    if (!merged) throw new Error("Winner contact not found");
    return mapContact(merged);
  }

  async getContact(id: string): Promise<Contact | undefined> {
    const row = await this.prisma.contact.findUnique({ where: { id }, include: CONTACT_INCLUDE });
    return row ? mapContact(row) : undefined;
  }

  async getContactWithConversations(id: string): Promise<ContactWithConversations | undefined> {
    const contact = await this.prisma.contact.findUnique({ where: { id }, include: CONTACT_INCLUDE });
    if (!contact) return undefined;
    const convs = await this.prisma.conversation.findMany({
      where: { contactId: id },
      include: convInclude,
      orderBy: { lastActivityAt: "desc" },
    });
    return { ...mapContact(contact), conversations: convs.map(mapConversation) };
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
    const existing = await this.prisma.contact.findUnique({ where: { id } });
    if (!existing) return undefined;
    const data: Prisma.ContactUpdateInput = {};
    if (params.displayName !== undefined) data.displayName = params.displayName;
    if (params.company !== undefined) data.company = params.company || null;
    if (params.tags !== undefined) data.tags = params.tags;
    if (params.ownerUserId !== undefined) data.ownerUserId = params.ownerUserId ?? null;
    if (params.ownerTeamId !== undefined) data.ownerTeamId = params.ownerTeamId ?? null;
    if (params.blocked !== undefined) data.blocked = params.blocked;
    if (Object.keys(data).length) await this.prisma.contact.update({ where: { id }, data });
    await this.setIdentity(id, existing.orgId, ["phone", "wa_id"], "phone", params.phone);
    await this.setIdentity(id, existing.orgId, ["email"], "email", params.email);
    const full = await this.prisma.contact.findUnique({ where: { id }, include: CONTACT_INCLUDE });
    return full ? mapContact(full) : undefined;
  }

  async deleteContact(id: string): Promise<void> {
    // The contact's own 1:1 conversations and everything hanging off them, then
    // their group memberships + identities, then the contact — in one transaction
    // (the FK relations aren't ON DELETE CASCADE, so children go first).
    const convs = await this.prisma.conversation.findMany({ where: { contactId: id }, select: { id: true } });
    const convIds = convs.map((c) => c.id);
    await this.prisma.$transaction(async (tx) => {
      if (convIds.length) {
        const msgs = await tx.message.findMany({ where: { conversationId: { in: convIds } }, select: { id: true } });
        const msgIds = msgs.map((m) => m.id);
        if (msgIds.length) await tx.attachment.deleteMany({ where: { messageId: { in: msgIds } } });
        await tx.message.deleteMany({ where: { conversationId: { in: convIds } } });
        await tx.note.deleteMany({ where: { conversationId: { in: convIds } } });
        await tx.conversationLabel.deleteMany({ where: { conversationId: { in: convIds } } });
        await tx.assignmentEvent.deleteMany({ where: { conversationId: { in: convIds } } });
        await tx.participant.deleteMany({ where: { conversationId: { in: convIds } } });
        await tx.conversation.deleteMany({ where: { id: { in: convIds } } });
      }
      await tx.participant.deleteMany({ where: { contactId: id } });
      await tx.contactIdentity.deleteMany({ where: { contactId: id } });
      await tx.contact.delete({ where: { id } });
    });
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
    const conv = await this.prisma.conversation.create({
      data: {
        orgId: params.orgId,
        inboxId: params.inboxId,
        contactId: params.contact.id,
        channel: "whatsapp_group",
        subject: params.subject,
        channelRef: params.channelRef,
        inviteLink: params.inviteLink,
        status: "open",
        assigneeUserId: params.assigneeUserId ?? null,
        assignedTeamId: params.assignedTeamId ?? null,
        priority: "normal",
        unread: false,
        seq: 0,
        preview: `Group created · ${params.memberContacts.length} members`,
        participants: { create: params.memberContacts.map((ct) => ({ contactId: ct.id, role: "member" })) },
      },
      include: convInclude,
    });
    return mapConversation(conv);
  }

  async listParticipants(conversationId: string): Promise<Participant[]> {
    const rows = await this.prisma.participant.findMany({
      where: { conversationId },
      include: { contact: { include: CONTACT_INCLUDE } },
      orderBy: { joinedAt: "asc" },
    });
    return rows.map(mapParticipant);
  }

  async countParticipants(conversationId: string): Promise<number> {
    return this.prisma.participant.count({ where: { conversationId } });
  }

  async addParticipant(conversationId: string, contact: Contact, role: ParticipantRole = "member"): Promise<Participant> {
    const existing = await this.prisma.participant.findUnique({
      where: { conversationId_contactId: { conversationId, contactId: contact.id } },
      include: { contact: { include: CONTACT_INCLUDE } },
    });
    if (existing) return mapParticipant(existing);
    const row = await this.prisma.participant.create({
      data: { conversationId, contactId: contact.id, role },
      include: { contact: { include: CONTACT_INCLUDE } },
    });
    return mapParticipant(row);
  }

  async removeParticipant(conversationId: string, contactId: string): Promise<void> {
    await this.prisma.participant.deleteMany({ where: { conversationId, contactId } });
  }
}

/** AttachmentInput → Prisma nested-create row (storage key stored as r2Key). */
function toAttachmentCreate(a: AttachmentInput): Prisma.AttachmentCreateWithoutMessageInput {
  return {
    // Set explicitly: a nested create (inside a message) is not seen by the
    // tenant extension, which only fills in top-level writes.
    orgId: currentOrgId(),
    r2Key: a.storageKey,
    mime: a.mime,
    size: a.size,
    filename: a.filename,
    kind: a.kind,
    durationMs: a.durationMs ?? null,
    width: a.width ?? null,
    height: a.height ?? null,
    waveform: a.waveform ? JSON.stringify(a.waveform) : null,
  };
}

