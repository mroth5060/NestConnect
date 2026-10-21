/**
 * The Outlook / Microsoft 365 email channel, against a faked Microsoft Graph.
 *
 * What has to hold:
 *
 *   1. A fresh connection starts at "now" — nothing already in the mailbox is
 *      pulled in, only mail that arrives afterwards.
 *   2. New inbox mail is ingested once, however many polls see it. The cursor
 *      is `ge`, so the newest message is always listed again; it must not be
 *      ingested again.
 *   3. A reply an agent typed straight into Outlook is recorded as outbound;
 *      Nest's own sends (carrying X-Ding-Origin) are not recorded a second time.
 *   4. A shared mailbox is read and sent through /users/{address}, not /me.
 *   5. An expired token is refreshed, and the ROTATED refresh token is kept —
 *      Microsoft retires the old one, so dropping it would disconnect the inbox.
 *   6. Sending goes out as MIME carrying our Message-ID and threading headers.
 *
 *     pnpm check:outlook
 */
import { MemoryStore } from "../apps/api/src/data/memory.store";
import { ORG_ID } from "../apps/api/src/data/fixtures";
import { MicrosoftOAuthService, OUTLOOK_CONFIG } from "../apps/api/src/channels/microsoft/microsoft-oauth.service";
import { OutlookSyncService } from "../apps/api/src/channels/microsoft/outlook-sync.service";
import { OutlookProvider } from "../apps/api/src/channels/microsoft/outlook.provider";
import { DING_ORIGIN_PROP } from "../apps/api/src/channels/microsoft/graph-api";
import type { IngestService } from "../apps/api/src/channels/ingest.service";
import type { MediaService } from "../apps/api/src/storage/media.service";

let failed = 0;
function ok(label: string, cond: boolean, detail = ""): void {
  if (!cond) failed++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

/* ------------------------------ a fake Graph ------------------------------ */

interface FakeMsg {
  id: string;
  folder: "inbox" | "sentitems";
  receivedDateTime: string;
  internetMessageId: string;
  subject: string;
  from: string;
  to: string[];
  html: string;
  nestOrigin?: boolean;
}
const mailbox: FakeMsg[] = [];
const calls: string[] = [];
const sent: Array<{ path: string; mime: string }> = [];
let tokenGrants: Array<Record<string, string>> = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  calls.push(`${init?.method ?? "GET"} ${decodeURIComponent(url.pathname)}`);

  if (url.host === "login.microsoftonline.com") {
    const grant = Object.fromEntries(new URLSearchParams(String(init?.body)));
    tokenGrants.push(grant);
    return json({ access_token: "fresh-access", refresh_token: "rotated-refresh", expires_in: 3600 });
  }

  const path = decodeURIComponent(url.pathname.replace(/^\/v1\.0/, ""));
  const list = path.match(/^(.*)\/mailFolders\/(inbox|sentitems)\/messages$/);
  if (list) {
    const since = (url.searchParams.get("$filter") ?? "").replace("receivedDateTime ge ", "");
    const value = mailbox
      .filter((m) => m.folder === list[2] && m.receivedDateTime >= since)
      .sort((a, b) => a.receivedDateTime.localeCompare(b.receivedDateTime))
      .map((m) => ({ id: m.id, receivedDateTime: m.receivedDateTime }));
    return json({ value });
  }
  const one = path.match(/^(.*)\/messages\/([^/]+)$/);
  if (one) {
    const m = mailbox.find((x) => x.id === one[2]);
    if (!m) return json({ error: { message: "not found" } }, 404);
    return json({
      id: m.id,
      receivedDateTime: m.receivedDateTime,
      internetMessageId: m.internetMessageId,
      subject: m.subject,
      from: { emailAddress: { address: m.from, name: m.from.split("@")[0] } },
      toRecipients: m.to.map((address) => ({ emailAddress: { address } })),
      body: { contentType: "html", content: m.html },
      conversationId: `conv-${m.subject}`,
      hasAttachments: false,
      isDraft: false,
      // Sent Items carry no internet headers; the marker comes back as a property.
      singleValueExtendedProperties: m.nestOrigin ? [{ id: DING_ORIGIN_PROP, value: "nest" }] : [],
    });
  }
  const send = path.match(/^(.*)\/sendMail$/);
  if (send && init?.method === "POST") {
    sent.push({ path: send[1], mime: Buffer.from(String(init.body), "base64").toString("utf8") });
    return new Response(null, { status: 202 });
  }
  return json({ error: { message: `unexpected ${path}` } }, 400);
}) as typeof fetch;

/* -------------------------------- the rig --------------------------------- */

const inbound: Array<{ from: string; subject?: string; toAddress: string }> = [];
const outbound: Array<{ subject?: string; recipients?: string[] }> = [];
const ingest = {
  ingestEmail: async (i: { from: string; subject?: string; toAddress: string }) => {
    inbound.push(i);
    return { conversationId: "c", created: true };
  },
  ingestOutboundEmail: async (i: { subject?: string; recipients?: string[] }) => {
    outbound.push(i);
    return { conversationId: "c" };
  },
} as unknown as IngestService;
const media = { store: async () => ({}) } as unknown as MediaService;

async function main(): Promise<void> {
  const store = new MemoryStore();
  const microsoft = new MicrosoftOAuthService(store);
  const sync = new OutlookSyncService(store, ingest, microsoft, media);
  const future = new Date(Date.now() + 3_600_000).toISOString();

  const inbox = await store.createInbox({
    orgId: ORG_ID, type: "email", name: "orders@hermolis.com", handle: "orders@hermolis.com",
    teamIds: [], routingStrategy: "manual",
    channelConfig: {
      [OUTLOOK_CONFIG.provider]: "outlook",
      [OUTLOOK_CONFIG.email]: "orders@hermolis.com",
      [OUTLOOK_CONFIG.sharedMailbox]: "orders@hermolis.com",
      [OUTLOOK_CONFIG.accessToken]: "live-access",
      [OUTLOOK_CONFIG.refreshToken]: "first-refresh",
      [OUTLOOK_CONFIG.tokenExpiry]: future,
    },
  });
  const config = async () => (await store.getInboxConfig(inbox.id))!;

  console.log("\nConnecting\n");
  mailbox.push({
    id: "old", folder: "inbox", receivedDateTime: "2020-01-01T09:00:00Z", internetMessageId: "<old@x>",
    subject: "Last year", from: "someone@example.com", to: ["orders@hermolis.com"], html: "<p>old</p>",
  });
  await sync.establishBaseline(inbox, new Date("2026-10-21T10:00:00Z"));
  await sync.syncInbox(inbox, await config());
  ok("mail from before the connection is left alone", inbound.length === 0, `${inbound.length} ingested`);

  console.log("\nNew mail\n");
  mailbox.push({
    id: "m1", folder: "inbox", receivedDateTime: "2026-10-21T10:05:00Z", internetMessageId: "<m1@shul>",
    subject: "Kiddush this Shabbat", from: "office@mapleroadshul.org.uk", to: ["orders@hermolis.com"],
    html: "<p>Can we add two platters?</p>",
  });
  mailbox.push({
    id: "m2", folder: "inbox", receivedDateTime: "2026-10-21T10:05:00Z", internetMessageId: "<m2@school>",
    subject: "Lunch order", from: "kitchen@oakwoodprimary.org.uk", to: ["orders@hermolis.com"],
    html: "<p>Same as last week.</p>",
  });
  await sync.syncInbox(inbox, await config());
  ok("both arrive, including two in the same second", inbound.length === 2, `${inbound.length}`);
  ok("addressed to the shared mailbox", inbound.every((m) => m.toAddress === "orders@hermolis.com"));
  await sync.syncInbox(inbox, await config());
  await sync.syncInbox(inbox, await config());
  ok("and once only, however many polls list them again", inbound.length === 2, `${inbound.length}`);
  ok(
    "the shared mailbox is read through /users/{address}",
    calls.some((c) => c.includes("/users/orders@hermolis.com/mailFolders/inbox")) && !calls.some((c) => c.includes("/me/")),
  );

  console.log("\nSent Items\n");
  mailbox.push({
    id: "s1", folder: "sentitems", receivedDateTime: "2026-10-21T10:07:00Z", internetMessageId: "<s1@out>",
    subject: "Re: Kiddush this Shabbat", from: "orders@hermolis.com", to: ["office@mapleroadshul.org.uk"],
    html: "<p>Done — two more platters.</p>",
  });
  mailbox.push({
    id: "s2", folder: "sentitems", receivedDateTime: "2026-10-21T10:08:00Z", internetMessageId: "<ding.x@hermolis.com>",
    subject: "Re: Lunch order", from: "orders@hermolis.com", to: ["kitchen@oakwoodprimary.org.uk"],
    html: "<p>Confirmed.</p>", nestOrigin: true,
  });
  await sync.syncInbox(inbox, await config());
  ok("a reply typed in Outlook is recorded as outbound", outbound.length === 1 && outbound[0].subject === "Re: Kiddush this Shabbat");
  ok("with who it went to", outbound[0]?.recipients?.join() === "office@mapleroadshul.org.uk");
  ok("Nest's own send is not recorded twice", outbound.every((o) => o.subject !== "Re: Lunch order"));

  console.log("\nAn expired token\n");
  await store.updateInbox(inbox.id, { channelConfig: { [OUTLOOK_CONFIG.tokenExpiry]: "2000-01-01T00:00:00Z" } });
  tokenGrants = [];
  await sync.syncInbox(inbox, await config());
  ok("is refreshed with the stored refresh token", tokenGrants[0]?.refresh_token === "first-refresh");
  const after = await config();
  ok("and the rotated refresh token is kept", after[OUTLOOK_CONFIG.refreshToken] === "rotated-refresh", after[OUTLOOK_CONFIG.refreshToken]);
  ok("with the new access token", after[OUTLOOK_CONFIG.accessToken] === "fresh-access");

  console.log("\nSending\n");
  const provider = new OutlookProvider(microsoft, store, media);
  ok("serves Outlook inboxes only", provider.supports("email", { provider: "outlook" }) && !provider.supports("email", { provider: "gmail" }));
  const conversation = (await store.listConversations("inbound", "usr_nathan", { limit: 1 })).items[0];
  const result = await provider.sendText({
    to: "office@mapleroadshul.org.uk",
    body: "See you Friday.",
    conversation: conversation as never,
    inboxId: inbox.id,
    context: { subject: "Kiddush this Shabbat", inReplyTo: "<m1@shul>", references: "<m1@shul>" },
  });
  ok("it sends", result.ok, result.ok ? "" : result.error);
  const mime = sent[0]?.mime ?? "";
  ok("through the shared mailbox", sent[0]?.path === "/users/orders@hermolis.com");
  ok("from its address", /^From: .*orders@hermolis\.com/m.test(mime));
  ok("with our Message-ID", result.ok && mime.includes(`Message-ID: ${result.channelMsgId}`));
  ok("threaded onto the customer's message", mime.includes("In-Reply-To: <m1@shul>"));
  ok("and marked as Nest's, so its Sent copy is skipped", mime.includes("X-Ding-Origin: nest"));

  console.log(failed === 0 ? "\nall good\n" : `\n${failed} check(s) failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
