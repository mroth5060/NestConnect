import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod/v4";
import { smsProviderConfigSchema, type SuggestedSmsConfig } from "@ding/schemas";
import { Store } from "../../data/store";
import { resolveAnthropicConfig } from "../../ai/anthropic-config";
import { SandboxPolicy } from "../../tenancy/sandbox";

/**
 * Paste an SMS provider's API documentation (or OpenAPI spec); get a channel
 * config to start from. Only ever a suggestion: it lands in the editor, where
 * every field can be changed and tested before anything is saved.
 *
 * The answer is constrained to the shape below (structured outputs) and then
 * checked against the real config schema, which fills defaults and catches
 * anything that still doesn't fit.
 */

const pair = z.object({ name: z.string(), value: z.string() });
const suggestionSchema = z.object({
  config: z.object({
    provider: z.string(),
    baseUrl: z.string(),
    auth: z.object({
      type: z.enum(["none", "bearer", "basic", "header", "query"]),
      headerName: z.string().optional(),
      queryName: z.string().optional(),
      username: z.string().optional(),
    }),
    headers: z.array(pair),
    params: z.array(pair),
    countryCode: z.string(),
    maxLength: z.number().int(),
    send: z.object({
      method: z.enum(["POST", "PUT", "GET"]),
      path: z.string(),
      bodyFormat: z.enum(["json", "form", "none"]),
      body: z.string(),
      successPath: z.string().optional(),
      successValue: z.string().optional(),
      messageIdPath: z.string().optional(),
      errorPath: z.string().optional(),
    }),
    inbound: z.object({
      mode: z.enum(["none", "webhook", "poll"]),
      method: z.enum(["GET", "POST"]),
      path: z.string(),
      headers: z.array(pair),
      intervalSeconds: z.number().int(),
      itemsPath: z.string().optional(),
      idPath: z.string().optional(),
      fromPath: z.string(),
      toPath: z.string().optional(),
      textPath: z.string(),
      timestampPath: z.string().optional(),
      textEncoding: z.enum(["plain", "url"]),
    }),
    status: z.object({
      mode: z.enum(["none", "webhook", "poll"]),
      method: z.enum(["GET", "POST"]),
      path: z.string(),
      headers: z.array(pair),
      intervalSeconds: z.number().int(),
      itemsPath: z.string().optional(),
      idPath: z.string().optional(),
      statusPath: z.string(),
      errorPath: z.string().optional(),
      delivered: z.array(z.string()),
      failed: z.array(z.string()),
      sent: z.array(z.string()),
    }),
  }),
  notes: z.array(z.string()),
});

const SYSTEM = `You configure SMS providers for NestConnect, a customer-messaging inbox. NestConnect talks to any SMS REST API through a declarative config; you read a provider's API documentation and fill that config in. Use only what the documentation says. Where it is silent or ambiguous, choose the most likely value and say so in "notes" — every field will be reviewed and tested by a person before it is used.

The config:
- provider: the provider's name. baseUrl: the API's base URL, without a trailing slash.
- auth: how the API key/token is sent. bearer = "Authorization: Bearer <secret>"; basic = HTTP Basic with username + <secret> as the password (username may be a template such as "{{param.account_sid}}"); header = a custom header named headerName carrying <secret>; query = a query parameter named queryName. The secret itself is entered separately — never put a key or password in the config.
- headers: extra headers sent with every request (e.g. Accept: application/json). params: the account's own non-secret settings the requests need (account ids, sender ids, keyword ids, campaign ids), with empty values for the person to fill in; reference them as {{param.<name>}}.
- countryCode: digits only (e.g. "1"), when the provider wants numbers without a country code or returns them that way; else "". maxLength: the longest text the provider accepts in one request (1600 if not stated).
- send: the request that sends one SMS to one number. path is appended to baseUrl. bodyFormat json: body is a JSON template; bodyFormat form: body is a JSON object of form field → template; none: everything is in the path/query. Templates use {{to}} (E.164, +15551234567), {{to_digits}} (15551234567), {{to_local}} (without countryCode), {{from}} (the sender number/id configured on the channel), {{text}}, {{message_id}} (NestConnect's id, for idempotency/reference fields), {{status_url}} (where the provider should post delivery receipts, if the send request takes a callback URL), {{secret}}, {{param.<name>}}. In a JSON body, a string that is exactly one placeholder keeps the value's type. successPath/successValue: where the response says it worked (omit to treat any 2xx as success). messageIdPath: the provider's message id in the response. errorPath: the error message in an error response.
- Paths into JSON responses: dotted with [n] for arrays, e.g. "data.messages[0].id"; "a|b" tries a then b; "$" is the whole body.
- inbound: how replies from customers arrive. "webhook" if the provider can POST incoming messages to a URL (the person will paste NestConnect's URL into the provider's dashboard); "poll" if there is only an endpoint to list incoming messages (then method/path/headers/intervalSeconds describe that request, 60 seconds unless rate limits suggest otherwise); "none" if neither exists. itemsPath: where the list of messages is (omit if a webhook body is a single message). idPath, fromPath, toPath, textPath, timestampPath locate each field in one message. textEncoding "url" if the text is URL-encoded.
- status: delivery receipts, the same way: "webhook" if the provider posts status callbacks, "poll" if there's an endpoint to look up one message's status (path uses {{message_id}}, the provider's id), else "none". statusPath is the status field; delivered/failed/sent list the provider's own status words for each outcome.
For any part that doesn't apply, still fill the fields with sensible empty values ("" or []), and set the mode to "none".
In "notes", list briefly: what to fill in (params, sender), where to paste the inbound/status URLs in the provider's dashboard, and anything you weren't sure of.`;

@Injectable()
export class SmsSuggestService {
  private readonly logger = new Logger(SmsSuggestService.name);
  /** The model call: tests replace it. */
  client: (apiKey: string) => Pick<Anthropic, "messages"> = (apiKey) => new Anthropic({ apiKey, timeout: 180_000, maxRetries: 1 });

  constructor(
    private readonly store: Store,
    private readonly sandbox: SandboxPolicy,
  ) {}

  async suggest(docs: string, provider?: string): Promise<SuggestedSmsConfig> {
    await this.sandbox.assertLive("AI suggestions");
    const cfg = await resolveAnthropicConfig(this.store);
    if (!cfg) throw new ServiceUnavailableException("AI isn't set up — add an Anthropic API key in Settings › Integrations › AI.");

    let response;
    try {
      response = await this.client(cfg.apiKey).messages.parse({
        model: cfg.model,
        max_tokens: 16000,
        system: SYSTEM,
        messages: [
          {
            role: "user",
            content: `${provider ? `The provider: ${provider}\n\n` : ""}Its API documentation:\n\n<documentation>\n${docs}\n</documentation>`,
          },
        ],
        output_config: { format: zodOutputFormat(suggestionSchema), effort: "medium" },
      });
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) throw new ServiceUnavailableException("The Anthropic API key was refused — check it in Settings › Integrations › AI.");
      if (err instanceof Anthropic.RateLimitError) throw new ServiceUnavailableException("The AI is busy — try again in a minute.");
      if (err instanceof Anthropic.BadRequestError) throw new BadRequestException(`The AI couldn't take this request: ${err.message}`);
      if (err instanceof Anthropic.APIError) throw new ServiceUnavailableException(`The AI didn't answer (${err.status ?? "network"}).`);
      throw err;
    }
    if (response.stop_reason === "refusal") throw new BadRequestException("The AI declined to read this documentation.");
    if (response.stop_reason === "max_tokens") throw new BadRequestException("The suggestion came out too long — paste just the SMS parts of the docs.");
    const out = response.parsed_output;
    if (!out) throw new BadRequestException("The AI's answer didn't come back as a config — try again, or paste less.");

    // Through the real schema: defaults filled, anything invalid reported.
    const { config, notes } = out;
    const cleaned = {
      ...config,
      preset: "custom",
      inbound: { ...config.inbound, intervalSeconds: clamp(config.inbound.intervalSeconds, 15, 3600, 60) },
      status: { ...config.status, intervalSeconds: clamp(config.status.intervalSeconds, 15, 3600, 120) },
      maxLength: clamp(config.maxLength, 70, 10_000, 1600),
      countryCode: config.countryCode.replace(/\D/g, "").slice(0, 4),
    };
    const parsed = smsProviderConfigSchema.safeParse(cleaned);
    if (parsed.success) return { config: parsed.data, notes };
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    this.logger.warn(`SMS suggestion didn't validate: ${issues.join("; ")}`);
    // The baseUrl is the usual casualty (docs that only show paths): keep the
    // rest, with a placeholder, and say so.
    const retry = smsProviderConfigSchema.safeParse({ ...cleaned, baseUrl: /^https?:\/\//.test(cleaned.baseUrl) ? cleaned.baseUrl : "https://api.example.com" });
    if (retry.success) return { config: retry.data, notes: [...notes, `Check: ${issues.join("; ")}`] };
    throw new BadRequestException(`The suggestion didn't fit the config: ${issues.join("; ")}`);
  }
}

function clamp(n: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}
