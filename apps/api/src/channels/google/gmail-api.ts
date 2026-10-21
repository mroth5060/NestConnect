/**
 * A thin, dependency-free client for the Gmail REST API. Every call takes an
 * OAuth access token (the caller is responsible for keeping it fresh) and hits
 * the `users/me` endpoints. Keeping all Gmail HTTP in one place makes the
 * provider + sync logic easy to read and to test against a fake client.
 */

// Type-only import (erased at build) — keeps this a runtime-dependency-free client
// while reusing the inline-image shape the email provider produces.
import type { InlineImage } from "../email/email.provider";

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}

export interface GmailMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  internalDate?: string;
  snippet?: string;
  payload?: GmailPart;
}

export interface GmailProfile {
  emailAddress: string;
  historyId: string;
}

export interface GmailHistoryList {
  history?: Array<{
    id?: string;
    messagesAdded?: Array<{ message: { id: string; threadId?: string; labelIds?: string[] } }>;
  }>;
  historyId?: string;
  nextPageToken?: string;
}

export interface GmailWatchResult {
  historyId: string;
  /** ms-since-epoch string when the watch expires (~7 days out). */
  expiration: string;
}

/** Raised for a non-2xx Gmail response, carrying the HTTP status for callers. */
export class GmailApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GmailApiError";
  }
}

async function gmailFetch<T>(
  accessToken: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetch(`${GMAIL_BASE}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch (err) {
    throw new GmailApiError(0, `Gmail request failed: ${String(err)}`);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GmailApiError(res.status, `Gmail ${path} → ${res.status}: ${detail}`);
  }
  // Some endpoints (stop) return empty bodies.
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

export const gmail = {
  /** The connected account's address + current history cursor. */
  getProfile(accessToken: string): Promise<GmailProfile> {
    return gmailFetch<GmailProfile>(accessToken, "/profile");
  },

  /** Send a pre-built RFC 2822 message (base64url in `raw`). */
  send(
    accessToken: string,
    raw: string,
    threadId?: string,
  ): Promise<{ id: string; threadId: string }> {
    return gmailFetch(accessToken, "/messages/send", {
      method: "POST",
      body: JSON.stringify({ raw, ...(threadId ? { threadId } : {}) }),
    });
  },

  /** Incremental change feed since `startHistoryId`. No label filter so both
   *  received (INBOX) and sent (SENT) message adds come through — the caller
   *  filters and routes them (inbound vs a reply sent straight from Gmail). */
  historyList(
    accessToken: string,
    startHistoryId: string,
    pageToken?: string,
  ): Promise<GmailHistoryList> {
    const params = new URLSearchParams({
      startHistoryId,
      historyTypes: "messageAdded",
    });
    if (pageToken) params.set("pageToken", pageToken);
    return gmailFetch<GmailHistoryList>(accessToken, `/history?${params.toString()}`);
  },

  /** Fetch a full message (headers + body parts). */
  getMessage(accessToken: string, id: string): Promise<GmailMessage> {
    return gmailFetch<GmailMessage>(accessToken, `/messages/${encodeURIComponent(id)}?format=full`);
  },

  /** Fetch an attachment's bytes (base64url) by its part id. */
  getAttachment(
    accessToken: string,
    messageId: string,
    attachmentId: string,
  ): Promise<{ data?: string; size?: number }> {
    return gmailFetch(
      accessToken,
      `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
    );
  },

  /** Ask Gmail to push change notifications for INBOX to a Pub/Sub topic. */
  watch(accessToken: string, topicName: string): Promise<GmailWatchResult> {
    return gmailFetch<GmailWatchResult>(accessToken, "/watch", {
      method: "POST",
      // Watch INBOX (received) and SENT (replies sent straight from Gmail).
      body: JSON.stringify({ topicName, labelIds: ["INBOX", "SENT"], labelFilterBehavior: "include" }),
    });
  },

  /** Stop all push notifications for the account. */
  stop(accessToken: string): Promise<Record<string, never>> {
    return gmailFetch(accessToken, "/stop", { method: "POST" });
  },
};

/* ----------------------------- message parsing ---------------------------- */

/** Read a header (case-insensitive) off a Gmail message payload. */
export function headerValue(msg: GmailMessage, name: string): string | undefined {
  const want = name.toLowerCase();
  return msg.payload?.headers?.find((h) => h.name.toLowerCase() === want)?.value;
}

/** Split a `Name <email>` (or bare `email`) header into its parts. */
export function parseAddress(raw: string): { email: string; name?: string } {
  const trimmed = (raw ?? "").trim();
  const angle = trimmed.match(/^(.*)<([^>]+)>\s*$/);
  if (angle) {
    const name = angle[1].trim().replace(/^"|"$/g, "").trim();
    return { email: angle[2].trim().toLowerCase(), name: name || undefined };
  }
  return { email: trimmed.toLowerCase() };
}

/**
 * Every address in a To/Cc header, lower-cased.
 *
 * Splitting on "," is not quite enough: a display name may contain one
 * (`"Ashcroft, Bob" <bob@…>`), which would otherwise split one recipient into
 * two unusable halves. So commas inside quotes or angle brackets don't count.
 */
export function parseAddressList(raw: string | undefined): string[] {
  if (!raw) return [];
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let angled = false;
  for (const ch of raw) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "<") angled = true;
    else if (ch === ">") angled = false;
    if (ch === "," && !quoted && !angled) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return [...new Set(parts.map((p) => parseAddress(p).email).filter(Boolean))];
}

/** Collect the Message-IDs a mail threads onto (References + In-Reply-To). */
export function threadRefs(msg: GmailMessage): string[] {
  const raw = `${headerValue(msg, "References") ?? ""} ${headerValue(msg, "In-Reply-To") ?? ""}`;
  return [...new Set(raw.split(/\s+/).map((s) => s.trim()).filter(Boolean))];
}

export interface GmailAttachmentPart {
  attachmentId: string;
  filename: string;
  mime: string;
  size: number;
}

/** Real attachment parts on a message (those with a filename + attachment id). */
export function collectAttachmentParts(msg: GmailMessage): GmailAttachmentPart[] {
  const out: GmailAttachmentPart[] = [];
  const walk = (part?: GmailPart): void => {
    if (!part) return;
    if (part.filename && part.body?.attachmentId) {
      out.push({
        attachmentId: part.body.attachmentId,
        filename: part.filename,
        mime: part.mimeType ?? "application/octet-stream",
        size: part.body.size ?? 0,
      });
    }
    for (const child of part.parts ?? []) walk(child);
  };
  walk(msg.payload);
  return out;
}

function decodeB64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

/** Strip tags from an HTML body as a last resort when there's no text/plain. */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>(?=)/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Best-effort plain-text body extraction: prefer the first text/plain part,
 * fall back to a stripped text/html part, walking nested multipart bodies.
 */
export function extractPlainText(msg: GmailMessage): string {
  const plain = findPart(msg.payload, "text/plain");
  if (plain?.body?.data) return decodeB64Url(plain.body.data).trim();
  const html = findPart(msg.payload, "text/html");
  if (html?.body?.data) return htmlToText(decodeB64Url(html.body.data));
  // Single-part message with an inline body.
  if (msg.payload?.body?.data) return decodeB64Url(msg.payload.body.data).trim();
  return msg.snippet ?? "";
}

/** The raw text/html part of a message, if any (decoded, not yet sanitized). */
export function extractHtml(msg: GmailMessage): string | undefined {
  const html = findPart(msg.payload, "text/html");
  if (html?.body?.data) return decodeB64Url(html.body.data);
  // A single-part text/html message carries its HTML on the top-level body.
  if (msg.payload?.mimeType === "text/html" && msg.payload.body?.data) {
    return decodeB64Url(msg.payload.body.data);
  }
  return undefined;
}

function findPart(part: GmailPart | undefined, mimeType: string): GmailPart | undefined {
  if (!part) return undefined;
  if (part.mimeType === mimeType && part.body?.data) return part;
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found) return found;
  }
  return undefined;
}

/* ------------------------------ MIME building ----------------------------- */

/** RFC 2047-encode a header value if it contains non-ASCII characters. */
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** A file to attach to an outbound Gmail message. */
export interface MimeAttachment {
  filename: string;
  mime: string;
  bytes: Buffer;
}

export interface BuildMimeInput {
  from: string;
  fromName?: string;
  to: string;
  toName?: string;
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  /** Rich HTML alternative — when present the message is multipart/alternative. */
  html?: string;
  messageId: string;
  inReplyTo?: string;
  references?: string;
  attachments?: MimeAttachment[];
  /** Images to embed inline, referenced from `html` as `cid:<contentId>`. They're
   *  bundled with the body in a multipart/related so clients resolve each cid. */
  inlineImages?: InlineImage[];
}

/** Base64 a buffer and hard-wrap at 76 chars per RFC 2045. */
function b64Wrap(buf: Buffer): string {
  return buf.toString("base64").replace(/(.{76})/g, "$1\r\n");
}

/**
 * Build a base64url-encoded RFC 2822 message for Gmail's `raw`. The reply body
 * is a plain text/plain part, or — when `html` is given — a multipart/alternative
 * (text + html) so clients pick the richer view. Attachments wrap the whole thing
 * in a multipart/mixed. Four shapes: text | alternative | mixed[text,…files] |
 * mixed[alternative,…files].
 */
export function buildMime(input: BuildMimeInput): string {
  const fromHeader = input.fromName
    ? `${encodeHeader(input.fromName)} <${input.from}>`
    : input.from;
  const toHeader = input.toName ? `${encodeHeader(input.toName)} <${input.to}>` : input.to;

  const headers = [
    `From: ${fromHeader}`,
    `To: ${toHeader}`,
    `Subject: ${encodeHeader(input.subject)}`,
    `Message-ID: ${input.messageId}`,
    "MIME-Version: 1.0",
    // Marks this as a Nest-originated send. Gmail preserves custom X- headers but
    // rewrites the Message-ID it assigns, so the sync can't reliably dedup our own
    // Sent copies by Message-ID — it keys off this header instead (see gmail-sync).
    "X-Ding-Origin: nest",
  ];
  if (input.cc?.length) headers.push(`Cc: ${input.cc.join(", ")}`);
  if (input.bcc?.length) headers.push(`Bcc: ${input.bcc.join(", ")}`);
  if (input.inReplyTo) headers.push(`In-Reply-To: ${input.inReplyTo}`);
  if (input.references) headers.push(`References: ${input.references}`);

  const attachments = input.attachments ?? [];
  const inlineImages = input.inlineImages ?? [];
  const html = input.html?.trim() ? input.html : undefined;
  const uid = input.messageId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 20);
  const altBoundary = `=_ding_alt_${uid}`;
  const relBoundary = `=_ding_rel_${uid}`;
  const mixBoundary = `=_ding_mix_${uid}`;

  // The reply body section: either a lone text/plain, or a text+html alternative.
  // `bodyHeader` is the Content-Type header line(s); `bodyLines` the encoded parts.
  let bodyHeader: string;
  let bodyLines: string[];
  if (html) {
    bodyHeader = `Content-Type: multipart/alternative; boundary="${altBoundary}"`;
    bodyLines = [
      `--${altBoundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      b64Wrap(Buffer.from(input.body, "utf8")),
      `--${altBoundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      b64Wrap(Buffer.from(html, "utf8")),
      `--${altBoundary}--`,
    ];
  } else {
    bodyHeader = 'Content-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64';
    bodyLines = [b64Wrap(Buffer.from(input.body, "utf8"))];
  }

  // When the HTML references images by `cid:` (inlined from our media endpoint),
  // bundle the body and those images in a multipart/related so mail clients
  // resolve each cid to its embedded bytes. This becomes the new "body" section,
  // which the attachment logic below wraps in multipart/mixed if needed.
  if (inlineImages.length) {
    const rootType = html ? "multipart/alternative" : "text/plain";
    const relLines: string[] = [`--${relBoundary}`, bodyHeader, "", ...bodyLines];
    for (const img of inlineImages) {
      const name = encodeHeader(img.filename);
      relLines.push(
        `--${relBoundary}`,
        `Content-Type: ${img.mime}; name="${name}"`,
        "Content-Transfer-Encoding: base64",
        `Content-ID: <${img.contentId}>`,
        `Content-Disposition: inline; filename="${name}"`,
        "",
        b64Wrap(img.bytes),
      );
    }
    relLines.push(`--${relBoundary}--`);
    bodyHeader = `Content-Type: multipart/related; boundary="${relBoundary}"; type="${rootType}"`;
    bodyLines = relLines;
  }

  let mime: string;
  if (!attachments.length) {
    headers.push(bodyHeader);
    mime = `${headers.join("\r\n")}\r\n\r\n${bodyLines.join("\r\n")}`;
  } else {
    headers.push(`Content-Type: multipart/mixed; boundary="${mixBoundary}"`);
    const parts: string[] = [`--${mixBoundary}`, bodyHeader, "", ...bodyLines];
    for (const att of attachments) {
      const name = encodeHeader(att.filename);
      parts.push(
        `--${mixBoundary}`,
        `Content-Type: ${att.mime}; name="${name}"`,
        "Content-Transfer-Encoding: base64",
        `Content-Disposition: attachment; filename="${name}"`,
        "",
        b64Wrap(att.bytes),
      );
    }
    parts.push(`--${mixBoundary}--`);
    mime = `${headers.join("\r\n")}\r\n\r\n${parts.join("\r\n")}`;
  }
  return Buffer.from(mime, "utf8").toString("base64url");
}
