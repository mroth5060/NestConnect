import { Injectable, Logger } from "@nestjs/common";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { env } from "../config/env";

/**
 * Versioned ciphertext prefix. The version lets the format (algorithm, key
 * derivation) evolve later without ambiguity — a future `enc:v2:` can coexist
 * with values still written as `enc:v1:`.
 */
const PREFIX = "enc:v1:";
const ALGO = "aes-256-gcm";
const IV_BYTES = 12; // 96-bit nonce, the standard for GCM

/**
 * channelConfig fields that hold provider credentials (WhatsApp/Gmail tokens).
 * Everything else in channelConfig (phoneNumberId, provider, email, historyId …)
 * is non-secret and stays plaintext so it remains queryable.
 */
/*
 * channelConfig fields encrypted at rest.
 *
 * `identitySecret` is one of these and not a key: it is the thing an app's own
 * backend signs user ids with, so anybody holding it can mint a signature
 * claiming to be any customer on that channel — which is the entire attack the
 * signing exists to prevent.
 */
const SECRET_CHANNEL_FIELDS = new Set([
  "accessToken",
  "providerToken",
  "refreshToken",
  "identitySecret",
  "fcmServiceAccount",
]);

/** AppSetting keys that hold secrets (see google/meta oauth + r2 config). */
const SECRET_APP_KEYS = new Set([
  "google_client_secret",
  "microsoft_client_secret",
  "meta_app_secret",
  "r2_access_key_id",
  "r2_secret_access_key",
  "smtp_password",
  "resend_api_key",
  "anthropic_api_key",
  "expo_access_token",
]);

/**
 * Authenticated encryption (AES-256-GCM) for integration secrets at rest. The
 * master key is loaded from the environment only — never Postgres. Encryption is
 * transparent: callers store/read plaintext and the stores route secret values
 * through here. A fresh 96-bit IV is generated per value and the GCM auth tag is
 * stored alongside, so tampering is detected on decrypt.
 *
 * When no key is configured the service is a pass-through (plaintext in/out) so
 * the zero-infra dev path keeps working; a production boot without a key is
 * warned about in {@link assertProdSecrets}.
 */
@Injectable()
export class SecretEncryptionService {
  private readonly logger = new Logger(SecretEncryptionService.name);
  private readonly key?: Buffer;

  constructor() {
    this.key = loadKey(env.secretKey);
    if (this.key) this.logger.log("Secret encryption enabled (AES-256-GCM)");
  }

  /** True when a master key is configured and values are actually encrypted. */
  get enabled(): boolean {
    return this.key !== undefined;
  }

  /** Whether a stored value is in our versioned ciphertext format. */
  isEncrypted(value: string): boolean {
    return typeof value === "string" && value.startsWith(PREFIX);
  }

  /** Encrypt a plaintext value. Idempotent: an already-encrypted value is
   *  returned unchanged (never double-encrypted); disabled ⇒ returned as-is. */
  encrypt(plaintext: string): string {
    if (!this.key || plaintext === "" || this.isEncrypted(plaintext)) return plaintext;
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return PREFIX + [iv, tag, ct].map((b) => b.toString("base64")).join(":");
  }

  /** Decrypt a value. A legacy plaintext value (no prefix) is returned as-is, so
   *  reads keep working before/through the encryption migration. */
  decrypt(value: string): string {
    if (!this.isEncrypted(value)) return value;
    if (!this.key) {
      this.logger.error("Encountered an encrypted value but SECRET_ENCRYPTION_KEY is not set");
      return value;
    }
    const [ivB64, tagB64, ctB64] = value.slice(PREFIX.length).split(":");
    const iv = Buffer.from(ivB64, "base64");
    const tag = Buffer.from(tagB64, "base64");
    const ct = Buffer.from(ctB64, "base64");
    const decipher = createDecipheriv(ALGO, this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  }

  /* ---- field-aware helpers used by the stores ---- */

  isSecretChannelField(field: string): boolean {
    return SECRET_CHANNEL_FIELDS.has(field);
  }

  isSecretAppKey(key: string): boolean {
    return SECRET_APP_KEYS.has(key);
  }

  /** Encrypt the secret fields of a channelConfig object (copy; non-secret
   *  fields untouched). Safe to call on a config that already has some fields
   *  encrypted — encrypt() is idempotent, so a merge never double-encrypts. */
  encryptChannelConfig(config: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(config)) {
      out[k] = this.isSecretChannelField(k) ? this.encrypt(v) : v;
    }
    return out;
  }

  /** Decrypt the secret fields of a channelConfig object (copy). */
  decryptChannelConfig(config: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(config)) {
      out[k] = this.isSecretChannelField(k) ? this.decrypt(v) : v;
    }
    return out;
  }

  encryptAppSetting(key: string, value: string): string {
    return this.isSecretAppKey(key) ? this.encrypt(value) : value;
  }

  decryptAppSetting(key: string, value: string): string {
    return this.isSecretAppKey(key) ? this.decrypt(value) : value;
  }
}

/**
 * Resolve the master key from the env value: a base64- or hex-encoded 32-byte
 * key is used verbatim; any other non-empty value is stretched to 32 bytes with
 * SHA-256 (fine for a high-entropy env secret). Empty ⇒ undefined (disabled).
 */
function loadKey(raw: string): Buffer | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  for (const enc of ["base64", "hex"] as const) {
    try {
      const buf = Buffer.from(value, enc);
      if (buf.length === 32) return buf;
    } catch {
      /* not this encoding */
    }
  }
  return createHash("sha256").update(value).digest();
}
