import { Injectable } from "@nestjs/common";
import type { ChannelType } from "@ding/schemas";
import { ChannelProvider, type SendParams, type SendResult } from "../channel-provider";
import { SmsService } from "./sms.service";

/** SMS through whichever provider the sending channel is configured for. */
@Injectable()
export class SmsProvider extends ChannelProvider {
  constructor(private readonly sms: SmsService) {
    super();
  }

  supports(channel: ChannelType): boolean {
    return channel === "sms";
  }

  async sendText(params: SendParams): Promise<SendResult> {
    // Plain SMS has no attachments (the composers hide the button). Refused
    // rather than dropped, so nobody thinks a photo went that didn't.
    if (params.media?.length) {
      return { ok: false, retryable: false, errorCode: "attachments", error: "SMS can't carry attachments — send the text on its own, or reply on another channel." };
    }
    return this.sms.send(params.inboxId ?? params.conversation.inboxId, {
      to: params.to,
      text: params.body,
      messageId: params.messageId,
    });
  }
}
