# SMS

SMS is one more channel type (`sms`). It uses the same conversations,
contacts, routing, notifications, channel switching and permissions as
WhatsApp, email and NestChat. Only the provider part is new, and that part
is **configured, not coded**. One engine talks to any SMS REST API from a
declarative config. DialMyCalls and Twilio ship as presets. A provider
without a preset is set up by filling the config in by hand, or by pasting
its API docs and letting AI suggest one.

Connect one under **Settings › Channels › Add channel › SMS**. The channel's
handle is its sender number or ID. Edit it later from the channel's card.
Several SMS channels can run side by side, each with its own provider.

## The config

Each channel stores its provider config as JSON (`channelConfig.smsConfig`).
It is validated by `smsProviderConfigSchema` in `packages/schemas/src/sms.ts`.

| Part | What it says |
| --- | --- |
| `provider`, `baseUrl` | The provider's name (shown in errors and the thread) and API root. |
| `auth` | `none`, `bearer`, `basic` (username + secret), `header` (named header) or `query` (named parameter). The secret itself is stored apart from the config (`smsSecret`), encrypted, and never sent back to the browser. |
| `headers`, `params` | Headers sent with every request. Non-secret account settings (sending number id, account SID, …), used as `{{param.name}}`. A param can carry a `lookup` (a GET path, plus where the list is and each item's value and label). The editor then shows **Find**, which asks the provider for the options so nobody has to dig out an id. |
| `countryCode`, `maxLength` | For providers that want or return numbers without a country code. The longest text one request may carry. |
| `send` | Method, path, body format (`json`, `form`, `none`) and body template. Plus where the answer says it worked (`successPath`/`successValue`), the provider's message id (`messageIdPath`) and its error (`errorPath`). |
| `inbound` | How replies arrive: `webhook`, `poll` or `none`. For polling: the request, its interval and `itemsPath`. Then where each text's id, from, to, text and time are. `textEncoding: "url"` for providers that URL-encode the text. |
| `status` | Delivery receipts, the same three ways. `statusPath` points to the status, and the provider's own words map to `delivered`, `failed` and `sent`. |

**Templates.** These work in paths, headers, params and the body:

- `{{to}}` (E.164), `{{to_digits}}`, `{{to_local}}` (without `countryCode`)
- `{{from}}` (the channel's handle) and `{{text}}`
- `{{message_id}}`: our id on send, the provider's on a status poll
- `{{status_url}}`, `{{secret}}` and `{{param.name}}`

In a JSON body, a string that is exactly one placeholder keeps the value's
type.

**Paths into responses** are dotted with `[n]` for arrays
(`data.messages[0].id`). `a|b` tries `a`, then `b`. `$` is the whole body.

What a config can do (send / receive by webhook or poll / receipts by
webhook or poll) is read from it (`smsCapabilities`). The editor shows it as
chips.

## How it runs

- **Sending.** `SmsProvider` implements the shared `ChannelProvider` interface.
  It goes through the same dispatcher and outbound queue as every other
  channel. A network error, a 5xx or a 429 is retried. Anything else fails the
  message, and the failure reason uses the provider's own error text. Texts
  over `maxLength`, empty texts and attachments are refused before sending. The
  composer hides the attach button on SMS.
- **Webhooks.** `POST`/`GET /api/channels/sms/:inboxId/inbound/:token` and
  `…/status/:token`. Each channel gets a random token when it's created, which
  is compared in constant time. Anything readable gets a 200, even when
  ignored, because providers retry refusals for hours. A wrong URL gets a 404.
  The URLs are built from `APP_URL` and shown in the editor to paste into the
  provider's dashboard.
- **Polling.** Every 15 seconds the service checks which channels are due. Set
  `SMS_POLL=off` to stop it. The first poll of a channel only records where
  "now" is, so a newly connected number doesn't pull in its whole history.
  After that, texts it has already seen are skipped (the last 500 ids, plus
  `since`). Receipts are polled for outbound messages up to 48 hours old, 20
  per run.
- **Ingest.** Incoming texts go through `IngestService.ingestSms`, the same
  pipeline as other channels: route, assign, SLA, log, push, realtime. The
  contact is matched on `phone`, which pairs with WhatsApp's `wa_id`, so one
  customer is one contact across both. Message ids are stored as
  `sms:<inboxId>:<providerId>`. A text that arrives twice (a webhook retry,
  or overlapping polls) is recorded once.
- **Errors.** When a send fails and the configured `errorPath` finds nothing,
  the engine looks through the answer for anything error-like (`error`,
  `errors`, `message`, `detail`, …). A refusal always shows the provider's
  reason, not just a status code.
- **Frozen workspaces** don't send, poll or take webhooks.

## Testing a config

The editor's **Test** section runs any of the following against the config
as it stands in the form, before it is saved:

- **Send a test text** to a number.
- **Fetch incoming once** (polling configs).
- **Read a sample**: paste a webhook body to check the field mapping.

Each run shows the request (with the secret masked as `••••••`), the
provider's answer and what was read from it. **Check now**, on a saved
channel, runs its polling straight away.

## AI-assisted setup

**Fill in from the provider's API docs** takes pasted docs or an OpenAPI spec.
It asks Claude (the model and key in **Settings › Integrations › AI**) for a
config, using structured outputs. The answer is checked against the real
schema, then dropped into the form with notes on what to fill in. Nothing is
saved until a person saves it, so test it first. Without an Anthropic key the
button explains that it needs one.

## DialMyCalls

- **Auth:** API key in the `X-Auth-ApiKey` header.
- **Sending number:** required. It's the `vanitynumber_id` of the DialMyCalls
  number the texts go out from. Enter the API key, then press **Find** next to
  it to pick the number (it calls `GET /vanitynumbers`). The send API refuses
  texts without one. Older docs and SDKs say `keyword_id`; the live API wants
  `vanitynumber_id`.
- **Answers:** wrapped as `{"results": …, "meta": {"result": "success" | "failure"}}`.
  Success is read from `meta.result`, the broadcast id from `results.id`, and
  errors from `results.error.message`.
- **Sending:** each text is a "broadcast" (`POST /service/text`) to one
  contact, sent immediately. It costs the account's text credits like any
  other broadcast.
- **Replies:** DialMyCalls has no webhooks. Replies are fetched every 60s from
  `GET /incoming/texts`, newest 100. Their text is URL-encoded.
- **Receipts:** polled from `/service/text/{id}/recipients`. `delivered` means
  delivered; `undeliverable` and `non_mobile` mean failed; `enroute` means
  sent.
- **Numbers:** DialMyCalls is US/Canada, so the preset sets country code `1`.
  Numbers are sent without it and incoming ones get it added back.

## Twilio

- **Auth:** HTTP Basic, Account SID plus Auth Token. The SID is a param.
- **Sending:** a form post to `Messages.json`. It carries the channel's
  receipts URL as `StatusCallback`, so receipts come by webhook.
- **Replies:** paste the inbound URL into the number's *Messaging › A message
  comes in* setting.
