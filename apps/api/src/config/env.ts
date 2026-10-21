import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { config } from "dotenv";

// Load env from the repo root (dev runs each app from its own dir), then any
// local override. Everything has a default, so the app also runs with no .env.
for (const p of [
  resolve(process.cwd(), "../../.env"),
  resolve(process.cwd(), ".env"),
]) {
  if (existsSync(p)) config({ path: p, override: false });
}

export const env = {
  // Railway (and most PaaS) inject PORT; fall back to API_PORT for local dev.
  port: Number(process.env.PORT ?? process.env.API_PORT ?? 3001),
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
  // Public origin of the web app, used to build links (e.g. invite emails).
  // Defaults to the CORS origin (same-origin in prod).
  appUrl: process.env.APP_URL ?? process.env.CORS_ORIGIN ?? "http://localhost:5173",
  databaseUrl: process.env.DATABASE_URL ?? "",
  redisUrl: process.env.REDIS_URL ?? "",
  whatsapp: {
    // Verification token you set in the Meta webhook config.
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN ?? "ding-dev-verify",
    // App secret → validates X-Hub-Signature-256 on inbound webhooks (optional in dev).
    appSecret: process.env.WHATSAPP_APP_SECRET ?? "",
    // Access token + phone number id → enables live sending. Without them a send
    // fails (or is faked only when MOCK_MESSAGING=true in dev).
    token: process.env.WHATSAPP_TOKEN ?? "",
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? "",
    // Meta App ID — needed only to change the profile photo from here (Meta's
    // resumable-upload API is app-scoped). Per-number config can override it.
    appId: process.env.WHATSAPP_APP_ID ?? "",
    apiVersion: process.env.WHATSAPP_API_VERSION ?? "v21.0",
  },
  auth: {
    jwtSecret: process.env.AUTH_JWT_SECRET ?? "ding-dev-secret-change-me",
    cookieName: process.env.AUTH_COOKIE_NAME ?? "ding_session",
    // Session lifetime in seconds (default 7 days).
    ttlSeconds: Number(process.env.AUTH_TTL_SECONDS ?? 60 * 60 * 24 * 7),
    // Native clients get a longer session: re-authenticating a phone weekly is
    // a real cost, and the session stays revocable either way (Session.revokedAt),
    // so length trades convenience against nothing but the revocation window.
    mobileTtlSeconds: Number(process.env.AUTH_MOBILE_TTL_SECONDS ?? 60 * 60 * 24 * 60),
    // Password for all seeded demo users (dev only).
    devPassword: process.env.AUTH_DEV_PASSWORD ?? "ding1234",
    /**
     * Whether an authenticated user who hasn't enrolled in 2FA is held at the
     * setup gate. On by default and *forced* on in production: needing an
     * authenticator app to reach a local stack or a CI run is real friction, but
     * a prod deployment must not be able to drop the requirement by setting one
     * env var. So `AUTH_REQUIRE_2FA=false` is honoured only outside production.
     *
     * This is about mandatory *enrolment*, not about skipping the code: a user
     * who has already enrolled is still challenged at login, in dev too.
     *
     * Read as a getter so it reflects the environment at call time, like
     * `mockMessaging`. The production check is spelled out rather than reusing
     * `env.isProd`, because a getter on this nested object sees `auth` as
     * `this`, not `env`.
     */
    get require2fa(): boolean {
      return process.env.NODE_ENV === "production" || process.env.AUTH_REQUIRE_2FA !== "false";
    },
  },
  // Master key for encrypting integration secrets at rest (AES-256-GCM). Loaded
  // from the environment only — never stored in Postgres. Prefer a base64- or
  // hex-encoded 32-byte random key; any other non-empty value is stretched with
  // SHA-256. Unset ⇒ encryption disabled (secrets stored as plaintext).
  secretKey: process.env.SECRET_ENCRYPTION_KEY ?? "",
  email: {
    // Postmark server token → enables live sending. Without it a send fails
    // (or is faked only when MOCK_MESSAGING=true in dev).
    postmarkToken: process.env.POSTMARK_TOKEN ?? "",
    // Address outbound email is sent from, and the domain used to mint Message-IDs.
    from: process.env.EMAIL_FROM ?? "support@hermolis.com",
    domain: process.env.EMAIL_DOMAIN ?? "hermolis.com",
    // Optional shared secret; when set, inbound webhooks must pass ?token=.
    inboundToken: process.env.EMAIL_INBOUND_TOKEN ?? "",
  },
  // SMTP for the app's OWN transactional email (invites, password resets, test
  // sends) — distinct from the customer-facing email channel above. Defaults
  // suit Gmail with an app password. An org's saved Setup values override these.
  smtp: {
    host: process.env.SMTP_HOST ?? "",
    port: Number(process.env.SMTP_PORT ?? 587),
    username: process.env.SMTP_USERNAME ?? "",
    password: process.env.SMTP_PASSWORD ?? "",
    // Envelope + header From; falls back to the username (the Gmail address).
    from: process.env.SMTP_FROM ?? "",
    // true → implicit TLS on connect (port 465); false → STARTTLS (port 587).
    secure: (process.env.SMTP_SECURE ?? "") === "true",
  },
  // Resend (https://resend.com) for the app's OWN transactional email — the
  // preferred transport for system mail (invites, resets, codes) when set. Runs
  // over HTTPS, so it delivers on hosts that block outbound SMTP (Railway does).
  // `from` must be on a domain verified in Resend; falls back to EMAIL_FROM.
  resend: {
    apiKey: process.env.RESEND_API_KEY ?? "",
    from: process.env.RESEND_FROM ?? process.env.EMAIL_FROM ?? "support@hermolis.com",
  },
  // Claude (Anthropic) for AI assist — the composer's one-tap Polish. An org's
  // saved Settings values override these, so it can be enabled from the UI.
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY ?? "",
    model: process.env.ANTHROPIC_MODEL ?? "",
  },
  push: {
    // Expo access token. Optional — Expo accepts unauthenticated sends — but with
    // "enhanced security" enabled it's what stops anyone who learns a device
    // token from pushing to that phone in our name.
    expoAccessToken: process.env.EXPO_ACCESS_TOKEN ?? "",
    // Where the Expo push API lives. Overridable so the delivery path can be
    // pointed at a stub in tests and in environments with no egress to exp.host.
    expoBaseUrl: (process.env.EXPO_PUSH_BASE_URL ?? "https://exp.host").replace(/\/+$/, ""),
    // How long after a send to ask Expo what actually happened. Receipts aren't
    // ready immediately, and they're the only way DeviceNotRegistered is learned.
    receiptDelaySeconds: Number(process.env.PUSH_RECEIPT_DELAY_SECONDS ?? 300),
  },
  // The Firebase project Android notifications travel through. Recorded, not
  // used: delivery is app → Expo → FCM, Expo holds the service-account key (in
  // EAS credentials, never here), and the app carries the matching client config
  // compiled in from google-services.json. These are the project's public
  // identifiers, kept so "which project is this app pointed at?" has an answer
  // outside a build artefact. An org's saved Settings values override them.
  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID ?? "",
    // The FCM sender id — `project_number` in google-services.json.
    projectNumber: process.env.FIREBASE_PROJECT_NUMBER ?? "",
    appId: process.env.FIREBASE_APP_ID ?? "",
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET ?? "",
  },
  gmail: {
    // Inbound polling cadence in seconds; 0 disables the poller (push-only).
    pollSeconds: Number(process.env.GMAIL_POLL_SECONDS ?? 60),
    // Optional shared secret; when set, the Pub/Sub push webhook must pass ?token=.
    pushToken: process.env.GMAIL_PUSH_TOKEN ?? "",
  },
  outlook: {
    // Inbound polling cadence in seconds for Outlook / Microsoft 365; 0 disables it.
    pollSeconds: Number(process.env.OUTLOOK_POLL_SECONDS ?? 60),
  },
  media: {
    // Where downloaded media is stored on the local-disk driver. Ephemeral on
    // Railway; production durability comes from Cloudflare R2 (below).
    dir: process.env.MEDIA_DIR ?? join(tmpdir(), "nest-media"),
    // Hard cap on a single media file we'll download/store (bytes). Default 100MB.
    maxBytes: Number(process.env.MEDIA_MAX_BYTES ?? 100 * 1024 * 1024),
  },
  r2: {
    // Cloudflare R2 (S3-compatible). Set all four to store media in R2 instead
    // of local disk. Endpoint is https://<accountId>.r2.cloudflarestorage.com.
    accountId: process.env.R2_ACCOUNT_ID ?? "",
    accessKeyId: process.env.R2_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? "",
    bucket: process.env.R2_BUCKET ?? "",
  },
  get usingDatabase() {
    return this.databaseUrl.length > 0;
  },
  get usingRedis() {
    return this.redisUrl.length > 0;
  },
  get whatsappLive() {
    return Boolean(this.whatsapp.token && this.whatsapp.phoneNumberId);
  },
  get emailLive() {
    return Boolean(this.email.postmarkToken);
  },
  /** Dev/demo escape hatch. When MOCK_MESSAGING=true (and NOT production), a send
   *  on an unconnected channel is faked so the flow is exercisable without live
   *  credentials. Off by default and force-off in production, where an
   *  unconnected channel fails the send — surfaced to the agent — instead of
   *  silently pretending the message went out. */
  get mockMessaging() {
    return !this.isProd && process.env.MOCK_MESSAGING === "true";
  },
  get isProd() {
    return process.env.NODE_ENV === "production";
  },
  // In production the API also serves the built web app (single origin).
  get serveWeb() {
    return this.isProd || process.env.SERVE_WEB === "true";
  },
};

const DEFAULT_JWT_SECRET = "ding-dev-secret-change-me";

/**
 * Fail closed on boot if production is running on insecure defaults. Only the
 * session-signing secret is boot-critical (a public default lets anyone forge an
 * admin cookie); per-channel secrets are enforced at request time instead, since
 * they're legitimately unset until a channel is wired. Weaker prod defaults are
 * warned about, not fatal.
 */
export function assertProdSecrets(logger: { warn: (m: string) => void } = console): void {
  // Outside production the only thing worth saying is which guardrails are down,
  // so they're visible in the log rather than discovered by surprise.
  if (!env.isProd) {
    if (!env.auth.require2fa) {
      logger.warn("AUTH_REQUIRE_2FA=false — mandatory two-factor enrolment is OFF. Ignored in production.");
    }
    return;
  }
  if (!process.env.AUTH_JWT_SECRET || process.env.AUTH_JWT_SECRET === DEFAULT_JWT_SECRET) {
    throw new Error(
      "Refusing to start in production with an insecure AUTH_JWT_SECRET. Set a strong, random value.",
    );
  }
  if (env.corsOrigin.includes("localhost")) {
    logger.warn(`CORS_ORIGIN is still "${env.corsOrigin}" in production — set it to your real web origin.`);
  }
  if (env.auth.devPassword === "ding1234") {
    // Worth being blunt about. This is not "a weak default" in the abstract: it
    // is a password published in the repository, and the API grants a full
    // session on a password alone — the two-factor enrolment gate is drawn by
    // the client, so a caller that is not a browser never meets it. If this
    // workspace was seeded without AUTH_DEV_PASSWORD set, its seeded accounts
    // are reachable by anyone who can read the source.
    logger.warn(
      "AUTH_DEV_PASSWORD is unset, so it is the built-in default — a password that is public in the " +
        "repository. Any account seeded with it can be signed into by anyone who has read the source, " +
        "and a password alone is enough for API access. Change those accounts' passwords in the app now, " +
        "and set AUTH_DEV_PASSWORD so a future fresh database is not seeded with a known one.",
    );
  }
  if (!env.secretKey) {
    logger.warn("SECRET_ENCRYPTION_KEY is not set — integration credentials (OAuth tokens, app secrets) are stored UNENCRYPTED. Set a 32-byte key and run `pnpm --filter @ding/api db:encrypt-secrets`.");
  }
}
