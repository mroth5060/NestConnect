import { Module } from "@nestjs/common";
import { RealtimeModule } from "../realtime/realtime.module";
import { StorageModule } from "../storage/storage.module";
import { PushModule } from "../push/push.module";
import { CHANNEL_PROVIDERS } from "./channel-provider";
import { ChannelDispatcher } from "./channel-dispatcher";
import { OutboundDeliveryService } from "./outbound-delivery.service";
import { IngestService } from "./ingest.service";
import { RoutingService } from "./routing.service";
import { WhatsAppCloudProvider } from "./whatsapp/whatsapp.provider";
import { WhatsAppGroupsProvider } from "./whatsapp/whatsapp-groups.provider";
import { WhatsAppController } from "./whatsapp/whatsapp.controller";
import { WhatsAppService } from "./whatsapp/whatsapp.service";
import { EmailProvider } from "./email/email.provider";
import { EmailController } from "./email/email.controller";
import { EmailService } from "./email/email.service";
import { GroupsService } from "./groups/groups.service";
import { GroupsController } from "./groups/groups.controller";
import { GoogleOAuthService } from "./google/google-oauth.service";
import { GoogleController } from "./google/google.controller";
import { GmailProvider } from "./google/gmail.provider";
import { GmailSyncService } from "./google/gmail-sync.service";
import { MicrosoftOAuthService } from "./microsoft/microsoft-oauth.service";
import { MicrosoftController } from "./microsoft/microsoft.controller";
import { OutlookProvider } from "./microsoft/outlook.provider";
import { OutlookSyncService } from "./microsoft/outlook-sync.service";
import { MetaOAuthService } from "./meta/meta-oauth.service";
import { MetaController } from "./meta/meta.controller";
import { CustomerPushService } from "./nestchat/customer-push.service";
import { NestChatProvider } from "./nestchat/nestchat.provider";
import { NestChatController } from "./nestchat/nestchat.controller";
import { NestChatAdminController } from "./nestchat/nestchat-admin.controller";
import { NestChatService } from "./nestchat/nestchat.service";
import { VisitorBus } from "./nestchat/visitor-bus";
import { DiagnosticsController } from "./diagnostics.controller";
import { IntegrationsController } from "../settings/integrations.controller";

@Module({
  imports: [RealtimeModule, StorageModule, PushModule],
  controllers: [
    WhatsAppController,
    EmailController,
    GroupsController,
    GoogleController,
    MicrosoftController,
    MetaController,
    NestChatController,
    NestChatAdminController,
    DiagnosticsController,
    IntegrationsController,
  ],
  providers: [
    WhatsAppCloudProvider,
    WhatsAppGroupsProvider,
    EmailProvider,
    GmailProvider,
    OutlookProvider,
    NestChatProvider,
    {
      provide: CHANNEL_PROVIDERS,
      useFactory: (
        wa: WhatsAppCloudProvider,
        email: EmailProvider,
        gmailProvider: GmailProvider,
        outlookProvider: OutlookProvider,
        nestchat: NestChatProvider,
      ) => [wa, gmailProvider, outlookProvider, email, nestchat],
      inject: [WhatsAppCloudProvider, EmailProvider, GmailProvider, OutlookProvider, NestChatProvider],
    },
    RoutingService,
    IngestService,
    WhatsAppService,
    EmailService,
    GroupsService,
    GoogleOAuthService,
    GmailSyncService,
    MicrosoftOAuthService,
    OutlookSyncService,
    MetaOAuthService,
    ChannelDispatcher,
    OutboundDeliveryService,
    VisitorBus,
    CustomerPushService,
    NestChatService,
  ],
  exports: [ChannelDispatcher, OutboundDeliveryService, GmailSyncService, OutlookSyncService, MetaOAuthService, NestChatService],
})
export class ChannelsModule {}
