import { ForbiddenException } from "@nestjs/common";
import { managingFrozen } from "./tenant-scope";

/**
 * A workspace's life: `active`, or frozen — `suspended` (paused, say for an
 * unpaid bill), `archived` (put away, kept for ever) or `deleting` (wiped for
 * good at its `purgeAt`, restorable until then).
 *
 * Frozen means nothing happens in it: nobody signs in, its channels take
 * nothing in and send nothing out, and background jobs pass it by. That is
 * enforced in one place — the tenant-scoped Prisma client refuses every query
 * for a frozen workspace — so a code path can't forget. The only way in is a
 * platform owner managing it (`runInTenant(id, fn, { manage: true })`).
 *
 * Which workspaces are frozen is held here, in memory, so the check costs
 * nothing per query. The store loads it at start, refreshes it every half
 * minute, and updates it the moment a status changes on this node.
 */
export type WorkspaceStatus = "active" | "suspended" | "archived" | "deleting";
export const WORKSPACE_STATUSES: readonly WorkspaceStatus[] = ["active", "suspended", "archived", "deleting"];

const frozen = new Map<string, WorkspaceStatus>();

export function isWorkspaceFrozen(orgId: string): boolean {
  return frozen.has(orgId);
}

/** Record one workspace's status (after a change on this node). */
export function noteWorkspaceStatus(orgId: string, status: WorkspaceStatus): void {
  if (status === "active") frozen.delete(orgId);
  else frozen.set(orgId, status);
}

/** Replace the whole picture (the periodic load). */
export function replaceFrozenWorkspaces(rows: { id: string; status: string }[]): void {
  frozen.clear();
  for (const r of rows) if (r.status !== "active") frozen.set(r.id, r.status as WorkspaceStatus);
}

/** A frozen workspace was reached for. A 403 when it surfaces in a request. */
export class WorkspaceFrozenError extends ForbiddenException {
  constructor(readonly orgId: string) {
    super(
      frozen.get(orgId) === "suspended"
        ? "This workspace is suspended. Ask the person who runs it."
        : "This workspace is no longer available.",
    );
    this.name = "WorkspaceFrozenError";
  }
}

/** Throw unless `orgId` is active, or a platform owner is managing it. */
export function assertWorkspaceOpen(orgId: string): void {
  if (frozen.has(orgId) && !managingFrozen()) throw new WorkspaceFrozenError(orgId);
}
