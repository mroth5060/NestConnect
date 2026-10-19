/**
 * Settings › People shows who has joined.
 *
 * Somebody invited sat in the list looking exactly like everyone else, so an
 * admin couldn't tell who had never set a password. Now each member carries
 * `pending`: "Invite pending" until they join, "Active" from then on. Pinned:
 *
 *   1. The people already signing in are active.
 *   2. Someone invited is pending, and a fresh invite can be sent to them.
 *   3. Once they set their password from the link they're active, and there
 *      is no invite left to send.
 *   4. The platform's own list of a workspace's people says the same.
 *
 *     pnpm check:member-invites
 */
import { MemoryStore } from "../apps/api/src/data/memory.store";
import { ORG_ID } from "../apps/api/src/data/fixtures";

let failed = 0;
function ok(label: string, cond: boolean, detail = ""): void {
  if (!cond) failed++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

async function main(): Promise<void> {
  const store = new MemoryStore();
  const pendingOf = async (id: string) => (await store.listMembers()).find((m) => m.user.id === id)?.pending;
  const platformPendingOf = async (id: string) =>
    (await store.listWorkspacePeople(ORG_ID)).find((p) => p.user.id === id)?.pending;

  console.log("\nPeople already here\n");
  const before = await store.listMembers();
  ok("everyone seeded is active", before.length > 0 && before.every((m) => m.pending === false), `${before.length} people`);

  console.log("\nAn invite\n");
  const { user, inviteToken } = await store.createUser({ orgId: ORG_ID, name: "Priya Shah", email: "priya@example.com", role: "agent", teamIds: [] });
  ok("inviting mints a link", Boolean(inviteToken));
  ok("they show as pending", (await pendingOf(user.id)) === true);
  ok("…on the platform's list too", (await platformPendingOf(user.id)) === true);
  const again = await store.reissueInvite(user.id);
  ok("a fresh invite can be sent", Boolean(again) && again !== inviteToken);

  console.log("\nThey join\n");
  const joined = await store.setPasswordByInviteToken(again!, "a-long-enough-password");
  ok("the newest link works", joined?.id === user.id);
  ok("they show as active", (await pendingOf(user.id)) === false);
  ok("…on the platform's list too", (await platformPendingOf(user.id)) === false);
  ok("there's no invite left to send", (await store.reissueInvite(user.id)) === undefined);

  console.log("\nSomeone added with a password\n");
  const direct = await store.createUser({ orgId: ORG_ID, name: "Tom Reid", email: "tom@example.com", role: "agent", teamIds: [], password: "another-long-password" });
  ok("is active straight away", (await pendingOf(direct.user.id)) === false);

  console.log(failed === 0 ? "\nAll good\n" : `\n${failed} check(s) failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
