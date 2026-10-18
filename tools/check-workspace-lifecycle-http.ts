/**
 * Managing a workspace from outside it, and its life: suspended, archived,
 * deleted (restorable for 30 days), or wiped now — through a running API on a
 * real Postgres.
 *
 *   A  The wipe covers every table: each is the workspace's own, platform-wide,
 *      or listed. A table added later that's none of these fails here.
 *   B  An owner renames a workspace and manages its people from outside it:
 *      adds, re-invites, changes roles, removes — never its last admin.
 *   C  Suspended: its people are signed out and can't sign in (a wrong password
 *      still reads as wrong), its channels take nothing in, nobody can switch
 *      into it — but its owner can still manage it. Reactivated, it all works.
 *   D  Archived, and deleted (wiped in 30 days): both frozen, both restorable.
 *      The platform's own workspace can't be closed.
 *   E  Wiped now (its name typed out): every row it had is gone — every table's
 *      count is back to what it was before the workspace existed — and its
 *      people's sign-ins with it, unless they're somewhere else too.
 *
 *     DATABASE_URL=… TENANT_HTTP_URL=http://localhost:3011 pnpm check:workspace-lifecycle-http
 *
 * Same API requirements as check:tenant-http (dev mode, 2FA off). Creates and
 * removes its own rows (emails `lch-…`, workspaces named `lch …`).
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { PLATFORM_ORG_ID } from "../apps/api/src/tenancy/platform";
import { planPurge, purgeWorkspaceData, tablesMissedByPurge } from "../apps/api/src/data/workspace-purge";

const BASE = (process.env.TENANT_HTTP_URL ?? "http://localhost:3011").replace(/\/+$/, "");
const PASSWORD = "lch-password-1";

let failed = 0;
function ok(label: string, cond: boolean, detail = ""): void {
  if (!cond) failed++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

/** A browser: keeps the session cookie between calls. A bearer token too, for the widget. */
class Browser {
  cookie = "";
  bearer = "";
  async call(method: string, path: string, body?: unknown) {
    const res = await fetch(`${BASE}/api${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(this.bearer ? { authorization: `Bearer ${this.bearer}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(";");
      const [name, value] = pair!.split("=");
      const jar = new Map(this.cookie ? this.cookie.split("; ").map((p) => p.split("=") as [string, string]) : []);
      if (value) jar.set(name!, value);
      else jar.delete(name!);
      this.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    }
    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    return { status: res.status, json, text };
  }
  login(email: string, password = PASSWORD) {
    return this.call("POST", "/auth/login", { email, password });
  }
}

const waMessage = (phoneNumberId: string, from: string, id: string, body: string) => ({
  object: "whatsapp_business_account",
  entry: [{
    id: "waba",
    changes: [{
      field: "messages",
      value: {
        messaging_product: "whatsapp",
        metadata: { phone_number_id: phoneNumberId, display_phone_number: phoneNumberId },
        contacts: [{ wa_id: from, profile: { name: "lch Customer" } }],
        messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body } }],
      },
    }],
  }],
});

/** Every table's row count. */
async function snapshot(root: PrismaClient): Promise<Map<string, number>> {
  const tables = await root.$queryRawUnsafe<{ t: string }[]>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = current_schema()`);
  const out = new Map<string, number>();
  for (const { t } of tables) {
    const [{ n }] = await root.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${t.replace(/"/g, '""')}"`);
    out.set(t, Number(n));
  }
  return out;
}

async function main(): Promise<void> {
  const root = new PrismaClient();
  await root.$connect();
  await cleanup(root);

  console.log("\nA — the wipe covers every table\n");
  const missed = await tablesMissedByPurge(root);
  ok("every table is a workspace's, platform-wide, or listed", missed.length === 0, missed.join(", "));

  await root.organization.upsert({ where: { id: PLATFORM_ORG_ID }, create: { id: PLATFORM_ORG_ID, name: "Platform" }, update: {} });
  const hash = bcrypt.hashSync(PASSWORD, 8);
  await root.user.create({ data: { orgId: PLATFORM_ORG_ID, name: "lch Owner", email: "lch-owner@example.com", role: "admin", passwordHash: hash } });
  const own = new Browser();
  ok("the owner signs in", (await own.login("lch-owner@example.com")).status < 300);
  // Webhook diagnostics belong to no workspace when a message is for no channel
  // we know — which is what a frozen workspace's channels become.
  const before = await snapshot(root);

  console.log("\nB — managing a workspace from outside it\n");
  const made = await own.call("POST", "/platform/workspaces", { name: "lch Client", adminName: "lch Ada", adminEmail: "lch-ada@example.com" });
  const ws = made.json?.workspace?.id as string;
  ok("a workspace is made", made.status === 201 && !!ws, made.text.slice(0, 120));
  const ada = new Browser();
  const token = new URL(made.json.admin.inviteUrl).searchParams.get("invite")!;
  ok("its admin sets a password", (await ada.call("POST", "/auth/set-password", { token, password: PASSWORD })).status < 300);

  const renamed = await own.call("PATCH", `/platform/workspaces/${ws}`, { name: "lch Client Ltd" });
  ok("the owner renames it", renamed.status === 200 && renamed.json?.name === "lch Client Ltd", renamed.text.slice(0, 120));
  ok("…and its people see the new name", (await ada.call("GET", "/auth/workspaces")).json?.workspaces?.[0]?.name === "lch Client Ltd");
  let people = await own.call("GET", `/platform/workspaces/${ws}/people`);
  ok("the owner sees its people", people.status === 200 && people.json.length === 1 && people.json[0].user.email === "lch-ada@example.com" && people.json[0].pending === false, people.text.slice(0, 160));
  const bob = await own.call("POST", `/platform/workspaces/${ws}/people`, { name: "lch Bob", email: "lch-bob@example.com", role: "agent" });
  ok("adds someone, who's invited", bob.status === 201 && bob.json?.person?.pending === true && !!bob.json?.invite?.url, bob.text.slice(0, 160));
  const bobId = bob.json?.person?.user?.id as string;
  ok("…not twice", (await own.call("POST", `/platform/workspaces/${ws}/people`, { name: "again", email: "LCH-bob@example.com", role: "agent" })).status === 409);
  const again = await own.call("POST", `/platform/workspaces/${ws}/people/${bobId}/invite`);
  ok("re-sends their invite, with a new link", again.status === 201 && !!again.json?.invite?.url && again.json.invite.url !== bob.json.invite.url, again.text.slice(0, 120));
  const adaId = people.json[0].user.id as string;
  ok("…but not to someone who has a password", (await own.call("POST", `/platform/workspaces/${ws}/people/${adaId}/invite`)).status === 400);
  ok("changes a role", (await own.call("PATCH", `/platform/workspaces/${ws}/people/${bobId}`, { role: "manager" })).json?.user?.role === "manager");
  ok("never leaves it without an admin: no demoting the last", (await own.call("PATCH", `/platform/workspaces/${ws}/people/${adaId}`, { role: "agent" })).status === 400);
  ok("…nor removing them", (await own.call("DELETE", `/platform/workspaces/${ws}/people/${adaId}`)).status === 400);
  ok("removes someone", (await own.call("DELETE", `/platform/workspaces/${ws}/people/${bobId}`)).status === 200);
  people = await own.call("GET", `/platform/workspaces/${ws}/people`);
  ok("…who's gone", people.json?.length === 1);
  ok("a manager of the platform can't do any of it", (await new Browser().call("GET", `/platform/workspaces/${ws}/people`)).status === 401);

  // Fill it the way a client would.
  const tried: string[] = [];
  const as = async (label: string, method: string, path: string, body?: unknown) => {
    const r = await ada.call(method, path, body);
    if (r.status >= 300) tried.push(`${label} ${r.status}`);
    return r;
  };
  const team = (await as("team", "POST", "/settings/teams", { name: "lch team" })).json?.id as string;
  const label = (await as("label", "POST", "/labels", { name: "lch VIP", color: "#ff0000" })).json?.id as string;
  await as("template", "POST", "/templates", { name: "lch_hello", body: "Hi {{1}}" });
  await as("field", "POST", "/custom-fields", { key: "lch_order", label: "Order", entity: "conversation" });
  await as("contact", "POST", "/contacts", { displayName: "lch Contact", phone: "+447700900222" });
  await as("macro", "POST", "/macros", { name: "lch macro", body: "Thanks!" });
  const account = (await as("account", "POST", "/accounts", { name: "lch Account" })).json?.id as string;
  if (account) await as("account note", "POST", `/accounts/${account}/notes`, { body: "lch note" });
  const group = (await as("chat group", "POST", "/chat/groups", { name: "lch group" })).json?.id as string;
  if (group) await as("chat message", "POST", `/chat/rooms/${group}/messages`, { body: "lch hello team" });
  await root.inbox.create({
    data: { orgId: ws, type: "whatsapp", name: "lch WhatsApp", handle: "lch_phone", routingStrategy: "manual", channelConfig: { phoneNumberId: "lch_phone" }, teams: { create: [{ teamId: team }] } },
  });
  await root.inbox.create({
    data: { orgId: ws, type: "nestchat", name: "lch chat", handle: "lch-chat", routingStrategy: "manual", channelConfig: { widgetKey: "lch_wk" }, teams: { create: [{ teamId: team }] } },
  });
  ok("its number takes a message in", (await own.call("POST", "/channels/whatsapp/webhook", waMessage("lch_phone", "447700900333", "wamid.lch_1", "lch first"))).status === 200);
  const visitor = new Browser();
  visitor.bearer = (await visitor.call("POST", "/nestchat/lch_wk/session", {})).json?.token ?? "";
  ok("its widget does", !!visitor.bearer && (await visitor.call("POST", "/nestchat/message", { body: "lch widget hello" })).status < 300);
  const conv = await root.conversation.findFirst({ where: { orgId: ws, channel: "whatsapp" } });
  if (conv) {
    await as("reply", "POST", `/conversations/${conv.id}/messages`, { body: "lch reply" });
    await as("note", "POST", `/conversations/${conv.id}/messages`, { body: "lch internal", internal: true });
    await as("labels", "POST", `/conversations/${conv.id}/labels`, { labelIds: [label] });
  }
  const plan = await planPurge(root);
  let filled = 0;
  for (const [table, where] of plan) {
    const [{ n }] = await root.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${table}" WHERE ${where}`, ws);
    if (Number(n) > 0) filled++;
  }
  ok("it's full of things (rows in many tables)", filled >= 15, `${filled} tables${tried.length ? `; not made: ${tried.join(", ")}` : ""}`);

  console.log("\nC — suspended, then reactivated\n");
  const suspended = await own.call("POST", `/platform/workspaces/${ws}/status`, { status: "suspended" });
  ok("the owner suspends it", suspended.status === 201 && suspended.json?.status === "suspended", suspended.text.slice(0, 120));
  ok("its people are signed out", (await ada.call("GET", "/auth/session")).status === 401);
  const refused = await new Browser().login("lch-ada@example.com");
  ok("…and can't sign in, told why", refused.status === 403 && /suspended/i.test(refused.text), `${refused.status} ${refused.text.slice(0, 100)}`);
  ok("…while a wrong password reads as wrong", (await new Browser().login("lch-ada@example.com", "nope-nope-1")).status === 401);
  const messages = await root.message.count({ where: { conversation: { orgId: ws } } });
  await own.call("POST", "/channels/whatsapp/webhook", waMessage("lch_phone", "447700900333", "wamid.lch_2", "lch while suspended"));
  ok("its number takes nothing in", (await root.message.count({ where: { conversation: { orgId: ws } } })) === messages);
  ok("its widget is gone", (await visitor.call("GET", "/nestchat/lch_wk/config")).status === 404);
  ok("nobody switches into it, not even an owner", (await own.call("POST", "/auth/switch", { orgId: ws })).status === 403);
  ok("…and the owner wasn't added to it", (await root.user.count({ where: { orgId: ws, email: "lch-owner@example.com" } })) === 0);
  ok("the owner can still manage it", (await own.call("GET", `/platform/workspaces/${ws}/people`)).status === 200);
  ok("…and it shows as suspended", (await own.call("GET", "/platform/workspaces")).json?.find((w: any) => w.id === ws)?.status === "suspended");
  ok("the platform's own workspace can't be suspended", (await own.call("POST", `/platform/workspaces/${PLATFORM_ORG_ID}/status`, { status: "suspended" })).status === 400);
  ok("reactivated", (await own.call("POST", `/platform/workspaces/${ws}/status`, { status: "active" })).json?.status === "active");
  ok("its people sign in again", (await ada.login("lch-ada@example.com")).status < 300);
  await own.call("POST", "/channels/whatsapp/webhook", waMessage("lch_phone", "447700900333", "wamid.lch_3", "lch back again"));
  ok("its number takes messages in again", (await root.message.count({ where: { conversation: { orgId: ws } } })) > messages);

  console.log("\nD — archived; deleted and restored\n");
  ok("archived", (await own.call("POST", `/platform/workspaces/${ws}/status`, { status: "archived" })).json?.status === "archived");
  ok("…and frozen", (await ada.call("GET", "/auth/session")).status === 401);
  ok("unarchived", (await own.call("POST", `/platform/workspaces/${ws}/status`, { status: "active" })).json?.status === "active");
  const deleting = await own.call("POST", `/platform/workspaces/${ws}/status`, { status: "deleting" });
  const days = (new Date(deleting.json?.purgeAt).getTime() - Date.now()) / 86_400_000;
  ok("deleted: wiped in 30 days", deleting.json?.status === "deleting" && days > 29.9 && days <= 30, `${deleting.json?.purgeAt}`);
  ok("…frozen meanwhile", (await new Browser().login("lch-ada@example.com")).status === 403);
  const restored = await own.call("POST", `/platform/workspaces/${ws}/status`, { status: "active" });
  ok("restored, with nothing lost", restored.json?.status === "active" && restored.json?.purgeAt === null && (await root.message.count({ where: { conversation: { orgId: ws } } })) > messages);

  console.log("\nE — wiped now\n");
  ok("not without its name typed out", (await own.call("POST", `/platform/workspaces/${ws}/delete-now`, { confirmName: "lch Client" })).status === 400);
  ok("the platform's own workspace can't be", (await own.call("POST", `/platform/workspaces/${PLATFORM_ORG_ID}/delete-now`, { confirmName: "Platform" })).status === 400);
  const wiped = await own.call("POST", `/platform/workspaces/${ws}/delete-now`, { confirmName: "lch Client Ltd" });
  ok("wiped", wiped.status === 201 && wiped.json?.ok === true, wiped.text.slice(0, 120));
  ok("it's gone from the list", !(await own.call("GET", "/platform/workspaces")).json?.some((w: any) => w.id === ws));
  ok("its admin's sign-in went with it", (await new Browser().login("lch-ada@example.com")).status === 401 && !(await root.login.findUnique({ where: { email: "lch-ada@example.com" } })));
  const after = await snapshot(root);
  const changed = [...after].filter(([t, n]) => t !== "WebhookDiagnostic" && (before.get(t) ?? 0) !== n).map(([t, n]) => `${t} ${before.get(t) ?? 0}→${n}`);
  ok("every table is back to what it was before the workspace existed", changed.length === 0, changed.join(", "));

  await cleanup(root);
  await root.$disconnect();
  console.log(failed ? `\n${failed} failed` : "\nall workspace lifecycle checks passed");
  process.exit(failed ? 1 : 0);
}

async function cleanup(root: PrismaClient): Promise<void> {
  for (const o of await root.organization.findMany({ where: { name: { startsWith: "lch " } }, select: { id: true } })) {
    await purgeWorkspaceData(root, o.id);
  }
  const users = (await root.user.findMany({ where: { email: { startsWith: "lch-", mode: "insensitive" } }, select: { id: true } })).map((u) => u.id);
  await root.device.deleteMany({ where: { userId: { in: users } } });
  await root.session.deleteMany({ where: { userId: { in: users } } });
  await root.notification.deleteMany({ where: { userId: { in: users } } });
  await root.user.deleteMany({ where: { id: { in: users } } });
  await root.login.deleteMany({ where: { email: { startsWith: "lch-" } } });
  await root.webhookDiagnostic.deleteMany({ where: { reference: { startsWith: "lch" } } });
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
