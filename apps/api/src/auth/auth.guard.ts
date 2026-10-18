import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import { isWorkspaceFrozen } from "../tenancy/workspace-status";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { env } from "../config/env";
import { AuthService } from "./auth.service";
import { SessionService } from "./session.service";
import { TwoFactorService } from "./two-factor.service";
import { IS_PUBLIC_KEY } from "./public.decorator";
import { IS_ENROLMENT_ALLOWED_KEY } from "./enrolment-allowed.decorator";
import { Store } from "../data/store";
import { runInTenant } from "../tenancy/tenant-scope";
import { SandboxPolicy } from "../tenancy/sandbox";

/**
 * Global guard. Reads the session JWT from the httpOnly cookie, validates it,
 * and sets `req.userId` (+ `req.sessionId`) for the param decorators. A cookie
 * bound to a session is also checked against revocation, so a remotely
 * signed-out device is rejected on its next request. Public routes (login,
 * health, channel webhooks) are allowed through; everything else needs a session.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly twoFactor: TwoFactorService,
    private readonly store: Store,
    private readonly sandbox: SandboxPolicy,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    // Guards also wrap WebSocket message handlers — don't gate those here.
    if (ctx.getType() !== "http") return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);

    const req = ctx
      .switchToHttp()
      .getRequest<Request & { userId?: string; sessionId?: string; orgId?: string; cookies?: Record<string, string> }>();
    // Browsers send the httpOnly cookie; native clients send the same JWT as a
    // bearer token, because a phone has no cookie jar shared between its HTTP
    // client, its socket and a background push registration.
    const header = req.headers.authorization;
    const bearer = header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
    const token = req.cookies?.[env.auth.cookieName] ?? bearer;
    const claims = token ? this.auth.verify(token) : undefined;

    // The user the token names decides which workspace this request acts for.
    // Looked up across workspaces — the one lookup that has to be — and then
    // everything else, the session check included, runs inside theirs. The
    // TenantInterceptor binds the handler to the same org via `req.orgId`.
    const principal = claims ? await this.store.getUserForAuth(claims.userId) : undefined;
    // A session in a suspended or closed workspace is no session: signed out,
    // so the apps go back to signing in rather than showing a screen of errors.
    if (claims && principal && !isWorkspaceFrozen(principal.orgId)) {
      await runInTenant(principal.orgId, async () => {
        if (claims.sessionId) {
          // Session-bound cookie: honour revocation (remote sign-out). If revoked,
          // leave req.userId unset so it's treated as unauthenticated below.
          if (await this.sessions.isValid(claims.sessionId)) {
            req.userId = claims.userId;
            req.sessionId = claims.sessionId;
            this.sessions.touch(claims.sessionId);
          }
        } else {
          // Cookie minted before sessions existed — grandfathered through.
          req.userId = claims.userId;
        }
      });
      // A public route acts for whoever its own token, link or webhook names —
      // never for the workspace a browser happens to be signed in to, or a
      // Swiftee cookie would collide with a new workspace's invite link.
      if (req.userId && !isPublic) req.orgId = principal.orgId;
    }

    if (isPublic) return true;
    if (!req.userId) throw new UnauthorizedException("Not authenticated");

    /*
     * Signed in, and held there until a second factor exists.
     *
     * This is the half of mandatory two-factor the server used to leave to the
     * client. The web app draws an enrolment screen and does the right thing; a
     * caller that is not the web app — curl, the mobile app, anything holding a
     * bearer token — simply never met that screen, so a password alone was the
     * whole of the credential for everything this workspace holds. It is
     * enforced here now, where it cannot be skipped by not asking.
     *
     * The question is put to the account rather than to the token, which costs
     * a cached lookup and buys two things. Sessions handed out before this
     * existed are covered — otherwise a phone that signed in last month would
     * carry an unchallenged 60-day token well into next year. And enrolling, or
     * turning it back off, lands on every device at once instead of on whichever
     * one happened to make the change.
     */
    // Required everywhere it is switched on — except a demo workspace's shared
    // login (tenancy/sandbox.ts), where it would make the demo unreachable.
    if (await this.sandbox.twoFactorRequired(req.orgId)) {
      const allowed = this.reflector.getAllAndOverride<boolean>(IS_ENROLMENT_ALLOWED_KEY, [
        ctx.getHandler(),
        ctx.getClass(),
      ]);
      // The allowlist is checked first because it settles the enrolment routes
      // with no I/O at all — and those are the only ones a person in this state
      // is going to be calling.
      const userId = req.userId;
      if (!allowed && !(await runInTenant(req.orgId, () => this.twoFactor.isEnrolled(userId)))) {
        throw new ForbiddenException(
          "Set up two-factor authentication to finish signing in — this workspace requires it.",
        );
      }
    }
    return true;
  }
}
