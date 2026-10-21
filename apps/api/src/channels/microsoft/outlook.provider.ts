import { Injectable, Logger } from "@nestjs/common";
import type { ChannelType } from "@ding/schemas";
import { env } from "../../config/env";
import { Store } from "../../data/store";
import {
  ChannelProvider,
  type SendParams,
  type SendResult,
  type SupportsContext,
} from "../channel-provider";
import { MediaService } from "../../storage/media.service";
import { buildMime } from "../google/gmail-api";
import { textToHtml } from "../email/html-sanitize";
import { appendSignature, appendTrackingPixel, inlineInternalImages, subjectLine } from "../email/email.provider";
import { MicrosoftOAuthService, OUTLOOK_CONFIG } from "./microsoft-oauth.service";
import { graph, GraphApiError, mailboxPath } from "./graph-api";

/**
 * Graph refuses a sendMail request over 4 MB, and base64 inflates MIME by a
 * third — so a message whose attachments approach 3 MB can't go this way.
 * Checked up front so the agent gets a plain reason instead of a 413.
 */
const MAX_MIME_BYTES = 4 * 1024 * 1024;

/**
 * Sends outbound email through an Outlook / Microsoft 365 inbox via Microsoft
 * Graph, using that inbox's stored OAuth token (refreshed on demand). Selected
 * over the generic email provider when the sending inbox was connected with
 * Microsoft. The message is built as MIME — the same builder Gmail uses — so it
 * carries our Message-ID, threading headers and the X-Ding-Origin marker.
 */
@Injectable()
export class OutlookProvider extends ChannelProvider {
  private readonly logger = new Logger(OutlookProvider.name);

  constructor(
    private readonly microsoft: MicrosoftOAuthService,
    private readonly store: Store,
    private readonly media: MediaService,
  ) {
    super();
  }

  supports(channel: ChannelType, ctx?: SupportsContext): boolean {
    return channel === "email" && ctx?.provider === "outlook";
  }

  async sendText(params: SendParams): Promise<SendResult> {
    const inboxId = params.inboxId ?? params.conversation.inboxId;
    const config = await this.store.getInboxConfig(inboxId);
    if (!config || config[OUTLOOK_CONFIG.provider] !== "outlook") {
      return { ok: false, error: "Outlook inbox is not connected" };
    }
    const fromAddress = config[OUTLOOK_CONFIG.email] || env.email.from;
    const domain = fromAddress.split("@")[1] || env.email.domain;
    const messageId = `<ding.${params.conversation.id}.${Date.now()}@${domain}>`;
    const subject = subjectLine(params.context);
    const attachments = (params.media ?? []).map((m) => ({ filename: m.filename, mime: m.mime, bytes: m.bytes }));

    if (this.microsoft.isMock) {
      const extra = attachments.length ? ` (+${attachments.length} attachment)` : "";
      this.logger.log(`[mock] Outlook send → ${params.to} · "${subject}"${extra}`);
      return { ok: true, channelMsgId: messageId };
    }

    try {
      const inbox = await this.store.getInbox(inboxId);
      if (!inbox) return { ok: false, error: "Outlook inbox not found" };
      const accessToken = await this.microsoft.accessTokenForInbox(inbox, config);
      const { html: signedHtml, text: textBody } = appendSignature(
        params.bodyHtml || textToHtml(params.body),
        params.body,
        params.signatureHtml,
      );
      const { html: htmlInlined, inlineImages } = await inlineInternalImages(signedHtml, this.media);
      const htmlBody = appendTrackingPixel(htmlInlined, params.trackingPixelUrl);
      const raw = buildMime({
        from: fromAddress,
        fromName: inbox.name !== fromAddress ? inbox.name : undefined,
        to: params.to,
        toName: params.context?.toName,
        cc: params.cc,
        bcc: params.bcc,
        subject,
        body: textBody,
        html: htmlBody,
        messageId,
        inReplyTo: params.context?.inReplyTo,
        references: params.context?.references ?? params.context?.inReplyTo,
        attachments,
        inlineImages,
      });
      // buildMime speaks Gmail's base64url; Graph wants standard base64.
      const mime = Buffer.from(raw, "base64url").toString("base64");
      if (mime.length > MAX_MIME_BYTES) {
        return { ok: false, error: "Outlook can't send a message this large — attachments must total under about 3 MB" };
      }
      await graph.sendMime(accessToken, mailboxPath(config[OUTLOOK_CONFIG.sharedMailbox] || undefined), mime);
      return { ok: true, channelMsgId: messageId };
    } catch (err) {
      if (err instanceof GraphApiError) {
        return { ok: false, error: err.message, errorCode: String(err.status), httpStatus: err.status };
      }
      // Token refresh / network error before any HTTP response — transient.
      return { ok: false, error: err instanceof Error ? err.message : String(err), retryable: true };
    }
  }
}
