import { Injectable, Logger } from "@nestjs/common";
import type { ChannelType } from "@ding/schemas";
import { env } from "../../config/env";
import { MediaService } from "../../storage/media.service";
import {
  ChannelProvider,
  type SendParams,
  type SendResult,
  type SupportsContext,
} from "../channel-provider";
import { htmlToText, textToHtml } from "./html-sanitize";

/**
 * Append the sender's HTML signature to the outbound HTML + text bodies (with a
 * blank-line separator). The signature rides the wire only — the stored message
 * never includes it, so it doesn't clutter the in-app thread. Shared by the
 * Postmark + Gmail providers.
 */
export function appendSignature(
  html: string,
  text: string,
  signatureHtml?: string,
): { html: string; text: string } {
  const sig = signatureHtml?.trim();
  if (!sig) return { html, text };
  return { html: `${html}<br><br>${sig}`, text: `${text}\n\n${htmlToText(sig)}` };
}

/**
 * Append a hidden 1×1 open-tracking pixel to the outbound HTML body. When the
 * recipient's client loads images, a request for this URL records that THIS
 * recipient opened the email (per-recipient read receipts). No-op without a URL.
 * Shared by the Postmark + Gmail providers.
 */
export function appendTrackingPixel(html: string, url?: string): string {
  if (!url) return html;
  return `${html}<img src="${url}" width="1" height="1" alt="" style="display:none;max-height:0;overflow:hidden" />`;
}

/**
 * An image to embed inline in an outbound email, referenced from the HTML as
 * `cid:<contentId>`. `contentId` is the bare id (the MIME header carries it in
 * angle brackets: `Content-ID: <contentId>`).
 */
export interface InlineImage {
  contentId: string;
  filename: string;
  mime: string;
  bytes: Buffer;
}

// Captures an <img>'s src: group 1 = everything up to the opening quote, group 2
// = the quote char, group 3 = the URL. Lets us rewrite the URL only.
const IMG_SRC_RE = /(<img\b[^>]*?\bsrc\s*=\s*)(["'])(.*?)\2/gi;

/**
 * Pull the media attachment id out of a URL that points at our own media
 * endpoint (`/api/media/:id`, absolute or root-relative). Returns null for
 * anything else — external `https://` images, `data:` URIs and existing `cid:`
 * refs — so only our internally-hosted images are touched.
 */
function mediaIdFromUrl(url: string): string | null {
  const trimmed = (url ?? "").trim();
  if (!trimmed || trimmed.startsWith("cid:") || trimmed.startsWith("data:")) return null;
  const m = /\/api\/media\/([A-Za-z0-9._-]+)/.exec(trimmed);
  return m ? m[1] : null;
}

/**
 * Rewrite <img> tags that point at this app's own (auth-guarded) media endpoint
 * into `cid:` references, returning the referenced bytes as inline attachments.
 * An email RECIPIENT has no app session, so a `https://<host>/api/media/:id`
 * image (e.g. a signature logo) would otherwise render broken; embedding it as a
 * `cid:` part makes it show. Bytes are read internally via MediaService — the
 * same path outbound attachments use — never an authed HTTP call back to us.
 *
 * External images and existing `cid:` refs are left untouched. No-op when the
 * HTML has no internal images; a media-load failure skips that one image (the
 * tag is left as-is) rather than breaking the send.
 */
export async function inlineInternalImages(
  html: string,
  media: MediaService,
): Promise<{ html: string; inlineImages: InlineImage[] }> {
  if (!html || !html.includes("/api/media/")) return { html, inlineImages: [] };

  // attachmentId → contentId, so an image used more than once is attached once.
  const cidById = new Map<string, string>();
  const inlineImages: InlineImage[] = [];

  // Resolve referenced media first (the regex walk is sync; loads are async).
  for (const match of html.matchAll(IMG_SRC_RE)) {
    const id = mediaIdFromUrl(match[3]);
    if (!id || cidById.has(id)) continue;
    const loaded = await media.load(id);
    if (!loaded) continue; // not ours / missing → leave the tag as it was
    const contentId = `img-${id}@ding.media`;
    cidById.set(id, contentId);
    inlineImages.push({ contentId, filename: loaded.filename, mime: loaded.mime, bytes: loaded.bytes });
  }

  if (!inlineImages.length) return { html, inlineImages: [] };

  const rewritten = html.replace(IMG_SRC_RE, (whole, pre: string, quote: string, url: string) => {
    const id = mediaIdFromUrl(url);
    const contentId = id ? cidById.get(id) : undefined;
    return contentId ? `${pre}${quote}cid:${contentId}${quote}` : whole;
  });

  return { html: rewritten, inlineImages };
}

/**
 * Email sender. Runs in mock mode until POSTMARK_TOKEN is set. We mint our own
 * RFC Message-ID and set In-Reply-To/References so replies thread back to the
 * right conversation (the Message-ID is stored as the message's channelMsgId).
 */
@Injectable()
export class EmailProvider extends ChannelProvider {
  private readonly logger = new Logger(EmailProvider.name);

  constructor(private readonly media: MediaService) {
    super();
  }

  private get isLive(): boolean {
    return Boolean(env.email.postmarkToken);
  }

  supports(channel: ChannelType, ctx?: SupportsContext): boolean {
    // Gmail- and Outlook-connected inboxes are served by their own providers, not Postmark.
    return channel === "email" && ctx?.provider !== "gmail" && ctx?.provider !== "outlook";
  }

  async sendText(params: SendParams): Promise<SendResult> {
    const messageId = `<ding.${params.conversation.id}.${Date.now()}@${env.email.domain}>`;
    const subject = subjectLine(params.context);

    if (!this.isLive) {
      // No Postmark token → email sending isn't configured. Fail honestly so the
      // agent sees it; only the explicit dev flag fakes a successful send.
      if (!env.mockMessaging) {
        return {
          ok: false,
          retryable: false,
          error: "Email sending is not configured (missing Postmark token)",
          errorCode: "not_connected",
        };
      }
      this.logger.log(
        `[mock] Email → ${params.to} · "${subject}"` +
          (params.trackingPixelUrl ? ` [track ${params.trackingPixelUrl}]` : ""),
      );
      return { ok: true, channelMsgId: messageId };
    }

    try {
      const headers: Array<{ Name: string; Value: string }> = [
        { Name: "Message-ID", Value: messageId },
        // Marks this as a Nest-originated send (see gmail-sync dedup).
        { Name: "X-Ding-Origin", Value: "nest" },
      ];
      if (params.context?.inReplyTo) {
        headers.push({ Name: "In-Reply-To", Value: params.context.inReplyTo });
        // References chains the whole thread when known; else just the parent.
        headers.push({
          Name: "References",
          Value: params.context.references ?? params.context.inReplyTo,
        });
      }
      // Rich reply → its HTML; else derive a simple HTML alternative. The
      // sender's signature is appended to the wire body only.
      const { html: signedHtml, text: textBody } = appendSignature(
        params.bodyHtml || textToHtml(params.body),
        params.body,
        params.signatureHtml,
      );
      // Embed any images hosted on our own media endpoint as cid: attachments so
      // a recipient (no app session) can load them; external images are left be.
      const { html: htmlInlined, inlineImages } = await inlineInternalImages(signedHtml, this.media);
      // Append this recipient's open-tracking pixel (per-recipient read receipts).
      const htmlBody = appendTrackingPixel(htmlInlined, params.trackingPixelUrl);
      const attachments = [
        ...(params.media ?? []).map((m) => ({
          Name: m.filename,
          Content: m.bytes.toString("base64"),
          ContentType: m.mime,
        })),
        // A ContentID marks the attachment inline/embeddable — Postmark links it
        // to the matching `cid:` reference in the HTML body.
        ...inlineImages.map((img) => ({
          Name: img.filename,
          Content: img.bytes.toString("base64"),
          ContentType: img.mime,
          ContentID: `cid:${img.contentId}`,
        })),
      ];
      const res = await fetch("https://api.postmarkapp.com/email", {
        method: "POST",
        headers: {
          "X-Postmark-Server-Token": env.email.postmarkToken,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          From: env.email.from,
          To: params.to,
          ...(params.cc?.length ? { Cc: params.cc.join(", ") } : {}),
          ...(params.bcc?.length ? { Bcc: params.bcc.join(", ") } : {}),
          Subject: subject,
          TextBody: textBody,
          HtmlBody: htmlBody,
          MessageStream: "outbound",
          Headers: headers,
          ...(attachments.length ? { Attachments: attachments } : {}),
        }),
      });
      const json = (await res.json()) as { ErrorCode?: number; Message?: string };
      if (!res.ok || (json.ErrorCode && json.ErrorCode !== 0)) {
        return {
          ok: false,
          error: json.Message ?? `HTTP ${res.status}`,
          errorCode: json.ErrorCode != null ? String(json.ErrorCode) : undefined,
          httpStatus: res.status,
        };
      }
      return { ok: true, channelMsgId: messageId };
    } catch (err) {
      // Network/transport error before any HTTP response — transient, worth a retry.
      return { ok: false, error: String(err), retryable: true };
    }
  }

}

/**
 * The subject line to send: a reply (has an In-Reply-To) carries "Re:"; a fresh
 * thread keeps the agent's subject verbatim. Shared by the Postmark + Gmail
 * providers so both channels thread and label subjects identically.
 */
export function subjectLine(context?: { subject?: string; inReplyTo?: string }): string {
  const s = (context?.subject ?? "").trim();
  const isReply = Boolean(context?.inReplyTo);
  // A reply must carry the SAME base subject as the thread, or Gmail/Outlook show
  // it as a brand-new conversation — they thread on the subject as well as the
  // In-Reply-To/References headers. If the thread has no subject, reply with none
  // too (an invented "Re: your message" is exactly what forks it into a new email).
  if (!s) return isReply ? "" : "(no subject)";
  if (!isReply) return s;
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

/**
 * The subject for a forwarded email: the original subject prefixed with "Fwd:"
 * (kept as-is if it already carries one). A forward opens a NEW thread to a new
 * recipient, so — unlike a reply — inventing a subject is correct: there's no
 * prior exchange with that recipient to fork.
 */
export function forwardSubject(subject?: string | null): string {
  const s = (subject ?? "").trim();
  if (!s) return "Fwd: (no subject)";
  return /^fwd:/i.test(s) ? s : `Fwd: ${s}`;
}
