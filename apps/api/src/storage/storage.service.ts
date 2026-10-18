import { Injectable, Logger } from "@nestjs/common";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import type { Readable } from "node:stream";
import { dirname, join, normalize, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { env } from "../config/env";
import { Store } from "../data/store";
import { R2Driver } from "./r2.driver";
import { resolveR2Config } from "./r2-config";
import { SandboxPolicy } from "../tenancy/sandbox";
import { currentOrgId } from "../tenancy/tenant-scope";

/**
 * Object storage for message media. Uses Cloudflare R2 when configured —
 * credentials come from the env or the org's Settings › Setup card, resolved on
 * demand so R2 can be switched on from the UI without a redeploy — otherwise a
 * local-disk driver (works in dev and on Railway, though Railway disk is
 * ephemeral). Keys are app-generated (`YYYY/MM/uuid.ext`) so they're safe to
 * join onto a base path or R2 prefix.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly base = env.media.dir;
  /** Cached R2 driver + the config signature it was built from (re-resolved on a TTL). */
  private driver: R2Driver | null = null;
  private driverSig: string | null = null;
  private resolvedAt = 0;
  private readonly ttlMs = 15_000;

  constructor(private readonly store: Store, private readonly sandbox: SandboxPolicy) {}

  /** The active R2 driver (or null for disk), re-resolved from settings on a TTL. */
  private async r2(): Promise<R2Driver | null> {
    // Before credentials, cache lookup or any disk/R2 operation. Reads and
    // redirects must not let reviewer media/avatar requests reach shared R2 either.
    currentOrgId();
    await this.sandbox.assertLive("Media storage");
    const now = Date.now();
    if (this.driverSig !== null && now - this.resolvedAt < this.ttlMs) return this.driver;
    const cfg = await resolveR2Config(this.store);
    const sig = cfg ? `${cfg.accountId}/${cfg.bucket}/${cfg.accessKeyId}/${cfg.secretAccessKey}` : "";
    if (sig !== this.driverSig) {
      this.driver = cfg ? new R2Driver(cfg) : null;
      this.driverSig = sig;
      this.logger.log(`Media storage: ${cfg ? `Cloudflare R2 (${cfg.bucket})` : `local disk (${this.base})`}`);
    }
    this.resolvedAt = now;
    return this.driver;
  }

  /** A fresh, collision-free storage key with an optional extension. */
  newKey(ext?: string): string {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const clean = (ext ?? "").replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase();
    return `${yyyy}/${mm}/${randomUUID()}${clean ? `.${clean}` : ""}`;
  }

  async put(key: string, body: Buffer, contentType?: string): Promise<void> {
    const r2 = await this.r2();
    if (r2) {
      await r2.put(key, body, contentType);
      return;
    }
    const path = this.resolve(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }

  async get(key: string): Promise<Buffer | null> {
    const r2 = await this.r2();
    if (r2) {
      try {
        return await r2.get(key);
      } catch (err) {
        this.logger.warn(`R2 read failed for ${key}: ${String(err)}`);
        return null;
      }
    }
    const path = this.resolve(key);
    if (!existsSync(path)) return null;
    try {
      return await readFile(path);
    } catch (err) {
      this.logger.warn(`Failed to read media ${key}: ${String(err)}`);
      return null;
    }
  }

  /**
   * A short-lived presigned GET URL when media lives in R2, else null (disk).
   * With a URL the client downloads straight from R2 — the object never passes
   * through this process, and Range/seek is handled by R2.
   */
  async presignedGetUrl(
    key: string,
    opts?: { expiresSeconds?: number; downloadName?: string },
  ): Promise<string | null> {
    const r2 = await this.r2();
    if (!r2) return null;
    return r2.presignGet(
      key,
      opts?.expiresSeconds ?? 300,
      opts?.downloadName ? { downloadName: opts.downloadName } : undefined,
    );
  }

  /** Delete an object. Missing already is fine. */
  async remove(key: string): Promise<void> {
    const r2 = await this.r2();
    if (r2) {
      await r2.delete(key);
      return;
    }
    await rm(this.resolve(key), { force: true });
  }

  /** Size of a locally-stored object (disk driver only), or null if missing. */
  async diskStat(key: string): Promise<{ size: number } | null> {
    try {
      const s = await stat(this.resolve(key));
      return { size: s.size };
    } catch {
      return null;
    }
  }

  /** A streaming reader for a locally-stored object, optionally a byte range —
   *  so large files are never buffered whole in memory. */
  diskReadStream(key: string, start?: number, end?: number): Readable {
    const path = this.resolve(key);
    return start != null && end != null
      ? createReadStream(path, { start, end })
      : createReadStream(path);
  }

  /** Resolve a key under the base dir, refusing any path-traversal escape. */
  private resolve(key: string): string {
    const path = normalize(join(this.base, key));
    const root = normalize(this.base).replace(/[/\\]+$/, "");
    if (path !== root && !path.startsWith(root + sep)) {
      throw new Error("Invalid storage key");
    }
    return path;
  }
}
