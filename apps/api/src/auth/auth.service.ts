import { HttpException, HttpStatus, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { User } from "@ding/schemas";
import { env } from "../config/env";
import { Store } from "../data/store";
import { bindTenant, runInTenant } from "../tenancy/tenant-scope";
import { isWorkspaceFrozen, WorkspaceFrozenError } from "../tenancy/workspace-status";

/** How long "remember this device" skips the second factor at sign-in. */
export const TRUSTED_DEVICE_TTL_S = 30 * 24 * 60 * 60;

/** Failed logins allowed per account before a cooldown kicks in, and the window. */
const MAX_FAILURES = 8;
const WINDOW_MS = 10 * 60 * 1000;

@Injectable()
export class AuthService {
  constructor(private readonly store: Store) {}

  // Per-account failed-attempt tracking to slow credential brute-forcing.
  // In-memory (per node) — good enough at this scale; a shared store would be
  // the multi-node upgrade.
  private readonly failures = new Map<string, { count: number; first: number }>();

  private key(email: string): string {
    return email.trim().toLowerCase();
  }

  /** Throw 429 if this account has too many recent failures. Call before validate. */
  assertNotThrottled(email: string): void {
    const rec = this.failures.get(this.key(email));
    if (!rec) return;
    if (Date.now() - rec.first > WINDOW_MS) {
      this.failures.delete(this.key(email));
      return;
    }
    if (rec.count >= MAX_FAILURES) {
      throw new HttpException("Too many login attempts — try again later.", HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  private recordFailure(email: string): void {
    const k = this.key(email);
    const rec = this.failures.get(k);
    if (!rec || Date.now() - rec.first > WINDOW_MS) {
      this.failures.set(k, { count: 1, first: Date.now() });
    } else {
      rec.count += 1;
    }
  }

  /** Verify email + password against the stored bcrypt hash. */
  async validate(email: string, password: string): Promise<User | null> {
    const user = await this.store.findUserByEmail(email);
    if (!user) {
      this.recordFailure(email);
      return null;
    }
    // A suspended or closed workspace (and nowhere open to go instead): the
    // password is still checked first, so a wrong one reads like any other and
    // only the account's owner learns the workspace is frozen.
    if (isWorkspaceFrozen(user.orgId)) {
      const hash = await runInTenant(user.orgId, () => this.store.getPasswordHash(user.id), { manage: true });
      if (!hash || !(await bcrypt.compare(password, hash))) {
        this.recordFailure(email);
        return null;
      }
      throw new WorkspaceFrozenError(user.orgId);
    }
    // From here the request acts for the account's workspace — including the
    // password check, which reads through the tenant-scoped client.
    bindTenant(user.orgId);
    const hash = await this.store.getPasswordHash(user.id);
    if (!hash || !(await bcrypt.compare(password, hash))) {
      this.recordFailure(email);
      return null;
    }
    this.failures.delete(this.key(email));
    return user;
  }

  /**
   * Enter the workspace of the account a verified token names (a pending 2FA
   * token, a session being signed out), for a public route that has no session
   * of its own yet. Returns the account, or undefined if it no longer exists.
   */
  async enterAccount(userId: string): Promise<User | undefined> {
    const user = await this.store.getUserForAuth(userId);
    if (user) bindTenant(user.orgId);
    return user;
  }

  /** Sign a session token. The session id (when given) rides as the JWT `jti`
   *  so a revoked session invalidates it server-side — which is what lets a
   *  long-lived native token stay safe. Same token either way; only the carrier
   *  (cookie vs Authorization header) and the lifetime differ. */
  sign(userId: string, sessionId?: string, ttlSeconds = env.auth.ttlSeconds): string {
    return jwt.sign(
      { sub: userId, ...(sessionId ? { jti: sessionId } : {}) },
      env.auth.jwtSecret,
      { expiresIn: ttlSeconds },
    );
  }

  verify(token: string): { userId: string; sessionId?: string } | undefined {
    try {
      const p = jwt.verify(token, env.auth.jwtSecret) as {
        sub?: string;
        jti?: string;
        twofa?: string;
        trust?: string;
      };
      // A half-authenticated "2FA pending" token is never a full session, and
      // nor is a remembered device — that one skips a code, not a password.
      if (!p.sub || p.twofa || p.trust) return undefined;
      return { userId: p.sub, sessionId: p.jti };
    } catch {
      return undefined;
    }
  }

  /** Short-lived token issued after the password step when 2FA is required — it
   *  ONLY authorises the /auth/login/2fa code check, never a real session. */
  signPending(userId: string): string {
    return jwt.sign({ sub: userId, twofa: "pending" }, env.auth.jwtSecret, { expiresIn: 300 });
  }

  verifyPending(token: string): string | undefined {
    try {
      const p = jwt.verify(token, env.auth.jwtSecret) as { sub?: string; twofa?: string };
      return p.twofa === "pending" ? p.sub : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * What a remembered device is remembered against: this account's password and
   * second factor, as they are now.
   *
   * Carried inside the device's token and compared at every sign-in, so
   * changing either one forgets every device at once — the move somebody makes
   * when they think a laptop or a password is in the wrong hands — with no list
   * of devices to keep and nothing to migrate. A hash of the hashes: nothing
   * about the password or the secret can be read back out of it.
   */
  private async deviceStamp(userId: string): Promise<string> {
    const hash = (await this.store.getPasswordHash(userId)) ?? "";
    const tf = await this.store.getTwoFactor(userId);
    return createHash("sha256")
      .update([hash, tf?.enabled ? "on" : "off", tf?.method ?? "", tf?.totpSecret ?? ""].join("|"))
      .digest("base64url")
      .slice(0, 22);
  }

  /** A device that has passed the second factor, for the next 30 days. It
   *  skips the code at sign-in and nothing else: the password is still asked
   *  for, and `verify` refuses it as a session. */
  async signTrustedDevice(userId: string): Promise<string> {
    return jwt.sign({ sub: userId, trust: await this.deviceStamp(userId) }, env.auth.jwtSecret, {
      expiresIn: TRUSTED_DEVICE_TTL_S,
    });
  }

  /** Whether this device was remembered by this person, since their password
   *  and second factor last changed. */
  async isTrustedDevice(token: string | undefined, userId: string): Promise<boolean> {
    if (!token) return false;
    try {
      const p = jwt.verify(token, env.auth.jwtSecret) as { sub?: string; trust?: string };
      if (!p.sub || !p.trust || p.trust !== (await this.deviceStamp(userId))) return false;
      // Remembered by this person in any of their workspaces: the device
      // passed the second factor they all share.
      return p.sub === userId || (await this.store.listMemberships(userId)).some((m) => m.user.id === p.sub);
    } catch {
      return false;
    }
  }

  /** Change a user's password after re-verifying the current one. Returns false
   *  if the current password is wrong (or the account has no password set). */
  async changePassword(userId: string, current: string, next: string): Promise<boolean> {
    const hash = await this.store.getPasswordHash(userId);
    if (!hash || !(await bcrypt.compare(current, hash))) return false;
    await this.store.setUserPassword(userId, next);
    return true;
  }
}
