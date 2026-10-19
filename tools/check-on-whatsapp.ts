/**
 * A phone number is a phone, not a WhatsApp account.
 *
 * Once SMS arrived, "has a number" stopped meaning "is on WhatsApp" — some
 * numbers only take texts — but every customer with one still wore WhatsApp's
 * mark, and the new-customer form asked for "Phone (WhatsApp)". Now a contact
 * carries `onWhatsApp`, true only once WhatsApp itself has told us: a WhatsApp
 * id, which only ever comes from a message they sent there (or history Meta
 * handed over). Pinned:
 *
 *   1. A number typed in by hand is not on WhatsApp.
 *   2. A message from WhatsApp makes the same customer on WhatsApp — without
 *      forking them into a second contact.
 *   3. Merging keeps it, whichever side had it.
 *   4. The Postgres mapping reads it from the identities the same way.
 *
 *     pnpm check:on-whatsapp
 */
import { MemoryStore } from "../apps/api/src/data/memory.store";
import { ORG_ID } from "../apps/api/src/data/fixtures";
import { mapContact } from "../apps/api/src/data/mappers";

let failed = 0;
function ok(label: string, cond: boolean, detail = ""): void {
  if (!cond) failed++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

async function main(): Promise<void> {
  const store = new MemoryStore();
  const find = async (id: string) => (await store.listContacts()).find((c) => c.id === id);

  console.log("\nA number on its own\n");
  const { contact: typed } = await store.createContact({ orgId: ORG_ID, displayName: "Landline Ltd", phone: "+44 117 496 0999" });
  ok("is a phone, not WhatsApp", !(await find(typed.id))?.onWhatsApp);
  const sms = await store.upsertContactByIdentity({ orgId: ORG_ID, kind: "phone", value: "+447700900111", displayName: "Texter" });
  ok("a text from a number doesn't make it WhatsApp", !(await find(sms.id))?.onWhatsApp);

  console.log("\nThey write on WhatsApp\n");
  const wa = await store.upsertContactByIdentity({ orgId: ORG_ID, kind: "wa_id", value: "447700900111", displayName: "Texter" });
  ok("the same customer, not a second one", wa.id === sms.id);
  ok("…and now on WhatsApp", (await find(sms.id))?.onWhatsApp === true);
  const fresh = await store.upsertContactByIdentity({ orgId: ORG_ID, kind: "wa_id", value: "447700900222", displayName: "New on WhatsApp" });
  ok("someone new from WhatsApp is on it from the start", (await find(fresh.id))?.onWhatsApp === true);

  console.log("\nMerging\n");
  const merged = await store.mergeContacts({ winnerId: typed.id, loserIds: [fresh.id] });
  ok("the survivor keeps WhatsApp from the merged-in record", merged.onWhatsApp === true);

  console.log("\nThe seeded demo\n");
  const all = await store.listContacts();
  const demoWa = all.filter((c) => c.onWhatsApp).length;
  // Bloom Florists has a number but has only ever emailed.
  const bloom = all.find((c) => c.displayName === "Bloom Florists");
  ok("WhatsApp chats' customers are on WhatsApp", demoWa > 0, `${demoWa} on WhatsApp`);
  ok("a customer with a number who only emails is not", !!bloom?.phone && !bloom.onWhatsApp);

  console.log("\nPostgres mapping\n");
  const base = { id: "ct_x", orgId: ORG_ID, displayName: "X", avatarColor: null, tags: [], accountLinks: [] };
  const asPhone = mapContact({ ...base, identities: [{ kind: "phone", value: "+447700900333" }] } as never);
  const asWa = mapContact({ ...base, identities: [{ kind: "phone", value: "+447700900333" }, { kind: "wa_id", value: "447700900333" }] } as never);
  ok("a phone identity alone: not on WhatsApp", asPhone.onWhatsApp === false && asPhone.phone === "+447700900333");
  ok("with a WhatsApp id: on WhatsApp", asWa.onWhatsApp === true);

  console.log(failed === 0 ? "\nAll good\n" : `\n${failed} check(s) failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
