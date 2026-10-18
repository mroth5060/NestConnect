import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  smsCapabilities,
  smsProviderConfigSchema,
  type Inbox,
  type MessageStatus,
  type SmsChannelSettings,
  type SmsProviderConfig,
  type SmsTestResult,
  type TestSmsInput,
} from "@ding/schemas";
import { env } from "../../config/env";
import { Store } from "../../data/store";
import { RealtimeGateway } from "../../realtime/realtime.gateway";
import { runInTenant } from "../../tenancy/tenant-scope";
import { isWorkspaceFrozen } from "../../tenancy/workspace-status";
import { isRetryableStatus, type SendResult } from "../channel-provider";
import { IngestService } from "../ingest.service";
import {
  buildInboundPoll,
  buildLookup,
  buildSend,
  buildStatusPoll,
  findError,
  parseBody,
  readInbound,
  readLookup,
  readSendResponse,
  readStatus,
  redactRequest,
  smsFetch,
  SmsConfigError,
  type SmsHttpResponse,
  type SmsInbound,
  type SmsOutcome,
  type SmsRequest,
} from "./sms-engine";

/** Where an SMS channel keeps its settings, in the inbox's channelConfig. The
 *  secret and the webhook token are encrypted at rest (SECRET_CHANNEL_FIELDS). */
export const SMS_KEYS = { config: "smsConfig", secret: "smsSecret", token: "smsWebhookToken", poll: "smsPollState" } as const;

/** A provider's message id, made unique to the channel: providers number their
 *  own texts, and two of them may well both have a message "42". */
export const smsMessageKey = (inboxId: string, providerId: string) => `sms:${inboxId}:${providerId}`;
const providerIdOf = (inboxId: string, key: string) => key.startsWith(`sms:${inboxId}:`) ? key.slice(`sms:${inboxId}:`.length) : key;

export function smsUrls(inboxId: string, token: string): { inboundUrl: string; statusUrl: string } {
  const base = `${env.appUrl.replace(/\/+$/, "")}/api/channels/sms/${inboxId}`;
  return { inboundUrl: `${base}/inbound/${token}`, statusUrl: `${base}/status/${token}` };
}

export const newWebhookToken = () => randomBytes(18).toString("base64url");

/** The config stored on a channel, if it reads as one. */
export function readSmsConfig(raw: Record<string, string> | undefined): SmsProviderConfig | undefined {
  if (!raw?.[SMS_KEYS.config]) return undefined;
  try {
    const parsed = smsProviderConfigSchema.safeParse(JSON.parse(raw[SMS_KEYS.config]!));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

interface SmsChannel {
  inbox: Inbox;
  config: SmsProviderConfig;
  secret?: string;
  token: string;
  poll: PollState;
}

/** What polling remembers between runs, per channel. */
interface PollState {
  inboundAt?: string;
  statusAt?: string;
  /** When polling first ran: texts from before it are history, not news. */
  since?: string;
  /** Ids already seen, newest last — for providers that don't time-stamp. */
  seen?: string[];
}

const RECEIPT_WINDOW_MS = 48 * 60 * 60 * 1000;
const TICK_MS = 15_000;

/**
 * SMS channels, through the universal engine: sending (for SmsProvider),
 * webhooks, polling for texts and receipts where a provider has no webhooks,
 * tests, and the settings the channel editor reads and writes.
 *
 * Everything a text does once it's here is the shared pipeline: an inbound one
 * goes through IngestService like WhatsApp's, a sent one through the delivery
 * queue like every reply.
 */
@Injectable()
export class SmsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SmsService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  /** The network seam: tests swap it for a fake provider. */
  http: (req: SmsRequest) => Promise<SmsHttpResponse> = (req) => smsFetch(req);

  constructor(
    private readonly store: Store,
    private readonly ingest: IngestService,
    private readonly realtime: RealtimeGateway,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.SMS_POLL === "off") return;
    this.timer = setInterval(() => void this.pollAll(), TICK_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /* ---- a channel ---- */

  /** An SMS channel in the bound workspace, with its config and secret. */
  async channel(inboxId: string): Promise<SmsChannel | undefined> {
    const inbox = await this.store.getInbox(inboxId);
    if (!inbox || inbox.type !== "sms") return undefined;
    const raw = await this.store.getInboxConfig(inboxId);
    const config = readSmsConfig(raw);
    if (!config) return undefined;
    let token = raw?.[SMS_KEYS.token];
    if (!token) {
      token = newWebhookToken();
      await this.store.updateInbox(inboxId, { channelConfig: { [SMS_KEYS.token]: token } });
    }
    let poll: PollState = {};
    try {
      poll = raw?.[SMS_KEYS.poll] ? (JSON.parse(raw[SMS_KEYS.poll]!) as PollState) : {};
    } catch {
      /* start over */
    }
    return { inbox, config, secret: raw?.[SMS_KEYS.secret] || undefined, token, poll };
  }

  async settings(inboxId: string): Promise<SmsChannelSettings | undefined> {
    const ch = await this.channel(inboxId);
    if (!ch) return undefined;
    return { config: ch.config, hasSecret: !!ch.secret, ...smsUrls(inboxId, ch.token), capabilities: smsCapabilities(ch.config) };
  }

  /* ---- sending (SmsProvider) ---- */

  async send(inboxId: string, msg: { to: string; text: string; messageId?: string }): Promise<SendResult> {
    const ch = await this.channel(inboxId);
    if (!ch) return { ok: false, retryable: false, errorCode: "not_connected", error: "This SMS channel isn't set up — finish its provider settings." };
    if (!msg.text.trim()) return { ok: false, retryable: false, errorCode: "empty", error: "A text message needs some words — SMS can't carry attachments." };
    if (msg.text.length > ch.config.maxLength) {
      return { ok: false, retryable: false, errorCode: "too_long", error: `Too long for ${ch.config.provider}: ${msg.text.length} characters, ${ch.config.maxLength} at most.` };
    }
    let req: SmsRequest;
    try {
      req = buildSend(ch.config, ch.secret, {
        to: msg.to,
        text: msg.text,
        from: ch.inbox.handle,
        message_id: msg.messageId,
        ...smsUrls(inboxId, ch.token),
      });
    } catch (err) {
      return { ok: false, retryable: false, errorCode: "config", error: (err as Error).message };
    }
    const res = await this.http(req);
    if (res.status === 0) return { ok: false, retryable: true, error: `Couldn't reach ${ch.config.provider}: ${res.text}` };
    const read = readSendResponse(ch.config, res.status, res.text, res.contentType);
    if (!read.ok) {
      return { ok: false, httpStatus: res.status, retryable: isRetryableStatus(res.status) && res.status >= 300, error: `${ch.config.provider}: ${read.error}` };
    }
    // No id from the provider: the text went, but nothing can match a receipt
    // to it. Ours stands in, so the message is still marked sent.
    return { ok: true, channelMsgId: smsMessageKey(inboxId, read.providerId ?? `nc-${msg.messageId ?? randomBytes(6).toString("hex")}`) };
  }

  /* ---- webhooks ---- */

  /**
   * A provider posting to one of this channel's URLs. The URL names the channel
   * and carries its token — compared in constant time — and that's the only
   * thing that lets a post in. Anything it says that we can't read is dropped,
   * not refused: a provider retries a refusal for hours.
   */
  async webhook(inboxId: string, token: string, kind: "inbound" | "status", rawBody: string, contentType: string): Promise<{ ok: boolean; handled: number }> {
    const orgId = await this.store.inboxOrg(inboxId);
    if (!orgId) return { ok: false, handled: 0 };
    if (isWorkspaceFrozen(orgId)) return { ok: true, handled: 0 };
    return runInTenant(orgId, async () => {
      const ch = await this.channel(inboxId);
      if (!ch || !sameToken(ch.token, token)) return { ok: false, handled: 0 };
      const body = parseBody(rawBody, contentType);
      if (kind === "inbound") {
        if (ch.config.inbound.mode !== "webhook") return { ok: true, handled: 0 };
        let handled = 0;
        for (const text of readInbound(ch.config, body)) if (await this.take(ch, text)) handled++;
        return { ok: true, handled };
      }
      if (ch.config.status.mode !== "webhook") return { ok: true, handled: 0 };
      const st = readStatus(ch.config, body);
      if (!st.providerId || !st.outcome) return { ok: true, handled: 0 };
      return { ok: true, handled: (await this.apply(smsMessageKey(inboxId, st.providerId), st.outcome, st.error)) ? 1 : 0 };
    });
  }

  /** One incoming text into the shared pipeline. False when it was a repeat. */
  private async take(ch: SmsChannel, text: SmsInbound): Promise<boolean> {
    const id = text.id ?? createHash("sha256").update(`${text.from}|${text.text}|${text.at?.toISOString() ?? ""}`).digest("hex").slice(0, 24);
    const res = await this.ingest.ingestSms({ inbox: ch.inbox, from: text.from, text: text.text, channelMsgId: smsMessageKey(ch.inbox.id, id) });
    return !!res && !res.duplicate;
  }

  private async apply(channelMsgId: string, outcome: SmsOutcome, error?: string): Promise<boolean> {
    const status: MessageStatus = outcome;
    const updated = await this.store.updateMessageStatusByChannelId(channelMsgId, status, outcome === "failed" ? error || "The provider couldn't deliver it" : undefined);
    if (updated) this.realtime.emitMessageUpdated(updated.conversationId, updated.message);
    return !!updated;
  }

  /* ---- polling, for providers without webhooks ---- */

  /** Every SMS channel that polls, whose turn it is. */
  async pollAll(now = new Date()): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const inbox of await this.store.listInboxesAcrossWorkspaces("sms")) {
        await runInTenant(inbox.orgId, () => this.pollChannel(inbox.id, now)).catch((err) =>
          this.logger.warn(`SMS poll for ${inbox.id} failed: ${String(err)}`),
        );
      }
    } finally {
      this.polling = false;
    }
  }

  /** One channel's turn: new texts, then receipts, each on its own interval. */
  async pollChannel(inboxId: string, now = new Date(), opts?: { force?: boolean }): Promise<{ imported: number; receipts: number }> {
    const ch = await this.channel(inboxId);
    if (!ch) return { imported: 0, receipts: 0 };
    const due = (at: string | undefined, seconds: number) => opts?.force || !at || now.getTime() - new Date(at).getTime() >= seconds * 1000 - 500;
    let imported = 0;
    let receipts = 0;
    const state = { ...ch.poll };
    if (ch.config.inbound.mode === "poll" && due(state.inboundAt, ch.config.inbound.intervalSeconds)) {
      imported = (await this.pollInbound(ch, state, now)).imported;
      state.inboundAt = now.toISOString();
    }
    if (ch.config.status.mode === "poll" && due(state.statusAt, ch.config.status.intervalSeconds)) {
      receipts = await this.pollReceipts(ch, now);
      state.statusAt = now.toISOString();
    }
    if (JSON.stringify(state) !== JSON.stringify(ch.poll)) {
      await this.store.updateInbox(inboxId, { channelConfig: { [SMS_KEYS.poll]: JSON.stringify(state) } });
    }
    return { imported, receipts };
  }

  /**
   * Ask the provider for texts and take the new ones. The first poll only
   * learns what's already there — a channel connected today doesn't fill the
   * inbox with last year's texts — and later ones take what wasn't seen
   * before. Every text is de-duplicated again on the way in, so an overlap
   * between polls costs nothing.
   */
  private async pollInbound(ch: SmsChannel, state: PollState, now: Date): Promise<{ imported: number; texts: SmsInbound[]; res: SmsHttpResponse; req: SmsRequest }> {
    const req = buildInboundPoll(ch.config, ch.secret, { since: state.inboundAt });
    const res = await this.http(req);
    if (res.status < 200 || res.status >= 300) {
      this.logger.warn(`SMS poll (${ch.config.provider}) for ${ch.inbox.id}: HTTP ${res.status} ${res.text.slice(0, 200)}`);
      return { imported: 0, texts: [], res, req };
    }
    const texts = readInbound(ch.config, parseBody(res.text, res.contentType));
    const keyOf = (t: SmsInbound) => t.id ?? `${t.from}|${t.text}|${t.at?.toISOString() ?? ""}`;
    const seen = new Set(state.seen ?? []);
    let imported = 0;
    if (!state.since) {
      state.since = now.toISOString();
    } else {
      const since = new Date(state.since);
      for (const t of texts) {
        if (seen.has(keyOf(t)) || (t.at && t.at < since)) continue;
        if (await this.take(ch, t)) imported++;
      }
    }
    state.seen = [...seen, ...texts.map(keyOf).filter((k) => !seen.has(k))].slice(-500);
    return { imported, texts, res, req };
  }

  /** Ask after texts sent in the last two days that have no receipt yet. */
  private async pollReceipts(ch: SmsChannel, now: Date): Promise<number> {
    let changed = 0;
    for (const m of await this.store.listAwaitingReceipt(ch.inbox.id, new Date(now.getTime() - RECEIPT_WINDOW_MS), 20)) {
      const providerId = providerIdOf(ch.inbox.id, m.channelMsgId);
      if (providerId.startsWith("nc-")) continue; // no provider id: nothing to ask after
      const res = await this.http(buildStatusPoll(ch.config, ch.secret, { message_id: providerId }));
      if (res.status < 200 || res.status >= 300) continue;
      const st = readStatus(ch.config, parseBody(res.text, res.contentType));
      if (st.outcome && (await this.apply(m.channelMsgId, st.outcome, st.error))) changed++;
    }
    return changed;
  }

  /* ---- tests, from settings ---- */

  /**
   * Try a config: send a real text, run the inbound poll once (importing
   * nothing), or read a sample webhook body. Says what was sent — the secret
   * blanked — what came back, and what the mapping made of it.
   */
  async test(input: TestSmsInput & { config: SmsProviderConfig }, stored?: { inboxId: string }): Promise<SmsTestResult> {
    const cfg = input.config;
    let secret = input.secret;
    let from = "";
    let token = "test";
    if (stored) {
      const ch = await this.channel(stored.inboxId);
      if (ch) {
        if (secret === undefined) secret = ch.secret;
        from = ch.inbox.handle;
        token = ch.token;
      }
    }
    try {
      if (input.action === "parse") {
        const body = parseBody(input.sample ?? "");
        const texts = readInbound(cfg, body);
        const st = cfg.status.mode !== "none" ? readStatus(cfg, body) : undefined;
        const ok = texts.length > 0 || !!st?.outcome;
        return {
          ok,
          summary: ok
            ? [texts.length ? `Read ${texts.length} text(s): from ${texts[0]!.from}, "${texts[0]!.text.slice(0, 60)}"` : "", st?.outcome ? `Read a receipt: ${st.raw} → ${st.outcome}` : ""].filter(Boolean).join(". ")
            : "Nothing in the sample matched the field mapping — check the paths.",
          mapped: { texts, receipt: st },
        };
      }
      if (input.action === "inbound") {
        if (cfg.inbound.mode !== "poll") return { ok: false, summary: "Incoming texts aren't fetched by polling for this config." };
        const req = buildInboundPoll(cfg, secret, {});
        const res = await this.http(req);
        const texts = res.status >= 200 && res.status < 300 ? readInbound(cfg, parseBody(res.text, res.contentType)) : [];
        return {
          ok: res.status >= 200 && res.status < 300,
          summary: res.status === 0 || res.status >= 300 ? failedAnswer(res) : `Connected. ${texts.length} text(s) in the answer${texts[0] ? `, the first from ${texts[0].from}` : ""}. Nothing was imported.`,
          request: redactRequest(req, secret),
          response: { status: res.status, body: res.text.slice(0, 4000) },
          mapped: { texts: texts.slice(0, 5) },
        };
      }
      if (input.action === "lookup") {
        const lookup = cfg.params.find((p) => p.name === input.param)?.lookup;
        if (!lookup) return { ok: false, summary: "This setting has nothing to look up." };
        const req = buildLookup(cfg, secret, lookup.path);
        const res = await this.http(req);
        const good = res.status >= 200 && res.status < 300;
        const options = good ? readLookup(parseBody(res.text, res.contentType), lookup) : [];
        return {
          ok: options.length > 0,
          summary: !good
            ? failedAnswer(res)
            : options.length ? `Found ${options.length}.` : "The provider listed nothing — check the API key, or the lookup's paths.",
          request: redactRequest(req, secret),
          response: { status: res.status, body: res.text.slice(0, 4000) },
          options,
        };
      }
      if (!input.to) return { ok: false, summary: "Say which number to text." };
      const req = buildSend(cfg, secret, { to: input.to, text: input.text || "Test from NestConnect", from, message_id: `test-${Date.now()}`, ...smsUrls(stored?.inboxId ?? "new", token) });
      const res = await this.http(req);
      const read = res.status === 0 ? { ok: false, error: res.text, mapped: {} } : readSendResponse(cfg, res.status, res.text, res.contentType);
      return {
        ok: read.ok,
        summary: read.ok ? `Sent.${"providerId" in read && read.providerId ? ` ${cfg.provider} message id: ${read.providerId}.` : " (No message id found at the configured path — receipts can't be matched.)"}` : `Not sent: ${read.error}`,
        request: redactRequest(req, secret),
        response: { status: res.status, body: res.text.slice(0, 4000) },
        mapped: read.mapped,
      };
    } catch (err) {
      if (err instanceof SmsConfigError) return { ok: false, summary: err.message };
      throw err;
    }
  }
}

/** Why a request didn't work, in the provider's words where it gave any. */
function failedAnswer(res: { status: number; text: string; contentType?: string }): string {
  if (res.status === 0) return `Couldn't reach the provider: ${res.text}`;
  const why = findError(parseBody(res.text, res.contentType));
  return `The provider answered HTTP ${res.status}${why ? `: ${why}` : "."}`;
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
