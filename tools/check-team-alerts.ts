/**
 * A chat routed to a team is heard by that team.
 *
 * Sending a chat to another team used to tell nobody: only handing it to a
 * person rang anything, so a transfer sat in the new team's queue until someone
 * happened to look. And a brand-new chat landing unassigned in a team queue
 * only rang for people who had switched on "every message in my team inbox" —
 * off by default, because it is noisy.
 *
 * "New chats for my team" (`teamChats`, on by default) covers both:
 *
 *   A  the push policy: a team_chat push reaches the team by default, can be
 *      switched off, and still reaches someone who asked for every team message;
 *   B  a transfer to a team with nobody picked: the team's bell, phone and
 *      screen — not whoever moved it, not another team, not anyone who
 *      switched it off — and nothing when it's handed to a person instead;
 *   C  a new chat waiting unassigned: the team hears it as a new chat, and
 *      every message after it until someone takes it — still the team's to
 *      pick up, so still news to them. Once a colleague has it, the rest of
 *      the team hears it only under the noisy setting ("Everything in my
 *      team's inboxes"); one routed straight to an agent rings only that agent.
 *
 *     pnpm check:team-alerts
 */
import { MemoryStore } from "../apps/api/src/data/memory.store";
import { ORG_ID } from "../apps/api/src/data/fixtures";
import { PushService, type PushRequest } from "../apps/api/src/push/push.service";
import type { PushProvider } from "../apps/api/src/push/push.provider";
import type { RealtimeGateway } from "../apps/api/src/realtime/realtime.gateway";
import { NotificationsService } from "../apps/api/src/notifications/notifications.service";
import { ConversationsService } from "../apps/api/src/conversations/conversations.service";
import { IngestService } from "../apps/api/src/channels/ingest.service";
import type { RoutingService } from "../apps/api/src/routing/routing.service";
import type { TenantContext } from "../apps/api/src/tenancy/tenant-context";
import type { ConversationSubjectService } from "../apps/api/src/ai/conversation-subject.service";
import { SandboxPolicy } from "../apps/api/src/tenancy/sandbox";
import { runInTenant } from "../apps/api/src/tenancy/tenant-scope";
import { DEFAULT_PUSH_PREFERENCES } from "../packages/schemas/src/index";

let failed = 0;
function ok(label: string, cond: boolean, detail = ""): void {
  if (!cond) failed++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

const NATHAN = "usr_nathan"; // admin, Support and Sales
const JAMES = "usr_james"; // Support
const AMARA = "usr_amara"; // Sales

/** A real PushService over a memory store, recording screens cued and phones pushed. */
function pushRig(store: MemoryStore) {
  const cued: string[] = [];
  const pushed: string[] = [];
  const realtime = {
    emitMessageCue: (ids: string[]) => cued.push(...ids),
    isViewing: async () => false,
    emitNotification: () => {},
  } as unknown as RealtimeGateway;
  const provider = {
    send: async (messages: { to: string }[]) => {
      pushed.push(...messages.map((m) => m.to.replace(/^ExponentPushToken\[|\]$/g, "")));
      return messages.map((m) => ({ ok: true as const, to: m.to, ticketId: "t" }));
    },
  } as unknown as PushProvider;
  return { cued, pushed, svc: new PushService(store, provider, realtime, new SandboxPolicy(store)) };
}

const teamChat = (userIds: string[], extra: Partial<PushRequest> = {}): PushRequest => ({
  userIds,
  kind: "team_chat",
  title: "New chat for Sales team",
  body: "Marta: hello",
  conversationId: "c1",
  ...extra,
});

async function main(): Promise<void> {
  console.log("\nA — the policy\n");
  {
    const store = new MemoryStore();
    for (const u of [NATHAN, JAMES, AMARA]) await store.upsertDevice({ userId: u, pushToken: `ExponentPushToken[${u}]`, platform: "ios" });
    const { svc, cued, pushed } = pushRig(store);
    ok("on by default", DEFAULT_PUSH_PREFERENCES.teamChats === true);
    await runInTenant(ORG_ID, async () => {
      await svc.updatePreferences(JAMES, { teamChats: false });
      await svc.updatePreferences(AMARA, { teamChats: false, teamInbound: true });
      await svc.notifyAndWait(teamChat([NATHAN, JAMES, AMARA]));
    });
    ok("the team's screens chime", cued.includes(NATHAN), cued.join());
    ok("and phones ring", pushed.includes(NATHAN), pushed.join());
    ok("not for someone who switched it off", !cued.includes(JAMES) && !pushed.includes(JAMES));
    ok("but yes for someone who asked for every team message", pushed.includes(AMARA));
    cued.length = 0;
    pushed.length = 0;
    await runInTenant(ORG_ID, () => svc.notifyAndWait(teamChat([NATHAN], { cue: false })));
    ok("a bell row doesn't chime twice", cued.length === 0 && pushed.includes(NATHAN));
  }

  console.log("\nB — a transfer to a team\n");
  {
    const store = new MemoryStore();
    const bell: Array<{ userId: string; type: string; title: string; conversationId?: string | null }> = [];
    const realtime = {
      emitNotification: () => {},
      emitConversationAssigned: () => {},
      emitMessageCue: () => {},
      isViewing: async () => false,
    } as unknown as RealtimeGateway;
    const { svc: push } = pushRig(store);
    const notifications = new NotificationsService(store, realtime, push);
    const created = notifications.create.bind(notifications);
    notifications.create = async (userId, n) => {
      bell.push({ userId, type: n.type, title: n.title, conversationId: n.conversationId });
      await created(userId, n);
    };
    const inert = {} as never;
    const convs = new ConversationsService(store, realtime, inert, inert, notifications, push, inert);

    await runInTenant(ORG_ID, async () => {
      const marta = await store.upsertContactByIdentity({ orgId: ORG_ID, kind: "phone", value: "+447700900333", displayName: "Marta" });
      const { conversation: conv } = await store.findOrCreateOpenConversation({ orgId: ORG_ID, inboxId: "inbox_wa", contact: marta, channel: "whatsapp" });
      await store.assign(conv.id, { assigneeUserId: null, assignedTeamId: "team_support" });

      await convs.assign(conv.id, { assigneeUserId: null, assignedTeamId: "team_sales" }, JAMES);
      ok(
        "James sends it to Sales: Sales hears it in the bell",
        bell.map((b) => b.userId).sort().join() === [AMARA, NATHAN].sort().join(),
        bell.map((b) => b.userId).join(),
      );
      ok("as a transfer naming who and where", bell[0]?.type === "team_transfer" && bell[0]?.title === "James sent a chat to Sales team", bell[0]?.title);
      ok("that opens the chat", bell[0]?.conversationId === conv.id);
      ok("and it lands in their bell list", (await store.listNotifications(AMARA))[0]?.type === "team_transfer");

      bell.length = 0;
      await convs.assign(conv.id, { assigneeUserId: null, assignedTeamId: "team_sales" }, JAMES);
      ok("sending it again to the same team says nothing new", bell.length === 0);

      await convs.assign(conv.id, { assigneeUserId: null, assignedTeamId: "team_support" }, NATHAN);
      ok("whoever moved it isn't told about it", bell.map((b) => b.userId).join() === JAMES, bell.map((b) => b.userId).join());

      bell.length = 0;
      await push.updatePreferences(AMARA, { teamChats: false });
      await convs.assign(conv.id, { assigneeUserId: null, assignedTeamId: "team_sales" }, JAMES);
      ok("switched off means no bell row either", !bell.some((b) => b.userId === AMARA) && bell.some((b) => b.userId === NATHAN));

      bell.length = 0;
      await convs.assign(conv.id, { assigneeUserId: AMARA, assignedTeamId: "team_support" }, NATHAN);
      ok("handed to a person: they're assigned, the team isn't paged", !bell.some((b) => b.type === "team_transfer"));
    });
  }

  console.log("\nC — a new chat waiting in a team's queue\n");
  {
    const store = new MemoryStore();
    const sent: PushRequest[] = [];
    let decision: { assigneeUserId: string | null; assignedTeamId: string | null } = { assigneeUserId: null, assignedTeamId: "team_sales" };
    const ingest = new IngestService(
      store,
      { route: async () => decision } as unknown as RoutingService,
      { emitConversationAssigned() {}, emitMessageCreated() {}, emitConversationUpdated() {} } as unknown as RealtimeGateway,
      { bind() {}, orgId: ORG_ID } as unknown as TenantContext,
      { notify: (r: PushRequest) => sent.push(r) } as unknown as PushService,
      { customerWrote() {}, fieldsChanged: async () => {} } as unknown as ConversationSubjectService,
    );
    const settle = () => new Promise((r) => setTimeout(r, 20));
    await runInTenant(ORG_ID, async () => {
      const chat = await store.createInbox({ orgId: ORG_ID, type: "nestchat", name: "Website", handle: "site", teamIds: ["team_sales"], routingStrategy: "manual" });
      const marta = await store.upsertContactByIdentity({ orgId: ORG_ID, kind: "phone", value: "+447700900111", displayName: "Marta" });
      const first = await ingest.ingestNestChat({ inbox: chat, contact: marta, text: "Hello, is anyone there?" });
      await settle();
      const one = sent.find((r) => r.conversationId === first?.conversationId);
      ok("a new chat goes to the team as a new chat", one?.kind === "team_chat", one?.kind);
      ok("to Sales, not Support", one?.userIds.slice().sort().join() === [AMARA, NATHAN].sort().join(), one?.userIds.join());
      ok("saying whose team and who wrote", one?.title === "New chat for Sales team" && one?.body === "Marta: Hello, is anyone there?", `${one?.title} / ${one?.body}`);

      sent.length = 0;
      await ingest.ingestNestChat({ inbox: chat, contact: marta, text: "Hello?", conversationId: first!.conversationId });
      await settle();
      // The bug: "a colleague took the chat and I still get every message".
      // Nobody has taken this one yet, so it is still the team's news.
      ok("a follow-up nobody has taken yet still reaches the team as theirs", sent.length === 1 && sent[0]?.kind === "team_chat", sent.map((r) => r.kind).join());
      ok("…reading as a message, not a second 'new chat'", sent[0]?.title === "Marta" && sent[0]?.body === "Hello?", `${sent[0]?.title} / ${sent[0]?.body}`);

      sent.length = 0;
      await store.assign(first!.conversationId, { assigneeUserId: AMARA, assignedTeamId: "team_sales" });
      await ingest.ingestNestChat({ inbox: chat, contact: marta, text: "Still there?", conversationId: first!.conversationId });
      await settle();
      ok("once a colleague has it: they hear it as theirs", sent.some((r) => r.kind === "message" && r.userIds.join() === AMARA));
      const rest = sent.find((r) => r.kind !== "message");
      ok("…and the rest of the team only under the every-message setting", rest?.kind === "team_message" && rest.userIds.join() === NATHAN, sent.map((r) => `${r.kind}:${r.userIds.join("+")}`).join(", "));
      ok("…which is off by default", DEFAULT_PUSH_PREFERENCES.teamInbound === false);

      sent.length = 0;
      decision = { assigneeUserId: AMARA, assignedTeamId: "team_sales" };
      const kim = await store.upsertContactByIdentity({ orgId: ORG_ID, kind: "phone", value: "+447700900222", displayName: "Kim" });
      await ingest.ingestNestChat({ inbox: chat, contact: kim, text: "Hi" });
      await settle();
      ok("routed straight to an agent: only the agent", sent.length > 0 && sent.every((r) => r.kind !== "team_chat") && sent.some((r) => r.kind === "message" && r.userIds.join() === AMARA), sent.map((r) => r.kind).join());
    });
  }

  console.log(failed ? `\n${failed} check(s) failed\n` : "\nall team alert checks passed\n");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
