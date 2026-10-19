import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
} from "@nestjs/common";
import {
  createInboxInputSchema,
  smsProviderConfigSchema,
  createLabelInputSchema,
  createTeamInputSchema,
  createUserInputSchema,
  reorderInboxesInputSchema,
  reorderTeamsInputSchema,
  updateInboxInputSchema,
  updateInboxSignatureInputSchema,
  setDefaultInboxInputSchema,
  updateLabelInputSchema,
  updateMyPreferencesInputSchema,
  isTimeZone,
  type AvailabilitySchedule,
  updateMyProfileInputSchema,
  updateTeamInputSchema,
  updateUserInputSchema,
  type CreateInboxInput,
  type CreateLabelInput,
  type CreateTeamInput,
  type CreateUserInput,
  type ReorderInboxesInput,
  type ReorderTeamsInput,
  type UpdateInboxInput,
  type UpdateInboxSignatureInput,
  type SetDefaultInboxInput,
  type UpdateLabelInput,
  type UpdateMyPreferencesInput,
  type UpdateMyProfileInput,
  type UpdateTeamInput,
  type UpdateUserInput,
  type User,
} from "@ding/schemas";
import { newWebhookToken } from "../channels/sms/sms.service";
import { Store } from "../data/store";
import { SandboxPolicy } from "../tenancy/sandbox";
import { isPlatformOrg } from "../tenancy/platform";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUserId } from "../auth/current-user.decorator";
import { Mailer } from "../mail/mailer.service";
import { MetaOAuthService } from "../channels/meta/meta-oauth.service";
import { sanitizeOutboundHtml } from "../channels/email/html-sanitize";
import { env } from "../config/env";

/** Workspace bootstrap data for the app shell, plus the Settings admin surface. */
@Controller()
export class WorkspaceController {
  constructor(
    private readonly store: Store,
    private readonly mailer: Mailer,
    private readonly metaOAuth: MetaOAuthService,
    private readonly sandbox: SandboxPolicy,
  ) {}

  /** Subscribe a WhatsApp number's WhatsApp Business Account to our app so its
   *  inbound messages + delivery statuses reach our webhook. The one-click OAuth
   *  connect already does this; this covers the manual "paste a token" path, which
   *  otherwise leaves the WABA unsubscribed (no inbound, no ticks). Needs the WABA
   *  id — no-op (logged) without it. Non-fatal: never blocks saving the channel. */
  private async subscribeWhatsAppWebhook(inboxId: string, type: string): Promise<void> {
    if (type !== "whatsapp" && type !== "whatsapp_group") return;
    const config = await this.store.getInboxConfig(inboxId);
    const wabaId = config?.wabaId;
    const accessToken = config?.accessToken;
    if (wabaId && accessToken) await this.metaOAuth.subscribeApp(wabaId, accessToken);
  }

  @Get("me")
  async me(@CurrentUserId() userId: string) {
    // Same shape as /auth/session, 2FA policy included — the two are one type on
    // the client, so they must not drift.
    const me = await this.store.me(userId);
    return { ...me, twoFactorEnforced: await this.sandbox.twoFactorRequired(me.user?.orgId) };
  }

  /** A user updating their OWN availability (no admin rights). */
  @Patch("me/preferences")
  async updateMyPreferences(
    @CurrentUserId() userId: string,
    @Body(new ZodValidationPipe(updateMyPreferencesInputSchema)) body: UpdateMyPreferencesInput,
  ): Promise<User> {
    const params: { available?: boolean; schedule?: AvailabilitySchedule | null } = {};
    if (body.available !== undefined) params.available = body.available;
    if (body.schedule !== undefined) {
      // A zone the server can't read would be quietly read as UTC — hours an
      // hour or eight off with nothing on screen to say why.
      if (body.schedule && !isTimeZone(body.schedule.timezone)) {
        throw new BadRequestException(`“${body.schedule.timezone}” isn't a time zone we recognise`);
      }
      params.schedule = body.schedule;
    }
    const user = await this.store.updateMyPreferences(userId, params);
    if (!user) throw new NotFoundException("Current user not found");
    return user;
  }

  /** A user updating their OWN profile — name, login email, photo. */
  @Patch("me/profile")
  async updateMyProfile(
    @CurrentUserId() userId: string,
    @Body(new ZodValidationPipe(updateMyProfileInputSchema)) body: UpdateMyProfileInput,
  ): Promise<User> {
    await this.sandbox.assertLive("Changing the demo account");
    const params: { name?: string; email?: string; avatarUrl?: string | null; position?: string | null } = {};
    if (body.name !== undefined) params.name = body.name.trim();
    // Their own job title, for email signatures. Trimmed by the schema; blank is none.
    if (body.position !== undefined) params.position = body.position || null;
    if (body.email !== undefined) {
      const email = body.email.trim().toLowerCase();
      // The address is who they sign in as, in every workspace: it has to be
      // nobody else's anywhere.
      const current = await this.store.getUser(userId);
      if (current?.email.toLowerCase() !== email && (await this.store.emailInUse(email))) {
        throw new ConflictException("That email address is already in use.");
      }
      params.email = email;
    }
    // Empty string clears the photo (back to Gravatar / initials).
    if (body.avatarUrl !== undefined) params.avatarUrl = body.avatarUrl?.trim() || null;
    const user = await this.store.updateMyProfile(userId, params);
    if (!user) throw new NotFoundException("Current user not found");
    return user;
  }

  @Get("inboxes")
  inboxes() {
    return this.store.listInboxes();
  }

  @Get("views")
  views(@CurrentUserId() userId: string) {
    return this.store.views(userId);
  }

  /* ---- Settings ---- */

  @Get("settings/teams")
  teams() {
    return this.store.listTeams();
  }

  @Get("settings/people")
  people() {
    return this.store.listMembers();
  }

  /**
   * One phone number or mailbox, one workspace. An inbound message is matched to
   * its inbox by that key alone, so a key held by two workspaces would leave it
   * to chance which business a customer's message reached.
   */
  private async assertChannelKeyFree(
    type: string,
    handle: string,
    channelConfig: Record<string, string> | undefined,
    exceptInboxId?: string,
  ): Promise<void> {
    const phoneNumberId = channelConfig?.phoneNumberId?.trim();
    const emailAddress = type === "email" ? handle.trim() : undefined;
    if (!phoneNumberId && !emailAddress) return;
    if (await this.store.channelKeyTaken({ phoneNumberId, emailAddress }, exceptInboxId)) {
      throw new ConflictException("That number or address is already connected to another workspace.");
    }
    // Nor twice in this one: two channels on one WhatsApp number leave every
    // incoming message with two possible homes.
    if (phoneNumberId) {
      for (const other of await this.store.listInboxes()) {
        if (other.id === exceptInboxId || (other.type !== "whatsapp" && other.type !== "whatsapp_group")) continue;
        if ((await this.store.getInboxConfig(other.id))?.phoneNumberId === phoneNumberId) {
          throw new ConflictException(
            `That WhatsApp number is already connected here as “${other.name}”. Edit or reconnect that channel instead of adding it again.`,
          );
        }
      }
    }
  }

  /** Create + route a new channel (inbox). Admins and managers only. */
  @Post("inboxes")
  async createInbox(
    @CurrentUserId() userId: string,
    @Body(new ZodValidationPipe(createInboxInputSchema)) body: CreateInboxInput,
  ) {
    const me = await this.requireManager(userId);
    await this.sandbox.assertLive("Connecting a channel");
    // A hosted address sends through the platform's own mail service, as the
    // platform's sender — fine for the platform's workspace, wrong for a
    // client's, whose customers would get replies from someone else's domain.
    // Theirs connects through Gmail and sends as them.
    if (body.type === "email" && !isPlatformOrg(me.orgId)) {
      throw new BadRequestException("Email for this workspace connects through Gmail — use “Connect Gmail” instead.");
    }
    await this.assertChannelKeyFree(body.type, body.handle, body.channelConfig);
    // SMS: the provider config must be one the engine can read, and the channel
    // gets the token that lets its provider's webhooks in.
    if (body.type === "sms") {
      const raw = body.channelConfig?.smsConfig;
      let ok = false;
      try {
        ok = !!raw && smsProviderConfigSchema.safeParse(JSON.parse(raw)).success;
      } catch {
        ok = false;
      }
      if (!ok) throw new BadRequestException("The SMS provider settings aren't complete — check them and try again.");
      body = { ...body, channelConfig: { ...body.channelConfig, smsWebhookToken: newWebhookToken() } };
    }
    const inbox = await this.store.createInbox({ orgId: me.orgId, ...body });
    await this.subscribeWhatsAppWebhook(inbox.id, inbox.type);
    return inbox;
  }

  @Patch("inboxes/:id")
  async updateInbox(
    @CurrentUserId() userId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateInboxInputSchema)) body: UpdateInboxInput,
  ) {
    await this.requireManager(userId);
    await this.sandbox.assertLive("Changing a channel");
    const current = await this.store.getInbox(id);
    if (!current) throw new NotFoundException("Channel not found");
    await this.assertChannelKeyFree(current.type, current.handle, body.channelConfig, id);
    if (body.conversationLabelId) {
      const labels = await this.store.listLabels(current.orgId);
      if (!labels.some((l) => l.id === body.conversationLabelId)) throw new BadRequestException("That label doesn't exist");
    }
    const inbox = await this.store.updateInbox(id, body);
    if (!inbox) throw new NotFoundException("Channel not found");
    await this.subscribeWhatsAppWebhook(inbox.id, inbox.type);
    return inbox;
  }

  /**
   * An email channel's signature: the layout (tags filled per sender) and the
   * marketing section under it. Sanitised like an outbound body — formatting,
   * links and hosted images stay, scripts don't. A null layout puts the
   * default back.
   */
  @Put("inboxes/:id/signature")
  async setInboxSignature(
    @CurrentUserId() userId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateInboxSignatureInputSchema)) body: UpdateInboxSignatureInput,
  ) {
    await this.requireManager(userId);
    const current = await this.store.getInbox(id);
    if (!current) throw new NotFoundException("Channel not found");
    if (current.type !== "email") throw new BadRequestException("Only an email channel has a signature");
    const clean = (html: string | null) => (html === null ? null : sanitizeOutboundHtml(html));
    const inbox = await this.store.setInboxSignature(id, { layoutHtml: clean(body.layoutHtml), footerHtml: clean(body.footerHtml) });
    if (!inbox) throw new NotFoundException("Channel not found");
    return inbox;
  }

  @Delete("inboxes/:id")
  async deleteInbox(@CurrentUserId() userId: string, @Param("id") id: string) {
    await this.requireManager(userId);
    await this.store.deleteInbox(id);
    return { ok: true };
  }

  /**
   * Choose which of this channel's numbers/mailboxes replies go out from.
   *
   * Only relevant with more than one of a type: a reply switched onto another
   * channel has to send from *something*, and without a choice that is the
   * oldest — deterministic, but not necessarily the number a workspace wants to
   * be known by. Setting one clears the channel's previous default; `false`
   * clears it outright and hands the decision back to age.
   */
  @Post("inboxes/:id/default")
  async setDefaultInbox(
    @CurrentUserId() userId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(setDefaultInboxInputSchema)) body: SetDefaultInboxInput,
  ) {
    await this.requireManager(userId);
    const inbox = await this.store.setDefaultInbox(id, body.isDefault);
    if (!inbox) throw new NotFoundException("Channel not found");
    return inbox;
  }

  /** Move this channel's still-open conversations onto its current routing. */
  @Post("inboxes/:id/reroute")
  async rerouteInbox(@CurrentUserId() userId: string, @Param("id") id: string) {
    await this.requireManager(userId);
    const moved = await this.store.rerouteInboxConversations(id);
    return { moved };
  }

  @Post("settings/teams")
  async createTeam(
    @CurrentUserId() userId: string,
    @Body(new ZodValidationPipe(createTeamInputSchema)) body: CreateTeamInput,
  ) {
    const me = await this.requireManager(userId);
    return this.store.createTeam({ orgId: me.orgId, name: body.name, icon: body.icon });
  }

  @Post("settings/teams/reorder")
  async reorderTeams(
    @CurrentUserId() userId: string,
    @Body(new ZodValidationPipe(reorderTeamsInputSchema)) body: ReorderTeamsInput,
  ) {
    await this.requireManager(userId);
    return this.store.reorderTeams(body.orderedIds);
  }

  /** The order channels appear in, everywhere they are listed. A manager's
   *  call, like the team ordering beside it: it is what the whole workspace
   *  sees, not a per-person preference. */
  @Post("settings/inboxes/reorder")
  async reorderInboxes(
    @CurrentUserId() userId: string,
    @Body(new ZodValidationPipe(reorderInboxesInputSchema)) body: ReorderInboxesInput,
  ) {
    await this.requireManager(userId);
    return this.store.reorderInboxes(body.orderedIds);
  }

  @Patch("settings/teams/:id")
  async updateTeam(
    @CurrentUserId() userId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateTeamInputSchema)) body: UpdateTeamInput,
  ) {
    await this.requireManager(userId);
    const team = await this.store.updateTeam(id, body);
    if (!team) throw new NotFoundException("Team not found");
    return team;
  }

  @Delete("settings/teams/:id")
  async deleteTeam(@CurrentUserId() userId: string, @Param("id") id: string) {
    await this.requireManager(userId);
    await this.store.deleteTeam(id);
    return { ok: true };
  }

  /* ---- labels: catalogue read (any agent) + management (managers) ---- */
  @Get("labels")
  async listLabels(@CurrentUserId() userId: string) {
    const me = await this.store.getUser(userId);
    if (!me) throw new NotFoundException("Current user not found");
    return this.store.listLabels(me.orgId);
  }

  @Post("labels")
  async createLabel(
    @CurrentUserId() userId: string,
    @Body(new ZodValidationPipe(createLabelInputSchema)) body: CreateLabelInput,
  ) {
    const me = await this.requireManager(userId);
    return this.store.createLabel({ orgId: me.orgId, name: body.name, color: body.color });
  }

  @Patch("labels/:id")
  async updateLabel(
    @CurrentUserId() userId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateLabelInputSchema)) body: UpdateLabelInput,
  ) {
    await this.requireManager(userId);
    const label = await this.store.updateLabel(id, body);
    if (!label) throw new NotFoundException("Label not found");
    return label;
  }

  @Delete("labels/:id")
  async deleteLabel(@CurrentUserId() userId: string, @Param("id") id: string) {
    await this.requireManager(userId);
    await this.store.deleteLabel(id);
    return { ok: true };
  }

  @Post("settings/people")
  async createUser(
    @CurrentUserId() userId: string,
    @Body(new ZodValidationPipe(createUserInputSchema)) body: CreateUserInput,
  ) {
    const me = await this.requireManager(userId);
    await this.sandbox.assertLive("Inviting people");
    // An address is one person wherever they are: somebody already in another
    // workspace joins this one with the sign-in they have. Only twice in the
    // same workspace is refused.
    if (await this.store.emailInWorkspace(body.email)) {
      throw new ConflictException("Someone in this workspace already has that email address.");
    }
    const workspace = (await this.store.listMemberships(userId)).find((m) => m.user.id === userId)?.orgName;
    const { user, inviteToken, joinedExisting } = await this.store.createUser({ orgId: me.orgId, ...body, position: body.position || null });
    // They already sign in: tell them they've been added — nothing to set up.
    if (joinedExisting) {
      await this.mailer.sendAddedToWorkspace(user.email, user.name, workspace ?? "a new workspace", env.appUrl).catch(() => undefined);
      return { user, addedExisting: true };
    }
    // No password → the store mints an invite token; email the "set your
    // password" link, and return it so the admin can share it by hand when no
    // transactional email is connected yet.
    if (!inviteToken) return { user };
    const url = `${env.appUrl}/?invite=${inviteToken}`;
    const { sent } = await this.mailer.sendInvite(user.email, user.name, url, workspace);
    return { user, invite: { url, emailed: sent } };
  }

  /** A fresh invite link for someone who hasn't joined yet — the last one
   *  expired, or went to spam. The old link stops working. */
  @Post("settings/people/:id/invite")
  async resendInvite(@CurrentUserId() userId: string, @Param("id") id: string) {
    await this.requireManager(userId);
    await this.sandbox.assertLive("Inviting people");
    const person = (await this.store.listMembers()).find((m) => m.user.id === id);
    if (!person) throw new NotFoundException("Member not found");
    const token = await this.store.reissueInvite(id);
    if (!token) throw new BadRequestException("They've already joined — they can sign in, or reset their password from the sign-in page.");
    const workspace = (await this.store.listMemberships(userId)).find((m) => m.user.id === userId)?.orgName;
    const url = `${env.appUrl}/?invite=${token}`;
    const { sent } = await this.mailer.sendInvite(person.user.email, person.user.name, url, workspace).catch(() => ({ sent: false }));
    return { user: person.user, invite: { url, emailed: sent } };
  }

  @Patch("settings/people/:id")
  async updateUser(
    @CurrentUserId() userId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateUserInputSchema)) body: UpdateUserInput,
  ) {
    await this.requireManager(userId);
    const user = await this.store.updateUser(id, {
      ...body,
      ...(body.position !== undefined ? { position: body.position || null } : {}),
    });
    if (!user) throw new NotFoundException("Person not found");
    return user;
  }

  @Delete("settings/people/:id")
  async deleteUser(@CurrentUserId() userId: string, @Param("id") id: string) {
    await this.requireManager(userId);
    if (id === userId) throw new ForbiddenException("You can't remove your own account");
    await this.store.deleteUser(id);
    return { ok: true };
  }

  private async requireManager(userId: string): Promise<User> {
    const me = await this.store.getUser(userId);
    if (!me) throw new NotFoundException("Current user not found");
    if (me.role !== "admin" && me.role !== "manager") {
      throw new ForbiddenException("Only admins and managers can change settings");
    }
    return me;
  }
}
