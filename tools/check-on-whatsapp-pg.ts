/**
 * A phone isn't WhatsApp, on real Postgres.
 *
 * `onWhatsApp` comes from a WhatsApp id among the customer's identities. One
 * is written when someone new arrives from WhatsApp — and, the case this pins,
 * when a customer already known by their phone number (added by hand, or met
 * by text) writes on WhatsApp later. The number matched them, and used to be
 * all that was kept, so they'd never have shown as on WhatsApp.
 *
 * Then the one-off backfill for customers from before that: the migration's
 * own SQL, run against a workspace laid out with each case it must tell apart.
 *
 *     DATABASE_URL=… pnpm check:on-whatsapp-pg
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaStore } from "../apps/api/src/data/prisma.store";
import type { PrismaService } from "../apps/api/src/data/prisma.service";
import { SecretEncryptionService } from "../apps/api/src/crypto/secret-encryption.service";
import { runInTenant } from "../apps/api/src/tenancy/tenant-scope";

let failed = 0;
function ok(label: string, cond: boolean, detail = ""): void {
  if (!cond) failed++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

const ORG = "wachk_a";
const BF = "wachk_bf";
const BF2 = "wachk_bf2";
const ORGS = [ORG, BF, BF2];
const BACKFILL = readFileSync(
  join(__dirname, "../apps/api/prisma/migrations/20261022090000_whatsapp_identity_backfill/migration.sql"),
  "utf8",
);

async function cleanup(root: PrismaClient): Promise<void> {
  await root.message.deleteMany({ where: { conversation: { orgId: { in: ORGS } } } });
  await root.conversation.deleteMany({ where: { orgId: { in: ORGS } } });
  await root.inbox.deleteMany({ where: { orgId: { in: ORGS } } });
  await root.contactIdentity.deleteMany({ where: { OR: [{ orgId: { in: ORGS } }, { contact: { orgId: { in: ORGS } } }] } });
  await root.contact.deleteMany({ where: { orgId: { in: ORGS } } });
  await root.organization.deleteMany({ where: { id: { in: ORGS } } });
}

/** A customer known by `phone`, with a conversation on `channel` holding these
 *  messages, and optionally a WhatsApp id of their own already. */
async function customer(
  root: PrismaClient,
  org: string,
  inboxId: string,
  id: string,
  phone: string,
  channel: "whatsapp" | "sms",
  messages: Array<"in" | "out">,
  waId?: string,
): Promise<void> {
  const digits = phone.replace(/\D/g, "");
  await root.contact.create({
    data: {
      id,
      orgId: org,
      displayName: id,
      identities: {
        create: [
          { orgId: org, kind: "phone", value: phone, normalizedValue: digits },
          ...(waId ? [{ orgId: org, kind: "wa_id", value: waId, normalizedValue: waId }] : []),
        ],
      },
    },
  });
  await root.conversation.create({
    data: {
      id: `${id}_conv`,
      orgId: org,
      inboxId,
      contactId: id,
      channel,
      messages: {
        create: messages.map((d, i) => ({
          seq: i + 1,
          direction: d,
          authorType: d === "in" ? "contact" : "user",
          body: d === "in" ? "Thanks!" : "Template",
        })),
      },
    },
  });
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required — this check runs against a real Postgres.");
    process.exit(1);
  }
  const root = new PrismaClient();
  await root.$connect();
  const store = new PrismaStore(root as unknown as PrismaService, new SecretEncryptionService());
  await cleanup(root);
  await root.organization.create({ data: { id: ORG, name: "WhatsApp check" } });

  await runInTenant(ORG, async () => {
    console.log("\nKnown by phone first\n");
    const { contact: typed } = await store.createContact({ orgId: ORG, displayName: "Mia Jones", phone: "+44 7700 900555" });
    ok("added with a number: a phone, not WhatsApp", typed.onWhatsApp === false);
    const texted = await store.upsertContactByIdentity({ orgId: ORG, kind: "phone", value: "07700900555", displayName: "07700900555" });
    ok("a text from it finds the same customer, still not WhatsApp", texted.id === typed.id && texted.onWhatsApp === false);

    console.log("\nThen they write on WhatsApp\n");
    const wa = await store.upsertContactByIdentity({ orgId: ORG, kind: "wa_id", value: "447700900555", displayName: "447700900555" });
    ok("the same customer, not a second one", wa.id === typed.id);
    ok("…now on WhatsApp", wa.onWhatsApp === true);
    ok("…and it's kept: read back, still on WhatsApp", (await store.getContact(typed.id))?.onWhatsApp === true);
    const again = await store.upsertContactByIdentity({ orgId: ORG, kind: "wa_id", value: "447700900555", displayName: "447700900555" });
    const ids = await root.contactIdentity.count({ where: { contactId: typed.id, kind: "wa_id" } });
    ok("a second WhatsApp message adds nothing more", again.id === typed.id && ids === 1, `${ids} WhatsApp id(s)`);

    console.log("\nNew from WhatsApp\n");
    const fresh = await store.upsertContactByIdentity({ orgId: ORG, kind: "wa_id", value: "447700900666", displayName: "447700900666" });
    ok("on WhatsApp from the start", fresh.onWhatsApp === true && fresh.phone === "447700900666");
  });

  console.log("\nBackfill for customers from before\n");
  await root.organization.createMany({ data: [{ id: BF, name: "Backfill" }, { id: BF2, name: "Backfill, other workspace" }] });
  await root.inbox.createMany({
    data: [
      { id: "wachk_wa", orgId: BF, type: "whatsapp", name: "WA", handle: "wachk-pnid" },
      { id: "wachk_sms", orgId: BF, type: "sms", name: "SMS", handle: "wachk-sms" },
      { id: "wachk_wa2", orgId: BF2, type: "whatsapp", name: "WA 2", handle: "wachk-pnid2" },
    ],
  });
  await customer(root, BF, "wachk_wa", "wachk_replied", "+44 7700 900001", "whatsapp", ["out", "in"]);
  await customer(root, BF, "wachk_wa", "wachk_template", "+44 7700 900002", "whatsapp", ["out"]);
  await customer(root, BF, "wachk_sms", "wachk_texted", "+44 7700 900003", "sms", ["in"]);
  await customer(root, BF, "wachk_wa", "wachk_already", "+44 7700 900004", "whatsapp", ["in"], "447700900004");
  // Two records for one number, the second already holding its WhatsApp id.
  await customer(root, BF, "wachk_wa", "wachk_dup", "+44 7700 900005", "whatsapp", ["in"]);
  await customer(root, BF, "wachk_sms", "wachk_holder", "+44 7700 900006", "sms", [], "447700900005");
  await customer(root, BF2, "wachk_wa2", "wachk_elsewhere", "+44 7700 900001", "whatsapp", ["in"]);

  const added = await root.$executeRawUnsafe(BACKFILL);
  const waIds = async (contactId: string) => root.contactIdentity.count({ where: { contactId, kind: "wa_id" } });
  ok("replied on WhatsApp: given a WhatsApp id", (await waIds("wachk_replied")) === 1);
  ok("…which makes them on WhatsApp", (await runInTenant(BF, () => store.getContact("wachk_replied")))?.onWhatsApp === true);
  ok("only ever sent a template: not", (await waIds("wachk_template")) === 0);
  ok("only ever texted: not", (await waIds("wachk_texted")) === 0);
  ok("already had one: not given a second", (await waIds("wachk_already")) === 1);
  ok("its WhatsApp id held by another record: left alone", (await waIds("wachk_dup")) === 0 && (await waIds("wachk_holder")) === 1);
  ok("the same number in another workspace gets its own", (await waIds("wachk_elsewhere")) === 1);
  ok("two added in all", added === 2, String(added));
  ok("running it again adds nothing", (await root.$executeRawUnsafe(BACKFILL)) === 0);

  await cleanup(root);
  await root.$disconnect();
  console.log(failed === 0 ? "\nAll good\n" : `\n${failed} check(s) failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
