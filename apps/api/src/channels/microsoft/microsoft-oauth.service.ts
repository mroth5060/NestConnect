import { Injectable, Logger } from "@nestjs/common";
import jwt from "jsonwebtoken";
import type { Inbox } from "@ding/schemas";
import { env } from "../../config/env";
import { Store } from "../../data/store";

/** AppSetting keys holding the org's Microsoft (Entra ID) app registration. */
export const MICROSOFT_CLIENT_ID_KEY = "microsoft_client_id";
export const MICROSOFT_CLIENT_SECRET_KEY = "microsoft_client_secret";
/** The directory (tenant) id, or "organizations" for any work account. */
export const MICROSOFT_TENANT_ID_KEY = "microsoft_tenant_id";

/** channelConfig keys on a connected Outlook inbox. */
export const OUTLOOK_CONFIG = {
  provider: "provider",
  /** The address mail is read from and sent as — a shared mailbox when one was named. */
  email: "email",
  /** Set when the inbox is a shared mailbox reached through the signed-in user. */
  sharedMailbox: "sharedMailbox",
  accessToken: "providerToken",
  refreshToken: "refreshToken",
  tokenExpiry: "tokenExpiry",
  /** receivedDateTime of the newest message seen, per folder. */
  inboxCursor: "inboxCursor",
  sentCursor: "sentCursor",
  /** Graph ids already handled AT the cursor instant, so `ge` doesn't redo them. */
  inboxCursorIds: "inboxCursorIds",
  sentCursorIds: "sentCursorIds",
} as const;

/** Refresh an access token this many ms before it actually expires. */
const TOKEN_REFRESH_BUFFER_MS = 60_000;

/**
 * Delegated Graph scopes. The `.Shared` pair lets one person connect a shared
 * mailbox (support@, orders@) they have Full Access / Send As on — which is how
 * most Microsoft 365 businesses run a team address. None needs admin consent
 * unless the tenant has turned user consent off.
 */
const OUTLOOK_SCOPES = [
  "openid",
  "email",
  "profile",
  "offline_access",
  "User.Read",
  "Mail.Read",
  "Mail.Send",
  "Mail.Read.Shared",
  "Mail.Send.Shared",
].join(" ");

export interface MicrosoftOAuthState {
  userId: string;
  orgId: string;
  /** Shared mailbox to connect instead of the signer's own, if any. */
  mailbox?: string;
}

export interface MicrosoftTokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
}

/**
 * Drives "Connect with Microsoft" for Outlook / Microsoft 365 mailboxes. The
 * app registration's id/secret/tenant live in AppSettings (Settings › Setup).
 *
 * When `MICROSOFT_OAUTH_MOCK=true` the exchange is faked so the popup →
 * connected loop works with no real Microsoft credentials (local/dev).
 */
@Injectable()
export class MicrosoftOAuthService {
  private readonly logger = new Logger(MicrosoftOAuthService.name);

  constructor(private readonly store: Store) {}

  get isMock(): boolean {
    return process.env.MICROSOFT_OAUTH_MOCK === "true";
  }

  private async credentials(orgId: string): Promise<{ clientId: string; clientSecret: string; tenant: string }> {
    const [clientId, clientSecret, tenant] = await Promise.all([
      this.store.getAppSetting(orgId, MICROSOFT_CLIENT_ID_KEY),
      this.store.getAppSetting(orgId, MICROSOFT_CLIENT_SECRET_KEY),
      this.store.getAppSetting(orgId, MICROSOFT_TENANT_ID_KEY),
    ]);
    return {
      clientId: (clientId ?? "").trim(),
      clientSecret: (clientSecret ?? "").trim(),
      tenant: (tenant ?? "").trim() || "organizations",
    };
  }

  /** The stored (non-secret) client id, or "" if unset. */
  async clientId(orgId: string): Promise<string> {
    return (await this.store.getAppSetting(orgId, MICROSOFT_CLIENT_ID_KEY))?.trim() ?? "";
  }

  /** The stored tenant id, or "" (meaning "organizations") if unset. */
  async tenantId(orgId: string): Promise<string> {
    return (await this.store.getAppSetting(orgId, MICROSOFT_TENANT_ID_KEY))?.trim() ?? "";
  }

  /** True once both the client id AND secret are set — i.e. we can run the flow. */
  async configured(orgId: string): Promise<boolean> {
    const { clientId, clientSecret } = await this.credentials(orgId);
    return Boolean(clientId && clientSecret);
  }

  signState(state: MicrosoftOAuthState): string {
    return jwt.sign({ ...state }, env.auth.jwtSecret, { expiresIn: 600 });
  }

  verifyState(token: string): MicrosoftOAuthState {
    const payload = jwt.verify(token, env.auth.jwtSecret) as jwt.JwtPayload & Partial<MicrosoftOAuthState>;
    if (!payload.userId || !payload.orgId) throw new Error("Invalid OAuth state");
    return { userId: payload.userId, orgId: payload.orgId, mailbox: payload.mailbox || undefined };
  }

  async authUrl(orgId: string, redirectUri: string, state: string): Promise<string> {
    if (this.isMock) return `${redirectUri}?code=mock-code&state=${encodeURIComponent(state)}`;
    const { clientId, tenant } = await this.credentials(orgId);
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      response_mode: "query",
      scope: OUTLOOK_SCOPES,
      // Let the admin pick which account to connect rather than silently reusing
      // whichever Microsoft session the browser happens to hold.
      prompt: "select_account",
      state,
    });
    return `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize?${params}`;
  }

  async exchangeCode(orgId: string, code: string, redirectUri: string): Promise<MicrosoftTokenSet> {
    if (this.isMock) return { accessToken: "mock-access-token", refreshToken: "mock-refresh-token", expiresIn: 3600 };
    return this.token(orgId, { grant_type: "authorization_code", code, redirect_uri: redirectUri });
  }

  /**
   * Exchange a refresh token for a fresh access token. Microsoft ROTATES refresh
   * tokens — the response carries a new one, and the old one eventually stops
   * working — so callers must persist the returned refreshToken when present.
   */
  async refresh(orgId: string, refreshToken: string): Promise<MicrosoftTokenSet> {
    if (this.isMock) return { accessToken: "mock-access-token", refreshToken, expiresIn: 3600 };
    return this.token(orgId, { grant_type: "refresh_token", refresh_token: refreshToken });
  }

  private async token(orgId: string, grant: Record<string, string>): Promise<MicrosoftTokenSet> {
    const { clientId, clientSecret, tenant } = await this.credentials(orgId);
    const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, scope: OUTLOOK_SCOPES, ...grant });
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
    } catch (err) {
      throw new Error(`Microsoft token request failed: ${String(err)}`);
    }
    const json = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error_description?: string;
    };
    if (!res.ok || !json.access_token) {
      // error_description is the useful part ("AADSTS65001: The user or
      // administrator has not consented…") — surface it rather than a bare status.
      const detail = json.error_description?.split("\r\n")[0] ?? "";
      throw new Error(`Microsoft token request failed (${res.status})${detail ? `: ${detail}` : ""}`);
    }
    return { accessToken: json.access_token, refreshToken: json.refresh_token, expiresIn: json.expires_in ?? 3600 };
  }

  /** The signed-in account's address (mail, else its sign-in name). */
  async getEmail(accessToken: string): Promise<string> {
    if (this.isMock) return "demo.outlook@hermolis.com";
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await fetch("https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName", {
        headers: { authorization: `Bearer ${accessToken}` },
      });
    } catch (err) {
      throw new Error(`Microsoft profile request failed: ${String(err)}`);
    }
    if (!res.ok) throw new Error(`Microsoft profile request failed (${res.status})`);
    const json = (await res.json()) as { mail?: string | null; userPrincipalName?: string };
    const email = json.mail || json.userPrincipalName;
    if (!email) throw new Error("Microsoft profile has no email address");
    return email.toLowerCase();
  }

  /**
   * A currently-valid access token for a connected Outlook inbox, refreshing
   * (and persisting the rotated refresh token) when the stored one is stale.
   */
  async accessTokenForInbox(inbox: Inbox, config: Record<string, string>): Promise<string> {
    if (this.isMock) return "mock-access-token";
    const stored = config[OUTLOOK_CONFIG.accessToken];
    const expiresAt = Date.parse(config[OUTLOOK_CONFIG.tokenExpiry] ?? "") || 0;
    if (stored && Date.now() < expiresAt - TOKEN_REFRESH_BUFFER_MS) return stored;
    const refreshToken = config[OUTLOOK_CONFIG.refreshToken];
    if (!refreshToken) throw new Error(`Outlook inbox ${inbox.id} has no refresh token — reconnect the channel`);
    const fresh = await this.refresh(inbox.orgId, refreshToken);
    const update: Record<string, string> = {
      [OUTLOOK_CONFIG.accessToken]: fresh.accessToken,
      [OUTLOOK_CONFIG.tokenExpiry]: new Date(Date.now() + fresh.expiresIn * 1000).toISOString(),
    };
    if (fresh.refreshToken) update[OUTLOOK_CONFIG.refreshToken] = fresh.refreshToken;
    await this.store.updateInbox(inbox.id, { channelConfig: update });
    // Later reads in this pass should see the new values too.
    Object.assign(config, update);
    this.logger.log(`Refreshed Outlook access token for inbox ${inbox.id}`);
    return fresh.accessToken;
  }
}
