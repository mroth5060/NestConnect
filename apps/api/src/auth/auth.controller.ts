import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request, Response } from "express";
import {
  changePasswordInputSchema,
  forgotPasswordInputSchema,
  loginInputSchema,
  setPasswordInputSchema,
  switchWorkspaceInputSchema,
  twoFactorCodeInputSchema,
  type ChangePasswordInput,
  type ForgotPasswordInput,
  type LoginInput,
  type SetPasswordInput,
  type MyWorkspaces,
  type SessionGrant,
  type SwitchWorkspaceInput,
  type TwoFactorChallenge,
  type TwoFactorCodeInput,
  type User,
} from "@ding/schemas";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { Store } from "../data/store";
import { env } from "../config/env";
import { bindTenant, runInTenant } from "../tenancy/tenant-scope";
import { isPlatformOwner } from "../tenancy/platform-owner";
import { isPlatformOrg } from "../tenancy/platform";
import { isWorkspaceFrozen, WorkspaceFrozenError } from "../tenancy/workspace-status";
import { SandboxPolicy } from "../tenancy/sandbox";
import { AuthService, TRUSTED_DEVICE_TTL_S } from "./auth.service";
import { SessionService } from "./session.service";
import { TwoFactorService } from "./two-factor.service";
import { Mailer } from "../mail/mailer.service";
import { Public } from "./public.decorator";
import { EnrolmentAllowed } from "./enrolment-allowed.decorator";
import { CurrentUserId, CurrentSessionId } from "./current-user.decorator";

/** Cookie carrying the half-authenticated "2FA pending" token (password OK,
 *  awaiting a code). Distinct from the real session cookie. */
const PENDING_COOKIE = `${env.auth.cookieName}_2fa`;

/** Cookie remembering that this browser passed the second factor, so sign-in
 *  skips the code for 30 days. Kept through sign-out — that is the point. */
const TRUSTED_COOKIE = `${env.auth.cookieName}_trusted`;

/** Session cookie options — shared by login and set-password. */
function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: env.isProd,
    maxAge: env.auth.ttlSeconds * 1000,
    path: "/",
  };
}

/** Client IP (first X-Forwarded-For hop behind Railway's proxy) + User-Agent. */
function clientMeta(req: Request): { ip?: string; userAgent?: string } {
  const xff = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim();
  const ip = xff || req.ip || req.socket?.remoteAddress || undefined;
  const userAgent = (req.headers["user-agent"] as string | undefined) || undefined;
  return { ip, userAgent };
}

function readCookie(req: Request, name: string): string | undefined {
  return (req as Request & { cookies?: Record<string, string> }).cookies?.[name];
}

/** The session token as a native client sends it — `Authorization: Bearer <jwt>`. */
function readBearer(req: Request): string | undefined {
  const header = req.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
}

@Controller("auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly twoFactor: TwoFactorService,
    private readonly store: Store,
    private readonly mailer: Mailer,
    private readonly sandbox: SandboxPolicy,
  ) {}

  /**
   * Start a real session for a fully-authenticated user.
   *
   * Browsers get the httpOnly cookie — unchanged, and the right defence there.
   * Native clients ask for `tokenAuth` and get the same JWT in the body instead,
   * to keep in the Keychain: a phone has no cookie jar shared between its HTTP
   * client, its socket and a background push registration. Those tokens live
   * longer (re-authenticating a phone weekly is a real cost) and stay revocable
   * through the same `Session` row either way.
   */
  /**
   * Who you are, plus the deployment's 2FA policy. The policy rides along with
   * the session because the enrolment gate is drawn by the client: without it
   * the web app would have to assume a rule the server owns.
   *
   * Deliberately NOT called `twoFactorRequired` — that key is the discriminator
   * for a login challenge (`TwoFactorChallenge`), and reusing it here would make
   * every successful session look like one.
   */
  private async meResponse(userId: string) {
    const me = await this.store.me(userId);
    return { ...me, twoFactorEnforced: await this.sandbox.twoFactorRequired(me.user?.orgId) };
  }

  private async grantSession(userId: string, req: Request, res: Response, tokenAuth = false) {
    const sessionId = await this.sessions.create(userId, clientMeta(req));
    const ttl = tokenAuth ? env.auth.mobileTtlSeconds : env.auth.ttlSeconds;
    const token = this.auth.sign(userId, sessionId, ttl);
    const me = await this.meResponse(userId);
    if (!tokenAuth) {
      res.cookie(env.auth.cookieName, token, cookieOptions());
      return me;
    }
    const grant: SessionGrant = { token, expiresIn: ttl };
    return { ...me, ...grant };
  }

  private async requireUser(userId: string): Promise<User> {
    const me = await this.store.me(userId);
    if (!me.user) throw new UnauthorizedException("Not authenticated");
    return me.user;
  }

  /**
   * Stop at a half-authenticated state and ask for the second factor.
   *
   * Shared by the two ways into an account that start with something only the
   * person should have — their password, or a link sent to their mailbox. Both
   * have to end at the same place or the weaker one becomes the way in, which
   * is exactly what a reset link was until this was pulled out of `login`.
   *
   * The pending token is not a session: `verify` refuses it, so it opens
   * nothing on its own and expires in five minutes. `login/2fa` is what turns
   * it into a real one, and it takes a recovery code as well as a live code —
   * which is what keeps this from stranding somebody who has lost their phone
   * and their password at the same time.
   */
  private async challenge(user: User, res: Response, tokenAuth?: boolean): Promise<TwoFactorChallenge> {
    const pending = this.auth.signPending(user.id);
    if (user.twoFactorMethod === "email") await this.twoFactor.sendEmailCode(user);
    const challenge = { twoFactorRequired: true as const, method: user.twoFactorMethod ?? "totp" };
    // Token clients carry the pending token themselves and post it back.
    if (tokenAuth) return { ...challenge, pendingToken: pending };
    res.cookie(PENDING_COOKIE, pending, { ...cookieOptions(), maxAge: 5 * 60 * 1000 });
    return challenge;
  }

  @Public()
  @Post("login")
  async login(
    @Body(new ZodValidationPipe(loginInputSchema)) body: LoginInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.auth.assertNotThrottled(body.email);
    const user = await this.auth.validate(body.email, body.password);
    if (!user) throw new UnauthorizedException("Invalid email or password");

    // 2FA on → stop at a half-authenticated state; the client posts the code
    // next. Unless this device passed it within the last 30 days and asked to
    // be remembered: then the password is the whole of today's sign-in.
    if (user.twoFactorEnabled) {
      const remembered = body.trustedDeviceToken ?? readCookie(req, TRUSTED_COOKIE);
      if (await this.auth.isTrustedDevice(remembered, user.id)) {
        return this.grantSession(user.id, req, res, body.tokenAuth);
      }
      return this.challenge(user, res, body.tokenAuth);
    }
    // 2FA required but never set up: this is a real session, and the guard
    // holds it at the enrolment routes until they have one.
    return this.grantSession(user.id, req, res, body.tokenAuth);
  }

  /** Second login step: verify the 2FA code (or a recovery code) → real session. */
  @Public()
  @Post("login/2fa")
  async loginTwoFactor(
    @Body(new ZodValidationPipe(twoFactorCodeInputSchema)) body: TwoFactorCodeInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const userId = this.auth.verifyPending(body.pendingToken ?? readCookie(req, PENDING_COOKIE) ?? "");
    if (!userId || !(await this.auth.enterAccount(userId))) {
      throw new UnauthorizedException("Your sign-in expired — please start again.");
    }
    if (!(await this.twoFactor.verifyChallenge(userId, body.code))) {
      throw new UnauthorizedException("That code isn't right.");
    }
    res.clearCookie(PENDING_COOKIE, { path: "/" });
    const granted = await this.grantSession(userId, req, res, body.tokenAuth);
    if (!body.rememberDevice) return granted;
    const trusted = await this.auth.signTrustedDevice(userId);
    // A phone keeps it in its keystore and sends it with the next login; a
    // browser gets it as a cookie that script on the page cannot read.
    if (body.tokenAuth) return { ...granted, trustedDeviceToken: trusted };
    res.cookie(TRUSTED_COOKIE, trusted, { ...cookieOptions(), maxAge: TRUSTED_DEVICE_TTL_S * 1000 });
    return granted;
  }

  /** Email-method only: resend the code during the login challenge. */
  @Public()
  @Post("login/2fa/resend")
  async resendLoginCode(@Req() req: Request, @Body() body: { pendingToken?: string } = {}) {
    const userId = this.auth.verifyPending(body?.pendingToken ?? readCookie(req, PENDING_COOKIE) ?? "");
    if (!userId || !(await this.auth.enterAccount(userId))) {
      throw new UnauthorizedException("Your sign-in expired — please start again.");
    }
    const user = await this.requireUser(userId);
    if (user.twoFactorMethod === "email") await this.twoFactor.sendEmailCode(user);
    return { ok: true };
  }

  /** Set a password from an emailed link — an invite or a reset, which share the
   *  token. Signs in on the way out, or stops for the second factor when the
   *  account has one, because a mailbox is not one. */
  @Public()
  @Post("set-password")
  async setPassword(
    @Body(new ZodValidationPipe(setPasswordInputSchema)) body: SetPasswordInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const user = await this.store.setPasswordByInviteToken(body.token, body.password);
    if (!user) throw new UnauthorizedException("This invite link is invalid or has expired.");
    // The link named the account; the rest of the request acts in its workspace.
    bindTenant(user.orgId);

    // Everything the old password could reach, the new one now can — so anyone
    // still holding a session from before it changed is holding a key to a lock
    // that was supposed to have been changed. On a reset that is the whole
    // point of resetting; there is nothing to revoke on an invite.
    await this.sessions.revokeOthers(user.id, "").catch(() => 0);

    // And a link to a mailbox is not a second factor. Without this, someone who
    // could read the person's email had a way past two-factor that signing in
    // normally would have stopped — the weaker door, standing open beside the
    // one we had just finished bolting.
    if (user.twoFactorEnabled) return this.challenge(user, res);

    return this.grantSession(user.id, req, res);
  }

  /**
   * Request a password-reset link. Always responds `{ ok: true }` — we never
   * reveal whether an address has an account.
   */
  @Public()
  @Post("forgot-password")
  async forgotPassword(@Body(new ZodValidationPipe(forgotPasswordInputSchema)) body: ForgotPasswordInput) {
    // A demo workspace's shared login is reset by its setup script, never by
    // email: no link is minted and nothing is sent. Checked here because this
    // route is public — no workspace is bound, so the mailer can't tell.
    const account = await this.store.findUserByEmail(body.email);
    if (account && (await this.sandbox.isSandbox(account.orgId))) return { ok: true };
    const reset = await this.store.createPasswordResetToken(body.email);
    if (reset) {
      const url = `${env.appUrl}/?reset=${reset.token}`;
      await this.mailer.sendPasswordReset(reset.user.email, reset.user.name, url);
    }
    return { ok: true };
  }

  @Public()
  @EnrolmentAllowed()
  @Post("logout")
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // Revoking the session is what actually signs a token client out — it has no
    // cookie to clear, and its stored JWT is dead the moment the row is revoked.
    const claims = this.auth.verify(readCookie(req, env.auth.cookieName) ?? readBearer(req) ?? "");
    if (claims?.sessionId && (await this.auth.enterAccount(claims.userId))) {
      await this.sessions.revoke(claims.userId, claims.sessionId).catch(() => {});
    }
    res.clearCookie(env.auth.cookieName, { path: "/" });
    res.clearCookie(PENDING_COOKIE, { path: "/" });
    return { ok: true };
  }

  @EnrolmentAllowed()
  @Get("session")
  session(@CurrentUserId() userId: string) {
    return this.meResponse(userId);
  }

  /**
   * Roll a native client's token forward on the *same* session, so a phone in
   * daily use never gets signed out while one that goes quiet still expires.
   *
   * This is deliberately a re-issue rather than a separate refresh-token family
   * with reuse detection. The token is bound to its `Session` by the JWT `jti`
   * and the guard checks that row on every request, so revoking the session
   * kills the token within seconds — which is the property a refresh scheme
   * exists to provide. A second credential to store, rotate and leak would add
   * surface, not safety.
   *
   * The guard has already verified the caller, so reaching here means the
   * session is live; an expired or revoked token gets a 401 and the app sends
   * the person back to sign-in.
   */
  @Post("refresh")
  async refresh(
    @CurrentUserId() userId: string,
    @CurrentSessionId() sessionId?: string,
  ): Promise<SessionGrant> {
    if (!sessionId) throw new UnauthorizedException("This session can't be refreshed — sign in again.");
    const ttl = env.auth.mobileTtlSeconds;
    return { token: this.auth.sign(userId, sessionId, ttl), expiresIn: ttl };
  }

  /** Change your own password — the current one is re-verified server-side. */
  @Post("change-password")
  async changePassword(
    @CurrentUserId() userId: string,
    @Body(new ZodValidationPipe(changePasswordInputSchema)) body: ChangePasswordInput,
    @CurrentSessionId() sessionId?: string,
  ) {
    // A demo workspace's login is shared; it stays the way the setup made it.
    await this.sandbox.assertLive("Changing the demo account's sign-in");
    const ok = await this.auth.changePassword(userId, body.currentPassword, body.newPassword);
    if (!ok) throw new BadRequestException("Your current password is incorrect.");
    // The same rule as a reset, from the other side. Somebody changing their
    // password is often doing it because they think someone else has it, and
    // leaving that someone signed in on their own device is the one outcome
    // that makes the whole exercise pointless. This device keeps its session —
    // signing yourself out of the screen you are standing at would read as the
    // change having failed.
    const signedOutOthers = await this.sessions.revokeOthers(userId, sessionId ?? "").catch(() => 0);
    return { ok: true, signedOutOthers };
  }

  /* ---- one person, several workspaces ---- */

  /** The workspaces I'm in, and whether I own the platform. */
  @Get("workspaces")
  async myWorkspaces(@CurrentUserId() userId: string): Promise<MyWorkspaces> {
    // A suspended or closed workspace isn't somewhere to go.
    const places = (await this.store.listMemberships(userId)).filter((m) => m.status === "active" || m.user.id === userId);
    return {
      workspaces: places.map((m) => ({
        orgId: m.user.orgId,
        name: m.orgName,
        role: m.user.role,
        sandbox: m.sandbox,
        current: m.user.id === userId,
        platform: isPlatformOrg(m.user.orgId),
      })),
      platformOwner: await isPlatformOwner(this.store, userId),
    };
  }

  /**
   * Move into another of my workspaces: a new session as my place there, and
   * this one ended — a session is in one workspace, as everything it reads and
   * writes is. Signing in next time takes me back to wherever I last was.
   *
   * A platform owner can move into any workspace; one they aren't in yet gets
   * them as an admin there, in its people list for its own admins to see.
   */
  @Post("switch")
  async switchWorkspace(
    @CurrentUserId() userId: string,
    @Body(new ZodValidationPipe(switchWorkspaceInputSchema)) body: SwitchWorkspaceInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @CurrentSessionId() sessionId?: string,
  ) {
    // Refused before anything changes — before an owner is added to it, before
    // this session ends — so a frozen workspace never strands anyone.
    if (isWorkspaceFrozen(body.orgId)) throw new WorkspaceFrozenError(body.orgId);
    let target = await this.store.membershipIn(userId, body.orgId);
    if (!target && (await isPlatformOwner(this.store, userId))) {
      const exists = (await this.store.listWorkspaces()).some((w) => w.id === body.orgId);
      if (exists) target = await this.store.joinWorkspace(userId, body.orgId, "admin");
    }
    if (!target) throw new NotFoundException("Workspace not found");
    await this.store.rememberWorkspace(target.id);
    if (target.id === userId) return this.meResponse(userId);
    if (sessionId) await this.sessions.revoke(userId, sessionId).catch(() => false);
    const into = target;
    return runInTenant(into.orgId, () => this.grantSession(into.id, req, res, body.tokenAuth));
  }

  /* ---- signed-in sessions ("where you're logged in") ---- */

  @Get("sessions")
  listSessions(@CurrentUserId() userId: string, @CurrentSessionId() currentId?: string) {
    return this.sessions.list(userId, currentId);
  }

  @Post("sessions/revoke-others")
  async revokeOtherSessions(@CurrentUserId() userId: string, @CurrentSessionId() currentId?: string) {
    const revoked = await this.sessions.revokeOthers(userId, currentId ?? "");
    return { revoked };
  }

  @Delete("sessions/:id")
  async revokeSession(@CurrentUserId() userId: string, @Param("id") id: string) {
    const ok = await this.sessions.revoke(userId, id);
    if (!ok) throw new NotFoundException("Session not found");
    return { ok: true };
  }

  /* ---- two-factor auth ---- */

  @EnrolmentAllowed()
  @Get("2fa/status")
  twoFactorStatus(@CurrentUserId() userId: string) {
    return this.twoFactor.status(userId);
  }

  /** Begin authenticator setup → QR + manual key (not enabled until confirmed). */
  @EnrolmentAllowed()
  @Post("2fa/totp/start")
  async startTotp(@CurrentUserId() userId: string) {
    // A demo workspace's login is shared; it stays the way the setup made it.
    await this.sandbox.assertLive("Changing the demo account's sign-in");
    return this.twoFactor.startTotpSetup(await this.requireUser(userId));
  }

  @EnrolmentAllowed()
  @Post("2fa/totp/enable")
  async enableTotp(
    @CurrentUserId() userId: string,
    @Body(new ZodValidationPipe(twoFactorCodeInputSchema)) body: TwoFactorCodeInput,
  ) {
    // A demo workspace's login is shared; it stays the way the setup made it.
    await this.sandbox.assertLive("Changing the demo account's sign-in");
    const recoveryCodes = await this.twoFactor.enableTotp(userId, body.code);
    if (!recoveryCodes) throw new BadRequestException("That code isn't right — try the current one from your app.");
    return { recoveryCodes };
  }

  /** Email a code to start (or re-start) email-method setup. */
  @EnrolmentAllowed()
  @Post("2fa/email/start")
  async startEmail(@CurrentUserId() userId: string) {
    // A demo workspace's login is shared; it stays the way the setup made it.
    await this.sandbox.assertLive("Changing the demo account's sign-in");
    await this.twoFactor.sendEmailCode(await this.requireUser(userId));
    return { ok: true };
  }

  @EnrolmentAllowed()
  @Post("2fa/email/enable")
  async enableEmail(
    @CurrentUserId() userId: string,
    @Body(new ZodValidationPipe(twoFactorCodeInputSchema)) body: TwoFactorCodeInput,
  ) {
    // A demo workspace's login is shared; it stays the way the setup made it.
    await this.sandbox.assertLive("Changing the demo account's sign-in");
    const recoveryCodes = await this.twoFactor.enableEmail(userId, body.code);
    if (!recoveryCodes) throw new BadRequestException("That code isn't right or has expired.");
    return { recoveryCodes };
  }

  @Post("2fa/recovery/regenerate")
  async regenerateRecovery(@CurrentUserId() userId: string) {
    // A demo workspace's login is shared; it stays the way the setup made it.
    await this.sandbox.assertLive("Changing the demo account's sign-in");
    return { recoveryCodes: await this.twoFactor.regenerateRecoveryCodes(userId) };
  }

  @Post("2fa/disable")
  async disableTwoFactor(@CurrentUserId() userId: string) {
    // A demo workspace's login is shared; it stays the way the setup made it.
    await this.sandbox.assertLive("Changing the demo account's sign-in");
    // Where the workspace requires a second factor this puts the person back
    // behind the enrolment gate on every device, because the guard asks whether
    // the account has one rather than what a token said when it was minted. It
    // stays allowed rather than refused: turning it off is also how somebody
    // moves from email codes to an authenticator app.
    await this.twoFactor.disable(userId);
    return { ok: true };
  }
}
