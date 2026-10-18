import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { env } from "../config/env";
import { Store } from "../data/store";
import { StorageService } from "../storage/storage.service";
import { runInTenant } from "../tenancy/tenant-scope";

const REFRESH_MS = 30_000;
const PURGE_SWEEP_MS = 60 * 60_000;

/**
 * Keeps this node's picture of which workspaces are frozen current, and wipes
 * deleted workspaces once their 30 days are up.
 */
@Injectable()
export class WorkspaceLifecycleService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkspaceLifecycleService.name);
  private timers: ReturnType<typeof setInterval>[] = [];
  private purging = false;

  constructor(
    private readonly store: Store,
    private readonly storage: StorageService,
  ) {}

  /** Before the first request: a frozen workspace is frozen from the start. */
  async onModuleInit(): Promise<void> {
    if (!env.usingDatabase) return;
    await this.store.refreshWorkspaceStatuses();
    const refresh = setInterval(() => void this.store.refreshWorkspaceStatuses().catch((err) => this.logger.warn(`Workspace status refresh failed: ${String(err)}`)), REFRESH_MS);
    const sweep = setInterval(() => void this.sweep(), PURGE_SWEEP_MS);
    refresh.unref?.();
    sweep.unref?.();
    this.timers.push(refresh, sweep);
    setTimeout(() => void this.sweep(), 60_000).unref?.();
  }

  onModuleDestroy(): void {
    for (const t of this.timers) clearInterval(t);
  }

  /** Wipe every deleted workspace whose time has come. Returns those wiped. */
  async sweep(now = new Date()): Promise<string[]> {
    if (this.purging) return [];
    this.purging = true;
    const done: string[] = [];
    try {
      for (const id of await this.store.listWorkspacesDueForPurge(now)) {
        try {
          await this.purge(id);
          done.push(id);
        } catch (err) {
          this.logger.error(`Wiping workspace ${id} failed: ${String(err)}`);
        }
      }
    } finally {
      this.purging = false;
    }
    return done;
  }

  /**
   * Wipe one workspace now: its rows, then its files. Files go after the rows
   * are gone, so a failure part-way leaves only unreachable files behind,
   * never a conversation whose attachments have vanished.
   */
  async purge(orgId: string): Promise<{ files: number; filesFailed: number }> {
    await this.store.revokeWorkspaceSessions(orgId);
    const { files } = await this.store.purgeWorkspace(orgId);
    let failed = 0;
    await runInTenant(
      orgId,
      async () => {
        for (const key of files) {
          await this.storage.remove(key).catch(() => {
            failed++;
          });
        }
      },
      { manage: true },
    );
    this.logger.log(`Wiped workspace ${orgId}: ${files.length} file(s)${failed ? `, ${failed} couldn't be deleted` : ""}`);
    return { files: files.length, filesFailed: failed };
  }
}
