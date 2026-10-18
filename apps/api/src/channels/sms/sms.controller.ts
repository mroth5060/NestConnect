import { Body, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Param, Post, Put, Req } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { SkipThrottle, Throttle } from "@nestjs/throttler";
import {
  saveSmsConfigInputSchema,
  suggestSmsConfigInputSchema,
  testSmsInputSchema,
  type SaveSmsConfigInput,
  type SmsChannelSettings,
  type SmsTestResult,
  type SuggestSmsConfigInput,
  type SuggestedSmsConfig,
  type TestSmsInput,
} from "@ding/schemas";
import { Public } from "../../auth/public.decorator";
import { CurrentUserId } from "../../auth/current-user.decorator";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { Store } from "../../data/store";
import { SandboxPolicy } from "../../tenancy/sandbox";
import { SMS_KEYS, SmsService } from "./sms.service";
import { SmsSuggestService } from "./sms-suggest.service";

/**
 * SMS channels: the provider's webhooks (public, let in by the token in the
 * URL), and the settings the channel editor uses (managers and admins).
 */
@Controller("channels/sms")
export class SmsController {
  constructor(
    private readonly sms: SmsService,
    private readonly suggester: SmsSuggestService,
    private readonly store: Store,
    private readonly sandbox: SandboxPolicy,
  ) {}

  /* ---- the provider ---- */

  // Always 200 for a post we could read, even one we ignored: a provider
  // retries anything else for hours. 404 only for a URL that isn't ours.
  @Public()
  @SkipThrottle()
  @Post(":inboxId/inbound/:token")
  @HttpCode(200)
  inbound(@Param("inboxId") inboxId: string, @Param("token") token: string, @Req() req: Request) {
    return this.hook(inboxId, token, "inbound", req);
  }

  /** Some providers send incoming texts as a GET with query parameters. */
  @Public()
  @SkipThrottle()
  @Get(":inboxId/inbound/:token")
  inboundGet(@Param("inboxId") inboxId: string, @Param("token") token: string, @Req() req: Request) {
    return this.hook(inboxId, token, "inbound", req);
  }

  @Public()
  @SkipThrottle()
  @Post(":inboxId/status/:token")
  @HttpCode(200)
  status(@Param("inboxId") inboxId: string, @Param("token") token: string, @Req() req: Request) {
    return this.hook(inboxId, token, "status", req);
  }

  @Public()
  @SkipThrottle()
  @Get(":inboxId/status/:token")
  statusGet(@Param("inboxId") inboxId: string, @Param("token") token: string, @Req() req: Request) {
    return this.hook(inboxId, token, "status", req);
  }

  private async hook(inboxId: string, token: string, kind: "inbound" | "status", req: Request) {
    const raw = req.method === "GET"
      ? new URLSearchParams(req.query as Record<string, string>).toString()
      : (req as Request & { rawBody?: Buffer }).rawBody?.toString("utf8") ?? JSON.stringify(req.body ?? {});
    const type = req.method === "GET" ? "application/x-www-form-urlencoded" : req.headers["content-type"] ?? "";
    const res = await this.sms.webhook(inboxId, token, kind, raw, type);
    if (!res.ok) throw new NotFoundException();
    return { ok: true, handled: res.handled };
  }

  /* ---- settings ---- */

  @Get(":inboxId/settings")
  async settings(@CurrentUserId() userId: string, @Param("inboxId") inboxId: string): Promise<SmsChannelSettings> {
    await this.requireManager(userId);
    const s = await this.sms.settings(inboxId);
    if (!s) throw new NotFoundException("SMS channel not found");
    return s;
  }

  @Put(":inboxId/settings")
  async save(
    @CurrentUserId() userId: string,
    @Param("inboxId") inboxId: string,
    @Body(new ZodValidationPipe(saveSmsConfigInputSchema)) body: SaveSmsConfigInput,
  ): Promise<SmsChannelSettings> {
    await this.requireManager(userId);
    const inbox = await this.store.getInbox(inboxId);
    if (!inbox || inbox.type !== "sms") throw new NotFoundException("SMS channel not found");
    const config = saveSmsConfigInputSchema.parse(body).config;
    await this.store.updateInbox(inboxId, {
      channelConfig: {
        [SMS_KEYS.config]: JSON.stringify(config),
        ...(body.secret !== undefined ? { [SMS_KEYS.secret]: body.secret } : {}),
      },
    });
    return (await this.sms.settings(inboxId))!;
  }

  /** Try a config: send a test text, fetch incoming once, or read a sample. */
  @Post("test")
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async test(
    @CurrentUserId() userId: string,
    @Body(new ZodValidationPipe(testSmsInputSchema.extend({ inboxId: z.string().optional() }))) body: TestSmsInput & { inboxId?: string },
  ): Promise<SmsTestResult> {
    await this.requireManager(userId);
    if (body.action !== "parse") await this.sandbox.assertLive("Testing an SMS provider");
    const input = testSmsInputSchema.parse(body);
    return this.sms.test(input, body.inboxId ? { inboxId: body.inboxId } : undefined);
  }

  /** "Check now": run this channel's polling once, whether or not it's due. */
  @Post(":inboxId/poll")
  async poll(@CurrentUserId() userId: string, @Param("inboxId") inboxId: string) {
    await this.requireManager(userId);
    await this.sandbox.assertLive("Fetching texts");
    const ch = await this.sms.settings(inboxId);
    if (!ch) throw new NotFoundException("SMS channel not found");
    return this.sms.pollChannel(inboxId, new Date(), { force: true });
  }

  /** Paste a provider's API docs; get a config to start from. */
  @Post("suggest")
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  async suggest(
    @CurrentUserId() userId: string,
    @Body(new ZodValidationPipe(suggestSmsConfigInputSchema)) body: SuggestSmsConfigInput,
  ): Promise<SuggestedSmsConfig> {
    await this.requireManager(userId);
    return this.suggester.suggest(body.docs, body.provider);
  }

  private async requireManager(userId: string): Promise<void> {
    const me = await this.store.getUser(userId);
    if (!me || (me.role !== "admin" && me.role !== "manager")) throw new ForbiddenException("Managers and admins only");
  }
}
