import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Patch,
  Post,
  Req,
} from "@nestjs/common";
import type { Request } from "express";
import {
  updateIntegrationSettingsInputSchema,
  type IntegrationSettings,
  type UpdateIntegrationSettingsInput,
  type User,
} from "@ding/schemas";
import { Store } from "../data/store";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUserId } from "../auth/current-user.decorator";
import {
  GoogleOAuthService,
  GOOGLE_CLIENT_ID_KEY,
  GOOGLE_CLIENT_SECRET_KEY,
  GOOGLE_PUBSUB_TOPIC_KEY,
} from "../channels/google/google-oauth.service";
import { googlePushEndpoint, googleRedirectUri } from "../channels/google/redirect-uri";
import {
  MicrosoftOAuthService,
  MICROSOFT_CLIENT_ID_KEY,
  MICROSOFT_CLIENT_SECRET_KEY,
  MICROSOFT_TENANT_ID_KEY,
} from "../channels/microsoft/microsoft-oauth.service";
import { microsoftRedirectUri } from "../channels/microsoft/redirect-uri";
import {
  MetaOAuthService,
  META_APP_ID_KEY,
  META_APP_SECRET_KEY,
  META_CONFIG_ID_KEY,
} from "../channels/meta/meta-oauth.service";
import { metaRedirectUri } from "../channels/meta/redirect-uri";
import {
  r2PublicSettings,
  R2_ACCESS_KEY_ID_KEY,
  R2_ACCOUNT_ID_KEY,
  R2_BUCKET_KEY,
  R2_SECRET_ACCESS_KEY_KEY,
} from "../storage/r2-config";
import {
  resendPublicSettings,
  smtpPublicSettings,
  RESEND_API_KEY_KEY,
  RESEND_FROM_KEY,
  SMTP_FROM_KEY,
  SMTP_HOST_KEY,
  SMTP_PASSWORD_KEY,
  SMTP_PORT_KEY,
  SMTP_SECURE_KEY,
  SMTP_USERNAME_KEY,
} from "../mail/smtp-config";
import { Mailer } from "../mail/mailer.service";
import {
  anthropicPublicSettings,
  ANTHROPIC_API_KEY_KEY,
  ANTHROPIC_MODEL_KEY,
  ANTHROPIC_POLISH_PROMPT_KEY,
} from "../ai/anthropic-config";
import {
  pushPublicSettings,
  EXPO_ACCESS_TOKEN_KEY,
  FIREBASE_APP_ID_KEY,
  FIREBASE_PROJECT_ID_KEY,
  FIREBASE_PROJECT_NUMBER_KEY,
  FIREBASE_STORAGE_BUCKET_KEY,
} from "../push/push-config";

/** App-level integration settings (Settings › Setup). Currently: the org's
 *  Google OAuth app credentials that power the "Connect with Google" flow. */
@Controller("settings/integrations")
export class IntegrationsController {
  constructor(
    private readonly store: Store,
    private readonly google: GoogleOAuthService,
    private readonly microsoft: MicrosoftOAuthService,
    private readonly meta: MetaOAuthService,
    private readonly mailer: Mailer,
  ) {}

  @Get()
  async get(@CurrentUserId() userId: string, @Req() req: Request): Promise<IntegrationSettings> {
    const me = await this.requireUser(userId);
    return this.snapshot(me.orgId, req);
  }

  @Patch()
  async update(
    @CurrentUserId() userId: string,
    @Req() req: Request,
    @Body(new ZodValidationPipe(updateIntegrationSettingsInputSchema))
    body: UpdateIntegrationSettingsInput,
  ): Promise<IntegrationSettings> {
    const me = await this.requireManager(userId);
    // Only overwrite a field when a non-empty value is supplied — so the secret
    // can be left blank in the form to keep the stored one.
    const clientId = body.googleClientId?.trim();
    if (clientId) await this.store.setAppSetting(me.orgId, GOOGLE_CLIENT_ID_KEY, clientId);
    const clientSecret = body.googleClientSecret?.trim();
    if (clientSecret) await this.store.setAppSetting(me.orgId, GOOGLE_CLIENT_SECRET_KEY, clientSecret);
    // The Pub/Sub topic is written whenever supplied, including empty to clear it.
    if (body.googlePubsubTopic !== undefined) {
      await this.store.setAppSetting(me.orgId, GOOGLE_PUBSUB_TOPIC_KEY, body.googlePubsubTopic.trim());
    }
    // Microsoft (Outlook / Microsoft 365) app registration.
    const msClientId = body.microsoftClientId?.trim();
    if (msClientId) await this.store.setAppSetting(me.orgId, MICROSOFT_CLIENT_ID_KEY, msClientId);
    const msClientSecret = body.microsoftClientSecret?.trim();
    if (msClientSecret) await this.store.setAppSetting(me.orgId, MICROSOFT_CLIENT_SECRET_KEY, msClientSecret);
    if (body.microsoftTenantId !== undefined) {
      await this.store.setAppSetting(me.orgId, MICROSOFT_TENANT_ID_KEY, body.microsoftTenantId.trim());
    }
    // Meta (WhatsApp) app credentials.
    const metaAppId = body.metaAppId?.trim();
    if (metaAppId) await this.store.setAppSetting(me.orgId, META_APP_ID_KEY, metaAppId);
    const metaAppSecret = body.metaAppSecret?.trim();
    if (metaAppSecret) await this.store.setAppSetting(me.orgId, META_APP_SECRET_KEY, metaAppSecret);
    if (body.metaConfigId !== undefined) {
      await this.store.setAppSetting(me.orgId, META_CONFIG_ID_KEY, body.metaConfigId.trim());
    }
    // Cloudflare R2 storage. Account id + bucket write on any change (empty
    // clears, dropping back to disk); the keys write only when supplied.
    if (body.r2AccountId !== undefined) {
      await this.store.setAppSetting(me.orgId, R2_ACCOUNT_ID_KEY, body.r2AccountId.trim());
    }
    if (body.r2Bucket !== undefined) {
      await this.store.setAppSetting(me.orgId, R2_BUCKET_KEY, body.r2Bucket.trim());
    }
    const r2AccessKeyId = body.r2AccessKeyId?.trim();
    if (r2AccessKeyId) await this.store.setAppSetting(me.orgId, R2_ACCESS_KEY_ID_KEY, r2AccessKeyId);
    const r2Secret = body.r2SecretAccessKey?.trim();
    if (r2Secret) await this.store.setAppSetting(me.orgId, R2_SECRET_ACCESS_KEY_KEY, r2Secret);
    // SMTP transactional email. Host/port/username/from/secure write on any
    // change (empty clears); the app password writes only when supplied.
    if (body.smtpHost !== undefined) await this.store.setAppSetting(me.orgId, SMTP_HOST_KEY, body.smtpHost.trim());
    if (body.smtpPort !== undefined) await this.store.setAppSetting(me.orgId, SMTP_PORT_KEY, String(body.smtpPort));
    if (body.smtpUsername !== undefined)
      await this.store.setAppSetting(me.orgId, SMTP_USERNAME_KEY, body.smtpUsername.trim());
    if (body.smtpFrom !== undefined) await this.store.setAppSetting(me.orgId, SMTP_FROM_KEY, body.smtpFrom.trim());
    if (body.smtpSecure !== undefined)
      await this.store.setAppSetting(me.orgId, SMTP_SECURE_KEY, body.smtpSecure ? "true" : "false");
    const smtpPassword = body.smtpPassword?.trim();
    if (smtpPassword) await this.store.setAppSetting(me.orgId, SMTP_PASSWORD_KEY, smtpPassword);
    // Resend transactional email. From writes on any change (empty clears); the
    // API key writes only when supplied, so it can be left blank to keep the stored one.
    if (body.resendFrom !== undefined) await this.store.setAppSetting(me.orgId, RESEND_FROM_KEY, body.resendFrom.trim());
    const resendApiKey = body.resendApiKey?.trim();
    if (resendApiKey) await this.store.setAppSetting(me.orgId, RESEND_API_KEY_KEY, resendApiKey);
    // Claude (AI assist). Model + polish prompt write on any change — empty
    // clears the override, so the built-in default applies again; the API key
    // writes only when supplied, so it can be left blank to keep the stored one.
    if (body.anthropicModel !== undefined) {
      await this.store.setAppSetting(me.orgId, ANTHROPIC_MODEL_KEY, body.anthropicModel.trim());
    }
    if (body.anthropicPolishPrompt !== undefined) {
      await this.store.setAppSetting(me.orgId, ANTHROPIC_POLISH_PROMPT_KEY, body.anthropicPolishPrompt.trim());
    }
    const anthropicApiKey = body.anthropicApiKey?.trim();
    if (anthropicApiKey) await this.store.setAppSetting(me.orgId, ANTHROPIC_API_KEY_KEY, anthropicApiKey);
    // Push. The Firebase values are the project's public identifiers, so they
    // write on any change (empty clears, dropping back to the environment); the
    // Expo access token is the only secret here and writes only when supplied.
    const firebase: [string, string | undefined][] = [
      [FIREBASE_PROJECT_ID_KEY, body.firebaseProjectId],
      [FIREBASE_PROJECT_NUMBER_KEY, body.firebaseProjectNumber],
      [FIREBASE_APP_ID_KEY, body.firebaseAppId],
      [FIREBASE_STORAGE_BUCKET_KEY, body.firebaseStorageBucket],
    ];
    for (const [key, value] of firebase) {
      if (value !== undefined) await this.store.setAppSetting(me.orgId, key, value.trim());
    }
    const expoAccessToken = body.expoAccessToken?.trim();
    if (expoAccessToken) await this.store.setAppSetting(me.orgId, EXPO_ACCESS_TOKEN_KEY, expoAccessToken);
    return this.snapshot(me.orgId, req);
  }

  /** Send a test email to the current user — verifies the SMTP/Postmark setup. */
  @Post("smtp/test")
  async smtpTest(@CurrentUserId() userId: string): Promise<{ sent: boolean; via?: string; error?: string }> {
    const me = await this.requireManager(userId);
    const result = await this.mailer.sendTest(me.email);
    return { sent: result.sent, via: result.via, error: result.error };
  }

  /** Build the GET/PATCH response. Secrets are never included. */
  private async snapshot(orgId: string, req: Request): Promise<IntegrationSettings> {
    const [
      clientId,
      googleConfigured,
      pubsubTopic,
      metaAppId,
      metaConfigured,
      metaConfigId,
      storage,
      smtp,
      resend,
      anthropic,
      push,
      msClientId,
      msTenantId,
      msConfigured,
    ] = await Promise.all([
        this.google.clientId(orgId),
        this.google.configured(orgId),
        this.store.getAppSetting(orgId, GOOGLE_PUBSUB_TOPIC_KEY),
        this.meta.appId(orgId),
        this.meta.configured(orgId),
        this.meta.configId(orgId),
        r2PublicSettings(this.store, orgId),
        smtpPublicSettings(this.store, orgId),
        resendPublicSettings(this.store, orgId),
        anthropicPublicSettings(this.store, orgId),
        pushPublicSettings(this.store, orgId),
        this.microsoft.clientId(orgId),
        this.microsoft.tenantId(orgId),
        this.microsoft.configured(orgId),
      ]);
    return {
      google: {
        clientId,
        configured: googleConfigured,
        redirectUri: googleRedirectUri(req),
        pubsubTopic: pubsubTopic ?? "",
        pushEndpoint: googlePushEndpoint(req),
      },
      microsoft: {
        clientId: msClientId,
        tenantId: msTenantId,
        configured: msConfigured,
        redirectUri: microsoftRedirectUri(req),
      },
      meta: {
        appId: metaAppId,
        configured: metaConfigured,
        configId: metaConfigId,
        redirectUri: metaRedirectUri(req),
      },
      storage,
      smtp,
      resend,
      anthropic,
      push,
    };
  }

  private async requireUser(userId: string): Promise<User> {
    const me = await this.store.getUser(userId);
    if (!me) throw new NotFoundException("Current user not found");
    return me;
  }

  private async requireManager(userId: string): Promise<User> {
    const me = await this.requireUser(userId);
    if (me.role !== "admin" && me.role !== "manager") {
      throw new ForbiddenException("Only admins and managers can change settings");
    }
    return me;
  }
}
