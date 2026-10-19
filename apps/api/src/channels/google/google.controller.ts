import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from "@nestjs/common";
import { EMAIL_CUTOVER_DAYS } from "@ding/schemas";
import { SkipThrottle } from "@nestjs/throttler";
import type { Request, Response } from "express";
import { env } from "../../config/env";
import { Public } from "../../auth/public.decorator";
import { CurrentUserId } from "../../auth/current-user.decorator";
import { Store } from "../../data/store";
import { SandboxPolicy } from "../../tenancy/sandbox";
import { bindTenant } from "../../tenancy/tenant-scope";
import { GMAIL_CONFIG, GoogleOAuthService } from "./google-oauth.service";
import { GmailSyncService } from "./gmail-sync.service";
import { googleRedirectUri } from "./redirect-uri";

/** Pub/Sub push delivery envelope (base64 `data` carries the Gmail notice). */
interface PubSubPushBody {
  message?: { data?: string; messageId?: string };
  subscription?: string;
}

/** The message the popup posts back to the opener window. */
interface OAuthMessage {
  source: "ding-oauth";
  ok: boolean;
  provider?: string;
  email?: string;
  /** An existing channel signed in again, rather than a new one added. */
  reconnected?: boolean;
  /** The channel this connected, so the page opens its settings by id. */
  inboxId?: string;
  error?: string;
}

@Controller("channels/google")
export class GoogleController {
  constructor(
    private readonly google: GoogleOAuthService,
    private readonly store: Store,
    private readonly gmailSync: GmailSyncService,
    private readonly sandbox: SandboxPolicy,
  ) {}

  /**
   * Kick off the consent flow. Same-origin popup, so the session cookie is sent
   * and the route stays authenticated. Redirects to Google (or, in mock mode,
   * straight back to our own callback).
   */
  @Get("oauth/start")
  async start(
    @CurrentUserId() userId: string,
    @Req() req: Request,
    @Res() res: Response,
    /** Sign this existing channel in again, keeping everything on it. */
    @Query("inboxId") inboxId?: string,
    /** "skip": reconnect without bringing in the email that arrived while it
     *  was signed out. By default it's brought in. */
    @Query("missed") missed?: string,
  ): Promise<void> {
    const redirectUri = googleRedirectUri(req);
    const user = await this.store.getUser(userId);
    if (!user) {
      this.sendResult(res, { source: "ding-oauth", ok: false, error: "Not signed in" });
      return;
    }
    // The demo workspace answers first: there, nobody connects anything, and
    // that's the reason worth giving.
    if (await this.sandbox.current()) {
      this.sendResult(res, { source: "ding-oauth", ok: false, error: "Connecting channels isn't available in the demo workspace" });
      return;
    }
    // Connecting a mailbox is setting up a channel: managers and admins, as adding one is.
    if (user.role !== "admin" && user.role !== "manager") {
      this.sendResult(res, { source: "ding-oauth", ok: false, error: "Only managers and admins can connect channels" });
      return;
    }
    const reconnecting = inboxId ? await this.store.getInbox(inboxId) : undefined;
    if (inboxId && (!reconnecting || reconnecting.type !== "email")) {
      this.sendResult(res, { source: "ding-oauth", ok: false, error: "That email channel no longer exists" });
      return;
    }
    if (!(await this.google.configured(user.orgId))) {
      this.sendResult(res, {
        source: "ding-oauth",
        ok: false,
        error: "Google credentials not set — add them in Settings › Setup",
      });
      return;
    }
    const state = this.google.signState({
      userId: user.id,
      orgId: user.orgId,
      ...(reconnecting ? { inboxId: reconnecting.id, skipMissed: missed === "skip" } : {}),
    });
    const authUrl = await this.google.authUrl(user.orgId, redirectUri, state, reconnecting?.handle);
    res.redirect(302, authUrl);
  }

  /**
   * Google's redirect target. Public — Google's redirect carries no session
   * cookie, so the initiating user is recovered from the signed `state` instead.
   */
  @Public()
  @Get("oauth/callback")
  async callback(
    @Query("code") code: string | undefined,
    @Query("state") state: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    try {
      if (!code) throw new Error("Missing authorization code");
      if (!state) throw new Error("Missing state");
      const { userId, orgId, inboxId, skipMissed } = this.google.verifyState(state);
      void userId; // bound for CSRF/user verification; teams drive routing below
      // The redirect carries no session; the signed state says whose workspace
      // started the flow, and the rest of it acts there.
      bindTenant(orgId);
      await this.sandbox.assertLive("Connecting a channel");

      const redirectUri = googleRedirectUri(req);
      const { accessToken, refreshToken, expiresIn } = await this.google.exchangeCode(
        orgId,
        code,
        redirectUri,
      );
      const email = await this.google.getEmail(accessToken);
      // Reconnecting a channel: it has to be the same mailbox. Signing in as
      // someone else would quietly turn support@ into somebody's own inbox.
      const target = inboxId ? await this.store.getInbox(inboxId) : undefined;
      if (inboxId && !target) throw new Error("That email channel no longer exists");
      if (target && target.handle.toLowerCase() !== email.toLowerCase()) {
        throw new Error(`You signed in as ${email}, but this channel is ${target.handle}. Reconnect with ${target.handle}.`);
      }
      // One mailbox, one workspace: mail to it must never be able to match
      // inboxes in two of them.
      if (await this.store.channelKeyTaken({ emailAddress: email })) {
        throw new Error(`${email} is already connected to another workspace`);
      }

      const tokenExpiry = new Date(Date.now() + expiresIn * 1000).toISOString();
      const channelConfig: Record<string, string> = {
        [GMAIL_CONFIG.provider]: "gmail",
        [GMAIL_CONFIG.email]: email,
        [GMAIL_CONFIG.accessToken]: accessToken,
        [GMAIL_CONFIG.tokenExpiry]: tokenExpiry,
        // Signed in again: whatever signed it out no longer applies.
        [GMAIL_CONFIG.authError]: "",
        [GMAIL_CONFIG.authErrorAt]: "",
      };
      // Google only returns a refresh token on first consent — keep the old one
      // (already stored) rather than overwriting it with an empty value.
      if (refreshToken) channelConfig[GMAIL_CONFIG.refreshToken] = refreshToken;

      // Reconnecting the same address refreshes the existing channel's tokens
      // instead of creating a duplicate inbox.
      const existing =
        target ??
        (await this.store.listInboxes()).find((i) => i.type === "email" && i.handle.toLowerCase() === email.toLowerCase());
      let inbox;
      // Where the last sync got to, before this sign-in: a reconnect catches up
      // from there. And when Google signed it out — read now, as signing in
      // clears it — for the mail Gmail's history no longer reaches back to.
      const before = existing ? await this.store.getInboxConfig(existing.id) : undefined;
      const resumeFrom = before?.[GMAIL_CONFIG.historyId];
      const signedOutAt = before?.[GMAIL_CONFIG.authErrorAt] ? new Date(before[GMAIL_CONFIG.authErrorAt]!) : undefined;
      if (existing) {
        inbox = (await this.store.updateInbox(existing.id, { channelConfig })) ?? existing;
      } else {
        // Created unrouted on purpose: the admin picks the team(s) + strategy
        // right after connecting (the UI opens the channel editor), rather than
        // blindly routing new mail to every team.
        inbox = await this.store.createInbox({
          orgId,
          type: "email",
          name: email,
          handle: email,
          teamIds: [],
          routingStrategy: "manual",
          channelConfig,
        });
      }

      // Record the history cursor now so the first poll only picks up mail that
      // arrives after connect — no full-mailbox backfill — and arm push if the
      // org has a Pub/Sub topic configured. (Real mode only.)
      //
      // A reconnect does neither: it picks up from where the mailbox stopped,
      // so mail that arrived while it was signed out still comes in — unless
      // whoever reconnected chose to start from now.
      if (!this.google.isMock) {
        if (resumeFrom && !skipMissed) {
          await this.gmailSync.catchUp(inbox, signedOutAt && !Number.isNaN(signedOutAt.getTime()) ? signedOutAt : undefined);
        } else {
          await this.gmailSync.establishBaseline(inbox, accessToken);
        }
        await this.gmailSync.armWatch(inbox, accessToken);
      }

      this.sendResult(res, { source: "ding-oauth", ok: true, provider: "gmail", email, reconnected: !!existing, inboxId: inbox.id });
    } catch (err) {
      this.sendResult(res, {
        source: "ding-oauth",
        ok: false,
        error: err instanceof Error ? err.message : "Google connection failed",
      });
    }
  }

  /**
   * Gmail push notifications, delivered by Google Cloud Pub/Sub. The payload
   * carries the affected mailbox address; we ack immediately and sync it in the
   * background so Pub/Sub doesn't retry. Optionally guarded by a shared ?token=.
   */
  @Public()
  @SkipThrottle() // Pub/Sub push can burst; guarded by the shared token
  @Post("push")
  @HttpCode(200)
  async push(
    @Body() body: PubSubPushBody,
    @Query("token") token?: string,
  ): Promise<{ ok: boolean }> {
    // A forged push can at worst trigger a re-sync of a mailbox we already own
    // (via our stored OAuth token; ingest is idempotent) — it can't inject
    // content the way the WhatsApp/Postmark webhooks could — so we don't hard-fail
    // when no token is set. When a shared ?token= IS configured, require it.
    if (env.gmail.pushToken && token !== env.gmail.pushToken) {
      throw new UnauthorizedException("Invalid push token");
    }
    const data = body?.message?.data;
    if (!data) return { ok: true }; // subscription verification / empty control message
    let notice: { emailAddress?: string; historyId?: string };
    try {
      notice = JSON.parse(Buffer.from(data, "base64").toString("utf8"));
    } catch {
      return { ok: true }; // malformed — ack so Pub/Sub stops retrying
    }
    if (notice.emailAddress) {
      // Fire-and-forget: ack fast, sync out of band.
      void this.gmailSync.syncInboxByEmail(notice.emailAddress).catch(() => undefined);
    }
    return { ok: true };
  }

  /**
   * On-demand Gmail sync — the "pull to refresh" path. Pulls any new mail now
   * so the caller can refetch and see it immediately. No-op in mock mode / when
   * no Gmail inbox is connected. Authed (not public).
   */
  @Post("sync")
  @HttpCode(200)
  async sync(): Promise<{ ok: boolean; synced: number }> {
    const synced = await this.gmailSync.syncAll();
    return { ok: true, synced };
  }

  /**
   * Bring in the email a connected Gmail channel received or sent since a
   * moment — for a gap a reconnect didn't cover (one made before it could, or
   * a mailbox out for longer than Gmail keeps its history). Starts the sweep and
   * answers at once; the mail arrives in the inbox as it's read. What's
   * already here is skipped. Managers and admins, as reconnecting is.
   */
  @Post("inboxes/:id/missed")
  @HttpCode(202)
  async pullMissed(
    @CurrentUserId() userId: string,
    @Param("id") id: string,
    @Body() body: { since?: string },
  ): Promise<{ ok: true; since: string }> {
    // The demo workspace answers first, as connecting does.
    await this.sandbox.assertLive("Bringing in email");
    const user = await this.store.getUser(userId);
    if (!user || (user.role !== "admin" && user.role !== "manager")) {
      throw new ForbiddenException("Only managers and admins can do this");
    }
    const inbox = await this.store.getInbox(id);
    const config = inbox?.type === "email" ? await this.store.getInboxConfig(inbox.id) : undefined;
    if (!inbox || config?.[GMAIL_CONFIG.provider] !== "gmail") throw new NotFoundException("That Gmail channel no longer exists");
    if (config[GMAIL_CONFIG.authError]) throw new BadRequestException("Reconnect the mailbox first");
    const since = new Date(body?.since ?? "");
    const earliest = Date.now() - EMAIL_CUTOVER_DAYS * 24 * 60 * 60 * 1000;
    if (Number.isNaN(since.getTime()) || since.getTime() > Date.now()) throw new BadRequestException("Pick a date in the past");
    if (since.getTime() < earliest) throw new BadRequestException(`It can reach back ${EMAIL_CUTOVER_DAYS} days at most`);
    if (!this.google.isMock) void this.gmailSync.sweepMissed(inbox, since);
    return { ok: true, since: since.toISOString() };
  }

  /** Render the tiny HTML page that posts the result to the opener and closes. */
  private sendResult(res: Response, message: OAuthMessage): void {
    const payload = JSON.stringify(message).replace(/</g, "\\u003c");
    const fallback = message.ok
      ? "Connected — you can close this window."
      : `Couldn't connect: ${message.error ?? "unknown error"}`;
    const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Google connection</title></head>
<body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;color:#1c2b24;background:#f6f8f7">
<main style="text-align:center;padding:24px;max-width:340px">
<p style="font-size:15px;line-height:1.5">${escapeHtml(fallback)}</p>
</main>
<script>
(function () {
  var msg = ${payload};
  try { if (window.opener) window.opener.postMessage(msg, "*"); } catch (e) {}
  window.close();
})();
</script>
</body>
</html>`;
    res.set("Content-Type", "text/html; charset=utf-8").send(html);
  }
}

/** Escape user-facing text placed into the HTML fallback body. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
