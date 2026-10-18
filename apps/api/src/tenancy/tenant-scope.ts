import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Which organisation the code running right now is acting for.
 *
 * Every read and write of workspace data happens inside one of these. The
 * Prisma client that the store uses refuses to touch an org-owned table when
 * nothing is bound — it does not fall back to a default org — so a code path
 * that forgot to establish its tenant fails loudly in testing instead of
 * quietly reading the first workspace's data in production.
 *
 * How a tenant gets bound:
 *  - a signed-in request: the auth guard resolves the user from the verified
 *    token, and the TenantInterceptor runs the handler bound to that user's org;
 *  - a public request (a channel webhook, the chat widget, a password reset):
 *    the handler starts unbound and calls `bindTenant` once it has resolved,
 *    from something it can trust (an inbox matched by its channel key, a
 *    signed visitor token, a single-use token), whose workspace it is acting in;
 *  - background work (snooze sweep, Gmail polling, outbound retries): each item
 *    runs inside `runInTenant(itsOrgId, …)`.
 *
 * A request binds once. Binding a second, different org inside the same request
 * throws — nothing legitimate needs to act for two workspaces in one request,
 * and that is exactly the shape a cross-tenant bug would take.
 */

interface TenantHolder {
  orgId?: string;
  /** A platform owner managing this workspace, which may be frozen. */
  manage?: boolean;
}

const storage = new AsyncLocalStorage<TenantHolder>();

export class TenantNotBoundError extends Error {
  constructor() {
    super("No tenant bound: workspace data was accessed outside an organisation context");
    this.name = "TenantNotBoundError";
  }
}

export class TenantConflictError extends Error {
  constructor(bound: string, requested: string) {
    super(`Tenant already bound to ${bound}; refusing to act for ${requested} in the same context`);
    this.name = "TenantConflictError";
  }
}

/** Run `fn` with `orgId` bound (or, with no org, a slot a public handler can
 *  bind into later). Everything `fn` awaits sees the same binding. */
export function runInTenant<T>(orgId: string | undefined, fn: () => T, opts?: { manage?: boolean }): T {
  return storage.run({ orgId, manage: opts?.manage }, fn);
}

/** Whether this context is a platform owner managing a workspace — the one
 *  thing that still reaches a frozen workspace (see workspace-status.ts). */
export function managingFrozen(): boolean {
  return storage.getStore()?.manage === true;
}

/** Bind the current context to `orgId`. Idempotent for the same org; throws
 *  for a different one, and outside any tenant context. */
export function bindTenant(orgId: string): void {
  if (!orgId) throw new TenantNotBoundError();
  const holder = storage.getStore();
  if (!holder) {
    throw new Error("bindTenant called outside a tenant context (no request scope or runInTenant)");
  }
  if (holder.orgId && holder.orgId !== orgId) throw new TenantConflictError(holder.orgId, orgId);
  holder.orgId = orgId;
}

/** The bound org, or a TenantNotBoundError. */
export function currentOrgId(): string {
  const orgId = storage.getStore()?.orgId;
  if (!orgId) throw new TenantNotBoundError();
  return orgId;
}

/** The bound org if there is one. For code that legitimately runs either way. */
export function boundOrgId(): string | undefined {
  return storage.getStore()?.orgId;
}
