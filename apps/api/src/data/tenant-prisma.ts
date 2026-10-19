import { Prisma, type PrismaClient } from "@prisma/client";
import { currentOrgId } from "../tenancy/tenant-scope";
import { assertWorkspaceOpen } from "../tenancy/workspace-status";

/**
 * The Prisma client every workspace read and write goes through.
 *
 * Tenant isolation is enforced here, once, rather than in each of the store's
 * hundred-odd queries — a rule that has to be remembered in every query is a
 * rule that is eventually forgotten in one, and the one is enough. Every
 * operation on a workspace-owned model has the bound org added to its filter;
 * every create has its org checked or filled in. Nothing is bound → the query
 * throws. There is no default workspace to fall back to.
 *
 * Models own their tenant one of two ways:
 *  - DIRECT: they carry `orgId` themselves.
 *  - VIA: they belong to something that does — a message to its conversation, a
 *    session to its user — and are filtered through that relation.
 *
 * A model that is in neither list is refused outright. Adding a table to the
 * schema without deciding whose it is should break the build of whoever
 * touches it, not quietly become readable across workspaces.
 *
 * The few lookups that genuinely have to cross tenants (finding the user an
 * email address signs in as; the inbox an incoming webhook is addressed to)
 * use the unscoped client explicitly, as `root` in the store, so every one of
 * them can be found with a search.
 */

type Filter = Record<string, unknown>;

const DIRECT = new Set<string>([
  "Account",
  "AppSetting",
  "Attachment",
  "AuditLog",
  "ChatRoom",
  "Contact",
  "ContactIdentity",
  "Conversation",
  "CustomField",
  "CustomFieldValue",
  "CustomerDevice",
  "Inbox",
  "Label",
  "Macro",
  "OpsCollection",
  "OpsSop",
  "Team",
  "Template",
  "User",
  "WebhookDiagnostic",
]);

const VIA: Record<string, (orgId: string) => Filter> = {
  Organization: (orgId) => ({ id: orgId }),
  Message: (orgId) => ({ conversation: { orgId } }),
  Participant: (orgId) => ({ conversation: { orgId } }),
  Note: (orgId) => ({ conversation: { orgId } }),
  ConversationLabel: (orgId) => ({ conversation: { orgId } }),
  NoteFollowUp: (orgId) => ({ conversation: { orgId } }),
  AssignmentEvent: (orgId) => ({ conversation: { orgId } }),
  ConversationEvent: (orgId) => ({ conversation: { orgId } }),
  EmailRecipient: (orgId) => ({ message: { conversation: { orgId } } }),
  InboxTeam: (orgId) => ({ inbox: { orgId } }),
  TeamMember: (orgId) => ({ team: { orgId } }),
  Session: (orgId) => ({ user: { orgId } }),
  Device: (orgId) => ({ user: { orgId } }),
  Notification: (orgId) => ({ user: { orgId } }),
  RecoveryCode: (orgId) => ({ user: { orgId } }),
  // An organisation's knowledge belongs to whoever owns the organisation.
  AccountContact: (orgId) => ({ account: { orgId } }),
  AccountAlert: (orgId) => ({ account: { orgId } }),
  AccountSop: (orgId) => ({ account: { orgId } }),
  AccountSopRevision: (orgId) => ({ sop: { account: { orgId } } }),
  AccountNote: (orgId) => ({ account: { orgId } }),
  AccountResource: (orgId) => ({ account: { orgId } }),
  AccountActivity: (orgId) => ({ account: { orgId } }),
  MacroTeam: (orgId) => ({ macro: { orgId } }),
  OpsSopTeam: (orgId) => ({ opsSop: { orgId } }),
  OpsSopRevision: (orgId) => ({ opsSop: { orgId } }),
  OpsAck: (orgId) => ({ opsSop: { orgId } }),
  OpsChecklist: (orgId) => ({ opsSop: { orgId } }),
  ChatMember: (orgId) => ({ room: { orgId } }),
  ChatMessage: (orgId) => ({ room: { orgId } }),
  ChatAudit: (orgId) => ({ room: { orgId } }),
  ChatPresence: (orgId) => ({ user: { orgId } }),
  ChatStar: (orgId) => ({ chatMessage: { room: { orgId } } }),
};

/**
 * Columns that point at another workspace-owned row. A write naming one is
 * checked: the row it points at must be in the bound workspace too. Without
 * this, a workspace could not *read* another's data, but could still *link* to
 * it by id — quote another workspace's message into its own thread (and so
 * display it), file its inbox under another's team, or assign its chat to
 * another's agent (who would then be notified about it).
 */
const REFERENCES: Record<string, string> = {
  conversationId: "Conversation",
  contactId: "Contact",
  inboxId: "Inbox",
  teamId: "Team",
  userId: "User",
  labelId: "Label",
  messageId: "Message",
  quotedMsgId: "Message",
  authorUserId: "User",
  ownerUserId: "User",
  ownerTeamId: "Team",
  assigneeUserId: "User",
  assignedTeamId: "Team",
  fieldId: "CustomField",
  sessionId: "Session",
  accountId: "Account",
  sopId: "AccountSop",
  attachmentId: "Attachment",
  macroId: "Macro",
  opsSopId: "OpsSop",
  routeTeamId: "Team",
  routeUserId: "User",
  collectionId: "OpsCollection",
  roomId: "ChatRoom",
  chatRoomId: "ChatRoom",
  replyToId: "ChatMessage",
  chatMessageId: "ChatMessage",
};
/** The same, for relation fields written as `{ connect: { id } }`. */
const RELATIONS: Record<string, string> = {
  conversation: "Conversation",
  contact: "Contact",
  inbox: "Inbox",
  team: "Team",
  user: "User",
  label: "Label",
  message: "Message",
  assignee: "User",
  assignedTeam: "Team",
  author: "User",
  field: "CustomField",
  session: "Session",
  account: "Account",
  sop: "AccountSop",
  macro: "Macro",
  opsSop: "OpsSop",
  routeTeam: "Team",
  routeUser: "User",
  collection: "OpsCollection",
  room: "ChatRoom",
  chatRoom: "ChatRoom",
  replyTo: "ChatMessage",
  chatMessage: "ChatMessage",
};

const FILTERED_OPS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
  "update",
  "updateMany",
  "delete",
  "deleteMany",
  "upsert",
]);

export class TenantViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantViolationError";
  }
}

/** The filter that confines `model` to `orgId`, or a refusal for a model whose
 *  ownership has not been declared. */
export function tenantFilter(model: string, orgId: string): Filter {
  if (DIRECT.has(model)) return { orgId };
  const via = VIA[model];
  if (via) return via(orgId);
  throw new TenantViolationError(`Model ${model} has no declared tenant owner`);
}

/** `where` with the tenant filter ANDed on. Unique selectors (`id`, compound
 *  keys) stay at the top level, which Prisma's extended unique filters allow. */
export function withTenant(where: Filter | undefined, filter: Filter): Filter {
  const existing = where?.AND;
  const and = Array.isArray(existing) ? existing : existing ? [existing] : [];
  return { ...(where ?? {}), AND: [...and, filter] };
}

/** A row about to be written: its org must be the bound one. */
function claim(model: string, data: Filter | undefined, orgId: string): Filter {
  const row = { ...(data ?? {}) };
  const given = row.orgId;
  if (given !== undefined && given !== null && given !== orgId) {
    throw new TenantViolationError(`Refusing to write ${model} for org ${String(given)} while acting for ${orgId}`);
  }
  const connected = (row.org as { connect?: { id?: string } } | undefined)?.connect?.id;
  if (connected !== undefined && connected !== orgId) {
    throw new TenantViolationError(`Refusing to connect ${model} to org ${connected} while acting for ${orgId}`);
  }
  if (connected === undefined) row.orgId = orgId;
  return row;
}

/** An update must not move a row to another workspace. */
function guardUpdate(model: string, data: Filter | undefined, orgId: string): void {
  if (!data) return;
  const given = data.orgId;
  if (given !== undefined && given !== orgId) {
    throw new TenantViolationError(`Refusing to move ${model} to org ${String(given)}`);
  }
}

/**
 * Every workspace-owned row a write's data points at, by model — including
 * inside nested writes (`teams: { create: [{ teamId }] }`, `connect`,
 * `createMany`), which is where a link across workspaces would otherwise hide.
 * A nested row that names its own `orgId` is collected too, under "Organization".
 */
function referencesIn(data: unknown, out = new Map<string, Set<string>>()): Map<string, Set<string>> {
  const add = (model: string, id: unknown) => {
    if (typeof id !== "string" || !id) return;
    const set = out.get(model) ?? new Set<string>();
    set.add(id);
    out.set(model, set);
  };
  if (Array.isArray(data)) {
    for (const item of data) referencesIn(item, out);
    return out;
  }
  if (!data || typeof data !== "object") return out;
  for (const [key, value] of Object.entries(data as Filter)) {
    if (key === "orgId") {
      add("Organization", typeof value === "object" && value !== null ? (value as { set?: unknown }).set : value);
      continue;
    }
    const scalar = REFERENCES[key];
    if (scalar) {
      add(scalar, typeof value === "object" && value !== null ? (value as { set?: unknown }).set : value);
      continue;
    }
    if (!value || typeof value !== "object") continue;
    const nested = value as {
      connect?: unknown;
      create?: unknown;
      createMany?: { data?: unknown };
      connectOrCreate?: unknown;
      upsert?: unknown;
      update?: unknown;
      set?: unknown;
    };
    const relation = RELATIONS[key];
    for (const c of [nested.connect, nested.set].flatMap((x) => (Array.isArray(x) ? x : x ? [x] : []))) {
      const id = (c as { id?: unknown }).id;
      if (relation) add(relation, id);
    }
    if (nested.create) referencesIn(nested.create, out);
    if (nested.createMany?.data) referencesIn(nested.createMany.data, out);
    if (nested.connectOrCreate) referencesIn(nested.connectOrCreate, out);
    if (nested.upsert) referencesIn(nested.upsert, out);
    if (nested.update && typeof nested.update === "object" && "data" in (nested.update as object)) {
      referencesIn((nested.update as { data?: unknown }).data, out);
    }
  }
  return out;
}

/** Refuse a write that points at a row outside `orgId`. */
async function assertOwnsReferences(
  root: PrismaClient,
  model: string,
  rows: (Filter | undefined)[],
  orgId: string,
): Promise<void> {
  const wanted = new Map<string, Set<string>>();
  for (const row of rows) {
    for (const [m, ids] of referencesIn(row)) {
      const set = wanted.get(m) ?? new Set<string>();
      for (const id of ids) set.add(id);
      wanted.set(m, set);
    }
  }
  for (const [target, ids] of wanted) {
    if (target === "Organization") {
      if ([...ids].some((id) => id !== orgId)) {
        throw new TenantViolationError(`${model} write names a workspace other than the bound one`);
      }
      continue;
    }
    const delegate = (root as unknown as Record<string, { count: (a: unknown) => Promise<number> }>)[
      target.charAt(0).toLowerCase() + target.slice(1)
    ];
    const n = await delegate.count({ where: { AND: [{ id: { in: [...ids] } }, tenantFilter(target, orgId)] } });
    if (n !== ids.size) {
      throw new TenantViolationError(`${model} write refers to a ${target} outside the bound workspace`);
    }
  }
}

/** Wrap a root client so every query is confined to the bound tenant. */
export function tenantScoped<C extends PrismaClient>(root: C) {
  return root.$extends(
    Prisma.defineExtension({
      name: "tenant-scope",
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            const orgId = currentOrgId();
            // A suspended, archived or deleting workspace: nothing happens in it.
            assertWorkspaceOpen(orgId);
            const a = { ...((args ?? {}) as Filter) };

            if (model === "Organization" && (operation === "create" || operation === "createMany" || operation === "upsert")) {
              throw new TenantViolationError("Organisations are created with the unscoped client only");
            }

            if (FILTERED_OPS.has(operation)) {
              a.where = withTenant(a.where as Filter | undefined, tenantFilter(model, orgId));
            } else {
              // Fail closed on anything not explicitly handled below.
              tenantFilter(model, orgId);
            }

            const direct = DIRECT.has(model);
            if (operation === "create" && direct) {
              a.data = claim(model, a.data as Filter, orgId);
            }
            if ((operation === "createMany" || operation === "createManyAndReturn") && direct) {
              const rows = Array.isArray(a.data) ? a.data : [a.data];
              a.data = (rows as Filter[]).map((r) => claim(model, r, orgId));
            }
            if (operation === "upsert" && direct) {
              a.create = claim(model, a.create as Filter, orgId);
              guardUpdate(model, a.update as Filter, orgId);
            }
            if ((operation === "update" || operation === "updateMany") && direct) {
              guardUpdate(model, a.data as Filter, orgId);
            }

            // Whatever the write points at must be in this workspace too.
            if (operation === "create" || operation === "update" || operation === "updateMany") {
              await assertOwnsReferences(root, model, [a.data as Filter], orgId);
            } else if (operation === "createMany" || operation === "createManyAndReturn") {
              await assertOwnsReferences(root, model, a.data as Filter[], orgId);
            } else if (operation === "upsert") {
              await assertOwnsReferences(root, model, [a.create as Filter, a.update as Filter], orgId);
            }
            return query(a as typeof args);
          },
        },
      },
    }),
  );
}

export type TenantPrisma = ReturnType<typeof tenantScoped<PrismaClient>>;
