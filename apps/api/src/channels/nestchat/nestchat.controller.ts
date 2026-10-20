import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  UploadedFile,
  UseInterceptors,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import { channelContactTag } from "../arrival-tags";
import { Throttle } from "@nestjs/throttler";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { randomBytes } from "node:crypto";
import {
  externalIdentity,
  nestchatAcceptsUpload,
  NESTCHAT_MAX_UPLOAD_BYTES,
  NESTCHAT_VOICE_MAX_MS,
  NESTCHAT_WAVEFORM_BARS,
  nestchatAppSessionInputSchema,
  nestchatDeviceInputSchema,
  nestchatIdentifyInputSchema,
  nestchatReactInputSchema,
  nestchatReadInputSchema,
  nestchatSendInputSchema,
  nestchatSessionInputSchema,
  nestchatStartInputSchema,
  nestchatTypingInputSchema,
  nestchatViewingInputSchema,
  toPublicRouting,
  type NestChatAppSession,
  type NestChatAppSessionInput,
  type NestChatConfig,
  type NestChatConversations,
  type NestChatMessage,
  type NestChatDeviceInput,
  type NestChatIdentifyInput,
  type NestChatIdentifyResult,
  type NestChatReactInput,
  type NestChatReadInput,
  type NestChatSendInput,
  type NestChatSession,
  type NestChatUploadResult,
  type NestChatSessionInput,
  type NestChatStartInput,
  type NestChatStartResult,
  type NestChatTypingInput,
  type NestChatViewingInput,
} from "@ding/schemas";
import type { Inbox } from "@ding/schemas";
import type { AttachmentInput } from "../../data/store";
import { Public } from "../../auth/public.decorator";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { Store } from "../../data/store";
import { MediaService } from "../../storage/media.service";
import { RealtimeGateway } from "../../realtime/realtime.gateway";
import { IngestService } from "../ingest.service";
import { NestChatService, visitorStamp } from "./nestchat.service";
import { VisitorBus } from "./visitor-bus";
import { ConversationSubjectService } from "../../ai/conversation-subject.service";

/** The subset of a multer file we rely on (avoids an Express.Multer.File dep). */
interface UploadedFileLike {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

/** Pull the visitor's bearer token off the request. */
function bearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const [scheme, value] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" ? value : undefined;
}

/**
 * The NestChat widget's API — the one part of this platform that answers
 * strangers.
 *
 * Every other route sits behind a session; these are reached from an iframe on
 * somebody else's website by someone who has never signed in to anything. Three
 * things keep that safe, and they are the reason this is a controller of its own
 * rather than routes spread through the app:
 *
 *  - the widget key identifies a channel and authorises nothing beyond "open a
 *    chat with this business", which is what a chat widget is for;
 *  - everything past `POST /session` requires a visitor token scoped to exactly
 *    one conversation, so a visitor can only ever read and write their own;
 *  - nothing internal is returned. Replies are projected field by field by
 *    NestChatService rather than serialised from the domain object.
 */
@Public()
@Controller("nestchat")
export class NestChatController {
  constructor(
    private readonly nestchat: NestChatService,
    private readonly store: Store,
    private readonly ingest: IngestService,
    private readonly bus: VisitorBus,
    private readonly media: MediaService,
    private readonly realtime: RealtimeGateway,
    private readonly subjects: ConversationSubjectService,
  ) {}

  /** What the widget needs before it draws anything. No customer data. */
  @Get(":widgetKey/config")
  async config(@Param("widgetKey") widgetKey: string): Promise<NestChatConfig> {
    const inbox = await this.nestchat.inboxForWidgetKey(widgetKey);
    return this.buildConfig(inbox, widgetKey);
  }

  /**
   * The same thing for an app.
   *
   * An app fetches this before it draws its messenger, for the same reasons a
   * widget does — the brand colour, the greeting, the home cards, whether
   * anybody is on. Keyed by the app key rather than the widget's, so a channel
   * with the app surface turned off answers nothing here even though its
   * website is still live.
   */
  @Get("app/:appKey/config")
  async appConfig(@Param("appKey") appKey: string): Promise<NestChatConfig> {
    const { inbox } = await this.nestchat.inboxForAppKey(appKey);
    // The logo route is the widget's, and it is keyed by the widget key — the
    // file is the channel's either way, and minting a second route for the same
    // bytes would be two ways to fetch one picture.
    return this.buildConfig(inbox, await this.nestchat.ensureWidgetKey(inbox.id));
  }

  private async buildConfig(inbox: Inbox, widgetKey: string): Promise<NestChatConfig> {
    const appearance = await this.nestchat.appearanceFor(inbox.id);
    const preChat = await this.nestchat.preChatFor(inbox.id);
    const routing = await this.nestchat.routingFor(inbox.id);
    const home = await this.nestchat.homeFor(inbox.id);
    const away = await this.nestchat.awayFor(inbox.id);
    return {
      appearance: {
        ...appearance,
        /*
         * An uploaded logo is served by this channel's own public route, so its
         * address is built here rather than stored.
         *
         * Root-relative for the same reason the avatar route is: the only thing
         * that loads it is the widget document, served from whatever origin the
         * customer pointed their embed at, so the browser resolves it against
         * the host actually answering. Building it from a configured app URL
         * instead 404s on every deployment where the two aren't the same
         * string, and fails silently — you just get no logo.
         */
        logoUrl: appearance.logoAttachmentId
          ? `/api/nestchat/${encodeURIComponent(widgetKey)}/logo`
          : appearance.logoUrl,
      },
      // Somebody who answers this channel is available now — not just anybody
      // in the workspace with the app open.
      online: await this.nestchat.channelOnline(inbox),
      // Only when the business asked for it: showing who is behind the counter
      // is a choice, not a default we make on their behalf.
      team: appearance.showTeam ? await this.nestchat.teamFacesFor(inbox) : undefined,
      preChat: preChat.enabled ? preChat : undefined,
      routing: toPublicRouting(routing, inbox.teamIds),
      // Sent whole: unlike the routing menu, nothing on a home card is internal
      // — a label, a line of text and a link the business wants people to use.
      home: home.enabled ? home : undefined,
      away: { homeLine: away.homeLine, thanks: away.thanks },
    };
  }

  /**
   * One agent's photo, for the faces in the widget's header.
   *
   * Its own route because the ordinary media endpoint is session-guarded and a
   * visitor has no session. Scoped hard: the widget key names a channel, and
   * the user must be on a team that channel routes to — so this serves the
   * faces that widget already shows and nothing else.
   */
  @Get(":widgetKey/avatar/:userId")
  async avatar(
    @Param("widgetKey") widgetKey: string,
    @Param("userId") userId: string,
    @Res() res: Response,
  ): Promise<void> {
    const inbox = await this.nestchat.inboxForWidgetKey(widgetKey);
    if (!(await this.nestchat.servesWidget(inbox, userId))) {
      throw new NotFoundException("No such avatar");
    }
    const user = await this.store.getUser(userId);
    // avatarUrl is our own media path; the id at the end is what we can stream.
    const attachmentId = user?.avatarUrl?.split("/").pop();
    const file = attachmentId ? await this.media.load(attachmentId) : null;
    if (!file) throw new NotFoundException("No such avatar");
    res.setHeader("Content-Type", file.mime || "application/octet-stream");
    // A face doesn't change often, and this is on somebody else's page.
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.end(file.bytes);
  }

  /**
   * The channel's uploaded logo.
   *
   * Its own public route for the same reason the avatar one exists: the
   * ordinary media endpoint is session-guarded and a visitor has no session.
   * Scoped to exactly the file this channel's own settings name — the id is
   * never taken from the request, so this cannot be turned into a reader for
   * arbitrary attachments.
   */
  @Get(":widgetKey/logo")
  async logo(@Param("widgetKey") widgetKey: string, @Res() res: Response): Promise<void> {
    const inbox = await this.nestchat.inboxForWidgetKey(widgetKey);
    const appearance = await this.nestchat.appearanceFor(inbox.id);
    const file = appearance.logoAttachmentId
      ? await this.media.load(appearance.logoAttachmentId)
      : null;
    if (!file) throw new NotFoundException("No logo");
    res.setHeader("Content-Type", file.mime || "application/octet-stream");
    // A logo changes about never, and this is on somebody else's page.
    res.setHeader("Cache-Control", "public, max-age=3600");
    // Never inline-render an SVG from our own origin as a document: it can
    // carry script. As an <img> source it is inert, and this header stops it
    // being opened as a page.
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.end(file.bytes);
  }

  /**
   * Open a chat, or resume the one this browser already had.
   *
   * The visitor id comes from the widget's own localStorage, which means a
   * visitor can claim to be anyone — so it is treated as a *hint*, not proof:
   * it selects which conversation to continue, and the worst a forged one can do
   * is show someone a chat they'd have to guess a 32-hex id to find. What it
   * must never do is identify a customer we know by another channel, which is
   * why the identity kind is `nestchat` and never `email`.
   */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post(":widgetKey/session")
  async session(
    @Param("widgetKey") widgetKey: string,
    @Body(new ZodValidationPipe(nestchatSessionInputSchema)) body: NestChatSessionInput,
  ): Promise<NestChatSession> {
    const inbox = await this.nestchat.inboxForWidgetKey(widgetKey);

    // A website that knows who is signed in, and signed it. The same rule as an
    // app: the user's id under the channel's secret, checked here, or nothing
    // they sent is believed. There is no "trust it anyway" setting for a
    // website — a browser can be made to say anything, and an email is what
    // joins a chat onto a customer's history.
    const externalId = body.externalId?.trim();
    if (externalId) {
      if (await this.nestchat.verifyUserHash(inbox.id, externalId, body.userHash ?? "")) {
        return this.signedInWebSession(inbox, externalId, body);
      }
      await this.nestchat.reportUnverifiedIdentity(inbox, externalId, "website");
    }

    const visitorId = body.visitorId?.trim() || randomBytes(16).toString("hex");

    const contact = await this.store.upsertContactByIdentity({
      orgId: inbox.orgId,
      kind: "nestchat",
      value: visitorId,
      // A name they typed beats "Visitor 4f2a1c", but only for a brand-new
      // contact: upsert must not let a stranger rename someone by reusing an id.
      displayName: body.name?.trim() || `Visitor ${visitorId.slice(0, 6)}`,
    });

    // Resume the open thread on this channel if there is one. Nothing is created
    // here — a conversation is opened by the first message. That is deliberate:
    // an agent shouldn't see a queue item for someone who opened the widget and
    // thought better of it.
    // Only a thread this browser started: the contact may since have been
    // merged onto a customer whose own open chat is not the visitor's to join.
    const withConvs = await this.store.getContactWithConversations(contact.id);
    const conversationId = withConvs?.conversations.find(
      (c) => c.inboxId === inbox.id && c.status !== "closed" && c.channelRef === visitorStamp(visitorId),
    )?.id;

    // What the page is about — `fields` in its settings. Conversation fields
    // only, so a visitor can describe their chat but never rewrite a record.
    const { values, unknown } = await this.nestchat.validateFields(inbox.id, body.fields ?? {});
    const hasFields = Object.keys(values).length > 0;
    if (conversationId && hasFields) {
      await this.store.setCustomFieldValues(inbox.orgId, "conversation", conversationId, values);
      await this.subjects.fieldsChanged(conversationId);
    }

    const token = conversationId
      ? this.nestchat.signVisitorToken({ visitorId, inboxId: inbox.id, contactId: contact.id, conversationId })
      : // No thread yet: the token names the contact, and the first message
        // creates the conversation and mints a token that names it too.
        this.nestchat.signVisitorToken({
          visitorId,
          inboxId: inbox.id,
          contactId: contact.id,
          conversationId: "",
          ...(hasFields ? { fields: values } : {}),
        });

    return {
      visitorId,
      token,
      hasConversation: Boolean(conversationId),
      messages: conversationId ? await this.nestchat.visitorHistory(conversationId) : [],
      known: await this.nestchat.knownFor(contact.id),
      ...(externalId ? { identified: false } : {}),
      ...(unknown.length ? { unknownFields: unknown } : {}),
    };
  }

  /**
   * A website's signed-in user, verified.
   *
   * Keyed exactly as an app user is — the channel and the site's own id — so a
   * customer who chats on the website and later in the app is one person with
   * one history, on whichever browser or phone they pick up.
   */
  private async signedInWebSession(
    inbox: Inbox,
    externalId: string,
    body: NestChatSessionInput,
  ): Promise<NestChatSession> {
    const app = await this.nestchat.appFor(inbox.id);
    const visitorId = externalIdentity(inbox.id, externalId);
    const contact = await this.store.upsertContactByIdentity({
      orgId: inbox.orgId,
      kind: "external",
      value: visitorId,
      displayName: body.name?.trim() || `Visitor ${visitorId.slice(-6)}`,
    });
    await this.nestchat.identifyVisitor(
      { visitorId, inboxId: inbox.id, contactId: contact.id, conversationId: "" },
      { name: body.name, email: body.email, phone: body.phone },
    );

    const { values, unknown } = await this.nestchat.validateFields(inbox.id, body.fields ?? {});
    const conversationId = await this.nestchat.threadFor(inbox, contact.id, app, values, visitorId);
    if (conversationId && Object.keys(values).length) {
      await this.store.setCustomFieldValues(inbox.orgId, "conversation", conversationId, values);
      await this.subjects.fieldsChanged(conversationId);
    }

    return {
      visitorId,
      token: this.nestchat.signVisitorToken({
        visitorId,
        inboxId: inbox.id,
        contactId: contact.id,
        conversationId: conversationId ?? "",
        ...(conversationId ? {} : { fields: values }),
      }),
      hasConversation: Boolean(conversationId),
      messages: conversationId ? await this.nestchat.visitorHistory(conversationId) : [],
      known: await this.nestchat.knownFor(contact.id),
      identified: true,
      unknownFields: unknown,
    };
  }

  /**
   * An app opens a session.
   *
   * The counterpart to `POST :widgetKey/session` for a client that is not a
   * browser, and the differences are the whole point of it existing:
   *
   *  - the person is keyed by the app's own user id, so a reinstall or a new
   *    phone keeps their history, where a browser id would not;
   *  - the channel decides how hard to check that claim, because an app that
   *    knows who its user is can prove it and a public web page cannot;
   *  - custom field values arrive with the session, so the thread this opens is
   *    the one for that order rather than whichever was last open.
   *
   * Everything past here is the visitor API the widget already uses. One
   * conversation, one token, one stream — the surfaces differ at the door and
   * nowhere after it.
   */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post("app/:appKey/session")
  async appSession(
    @Param("appKey") appKey: string,
    @Body(new ZodValidationPipe(nestchatAppSessionInputSchema)) body: NestChatAppSessionInput,
  ): Promise<NestChatAppSession> {
    const { inbox, app } = await this.nestchat.inboxForAppKey(appKey);

    // Whether we believe them. `required` refuses an unsigned claim outright;
    // `optional` carries on anonymously, which is what lets an app ship before
    // the backend that signs for it.
    const externalId = body.externalId?.trim();
    let identified = false;
    if (externalId) {
      if (app.identity === "off") identified = true;
      else {
        identified = await this.nestchat.verifyUserHash(inbox.id, externalId, body.userHash ?? "");
        if (!identified && app.identity === "required") {
          throw new ForbiddenException("This app must sign who its users are");
        }
      }
    }

    // An unverified session is anonymous rather than rejected — it gets a
    // per-install id and none of the details sent with it, so a stranger
    // holding the app key can open a chat but cannot become a customer.
    const visitorId = identified && externalId
      ? externalIdentity(inbox.id, externalId)
      : randomBytes(16).toString("hex");

    const contact = await this.store.upsertContactByIdentity({
      orgId: inbox.orgId,
      kind: identified ? "external" : "nestchat",
      value: visitorId,
      displayName:
        (identified ? body.name?.trim() : undefined) || `Visitor ${visitorId.slice(-6)}`,
    });

    if (identified) {
      // Only now: an unverified caller must not be able to write an email onto
      // a record, because a matching one is what merges this session onto a
      // customer we already know.
      await this.nestchat.identifyVisitor(
        { visitorId, inboxId: inbox.id, contactId: contact.id, conversationId: "" },
        { name: body.name, email: body.email, phone: body.phone },
      );
    } else if (externalId) {
      // They told us who this is and we could not believe it. Everything they
      // sent has just been dropped, which is right — and used to be silent,
      // which is how an app can run for weeks filing every customer as
      // "Visitor 3f9a21" with nobody able to say why.
      await this.nestchat.reportUnverifiedIdentity(inbox, externalId);
    }

    // The tag goes on either way. It says where this customer came from, which
    // is true whether or not we could verify who they are — the setting calls
    // it "a tag put on every contact this channel creates", and it was only
    // ever applied to verified ones. Attribution is not an identity claim, and
    // withholding it meant a channel's own customers could not be found by the
    // tag that exists to find them.
    await this.nestchat.applyContactTag(contact.id, await channelContactTag(this.store, inbox));

    const { values, unknown } = await this.nestchat.validateFields(inbox.id, body.fields ?? {});
    const conversationId = await this.nestchat.threadFor(inbox, contact.id, app, values, visitorId);
    // Written straight onto an existing thread; carried in the token otherwise,
    // because there is nothing to write them on until the first message creates
    // a conversation.
    if (conversationId && Object.keys(values).length) {
      await this.store.setCustomFieldValues(inbox.orgId, "conversation", conversationId, values);
      await this.subjects.fieldsChanged(conversationId);
    }

    return {
      token: this.nestchat.signVisitorToken({
        visitorId,
        inboxId: inbox.id,
        contactId: contact.id,
        conversationId: conversationId ?? "",
        ...(conversationId ? {} : { fields: values }),
      }),
      hasConversation: Boolean(conversationId),
      messages: conversationId ? await this.nestchat.visitorHistory(conversationId) : [],
      known: await this.nestchat.knownFor(contact.id),
      identified,
      unknownFields: unknown,
    };
  }

  /**
   * A customer attaches a file.
   *
   * Its own route rather than the agents' upload, which is session-guarded and
   * has no session to check here. Three things make that safe to expose:
   *
   *  - the visitor token scopes it, so only somebody already in a conversation
   *    can upload at all;
   *  - the type is checked against an allowlist. This takes files from
   *    strangers and serves them back from our own domain, so the question is
   *    not whether a type is dangerous but whether there is any reason to
   *    accept it — a photo of a wrong order, yes; an installer, no;
   *  - nothing is written to the database. The file goes to storage and the
   *    caller gets a signed ticket describing it, redeemed when the message is
   *    actually sent — so an upload nobody sends leaves no row behind, and the
   *    client cannot rename or re-type the file on the way.
   */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post("upload")
  @UseInterceptors(FileInterceptor("file"))
  async upload(
    @Headers("authorization") auth: string | undefined,
    @UploadedFile() file: UploadedFileLike | undefined,
    // Multipart, so these arrive as strings beside the file part rather than
    // as JSON. Unvalidated by a pipe on purpose — `readVoiceMeta` decides, and
    // a malformed pair means "an ordinary audio file", not a failed upload.
    @Body() body: Record<string, unknown> | undefined,
  ): Promise<NestChatUploadResult> {
    const claims = await this.nestchat.visitor(bearer(auth));
    if (!file?.buffer?.length) throw new BadRequestException("No file uploaded");
    if (file.size > NESTCHAT_MAX_UPLOAD_BYTES) {
      throw new BadRequestException("That file is too large — 25 MB is the limit");
    }
    if (!nestchatAcceptsUpload(file.mimetype)) {
      throw new BadRequestException("That kind of file can't be attached here");
    }

    const stored = await this.media.store(file.buffer, {
      mime: file.mimetype,
      // The name is taken from the part and then only ever used as a label. It
      // is never a path, so the one thing it must not carry is a separator.
      filename: (file.originalname || "file").replace(/[/\\\r\n"]/g, "_").slice(0, 120),
    });

    // A recording and an audio file someone attached are both `audio/…`, and
    // only the first should be drawn as a waveform with a play button. What
    // separates them is that the recorder measured the note while it was being
    // made: the duration and the bars it drew. So the presence of those is the
    // claim "this is a voice note", and it rides inside the signed ticket with
    // the rest of the file's details — otherwise a client could attach one
    // upload's shape to another's bytes between uploading and sending.
    const voice = readVoiceMeta(body);
    const attachment: AttachmentInput = voice
      ? { ...stored, kind: "voice", durationMs: voice.durationMs, waveform: voice.waveform }
      : stored;

    return {
      ticket: this.nestchat.signAttachmentTicket(claims.contactId, attachment),
      filename: attachment.filename,
      mime: attachment.mime,
      size: attachment.size,
      kind: attachment.kind,
    };
  }

  /** The visitor writes. Creates the conversation on the first message. */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post("message")
  async send(
    @Headers("authorization") auth: string | undefined,
    @Body(new ZodValidationPipe(nestchatSendInputSchema)) body: NestChatSendInput,
  ) {
    const claims = await this.nestchat.visitor(bearer(auth));
    const inbox = (await this.store.listInboxes()).find((i) => i.id === claims.inboxId);
    if (!inbox || inbox.type !== "nestchat") throw new NotFoundException("Chat unavailable");
    const contact = await this.store.getContact(claims.contactId);
    if (!contact) throw new NotFoundException("Chat unavailable");

    // From the token, not the request body: the visitor chose this on the
    // pre-chat form and the choice was signed there. Re-resolved rather than
    // trusted — the option may have been renamed or its team taken off the
    // channel while they were typing.
    const chosen = await this.nestchat.resolveOption(inbox, claims.optionId);

    // Redeemed against the token's own contact, so a ticket is useless to
    // anybody it was not issued to. A bad one is dropped rather than failing
    // the send: the words somebody typed are worth more than the photo that
    // was meant to go with them.
    const attachments = this.nestchat.redeemAttachmentTickets(claims.contactId, body.attachments);
    if (!body.body.trim() && !attachments.length) {
      throw new BadRequestException("Nothing to send");
    }

    // The session's own conversation (or, for a chat keyed per order, this
    // order's) — never simply the customer's most recent open one.
    const target = await this.nestchat.sendTarget(inbox, contact.id, claims);
    const result = await this.ingest.ingestNestChat({
      inbox,
      contact,
      text: body.body,
      pageUrl: body.pageUrl,
      option: chosen ? { label: chosen.option.label, teamId: chosen.teamId } : undefined,
      attachments,
      quotedMsgId: body.quotedMsgId,
      startedBy: visitorStamp(claims.visitorId),
      conversationId: target.conversationId,
      forceNew: target.forceNew,
    });
    // Blocked contact: accepted and dropped. Telling them they're blocked only
    // teaches them to come back with a fresh visitor id.
    if (!result) return { ok: true };

    // Field values an app sent when it opened the session, written now that
    // there is a conversation to write them on. From the signed token rather
    // than this request, so the order a thread is filed under is the one the
    // app asked for and not one the client edited on the way.
    // These now land on the thread they were for: the new one, or the open one
    // for the same order. They used to land on whatever thread the message had
    // joined, which is how order A's chat ended up labelled as order B.
    const pending = target.fields ?? claims.fields;
    if (pending && Object.keys(pending).length) {
      await this.store.setCustomFieldValues(
        inbox.orgId,
        "conversation",
        result.conversationId,
        pending,
      );
      await this.subjects.fieldsChanged(result.conversationId);
    }

    const message = result.message
      ? this.nestchat.toVisitorMessage(
          result.message,
          (await this.store.getConversation(result.conversationId))?.messages,
        )
      : undefined;
    // Nobody online: tell them so, in the thread (once per stretch).
    const away = await this.nestchat.awayReply(inbox, result.conversationId);
    return {
      ok: true,
      message,
      ...(away ? { away } : {}),
      // The first message is what creates the conversation, so the token the
      // widget holds doesn't name one yet. Hand back the one that does — with
      // the pending fields dropped, now that they have somewhere to live. A
      // stale copy would re-stamp the order onto a thread somebody had since
      // corrected.
      token:
        claims.conversationId === result.conversationId && !claims.fields
          ? undefined
          : this.nestchat.signVisitorToken({
              ...claims,
              conversationId: result.conversationId,
              fields: undefined,
            }),
    };
  }

  /**
   * The visitor puts an emoji on a message, or takes theirs off.
   *
   * Answers `{ ok: false }` rather than a 404 for a message that is not
   * theirs to react to. The distinction a 404 would draw — this id exists,
   * that one does not — is the only thing an unauthenticated caller could
   * learn here, and it is worth nothing to the widget, which knows perfectly
   * well which messages it is showing.
   */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post("react")
  async react(
    @Headers("authorization") auth: string | undefined,
    @Body(new ZodValidationPipe(nestchatReactInputSchema)) body: NestChatReactInput,
  ) {
    const claims = await this.nestchat.visitor(bearer(auth));
    const result = await this.nestchat.reactAsVisitor(claims, body.messageId, body.emoji);
    if (!result) return { ok: false };
    // Straight to the agents watching the thread. The visitor's own widget has
    // already drawn it — it did so the moment they tapped, because a reaction
    // that waits for a round trip feels broken however fast the round trip is.
    if (claims.conversationId) {
      this.realtime.emitMessageUpdated(claims.conversationId, result.stored);
      void this.ingest.customerReacted(claims.conversationId, result.stored.id, body.emoji).catch(() => undefined);
    }
    return { ok: true, message: result.visible };
  }

  /** Everything said so far, for a widget that has just reconnected. */
  @Get("messages")
  async messages(@Headers("authorization") auth: string | undefined) {
    const claims = await this.nestchat.visitor(bearer(auth));
    if (!claims.conversationId) return { messages: [] };
    return { messages: await this.nestchat.visitorHistory(claims.conversationId) };
  }

  /**
   * Every conversation this visitor has had on this channel.
   *
   * What makes it necessary: a closed chat is never resumed — `threadFor` only
   * joins an open one — so the moment an agent resolved a thread it vanished
   * from the customer's side. They opened the chat, found an empty box, and
   * everything agreed about their order was readable only by the business.
   *
   * No id in the request. The contact and the channel both come out of the
   * signed token, so this can only ever be the caller's own history.
   */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get("conversations")
  async conversations(
    @Headers("authorization") auth: string | undefined,
  ): Promise<NestChatConversations> {
    const claims = await this.nestchat.visitor(bearer(auth));
    return { conversations: await this.nestchat.visitorConversations(claims) };
  }

  /**
   * One earlier conversation, read in full.
   *
   * 404 for a thread that is not this visitor's, which is the same answer as one
   * that does not exist. The distinction is the only thing somebody trying ids
   * could learn here, and it is worth nothing to a client that already knows
   * which conversations it was offered.
   */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get("conversations/:conversationId/messages")
  async pastMessages(
    @Headers("authorization") auth: string | undefined,
    @Param("conversationId") conversationId: string,
  ): Promise<{ messages: NestChatMessage[] }> {
    const claims = await this.nestchat.visitor(bearer(auth));
    const messages = await this.nestchat.visitorConversation(claims, conversationId);
    if (!messages) throw new NotFoundException("No such conversation");
    return { messages };
  }

  /**
   * Switch this session to another of the visitor's own open conversations —
   * the order they tapped on the home screen, rather than the one the session
   * happened to be on. A new token comes back naming it, with its messages.
   *
   * 404 for one that isn't theirs, doesn't exist or is closed: the same answer
   * reading one gives, for the same reason.
   */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post("conversations/:conversationId/open")
  async openConversation(
    @Headers("authorization") auth: string | undefined,
    @Param("conversationId") conversationId: string,
  ): Promise<{ token: string; hasConversation: true; messages: NestChatMessage[] }> {
    const claims = await this.nestchat.visitor(bearer(auth));
    const switched = await this.nestchat.switchVisitorConversation(claims, conversationId);
    if (!switched) throw new NotFoundException("No such open conversation");
    return { token: switched.token, hasConversation: true, messages: switched.messages };
  }

  /**
   * The pre-chat form, submitted: who they are, and what they're here about.
   *
   * One call rather than an identify followed by a routing call, because these
   * are answers to one form — and half-applying them would put a visitor in
   * front of the wrong team under their own name, which is worse than either
   * failure on its own.
   *
   * Deliberately before the conversation exists. Identifying first is what lets
   * the merge in `identifyVisitor` find a customer we already know *before* the
   * first message creates a thread, so the thread is born on their record —
   * with their history, their owner and their name in the agent's queue —
   * instead of on `Visitor 4f2a1c` and stitched over afterwards.
   *
   * The token is always reissued, not only after a merge as `identify` does:
   * the routing choice lives in the claims, so a token that didn't change would
   * be a choice that didn't take.
   */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("start")
  async start(
    @Headers("authorization") auth: string | undefined,
    @Body(new ZodValidationPipe(nestchatStartInputSchema)) body: NestChatStartInput,
  ): Promise<NestChatStartResult> {
    const claims = await this.nestchat.visitor(bearer(auth));
    const inbox = await this.store.getInbox(claims.inboxId);
    if (!inbox || inbox.type !== "nestchat") throw new NotFoundException("Chat unavailable");

    const { saved, linked, contactId } = await this.nestchat.identifyVisitor(claims, body);
    const chosen = await this.nestchat.resolveOption(inbox, body.optionId);
    const appearance = await this.nestchat.appearanceFor(inbox.id);

    return {
      ok: true,
      saved,
      linked,
      token: this.nestchat.signVisitorToken({ ...claims, contactId, optionId: chosen?.option.id }),
      option: chosen ? { id: chosen.option.id, label: chosen.option.label } : undefined,
      // Narrowed to the team that will actually answer — but still only if this
      // channel shows faces at all. A business that turned the team off doesn't
      // want it back because somebody pressed "Billing".
      team:
        appearance.showTeam && chosen?.teamId
          ? await this.nestchat.teamFacesFor(inbox, { teamId: chosen.teamId })
          : undefined,
    };
  }

  /**
   * The visitor gives their name, email or phone from the card inside the
   * thread — the ask for channels that don't put a form in front of the chat.
   *
   * The work, including what a match with a customer we already know means, is
   * `NestChatService.identifyVisitor`; it is shared with the pre-chat form above
   * so the two asks can't drift into treating the same details differently.
   */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("identify")
  async identify(
    @Headers("authorization") auth: string | undefined,
    @Body(new ZodValidationPipe(nestchatIdentifyInputSchema)) body: NestChatIdentifyInput,
  ): Promise<NestChatIdentifyResult> {
    const claims = await this.nestchat.visitor(bearer(auth));
    const { saved, linked, contactId } = await this.nestchat.identifyVisitor(claims, body);
    return {
      ok: true,
      saved,
      linked,
      // A merge deletes the contact the visitor's token names, so it has to be
      // reissued against the surviving one or every later call 404s.
      token: linked ? this.nestchat.signVisitorToken({ ...claims, contactId }) : undefined,
    };
  }

  /**
   * The visitor's widget reporting how far it has got: what moves an agent's
   * ticks from sent to delivered to read.
   *
   * The widget is trusted for this in the same way a phone is trusted to say it
   * displayed a WhatsApp message — it is a claim about the other end that only
   * the other end can make. It is bounded by the token's own conversation, so
   * the worst a forged one does is mark that visitor's own thread read.
   */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post("read")
  async read(
    @Headers("authorization") auth: string | undefined,
    @Body(new ZodValidationPipe(nestchatReadInputSchema)) body: NestChatReadInput,
  ) {
    const claims = await this.nestchat.visitor(bearer(auth));
    if (!claims.conversationId) return { ok: true };
    const changed = await this.store.markOutboundStatusUpTo(
      claims.conversationId,
      body.throughMessageId,
      body.status,
    );
    // Tell the agents' inbox so the ticks move while they're looking at it.
    const conv = changed.length ? await this.store.getConversation(claims.conversationId) : undefined;
    for (const c of changed) {
      this.realtime.emitMessageUpdated(c.conversationId, c.message, conv?.orgId);
    }
    return { ok: true, updated: changed.length };
  }

  /**
   * The visitor is typing — relayed to the agents watching the thread, along
   * with what they have written so far.
   *
   * The draft is the point: on a live chat an agent can be looking up the order
   * number before the question finishes arriving, which is the whole difference
   * between a chat and a contact form. It is never stored — it goes to the
   * conversation room and is gone.
   *
   * The limit is generous because the widget sends one of these under once a
   * second while somebody types. It is still a limit: this is an unauthenticated
   * endpoint reachable with any visitor token.
   */
  @Throttle({ default: { limit: 240, ttl: 60_000 } })
  @Post("typing")
  async typing(
    @Headers("authorization") auth: string | undefined,
    @Body(new ZodValidationPipe(nestchatTypingInputSchema)) body: NestChatTypingInput,
  ) {
    const claims = await this.nestchat.visitor(bearer(auth));
    if (!claims.conversationId) return { ok: true };
    const contact = await this.store.getContact(claims.contactId);
    this.realtime.emitTyping(
      claims.conversationId,
      contact?.displayName ?? "Visitor",
      true,
      body.preview,
    );
    return { ok: true };
  }

  /**
   * Where to ring this customer when an agent replies.
   *
   * Scoped to the token, so a device can only ever be registered against the
   * contact the token already names — the alternative, a contact id in the
   * body, would let anyone with an app key point somebody else's phone at their
   * own conversation and read every reply from the lock screen.
   *
   * The channel comes from the token too. A customer with two of the business's
   * apps has a row per app, and a reply on one must not ring the other.
   */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post("device")
  async registerDevice(
    @Headers("authorization") auth: string | undefined,
    @Body(new ZodValidationPipe(nestchatDeviceInputSchema)) body: NestChatDeviceInput,
  ) {
    const claims = await this.nestchat.visitor(bearer(auth));
    const inbox = await this.store.getInbox(claims.inboxId);
    if (!inbox) throw new NotFoundException("Channel not found");
    // A token outlives the contact it names — the customer was merged into
    // another record, or deleted. The row cannot be written (the foreign key
    // says so) and that used to surface as a 500 on an endpoint the app calls
    // at every launch, which reads as the whole chat being down rather than as
    // one stale registration. Nothing is lost by declining it: the next
    // session mints a token naming a contact that exists, and the SDK offers
    // its push address again.
    if (!(await this.store.getContact(claims.contactId))) {
      return { ok: false, reason: "stale_session" };
    }
    await this.store.registerCustomerDevice({
      orgId: inbox.orgId,
      contactId: claims.contactId,
      inboxId: claims.inboxId,
      token: body.token,
      platform: body.platform,
    });
    return { ok: true };
  }

  /**
   * Stop ringing this one — a sign-out, or notifications turned off in the app.
   *
   * Deleted rather than disabled: a disabled row means "the push service told
   * us this address is dead", and a customer who signs out has said something
   * quite different. Keeping the two apart is what makes the disabled ones
   * worth reading when somebody asks why a phone stopped buzzing.
   */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post("device/forget")
  async forgetDevice(
    @Headers("authorization") auth: string | undefined,
    @Body(new ZodValidationPipe(nestchatDeviceInputSchema)) body: NestChatDeviceInput,
  ) {
    const claims = await this.nestchat.visitor(bearer(auth));
    const removed = await this.store.deleteCustomerDevice(claims.contactId, body.token);
    return { ok: true, removed };
  }

  /**
   * One attachment an agent sent, streamed to the visitor.
   *
   * The token names a conversation and the attachment must belong to a message
   * in it — an id from someone else's thread is a 404, not a download. The token
   * rides in the query string because this URL goes into an `<a href>` and an
   * `<img src>`, where a header cannot follow it.
   */
  @Get("media/:attachmentId")
  async mediaFile(
    @Param("attachmentId") attachmentId: string,
    @Query("token") token: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const claims = await this.nestchat.visitor(token);
    const conv = claims.conversationId
      ? await this.store.getConversation(claims.conversationId)
      : undefined;
    const owned = conv?.messages.some(
      (m) => !m.internal && m.attachments?.some((a) => a.id === attachmentId),
    );
    if (!owned) throw new NotFoundException("File not found");

    const file = await this.media.load(attachmentId);
    if (!file) throw new NotFoundException("File not found");
    res.setHeader("Content-Type", file.mime || "application/octet-stream");
    res.setHeader("Cache-Control", "private, max-age=300");
    // Never inline: this renders on a third-party page, and an attacker-supplied
    // HTML or SVG file served inline from our own origin is a stored XSS.
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${(file.filename || "file").replace(/["\\\r\n]/g, "")}"`,
    );
    res.end(file.bytes);
  }

  /**
   * The app's chat is on screen, or is not.
   *
   * Said by apps, repeated every 25 seconds while true, and what decides whether
   * an agent's reply is pushed: not while the customer is reading it, always
   * otherwise. Before this the server inferred it from the live stream, which an
   * app keeps open while it sits in the background — so the replies a push
   * exists for, the ones that arrive while the phone is in a pocket, were the
   * ones it skipped.
   *
   * Nothing to record before the first message: there is no conversation for
   * the screen to be showing, and nothing an agent could reply to.
   */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post("viewing")
  async viewing(
    @Headers("authorization") auth: string | undefined,
    @Body(new ZodValidationPipe(nestchatViewingInputSchema)) body: NestChatViewingInput,
  ): Promise<{ ok: true }> {
    const claims = await this.nestchat.visitor(bearer(auth));
    if (claims.conversationId) await this.bus.setViewing(claims.conversationId, body.viewing);
    return { ok: true };
  }

  /**
   * The live stream: agent replies pushed to an open widget.
   *
   * Server-Sent Events rather than the Socket.IO the agents use — see VisitorBus
   * for why. EventSource reconnects on its own, so the only thing this has to do
   * beyond forwarding is keep the connection from being closed by an idle proxy,
   * which the comment heartbeat does.
   */
  @Get("stream")
  async stream(
    @Query("token") token: string | undefined,
    @Query("presence") presence: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const claims = await this.nestchat.visitor(token);
    if (!claims.conversationId) throw new BadRequestException("No conversation yet");

    // Charset named explicitly. Every reader here already decodes UTF-8 — a
    // browser's EventSource because the spec says so, the Dart SDK because it
    // asks for it — so this changes nothing today. It is said anyway because
    // the alternative relies on three separate clients each choosing right
    // about a stream that carries emoji in every reaction.
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    // Nginx and friends buffer by default, which turns a live stream into a
    // stream that arrives all at once when it ends.
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    res.write(": open\n\n");

    // An app sends `presence=viewing`: it reports what is on screen itself, so
    // its stream is not taken to mean somebody is reading. The web widget's
    // stream still is — a widget that is open is a page that is open.
    const unsubscribe = this.bus.subscribe(
      claims.conversationId,
      (event) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      },
      { reportsViewing: presence === "viewing" },
    );
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);
    const stop = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    res.on("close", stop);
    res.on("error", stop);
  }

}

/**
 * The duration and bars a recorder measured, if this upload came with them.
 *
 * Returns nothing for anything it does not like, and never throws: the worst
 * outcome of a malformed pair is that a recording is filed as an ordinary
 * audio file and drawn with a download arrow instead of a waveform. Failing
 * the upload instead would lose the recording itself.
 */
function readVoiceMeta(
  body: Record<string, unknown> | undefined,
): { durationMs: number; waveform: number[] } | undefined {
  if (!body) return undefined;
  const durationMs = Number(body.durationMs);
  if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > NESTCHAT_VOICE_MAX_MS) {
    return undefined;
  }
  // A JSON array in a form field. Parsed defensively — this is a string a
  // stranger sent, and the shape it should have is very specific.
  let raw: unknown;
  try {
    raw = typeof body.waveform === "string" ? JSON.parse(body.waveform) : body.waveform;
  } catch {
    return undefined;
  }
  if (!Array.isArray(raw)) return undefined;
  const waveform = raw
    .slice(0, NESTCHAT_WAVEFORM_BARS)
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v))
    .map((v) => Math.min(1, Math.max(0, v)));
  if (!waveform.length) return undefined;
  return { durationMs: Math.round(durationMs), waveform };
}
