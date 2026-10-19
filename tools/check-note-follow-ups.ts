/**
 * Someone else's conversation in my My Inbound, because of its notes.
 *
 * Mentions weren't reaching people: a mention was a bell entry and a row in a
 * Mentions list that never emptied, and nobody could tell what still needed
 * them. Now a note puts the conversation in the inbound of everyone it's for —
 * whoever it @-mentions, and whoever's already in those notes — until they
 * answer, dismiss it, or it closes.
 *
 *   A  A note @-mentioning me puts it in my inbound, tagged as a mention, and
 *      on my app badge; nobody outside the notes gets it.
 *   B  Answering in the notes takes it out of mine — and the answer, with no @,
 *      puts it in the asker's.
 *   C  "Thanks!" with no @ brings it back to whoever's in the notes; Dismiss
 *      takes it out again, leaving the conversation itself alone.
 *   D  A reply to the customer answers it too.
 *   E  Closing it takes it out of everyone's.
 *   F  Never your own note; each person separately.
 *
 *     pnpm check:note-follow-ups
 */
import { MemoryStore } from "../apps/api/src/data/memory.store";
import { DEMO_USER_ID, ORG_ID } from "../apps/api/src/data/fixtures";
import { runInTenant } from "../apps/api/src/tenancy/tenant-scope";
import { ConversationsService } from "../apps/api/src/conversations/conversations.service";
import { NotificationsService } from "../apps/api/src/notifications/notifications.service";
import type { RealtimeGateway } from "../apps/api/src/realtime/realtime.gateway";
import type { PushService } from "../apps/api/src/push/push.service";
import { sendMessageInputSchema, type Conversation } from "../packages/schemas/src/index";

let failed = 0;
function ok(label: string, cond: boolean, detail = ""): void {
  if (!cond) failed++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

const NATHAN = DEMO_USER_ID;
const JAMES = "usr_james";
const AMARA = "usr_amara";

async function main(): Promise<void> {
  const store = new MemoryStore();
  const realtime = new Proxy({}, { get: () => () => {} }) as unknown as RealtimeGateway;
  const push = { notify: () => {} } as unknown as PushService;
  const notifications = new NotificationsService(store, realtime, push);
  const inert = new Proxy({}, { get: () => async () => {} }) as never;
  const convs = new ConversationsService(store, realtime, inert, { enqueueDelivery: async () => {} } as never, notifications, push, inert);
  // The note's follow-ups are written without being awaited by the send.
  const settle = () => new Promise((r) => setTimeout(r, 50));

  await runInTenant(ORG_ID, async () => {
    const inbound = async (userId: string): Promise<Conversation[]> => (await convs.list("inbound", userId, { limit: 200 })).items;
    const has = async (userId: string, id: string) => (await inbound(userId)).find((c) => c.id === id);
    const badge = (userId: string) => store.unreadConversationCount(userId);
    const myInboundCount = async (userId: string) => (await store.views(userId)).my.find((v) => v.key === "inbound")?.count ?? -1;

    // A conversation that is nobody's here: on an email channel (so a reply to
    // the customer can go), assigned to someone outside these three.
    const inbox = (await store.listInboxes()).find((i) => i.type === "email") ?? (await store.listInboxes())[0]!;
    const { contact } = await store.createContact({ orgId: ORG_ID, displayName: "Someone else's", email: "someone@example.com" });
    const { conversation: target } = await store.findOrCreateOpenConversation({
      orgId: ORG_ID,
      inboxId: inbox.id,
      contact,
      channel: inbox.type,
      assigneeUserId: "usr_sofia",
    });
    const id = target.id;
    const note = async (by: string, body: string) => {
      await convs.sendMessage(id, sendMessageInputSchema.parse({ body, internal: true }), by);
      await settle();
    };
    ok("to start with, it's in nobody's inbound here", !(await has(NATHAN, id)) && !(await has(JAMES, id)) && !(await has(AMARA, id)), id);
    const jamesBadge0 = await badge(JAMES);
    const jamesCount0 = await myInboundCount(JAMES);

    console.log("\nA — a note @-mentioning someone\n");
    await note(NATHAN, "@james can you check the VAT on this?");
    const forJames = await has(JAMES, id);
    ok("it lands in James's My Inbound", !!forJames);
    ok("…tagged: Nathan mentioned him", forJames?.followUp?.reason === "mention" && forJames.followUp.byUserId === NATHAN, JSON.stringify(forJames?.followUp));
    ok("…counted in his My Inbound and on his app badge", (await myInboundCount(JAMES)) === jamesCount0 + 1 && (await badge(JAMES)) === jamesBadge0 + 1);
    ok("…and the thread knows it, for the Dismiss button", (await convs.get(id, JAMES)).followUp?.reason === "mention");
    ok("Amara, not in the notes, doesn't get it", !(await has(AMARA, id)));
    ok("Nathan doesn't get his own note", !(await has(NATHAN, id)));

    console.log("\nB — answering in the notes\n");
    await note(JAMES, "Checked — it's zero-rated, invoice is wrong. Reissuing.");
    ok("it leaves James's inbound once he answers", !(await has(JAMES, id)));
    ok("…and his badge goes back down", (await badge(JAMES)) === jamesBadge0);
    const forNathan = await has(NATHAN, id);
    ok("his answer, with no @, puts it in Nathan's — he's in the notes", forNathan?.followUp?.reason === "reply" && forNathan.followUp.byUserId === JAMES, JSON.stringify(forNathan?.followUp));

    console.log("\nC — \"Thanks!\" and Dismiss\n");
    await note(NATHAN, "Thanks!");
    ok("Nathan's own note took it out of his", !(await has(NATHAN, id)));
    ok("\"Thanks!\" with no @ brings it back to James", (await has(JAMES, id))?.followUp?.reason === "reply");
    await convs.dismissFollowUp(id, JAMES);
    ok("Dismiss takes it out of James's inbound", !(await has(JAMES, id)) && (await badge(JAMES)) === jamesBadge0);
    const after = await store.getConversation(id);
    ok("…and leaves the conversation alone: still open, owner unchanged", after?.status === target.status && after?.assigneeUserId === target.assigneeUserId);
    ok("…and still in his Mentions", (await store.listConversations("mentions", JAMES, { limit: 200 })).items.some((c) => c.id === id));

    console.log("\nD — a reply to the customer answers it too\n");
    await note(JAMES, "@nathan one more thing — can you call them?");
    ok("it's in Nathan's again, as a mention", (await has(NATHAN, id))?.followUp?.reason === "mention");
    await convs.sendMessage(id, sendMessageInputSchema.parse({ body: "Hi — we're reissuing the invoice now." }), NATHAN);
    await settle();
    ok("replying to the customer takes it out of his", !(await has(NATHAN, id)));

    console.log("\nE — closing it\n");
    await note(NATHAN, "@james @amara over to you both");
    ok("both have it", !!(await has(JAMES, id))?.followUp && !!(await has(AMARA, id))?.followUp);
    await convs.setStatus(id, { status: "closed" }, NATHAN);
    ok("closing takes it out of everyone's", !(await has(JAMES, id)) && !(await has(AMARA, id)));
    ok("…and off their badges", (await badge(JAMES)) === jamesBadge0);
    await convs.setStatus(id, { status: "open" }, NATHAN);
    ok("reopening doesn't bring it back on its own", !(await has(JAMES, id)) && !(await has(AMARA, id)));

    console.log("\nF — each person separately\n");
    await note(NATHAN, "@james @amara quick one");
    await note(JAMES, "On it.");
    ok("James answering clears his, not Amara's", !(await has(JAMES, id)) && !!(await has(AMARA, id))?.followUp);
  });

  console.log(failed === 0 ? "\nall note follow-up checks passed" : `\n${failed} failed`);
  process.exit(failed ? 1 : 0);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
