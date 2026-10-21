import { Controller, Get, HttpCode, Post, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { Public } from "../../auth/public.decorator";
import { CurrentUserId } from "../../auth/current-user.decorator";
import { Store } from "../../data/store";
import { MicrosoftOAuthService, OUTLOOK_CONFIG } from "./microsoft-oauth.service";
import { OutlookSyncService } from "./outlook-sync.service";
import { graph, mailboxPath } from "./graph-api";
import { microsoftRedirectUri } from "./redirect-uri";

/** The message the popup posts back to the opener window. */
interface OAuthMessage {
  source: "ding-oauth";
  ok: boolean;
  provider?: string;
  email?: string;
  error?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

@Controller("channels/microsoft")
export class MicrosoftController {
  constructor(
    private readonly microsoft: MicrosoftOAuthService,
    private readonly store: Store,
    private readonly outlookSync: OutlookSyncService,
  ) {}

  /**
   * Kick off the consent flow in the (same-origin, authenticated) popup.
   * `?mailbox=` names a shared mailbox to connect through the signer's account;
   * without it, the signer's own mailbox is connected.
   */
  @Get("oauth/start")
  async start(
    @CurrentUserId() userId: string,
    @Query("mailbox") mailbox: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const user = await this.store.getUser(userId);
    if (!user) return this.sendResult(res, { source: "ding-oauth", ok: false, error: "Not signed in" });
    if (user.role !== "admin" && user.role !== "manager") {
      return this.sendResult(res, { source: "ding-oauth", ok: false, error: "Only admins and managers can add channels" });
    }
    if (!(await this.microsoft.configured(user.orgId))) {
      return this.sendResult(res, {
        source: "ding-oauth",
        ok: false,
        error: "Microsoft credentials not set — add them in Settings › Setup",
      });
    }
    const shared = mailbox?.trim().toLowerCase() || undefined;
    if (shared && !EMAIL_RE.test(shared)) {
      return this.sendResult(res, { source: "ding-oauth", ok: false, error: `“${shared}” isn't an email address` });
    }
    const state = this.microsoft.signState({ userId: user.id, orgId: user.orgId, mailbox: shared });
    res.redirect(302, await this.microsoft.authUrl(user.orgId, microsoftRedirectUri(req), state));
  }

  /** Microsoft's redirect target. Public — the user is recovered from the signed state. */
  @Public()
  @Get("oauth/callback")
  async callback(
    @Query("code") code: string | undefined,
    @Query("state") state: string | undefined,
    @Query("error_description") errorDescription: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    try {
      // A refused consent comes back here with an error instead of a code.
      if (errorDescription) throw new Error(errorDescription.split("\r\n")[0]);
      if (!code) throw new Error("Missing authorization code");
      if (!state) throw new Error("Missing state");
      const { orgId, mailbox } = this.microsoft.verifyState(state);

      const tokens = await this.microsoft.exchangeCode(orgId, code, microsoftRedirectUri(req));
      const signer = await this.microsoft.getEmail(tokens.accessToken);
      const email = mailbox ?? signer;

      if (!this.microsoft.isMock) {
        // Prove the token can read this mailbox before creating anything — a
        // shared mailbox the signer has no access to fails here, with a reason,
        // rather than leaving a channel behind that fails on every poll.
        try {
          await graph.listSince(tokens.accessToken, mailboxPath(mailbox), "inbox", new Date().toISOString());
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err);
          throw new Error(
            mailbox
              ? `Signed in as ${signer}, but couldn't open ${mailbox}. Check that ${signer} has Full Access and Send As on it in Exchange. (${why})`
              : why,
          );
        }
      }

      const channelConfig: Record<string, string> = {
        [OUTLOOK_CONFIG.provider]: "outlook",
        [OUTLOOK_CONFIG.email]: email,
        [OUTLOOK_CONFIG.sharedMailbox]: mailbox ?? "",
        [OUTLOOK_CONFIG.accessToken]: tokens.accessToken,
        [OUTLOOK_CONFIG.tokenExpiry]: new Date(Date.now() + tokens.expiresIn * 1000).toISOString(),
      };
      if (tokens.refreshToken) channelConfig[OUTLOOK_CONFIG.refreshToken] = tokens.refreshToken;

      // Reconnecting the same address refreshes the existing channel instead of
      // creating a duplicate inbox.
      const existing = (await this.store.listInboxes()).find(
        (i) => i.type === "email" && i.handle.toLowerCase() === email.toLowerCase(),
      );
      const inbox = existing
        ? ((await this.store.updateInbox(existing.id, { channelConfig })) ?? existing)
        : // Created unrouted on purpose: the admin picks the team(s) right after
          // connecting (the UI opens the channel editor).
          await this.store.createInbox({
            orgId,
            type: "email",
            name: email,
            handle: email,
            teamIds: [],
            routingStrategy: "manual",
            channelConfig,
          });

      // Start the cursors at now: only mail arriving from here on is pulled in.
      if (!this.microsoft.isMock) await this.outlookSync.establishBaseline(inbox);

      this.sendResult(res, { source: "ding-oauth", ok: true, provider: "outlook", email });
    } catch (err) {
      this.sendResult(res, {
        source: "ding-oauth",
        ok: false,
        error: err instanceof Error ? err.message : "Microsoft connection failed",
      });
    }
  }

  /** On-demand sync — the "pull to refresh" path. Authed. */
  @Post("sync")
  @HttpCode(200)
  async sync(): Promise<{ ok: boolean; synced: number }> {
    return { ok: true, synced: await this.outlookSync.syncAll() };
  }

  /** The tiny HTML page that posts the result to the opener and closes. */
  private sendResult(res: Response, message: OAuthMessage): void {
    const payload = JSON.stringify(message).replace(/</g, "\\u003c");
    const fallback = message.ok
      ? "Connected — you can close this window."
      : `Couldn't connect: ${message.error ?? "unknown error"}`;
    const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Microsoft connection</title></head>
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

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
