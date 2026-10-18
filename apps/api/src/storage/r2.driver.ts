import { createHash, createHmac } from "node:crypto";
import type { R2Config } from "./r2-config";

/** SHA-256 hex of an empty body (used for GET / no-body requests). */
const EMPTY_SHA = createHash("sha256").update("").digest("hex");

function sha256hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}
function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

export interface SigV4Input {
  method: string;
  path: string; // already-encoded canonical URI
  query?: string;
  amzDate: string; // YYYYMMDDTHHMMSSZ
  payloadHash: string;
  region: string;
  service: string;
  accessKey: string;
  secretKey: string;
  /** Headers to sign, as [name, value]. Sorted + lowercased internally. */
  headers: Array<[string, string]>;
}

/**
 * AWS Signature V4 Authorization header. Pure + deterministic so it can be
 * checked against the official SigV4 test vectors (see r2.driver.spec).
 */
export function signV4(input: SigV4Input): string {
  const dateStamp = input.amzDate.slice(0, 8);
  const sorted = [...input.headers]
    .map(([k, v]) => [k.toLowerCase(), v.trim()] as [string, string])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const signedHeaders = sorted.map(([k]) => k).join(";");
  const canonicalHeaders = sorted.map(([k, v]) => `${k}:${v}\n`).join("");
  const canonicalRequest = [
    input.method,
    input.path,
    input.query ?? "",
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    input.amzDate,
    scope,
    sha256hex(canonicalRequest),
  ].join("\n");

  const kDate = hmac(`AWS4${input.secretKey}`, dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  return `AWS4-HMAC-SHA256 Credential=${input.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

/** Encode an object key for the URL path, preserving `/` separators. */
function encodeKey(key: string): string {
  return key.split("/").map(rfc3986).join("/");
}

/** Strict RFC-3986 encoding (SigV4 requires the extra chars encodeURIComponent leaves). */
function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

function amzNow(): string {
  return new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
}

/**
 * Cloudflare R2 object storage over its S3-compatible API. Server-side PUT/GET
 * with SigV4 (region "auto", service "s3"). Constructed with a resolved
 * {@link R2Config}; StorageService builds one only when all four credentials are
 * present (from env or the org's saved Setup settings), else falls back to disk.
 */
export class R2Driver {
  private readonly host: string;

  constructor(private readonly cfg: R2Config) {
    this.host = `${cfg.accountId}.r2.cloudflarestorage.com`;
  }

  async put(key: string, body: Buffer, contentType = "application/octet-stream"): Promise<void> {
    const res = await this.signed("PUT", key, body, contentType);
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`R2 PUT ${key} → ${res.status}: ${detail}`);
    }
  }

  async get(key: string): Promise<Buffer | null> {
    const res = await this.signed("GET", key);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`R2 GET ${key} → ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    const res = await this.signed("DELETE", key);
    // 204 when it went, 404 when it was never there: gone either way.
    if (!res.ok && res.status !== 404) throw new Error(`R2 DELETE ${key} → ${res.status}`);
  }

  /**
   * A short-lived presigned GET URL (SigV4 query auth). The client fetches the
   * object straight from R2 — so bytes never pass through this process, Range
   * requests are served by R2, and the URL is unguessable and expires. Optional
   * `downloadName` forces a download via response-content-disposition.
   */
  presignGet(key: string, expiresSeconds = 300, opts?: { downloadName?: string }): string {
    const amzDate = amzNow();
    const dateStamp = amzDate.slice(0, 8);
    const scope = `${dateStamp}/auto/s3/aws4_request`;
    const path = `/${this.cfg.bucket}/${encodeKey(key)}`;
    const params: Record<string, string> = {
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": `${this.cfg.accessKeyId}/${scope}`,
      "X-Amz-Date": amzDate,
      "X-Amz-Expires": String(expiresSeconds),
      "X-Amz-SignedHeaders": "host",
    };
    if (opts?.downloadName) {
      params["response-content-disposition"] = `attachment; filename="${opts.downloadName}"`;
    }
    const canonicalQuery = Object.keys(params)
      .sort()
      .map((k) => `${rfc3986(k)}=${rfc3986(params[k])}`)
      .join("&");
    const canonicalRequest = [
      "GET",
      path,
      canonicalQuery,
      `host:${this.host}\n`,
      "host",
      "UNSIGNED-PAYLOAD",
    ].join("\n");
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      scope,
      sha256hex(canonicalRequest),
    ].join("\n");
    const kDate = hmac(`AWS4${this.cfg.secretAccessKey}`, dateStamp);
    const kRegion = hmac(kDate, "auto");
    const kService = hmac(kRegion, "s3");
    const kSigning = hmac(kService, "aws4_request");
    const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
    return `https://${this.host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
  }

  private signed(method: "GET" | "PUT" | "DELETE", key: string, body?: Buffer, contentType?: string) {
    const amzDate = amzNow();
    const path = `/${this.cfg.bucket}/${encodeKey(key)}`;
    const payloadHash = body ? sha256hex(body) : EMPTY_SHA;
    const authorization = signV4({
      method,
      path,
      amzDate,
      payloadHash,
      region: "auto",
      service: "s3",
      accessKey: this.cfg.accessKeyId,
      secretKey: this.cfg.secretAccessKey,
      headers: [
        ["host", this.host],
        ["x-amz-content-sha256", payloadHash],
        ["x-amz-date", amzDate],
      ],
    });
    const headers: Record<string, string> = {
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      authorization,
    };
    if (body && contentType) headers["content-type"] = contentType;
    return fetch(`https://${this.host}${path}`, { method, headers, body });
  }
}
