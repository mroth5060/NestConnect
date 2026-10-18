/**
 * SMS through the universal engine: any provider described by config, and an
 * SMS channel behaving like every other channel once a text is in.
 *
 *   A  The engine: each preset builds the request its provider expects —
 *      DialMyCalls (header key, JSON broadcast), Twilio (basic auth, form,
 *      status callback) — and a text with quotes and newlines can't break a
 *      JSON body. Answers are read by path, with fallbacks.
 *   B  Polling (DialMyCalls has no webhooks): the first poll only learns
 *      what's there; a new text then becomes a conversation, routed, on the
 *      customer's phone contact; polling again stores nothing twice.
 *   C  Replying goes through the delivery path like any channel: the provider
 *      is called, its id kept; a refusal is permanent and says why, a 503 is
 *      retried, a too-long text never leaves. Receipts are polled and applied.
 *   D  Webhooks (a Twilio-shaped provider): the URL's token lets a post in,
 *      a wrong one doesn't; a retried post stores nothing twice; a receipt
 *      moves the message to delivered.
 *   E  One customer: their WhatsApp and their texts are one contact.
 *   F  Tests from settings say what was sent — the secret blanked — and what
 *      came back; a sample webhook body is read with the mapping.
 *
 * No provider is called: the network is a fake that records each request.
 *
 *     pnpm check:sms
 */
process.env.SMS_POLL = "off";

import { MemoryStore } from "../apps/api/src/data/memory.store";
import { DEMO_USER_ID, ORG_ID } from "../apps/api/src/data/fixtures";
import { runInTenant } from "../apps/api/src/tenancy/tenant-scope";
import { MemoryAccountStore } from "../apps/api/src/accounts/memory-account.store";
import { AccountsService } from "../apps/api/src/accounts/accounts.service";
import { RoutingService } from "../apps/api/src/channels/routing.service";
import { IngestService } from "../apps/api/src/channels/ingest.service";
import { ChannelDispatcher } from "../apps/api/src/channels/channel-dispatcher";
import { SmsService, SMS_KEYS } from "../apps/api/src/channels/sms/sms.service";
import { SmsProvider } from "../apps/api/src/channels/sms/sms.provider";
import { buildSend, normalizePhone, readLookup, readPath, readSendResponse, type SmsRequest, type SmsHttpResponse } from "../apps/api/src/channels/sms/sms-engine";
import type { RealtimeGateway } from "../apps/api/src/realtime/realtime.gateway";
import type { TenantContext } from "../apps/api/src/tenancy/tenant-context";
import type { PushService } from "../apps/api/src/push/push.service";
import type { ConversationSubjectService } from "../apps/api/src/ai/conversation-subject.service";
import type { SandboxPolicy } from "../apps/api/src/tenancy/sandbox";
import type { MediaService } from "../apps/api/src/storage/media.service";
import { SMS_PRESETS, smsProviderConfigSchema, type Message, type SmsProviderConfig } from "../packages/schemas/src/index";

let failed = 0;
function ok(label: string, cond: boolean, detail = ""): void {
  if (!cond) failed++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

const preset = (key: string, patch: (c: SmsProviderConfig) => void = () => {}) => {
  const c = smsProviderConfigSchema.parse(SMS_PRESETS[key]!.config);
  patch(c);
  return c;
};
const notSandbox = { isSandbox: async () => false, current: async () => false, assertLive: async () => {} } as unknown as SandboxPolicy;

/** The provider: answers from a script, records every request. */
class FakeProvider {
  calls: SmsRequest[] = [];
  answer: (req: SmsRequest) => SmsHttpResponse = () => json(200, {});
  http = async (req: SmsRequest) => {
    this.calls.push(req);
    return this.answer(req);
  };
}
const json = (status: number, body: unknown): SmsHttpResponse => ({ status, text: JSON.stringify(body), contentType: "application/json" });

async function main(): Promise<void> {
  console.log("\nA — the engine builds each provider's request\n");
  const dmc = preset("dialmycalls", (c) => (c.params = [{ ...c.params[0]!, value: "vn-123" }]));
  const reqD = buildSend(dmc, "dmc-secret", { to: "+1 (555) 201-3344", text: "Hi there", from: "+15550001111", message_id: "msg_9" });
  const bodyD = JSON.parse(reqD.body!);
  ok("DialMyCalls: POST to /service/text", reqD.method === "POST" && reqD.url === "https://api.dialmycalls.com/2.0/service/text", reqD.url);
  ok("…with the key in X-Auth-ApiKey", reqD.headers["X-Auth-ApiKey"] === "dmc-secret");
  ok("…a broadcast to one contact, from the chosen number, sent now", bodyD.vanitynumber_id === "vn-123" && bodyD.messages[0] === "Hi there" && bodyD.contacts[0].phone === "5552013344" && bodyD.send_immediately === true, reqD.body);
  const readD = readSendResponse(dmc, 200, JSON.stringify({ results: { id: "svc-1" }, meta: { result: "success" } }));
  ok("…and its answer read: sent, with the broadcast id", readD.ok && readD.providerId === "svc-1");
  // Word for word what DialMyCalls answered a send without a number.
  const refusedD = readSendResponse(dmc, 400, '{"results":{"error":{"message":"Please provide a valid `vanitynumber_id`. You can get a list of vanity numbers from `\\/2.0\\/vanitynumbers`."}},"meta":{"result":"failure","status":400}}');
  ok("…a refusal read as one, with its reason", !refusedD.ok && /valid `vanitynumber_id`/.test(refusedD.error ?? "") && refusedD.mapped.error === refusedD.error, JSON.stringify(refusedD));
  ok("…a 200 that says failure is a failure", !readSendResponse(dmc, 200, JSON.stringify({ results: {}, meta: { result: "failure" } })).ok);
  const lookup = dmc.params[0]!.lookup!;
  const numbers = readLookup({ results: [{ id: "vn-1", phone: "8005551234", status: "active" }, { id: "vn-2", phone: "8005559999" }], meta: { result: "success" } }, lookup);
  ok("its numbers can be listed, to pick one by phone number", numbers.length === 2 && numbers[0]!.value === "vn-1" && numbers[0]!.label === "8005551234", JSON.stringify(numbers));

  const tw = preset("twilio", (c) => (c.params = [{ name: "account_sid", value: "AC123" }]));
  const reqT = buildSend(tw, "tw-token", { to: "+447700900123", text: "Hello & welcome", from: "+447700900999", status_url: "https://nc.example/api/channels/sms/x/status/t" });
  const form = new URLSearchParams(reqT.body);
  ok("Twilio: POST to the account's Messages.json", reqT.url === "https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json", reqT.url);
  ok("…basic auth as the account, with the token", reqT.headers.Authorization === `Basic ${Buffer.from("AC123:tw-token").toString("base64")}`);
  ok("…a form: To, From, Body, StatusCallback", form.get("To") === "+447700900123" && form.get("From") === "+447700900999" && form.get("Body") === "Hello & welcome" && form.get("StatusCallback")!.endsWith("/status/t"), reqT.body);

  const custom = preset("custom");
  const tricky = 'She said "hi"\nand {left} \\ right';
  const reqC = buildSend(custom, "tok", { to: "+15550000000", text: tricky, from: "NEST" });
  ok("a text with quotes, newlines and braces stays valid JSON, word for word", JSON.parse(reqC.body!).text === tricky);
  ok("bearer auth", reqC.headers.Authorization === "Bearer tok");
  ok("paths: fallbacks, indexes, the whole body", readPath({ a: { b: [{ c: 7 }] } }, "x|a.b[0].c") === 7 && Array.isArray(readPath([1], "$")));
  ok("numbers come out E.164", normalizePhone("(555) 201-3344", "1") === "+15552013344" && normalizePhone("07700 900123", "44") === "+447700900123" && normalizePhone("0044 7700 900123") === "+447700900123");

  const store = new MemoryStore();
  const realtime = new Proxy({}, { get: () => () => {} }) as unknown as RealtimeGateway;
  const ingest = new IngestService(
    store,
    new RoutingService(store, new AccountsService(new MemoryAccountStore(), store)),
    realtime,
    { bind() {}, orgId: ORG_ID } as unknown as TenantContext,
    { notify() {} } as unknown as PushService,
    { customerWrote() {}, fieldsChanged: async () => {} } as unknown as ConversationSubjectService,
  );
  const sms = new SmsService(store, ingest, realtime);
  // Every conversation in the demo workspace, whatever view it's in.
  const allConvs = async () => {
    const ids = ((store as unknown as { conversations: { id: string }[] }).conversations).map((c) => c.id);
    return (await Promise.all(ids.map((id) => store.getConversation(id)))).filter((c) => !!c).map((c) => c!);
  };
  const fake = new FakeProvider();
  sms.http = fake.http;
  const dispatcher = new ChannelDispatcher([new SmsProvider(sms)], store, {} as MediaService, notSandbox);

  await runInTenant(ORG_ID, async () => {
    const team = (await store.listTeams())[0]!;
    const inbox = await store.createInbox({
      orgId: ORG_ID, type: "sms", name: "Texts", handle: "+15550001111", teamIds: [team.id], routingStrategy: "manual",
      channelConfig: { [SMS_KEYS.config]: JSON.stringify(dmc), [SMS_KEYS.secret]: "dmc-secret", [SMS_KEYS.token]: "tok-dmc" },
    });

    console.log("\nB — polling for texts\n");
    const incoming = (items: unknown[]) => () => json(200, { results: items, meta: { result: "success" } });
    fake.answer = incoming([{ id: "in-old", from_number: "5559990000", to_number: "5550001111", message: "old%20news", created_at: "2026-01-01 10:00:00" }]);
    let res = await sms.pollChannel(inbox.id, new Date("2026-10-18T10:00:00Z"));
    const asked = fake.calls.at(-1)!;
    ok("the first poll asks for incoming texts, with the key and its Range", asked.url.endsWith("/incoming/texts") && asked.headers["X-Auth-ApiKey"] === "dmc-secret" && asked.headers.Range === "records=1-100");
    ok("…and only learns what's there: nothing imported", res.imported === 0 && (await allConvs()).every((c) => c.channel !== "sms"));
    fake.answer = incoming([
      { id: "in-1", from_number: "5552013344", to_number: "5550001111", message: "Is%20my%20order%20ready%3F", created_at: "2026-10-18 10:01:00" },
      { id: "in-old", from_number: "5559990000", to_number: "5550001111", message: "old%20news", created_at: "2026-01-01 10:00:00" },
    ]);
    res = await sms.pollChannel(inbox.id, new Date("2026-10-18T10:01:05Z"));
    const conv = (await allConvs()).find((c) => c.channel === "sms");
    ok("a new text becomes an SMS conversation", res.imported === 1 && !!conv, JSON.stringify(res));
    const full = conv ? await store.getConversation(conv.id) : undefined;
    ok("…on the customer's number, in E.164", full?.contact.phone === "+15552013344", full?.contact.phone ?? "");
    ok("…the text decoded", full?.messages.at(-1)?.body === "Is my order ready?", full?.messages.at(-1)?.body);
    ok("…routed like any other", !!(full?.assignedTeamId || full?.assigneeUserId));
    ok("not before its interval comes round", (await sms.pollChannel(inbox.id, new Date("2026-10-18T10:01:30Z"))).imported === 0 && fake.calls.length === 2);
    await sms.pollChannel(inbox.id, new Date("2026-10-18T10:02:10Z"));
    ok("polling again stores nothing twice", (await store.getConversation(conv!.id))!.messages.filter((m) => m.direction === "in").length === 1);

    console.log("\nC — replying, and receipts\n");
    const reply = { id: "msg_r1", conversationId: conv!.id, body: "Yes — collect any time today.", channel: "sms", direction: "out", internal: false, attachments: [] } as unknown as Message;
    fake.answer = () => json(200, { results: { id: "svc-77" }, meta: { result: "success" } });
    const sent = await dispatcher.attemptSend(full!, reply);
    const call = fake.calls.at(-1)!;
    ok("a reply goes out through the provider", sent.ok && call.url.endsWith("/service/text") && JSON.parse(call.body!).contacts[0].phone === "5552013344", JSON.stringify(sent));
    ok("…from this channel", sent.ok && sent.inboxId === inbox.id);
    ok("…keeping the provider's id, unique to the channel", sent.ok && sent.channelMsgId === `sms:${inbox.id}:svc-77`);

    fake.answer = () => json(402, { results: { error: { message: "Insufficient credits" } }, meta: { result: "failure" } });
    const refused = await dispatcher.attemptSend(full!, reply);
    ok("a refusal fails for good, saying why", !refused.ok && !refused.retryable && refused.reason === "SMS: DialMyCalls: Insufficient credits", JSON.stringify(refused));
    fake.answer = () => json(503, {});
    const busy = await dispatcher.attemptSend(full!, reply);
    ok("a 503 is retried", !busy.ok && busy.retryable);
    const before = fake.calls.length;
    const long = await dispatcher.attemptSend(full!, { ...reply, body: "x".repeat(1601) } as Message);
    ok("a text too long for the provider never leaves", !long.ok && !long.retryable && fake.calls.length === before);
    const photo = await new SmsProvider(sms).sendText({ conversation: full!, to: "+15552013344", body: "See attached", inboxId: inbox.id, media: [{ kind: "image", mimeType: "image/png", filename: "a.png", bytes: Buffer.from("x") }] } as never);
    ok("an attachment is refused, not silently dropped", !photo.ok && /attachments/.test(photo.error ?? "") && fake.calls.length === before);

    // A sent reply waiting on its receipt.
    const me = (await store.getUser(DEMO_USER_ID))!;
    const msg = await store.addMessage(conv!.id, { body: "On its way", internal: false }, me);
    await store.setMessageInbox(msg!.id, inbox.id);
    await store.markMessageSent(msg!.id, `sms:${inbox.id}:svc-88`);
    fake.answer = (req) => (req.url.endsWith("/service/text/svc-88/recipients") ? json(200, { results: [{ phone: "5552013344", status: "delivered", successful: true }], meta: { result: "success" } }) : json(200, { results: [], meta: { result: "success" } }));
    res = await sms.pollChannel(inbox.id, new Date(), { force: true });
    const after = (await store.getConversation(conv!.id))!.messages.find((m) => m.id === msg!.id);
    ok("receipts are polled and applied: delivered", res.receipts >= 1 && after?.status === "delivered", `${res.receipts} ${after?.status}`);

    console.log("\nD — webhooks\n");
    const twilioish = preset("twilio", (c) => (c.params = [{ name: "account_sid", value: "AC1" }]));
    const hooked = await store.createInbox({
      orgId: ORG_ID, type: "sms", name: "Twilio", handle: "+447700900999", teamIds: [team.id], routingStrategy: "manual",
      channelConfig: { [SMS_KEYS.config]: JSON.stringify(twilioish), [SMS_KEYS.secret]: "tw", [SMS_KEYS.token]: "tok-tw" },
    });
    const post = new URLSearchParams({ MessageSid: "SM1", From: "+447700900555", To: "+447700900999", Body: "Running late" }).toString();
    ok("a wrong token is refused", !(await sms.webhook(hooked.id, "nope", "inbound", post, "application/x-www-form-urlencoded")).ok);
    const first = await sms.webhook(hooked.id, "tok-tw", "inbound", post, "application/x-www-form-urlencoded");
    ok("the right one lets a text in", first.ok && first.handled === 1);
    const again = await sms.webhook(hooked.id, "tok-tw", "inbound", post, "application/x-www-form-urlencoded");
    ok("a retried post stores nothing twice", again.ok && again.handled === 0);
    const tconv = (await allConvs()).find((c) => c.inboxId === hooked.id);
    ok("…and it's a conversation on that channel", !!tconv && tconv.channel === "sms");
    const out = await store.addMessage(tconv!.id, { body: "No problem", internal: false }, me);
    await store.markMessageSent(out!.id, `sms:${hooked.id}:SM9`);
    await sms.webhook(hooked.id, "tok-tw", "status", new URLSearchParams({ MessageSid: "SM9", MessageStatus: "delivered" }).toString(), "application/x-www-form-urlencoded");
    ok("a receipt moves the message to delivered", (await store.getConversation(tconv!.id))!.messages.find((m) => m.id === out!.id)?.status === "delivered");
    await sms.webhook(hooked.id, "tok-tw", "status", new URLSearchParams({ MessageSid: "SM9", MessageStatus: "sent" }).toString(), "application/x-www-form-urlencoded");
    ok("…and a late 'sent' doesn't move it back", (await store.getConversation(tconv!.id))!.messages.find((m) => m.id === out!.id)?.status === "delivered");

    console.log("\nE — one customer\n");
    const waContact = await store.upsertContactByIdentity({ orgId: ORG_ID, kind: "wa_id", value: "447700900777", displayName: "Kit" });
    await sms.webhook(hooked.id, "tok-tw", "inbound", new URLSearchParams({ MessageSid: "SM2", From: "+447700900777", To: "+447700900999", Body: "It's Kit" }).toString(), "application/x-www-form-urlencoded");
    const kit = (await allConvs()).find((c) => c.contact.id === waContact.id && c.channel === "sms");
    ok("their texts land on the same contact as their WhatsApp", !!kit);

    console.log("\nF — testing from settings\n");
    fake.answer = () => json(200, { results: { id: "svc-test" }, meta: { result: "success" } });
    const t = await sms.test({ config: dmc, action: "send", to: "+15552013344", text: "Test" }, { inboxId: inbox.id });
    ok("a test text is sent, with the stored key", t.ok && /svc-test/.test(t.summary) && fake.calls.at(-1)!.headers["X-Auth-ApiKey"] === "dmc-secret", t.summary);
    ok("…and what was sent is shown with the key blanked", !!t.request && t.request.headers["X-Auth-ApiKey"] === "••••••" && !JSON.stringify(t.request).includes("dmc-secret"));
    const p = await sms.test({ config: twilioish, action: "parse", sample: "From=%2B15550001234&Body=Hi+there&MessageSid=SMx" });
    ok("a sample webhook body is read with the mapping", p.ok && /\+15550001234/.test(p.summary) && /Hi there/.test(p.summary), p.summary);
    fake.answer = (req) => (req.url.endsWith("/vanitynumbers") ? json(200, { results: [{ id: "vn-9", phone: "8005550199" }], meta: { result: "success" } }) : json(404, {}));
    const found = await sms.test({ config: dmc, action: "lookup", param: "vanitynumber_id", secret: "typed-key" });
    ok("Find lists the account's numbers, with the key as typed", found.ok && found.options?.[0]?.value === "vn-9" && found.options[0].label === "8005550199" && fake.calls.at(-1)!.headers["X-Auth-ApiKey"] === "typed-key", found.summary);
    fake.answer = () => json(400, { results: { error: { message: "Please provide a valid `vanitynumber_id`." } }, meta: { result: "failure" } });
    const why = await sms.test({ config: dmc, action: "send", to: "+15552013344" }, { inboxId: inbox.id });
    ok("a refused test says why, in the provider's words", !why.ok && /valid `vanitynumber_id`/.test(why.summary) && /vanitynumber_id/.test(String(why.mapped?.error)), why.summary);
    fake.answer = () => json(422, { code: 21211, errors: [{ detail: "The 'To' number is not valid" }] });
    const unmapped = await sms.test({ config: custom, action: "send", to: "+15550000000" });
    ok("…even when its error isn't where the config looks", !unmapped.ok && /'To' number is not valid/.test(unmapped.summary), unmapped.summary);
    const bad = await sms.test({ config: { ...custom, send: { ...custom.send, body: "{ not json" } }, action: "send", to: "+15550000000" });
    ok("a body that isn't JSON says so, rather than sending", !bad.ok && /isn't valid JSON/.test(bad.summary), bad.summary);
  });

  console.log(failed ? `\n${failed} failed` : "\nall SMS checks passed");
  process.exit(failed ? 1 : 0);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
