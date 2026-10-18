import { z } from "zod";

/**
 * SMS, through almost any provider's REST API — described, not coded.
 *
 * An SMS channel carries a provider config: how to authenticate, the request
 * that sends one text (a template filled with the message), where in the
 * answer the provider's message id and any error are, and how texts come back
 * — pushed to a webhook, or fetched by polling — along with delivery receipts
 * where the provider has them. The engine (apps/api/src/channels/sms) reads
 * the config; adding a provider is configuring one, not writing one.
 *
 * Templates: `{{name}}` is replaced by a value. In a JSON body, a string that is
 * exactly one placeholder keeps the value's type; anything else is text. The
 * values: `to` (E.164, +447700900123), `to_digits` (447700900123), `to_local`
 * (without the channel's country code), `from` (the channel's sender), `text`,
 * `message_id` (ours), `status_url`, `inbound_url`, `secret` (the API key,
 * token or password — stored encrypted, never shown again), `param.<name>`
 * (the channel's own settings, e.g. a DialMyCalls keyword id) and, when
 * polling, `since` (ISO time of the last poll).
 *
 * Paths into a response: `response.id`, `messages[0].id`; `a|b` tries `a` then
 * `b`; `$` is the whole body.
 */

const pairSchema = z.object({ name: z.string().trim().min(1).max(100), value: z.string().max(2000) });
export type SmsPair = z.infer<typeof pairSchema>;

const pathSchema = z.string().trim().max(200);
const words = z.array(z.string().trim().min(1).max(60)).max(20);

export const smsAuthSchema = z.object({
  /** bearer: Authorization: Bearer <secret>. basic: <username>:<secret>. header:
   *  <headerName>: <secret>. query: ?<queryName>=<secret>. */
  type: z.enum(["none", "bearer", "basic", "header", "query"]).default("none"),
  headerName: z.string().trim().max(100).optional(),
  queryName: z.string().trim().max(100).optional(),
  /** Basic auth's user — an account id, not a secret. May use {{param.x}}. */
  username: z.string().trim().max(200).optional(),
});

export const smsSendSchema = z.object({
  method: z.enum(["POST", "PUT", "GET"]).default("POST"),
  /** Appended to the base URL. A template. */
  path: z.string().trim().max(500).default(""),
  bodyFormat: z.enum(["json", "form", "none"]).default("json"),
  /** JSON: the request body, as a template. Form: a JSON object of field → template. */
  body: z.string().max(5000).default(""),
  /** Where the answer says it worked; with `successValue`, it must equal that.
   *  Without either, any 2xx is success. */
  successPath: pathSchema.optional(),
  successValue: z.string().trim().max(100).optional(),
  /** The provider's id for the message — how receipts find it again. */
  messageIdPath: pathSchema.optional(),
  /** Where a refusal says why. */
  errorPath: pathSchema.optional(),
});

/** Where each part of an incoming text is, in a webhook's or a poll's answer. */
const smsInboundFieldsSchema = z.object({
  /** The list of texts; empty when the body is one text. */
  itemsPath: pathSchema.optional(),
  idPath: pathSchema.optional(),
  fromPath: pathSchema.default("from"),
  toPath: pathSchema.optional(),
  textPath: pathSchema.default("text"),
  timestampPath: pathSchema.optional(),
  /** Some providers URL-encode the text. */
  textEncoding: z.enum(["plain", "url"]).default("plain"),
});

export const smsInboundSchema = smsInboundFieldsSchema.extend({
  /** webhook: the provider posts each text to this channel's inbound URL.
   *  poll: we ask for new texts every `intervalSeconds`. */
  mode: z.enum(["none", "webhook", "poll"]).default("none"),
  method: z.enum(["GET", "POST"]).default("GET"),
  path: z.string().trim().max(500).default(""),
  headers: z.array(pairSchema).max(10).default([]),
  intervalSeconds: z.number().int().min(15).max(3600).default(60),
});

export const smsStatusSchema = z.object({
  /** webhook: the provider posts receipts to this channel's status URL.
   *  poll: we ask after each recently sent text. */
  mode: z.enum(["none", "webhook", "poll"]).default("none"),
  method: z.enum(["GET", "POST"]).default("GET"),
  /** Poll: a template, usually with {{message_id}}. */
  path: z.string().trim().max(500).default(""),
  headers: z.array(pairSchema).max(10).default([]),
  intervalSeconds: z.number().int().min(15).max(3600).default(120),
  /** A list of recipients/receipts; the first is used. Empty: the body is one. */
  itemsPath: pathSchema.optional(),
  /** Webhook: which message this is about (the provider's id). */
  idPath: pathSchema.optional(),
  statusPath: pathSchema.default("status"),
  errorPath: pathSchema.optional(),
  /** The provider's words for each outcome (any case). Anything else: no change. */
  delivered: words.default(["delivered"]),
  failed: words.default(["failed", "undelivered", "undeliverable"]),
  sent: words.default(["sent"]),
});

export const smsProviderConfigSchema = z.object({
  /** Shown in settings: "DialMyCalls", "Twilio"… */
  provider: z.string().trim().min(1).max(60),
  /** The preset it started from, if any. */
  preset: z.string().trim().max(40).optional(),
  baseUrl: z.string().trim().url().max(300),
  auth: smsAuthSchema.default({ type: "none" }),
  /** Sent with every request. Values are templates. */
  headers: z.array(pairSchema).max(20).default([]),
  /** The channel's own settings, used as {{param.<name>}} — never secret. */
  params: z.array(pairSchema).max(20).default([]),
  /** Digits only, e.g. "1" or "44": how a number written without one is read,
   *  and what {{to_local}} leaves off. */
  countryCode: z.string().trim().regex(/^\d{0,4}$/).default(""),
  /** Longest text the provider takes, in characters; longer is refused before sending. */
  maxLength: z.number().int().min(70).max(10_000).default(1600),
  send: smsSendSchema,
  inbound: smsInboundSchema.default({ mode: "none" }),
  status: smsStatusSchema.default({ mode: "none" }),
});
export type SmsProviderConfig = z.infer<typeof smsProviderConfigSchema>;
export type SmsProviderConfigInput = z.input<typeof smsProviderConfigSchema>;

/** What a channel can and can't do, read from its config — so nothing assumes
 *  a provider does what it doesn't. */
export interface SmsCapabilities {
  send: true;
  receive: "webhook" | "poll" | false;
  deliveryReceipts: "webhook" | "poll" | false;
}

export function smsCapabilities(cfg: Pick<SmsProviderConfig, "inbound" | "status">): SmsCapabilities {
  return {
    send: true,
    receive: cfg.inbound.mode === "none" ? false : cfg.inbound.mode,
    deliveryReceipts: cfg.status.mode === "none" ? false : cfg.status.mode,
  };
}

/** An SMS channel as settings shows it: the config, and the URLs a provider
 *  posts to. The secret is never sent back — only whether one is set. */
export interface SmsChannelSettings {
  config: SmsProviderConfig;
  hasSecret: boolean;
  inboundUrl: string;
  statusUrl: string;
  capabilities: SmsCapabilities;
}

/** Save an SMS channel's provider config. `secret` absent keeps the stored
 *  one; "" clears it. */
export const saveSmsConfigInputSchema = z.object({
  config: smsProviderConfigSchema,
  secret: z.string().max(2000).optional(),
});
export type SaveSmsConfigInput = z.input<typeof saveSmsConfigInputSchema>;

/** Try a config before (or after) saving it. */
export const testSmsInputSchema = z.object({
  config: smsProviderConfigSchema,
  /** Absent: the channel's stored secret (when testing a saved channel). */
  secret: z.string().max(2000).optional(),
  /** "send": text this number for real. "inbound": run the inbound poll once,
   *  importing nothing. "parse": read a sample webhook body. */
  action: z.enum(["send", "inbound", "parse"]),
  to: z.string().trim().max(40).optional(),
  text: z.string().max(1600).optional(),
  sample: z.string().max(20_000).optional(),
});
export type TestSmsInput = z.input<typeof testSmsInputSchema>;

/** What a test did, step by step — enough to see why it didn't. */
export interface SmsTestResult {
  ok: boolean;
  summary: string;
  request?: { method: string; url: string; headers: Record<string, string>; body?: string };
  response?: { status: number; body: string };
  /** What the mapping read out of the answer. */
  mapped?: Record<string, unknown>;
}

/** Paste a provider's API documentation (or OpenAPI spec); get a config to start from. */
export const suggestSmsConfigInputSchema = z.object({
  docs: z.string().trim().min(40, "Paste the provider's API documentation").max(120_000),
  provider: z.string().trim().max(60).optional(),
});
export type SuggestSmsConfigInput = z.infer<typeof suggestSmsConfigInputSchema>;

export interface SuggestedSmsConfig {
  config: SmsProviderConfig;
  /** What the AI wasn't sure of, or couldn't find in the docs. */
  notes: string[];
}

/* ---- presets: a start, every field still editable ---- */

export const SMS_PRESETS: Record<string, { label: string; blurb: string; secretLabel: string; config: SmsProviderConfigInput }> = {
  dialmycalls: {
    label: "DialMyCalls",
    blurb: "Texts from your DialMyCalls keyword number. Replies are fetched every minute — DialMyCalls has no webhooks — and so are delivery receipts.",
    secretLabel: "API key",
    config: {
      provider: "DialMyCalls",
      preset: "dialmycalls",
      baseUrl: "https://api.dialmycalls.com/2.0",
      auth: { type: "header", headerName: "X-Auth-ApiKey" },
      headers: [{ name: "Accept", value: "application/json" }],
      params: [{ name: "keyword_id", value: "" }],
      countryCode: "1",
      maxLength: 1600,
      send: {
        method: "POST",
        path: "/service/text",
        bodyFormat: "json",
        body: JSON.stringify(
          {
            name: "NestConnect {{message_id}}",
            keyword_id: "{{param.keyword_id}}",
            messages: ["{{text}}"],
            contacts: [{ phone: "{{to_local}}" }],
            send_immediately: true,
          },
          null,
          2,
        ),
        successPath: "success",
        messageIdPath: "response.id|id",
        errorPath: "error.message|error|message",
      },
      inbound: {
        mode: "poll",
        method: "GET",
        path: "/incoming/texts",
        headers: [{ name: "Range", value: "records=1-100" }],
        intervalSeconds: 60,
        itemsPath: "response|$",
        idPath: "id",
        fromPath: "from_number",
        toPath: "to_number",
        textPath: "message",
        timestampPath: "created_at",
        textEncoding: "url",
      },
      status: {
        mode: "poll",
        method: "GET",
        path: "/service/text/{{message_id}}/recipients",
        intervalSeconds: 120,
        itemsPath: "response|$",
        statusPath: "status",
        delivered: ["delivered"],
        failed: ["undeliverable", "non_mobile"],
        sent: ["enroute"],
      },
    },
  },
  twilio: {
    label: "Twilio",
    blurb: "Texts from your Twilio number. Replies and delivery receipts arrive by webhook — paste the inbound URL into the number's Messaging settings.",
    secretLabel: "Auth token",
    config: {
      provider: "Twilio",
      preset: "twilio",
      baseUrl: "https://api.twilio.com/2010-04-01",
      auth: { type: "basic", username: "{{param.account_sid}}" },
      params: [{ name: "account_sid", value: "" }],
      countryCode: "",
      maxLength: 1600,
      send: {
        method: "POST",
        path: "/Accounts/{{param.account_sid}}/Messages.json",
        bodyFormat: "form",
        body: JSON.stringify({ To: "{{to}}", From: "{{from}}", Body: "{{text}}", StatusCallback: "{{status_url}}" }, null, 2),
        messageIdPath: "sid",
        errorPath: "message",
      },
      inbound: { mode: "webhook", idPath: "MessageSid", fromPath: "From", toPath: "To", textPath: "Body" },
      status: { mode: "webhook", idPath: "MessageSid", statusPath: "MessageStatus", errorPath: "ErrorMessage", delivered: ["delivered"], failed: ["failed", "undelivered"], sent: ["sent"] },
    },
  },
  custom: {
    label: "Another provider",
    blurb: "Any SMS REST API: describe its send request, its answer and how replies come back — or paste its docs and let AI fill this in.",
    secretLabel: "API key / token",
    config: {
      provider: "My SMS provider",
      preset: "custom",
      baseUrl: "https://api.example.com/v1",
      auth: { type: "bearer" },
      send: {
        method: "POST",
        path: "/messages",
        bodyFormat: "json",
        body: JSON.stringify({ from: "{{from}}", to: "{{to}}", text: "{{text}}" }, null, 2),
        messageIdPath: "id",
        errorPath: "error.message|message",
      },
      inbound: { mode: "webhook", idPath: "id", fromPath: "from", toPath: "to", textPath: "text" },
      status: { mode: "none" },
    },
  },
};
