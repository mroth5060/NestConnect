import { Injectable, Logger } from "@nestjs/common";
import jwt from "jsonwebtoken";
import { env } from "../../config/env";
import { Store } from "../../data/store";

/** AppSetting keys holding the org's Meta (Facebook) app credentials. */
export const META_APP_ID_KEY = "meta_app_id";
export const META_APP_SECRET_KEY = "meta_app_secret";
/** Optional Embedded Signup configuration id (from the Meta app's WhatsApp setup). */
export const META_CONFIG_ID_KEY = "meta_config_id";

/** channelConfig keys on a WhatsApp inbox connected via Meta. */
export const META_CONFIG = {
  provider: "provider",
  phoneNumberId: "phoneNumberId",
  accessToken: "accessToken",
  wabaId: "wabaId",
  displayNumber: "displayNumber",
} as const;

const GRAPH = "https://graph.facebook.com/v21.0";
/** Permissions needed to manage + message from a WhatsApp Business number. */
const META_SCOPES = ["whatsapp_business_management", "whatsapp_business_messaging", "business_management"].join(",");

export interface MetaState {
  userId: string;
  orgId: string;
}

export interface DiscoveredNumber {
  wabaId: string;
  phoneNumberId: string;
  displayNumber: string;
  verifiedName?: string;
}

/**
 * Drives the Meta "Connect with Facebook" OAuth flow that hooks up a WhatsApp
 * Business number. The app's own id/secret live per-org in AppSettings (Settings
 * › Setup). When `META_OAUTH_MOCK=true` the whole exchange is faked so the popup
 * → connected loop works with no real Meta credentials.
 */
@Injectable()
export class MetaOAuthService {
  private readonly logger = new Logger(MetaOAuthService.name);

  constructor(private readonly store: Store) {}

  get isMock(): boolean {
    return process.env.META_OAUTH_MOCK === "true";
  }

  private async credentials(orgId: string): Promise<{ appId: string; appSecret: string; configId: string }> {
    const [appId, appSecret, configId] = await Promise.all([
      this.store.getAppSetting(orgId, META_APP_ID_KEY),
      this.store.getAppSetting(orgId, META_APP_SECRET_KEY),
      this.store.getAppSetting(orgId, META_CONFIG_ID_KEY),
    ]);
    return {
      appId: (appId ?? "").trim(),
      appSecret: (appSecret ?? "").trim(),
      configId: (configId ?? "").trim(),
    };
  }

  /** The stored (non-secret) app id, or "" if unset. */
  async appId(orgId: string): Promise<string> {
    return (await this.store.getAppSetting(orgId, META_APP_ID_KEY))?.trim() ?? "";
  }

  /** The stored Embedded Signup config id, or "" if unset. */
  async configId(orgId: string): Promise<string> {
    return (await this.store.getAppSetting(orgId, META_CONFIG_ID_KEY))?.trim() ?? "";
  }

  /** True once both the app id AND secret are set — i.e. we can run the flow. */
  async configured(orgId: string): Promise<boolean> {
    const { appId, appSecret } = await this.credentials(orgId);
    return Boolean(appId && appSecret);
  }

  signState(state: MetaState): string {
    return jwt.sign({ userId: state.userId, orgId: state.orgId }, env.auth.jwtSecret, { expiresIn: 600 });
  }

  verifyState(token: string): MetaState {
    const payload = jwt.verify(token, env.auth.jwtSecret) as jwt.JwtPayload & Partial<MetaState>;
    if (!payload.userId || !payload.orgId) throw new Error("Invalid Meta OAuth state");
    return { userId: payload.userId, orgId: payload.orgId };
  }

  /**
   * The Facebook consent URL. In mock mode we skip Facebook and point straight
   * back at our own callback with a fake code. A configured Embedded Signup id
   * turns the dialog into the guided WhatsApp onboarding.
   */
  async authUrl(orgId: string, redirectUri: string, state: string): Promise<string> {
    if (this.isMock) {
      return `${redirectUri}?code=mock-code&state=${encodeURIComponent(state)}`;
    }
    const { appId, configId } = await this.credentials(orgId);
    const params = new URLSearchParams({
      client_id: appId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: META_SCOPES,
      state,
    });
    if (configId) {
      // Embedded Signup: launch the guided WhatsApp onboarding.
      params.set("config_id", configId);
      params.set("override_default_response_type", "true");
    }
    return `https://www.facebook.com/v21.0/dialog/oauth?${params.toString()}`;
  }

  /** Exchange the authorization code for an access token. */
  async exchangeCode(orgId: string, code: string, redirectUri: string): Promise<string> {
    if (this.isMock) return "mock-meta-token";
    const { appId, appSecret } = await this.credentials(orgId);
    const params = new URLSearchParams({
      client_id: appId,
      client_secret: appSecret,
      redirect_uri: redirectUri,
      code,
    });
    const res = await this.fetchJson<{ access_token?: string }>(
      `${GRAPH}/oauth/access_token?${params.toString()}`,
      "token exchange",
    );
    if (!res.access_token) throw new Error("Meta token response missing access_token");
    return res.access_token;
  }

  /**
   * Find the first WhatsApp Business number the token can manage: walk the
   * user's businesses → owned/client WABAs → phone numbers.
   */
  async discoverNumber(accessToken: string): Promise<DiscoveredNumber> {
    if (this.isMock) {
      return { wabaId: "waba_mock", phoneNumberId: "pn_mock", displayNumber: "+44 20 7946 0999", verifiedName: "Hermolis" };
    }
    const businesses = await this.fetchJson<{ data?: Array<{ id: string }> }>(
      `${GRAPH}/me/businesses?access_token=${encodeURIComponent(accessToken)}`,
      "list businesses",
    );
    for (const biz of businesses.data ?? []) {
      for (const edge of ["owned_whatsapp_business_accounts", "client_whatsapp_business_accounts"]) {
        const wabas = await this.fetchJson<{ data?: Array<{ id: string }> }>(
          `${GRAPH}/${biz.id}/${edge}?access_token=${encodeURIComponent(accessToken)}`,
          "list WABAs",
        ).catch(() => ({ data: [] }));
        for (const waba of wabas.data ?? []) {
          const phones = await this.fetchJson<{
            data?: Array<{ id: string; display_phone_number?: string; verified_name?: string }>;
          }>(
            `${GRAPH}/${waba.id}/phone_numbers?access_token=${encodeURIComponent(accessToken)}`,
            "list phone numbers",
          ).catch(() => ({ data: [] }));
          const phone = phones.data?.[0];
          if (phone) {
            return {
              wabaId: waba.id,
              phoneNumberId: phone.id,
              displayNumber: phone.display_phone_number ?? phone.id,
              verifiedName: phone.verified_name,
            };
          }
        }
      }
    }
    throw new Error("No WhatsApp Business number found on this account");
  }

  /** Subscribe our app to the WABA so inbound messages hit our webhook. */
  async subscribeApp(wabaId: string, accessToken: string): Promise<void> {
    if (this.isMock) return;
    try {
      await this.fetchJson(`${GRAPH}/${wabaId}/subscribed_apps?access_token=${encodeURIComponent(accessToken)}`, "subscribe app", {
        method: "POST",
      });
    } catch (err) {
      // Non-fatal: the number still connects; webhooks can be subscribed later.
      this.logger.warn(`Meta subscribe_apps failed for WABA ${wabaId}: ${String(err)}`);
    }
  }

  private async fetchJson<T>(url: string, what: string, init?: RequestInit): Promise<T> {
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await fetch(url, init);
    } catch (err) {
      throw new Error(`Meta ${what} failed: ${String(err)}`);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Meta ${what} failed (${res.status}): ${detail}`);
    }
    return (await res.json()) as T;
  }
}
