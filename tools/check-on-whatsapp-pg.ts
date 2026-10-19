/**
 * A phone isn't WhatsApp, on real Postgres.
 *
 * `onWhatsApp` comes from a WhatsApp id among the customer's identities. One
 * is written when someone new arrives from WhatsApp — and, the case this pins,
 * when a customer already known by their phone number (added by hand, or met
 * by text) writes on WhatsApp later. The number matched them, and used to be
 * all that was kept, so they'd never have shown as on WhatsApp.
 *
 *     DATABASE_URL=… pnpm check:on-whatsapp-pg
 */
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

async function cleanup(root: PrismaClient): Promise<void> {
  await root.contactIdentity.deleteMany({ where: { OR: [{ orgId: ORG }, { contact: { orgId: ORG } }] } });
  await root.contact.deleteMany({ where: { orgId: ORG } });
  await root.organization.deleteMany({ where: { id: ORG } });
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

  await cleanup(root);
  await root.$disconnect();
  console.log(failed === 0 ? "\nAll good\n" : `\n${failed} check(s) failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
