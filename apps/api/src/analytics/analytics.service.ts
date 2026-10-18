import { Injectable } from "@nestjs/common";
import type {
  AnalyticsQueryInput,
  AnalyticsRange,
  AnalyticsResult,
  ChannelType,
  ConversationStatus,
  Priority,
} from "@ding/schemas";
import { Store, type AnalyticsConvo, type AnalyticsQuery } from "../data/store";

const DAYS: Record<AnalyticsRange, number> = { "7d": 7, "30d": 30, "90d": 90, "12m": 365 };
const DAY_MS = 86_400_000;
const CHANNEL_ORDER: ChannelType[] = ["whatsapp", "whatsapp_group", "email", "nestchat", "sms"];
const STATUS_ORDER: ConversationStatus[] = ["open", "pending", "snoozed", "closed"];
const PRIORITY_ORDER: Priority[] = ["urgent", "high", "normal", "low"];

/** First-response distribution buckets (upper bound in ms; last is open-ended). */
const RESPONSE_BUCKETS: Array<{ label: string; maxMs: number }> = [
  { label: "< 5 min", maxMs: 5 * 60_000 },
  { label: "5–15 min", maxMs: 15 * 60_000 },
  { label: "15–60 min", maxMs: 60 * 60_000 },
  { label: "1–4 h", maxMs: 4 * 3_600_000 },
  { label: "4–24 h", maxMs: 24 * 3_600_000 },
  { label: "> 24 h", maxMs: Infinity },
];

function utcDate(iso: string): string {
  return iso.slice(0, 10); // ISO strings are already UTC — the date part is the day
}
function avg(xs: number[]): number | null {
  return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
}
function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}
/** The first-response time (ms) of a conversation, or null when it doesn't apply
 *  (no inbound, no reply, or an agent-initiated thread where the reply precedes
 *  the first customer message). */
function responseMs(c: AnalyticsConvo): number | null {
  if (!c.firstInboundAt || !c.firstReplyAt) return null;
  const d = new Date(c.firstReplyAt).getTime() - new Date(c.firstInboundAt).getTime();
  return d >= 0 ? d : null;
}

/**
 * Turns the store's raw analytics bundle into the dashboard payload: KPI cards
 * (with previous-period deltas), time series, breakdowns by channel/status/team/
 * label/priority, a per-agent leaderboard, an activity heatmap and a
 * first-response histogram. All aggregation lives here so both stores stay thin.
 */
@Injectable()
export class AnalyticsService {
  constructor(private readonly store: Store) {}

  async dashboard(orgId: string, input: AnalyticsQueryInput): Promise<AnalyticsResult> {
    const days = DAYS[input.range];
    const to = new Date();
    const from = new Date(to.getTime() - days * DAY_MS);
    const prevTo = from;
    const prevFrom = new Date(from.getTime() - days * DAY_MS);

    const filter = {
      channel: input.channel === "all" ? null : input.channel,
      teamId: input.teamId === "all" ? null : input.teamId,
      agentUserId: input.agentUserId === "all" ? null : input.agentUserId,
    };
    const q: AnalyticsQuery = { from: from.toISOString(), to: to.toISOString(), ...filter };
    const prevQ: AnalyticsQuery = { from: prevFrom.toISOString(), to: prevTo.toISOString(), ...filter };

    const [cur, prev, members, teams, labels] = await Promise.all([
      this.store.getAnalytics(orgId, q),
      this.store.getAnalytics(orgId, prevQ),
      this.store.listMembers(),
      this.store.listTeams(),
      this.store.listLabels(orgId),
    ]);

    const nonInternal = cur.messages.filter((m) => !m.internal);
    const inbound = nonInternal.filter((m) => m.direction === "in").length;
    const outbound = nonInternal.filter((m) => m.direction === "out").length;

    // First-response times across answered conversations.
    const responded = cur.conversations.filter((c) => responseMs(c) !== null);
    const responseTimes = responded.map((c) => responseMs(c) as number);

    const convCount = cur.conversations.length;
    const msgCount = inbound + outbound;
    const resolved = cur.conversations.filter((c) => c.status === "closed").length;
    const totalConvMsgs = cur.conversations.reduce((a, c) => a + c.inbound + c.outbound, 0);
    const activeAgents = new Set(
      nonInternal.filter((m) => m.direction === "out" && m.authorUserId).map((m) => m.authorUserId as string),
    ).size;

    // Previous period (only the metrics the KPI deltas need).
    const prevNonInternal = prev.messages.filter((m) => !m.internal);
    const prevResponseTimes = prev.conversations.map(responseMs).filter((x): x is number => x !== null);

    // ── Daily series (continuous, one point per day in the window) ──
    const dayMap = new Map<string, { conversations: number; inbound: number; outbound: number }>();
    for (let t = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()); t < to.getTime(); t += DAY_MS) {
      dayMap.set(new Date(t).toISOString().slice(0, 10), { conversations: 0, inbound: 0, outbound: 0 });
    }
    for (const c of cur.conversations) {
      const b = dayMap.get(utcDate(c.createdAt));
      if (b) b.conversations++;
    }
    for (const m of nonInternal) {
      const b = dayMap.get(utcDate(m.createdAt));
      if (!b) continue;
      if (m.direction === "in") b.inbound++;
      else b.outbound++;
    }
    const daily = [...dayMap.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([date, v]) => ({ date, ...v }));

    // ── By channel ──
    const chConv = new Map<ChannelType, number>();
    const chMsg = new Map<ChannelType, number>();
    for (const c of cur.conversations) chConv.set(c.channel, (chConv.get(c.channel) ?? 0) + 1);
    for (const m of nonInternal) chMsg.set(m.channel, (chMsg.get(m.channel) ?? 0) + 1);
    const byChannel = CHANNEL_ORDER.filter((ch) => (chConv.get(ch) ?? 0) + (chMsg.get(ch) ?? 0) > 0).map((channel) => ({
      channel,
      conversations: chConv.get(channel) ?? 0,
      messages: chMsg.get(channel) ?? 0,
    }));

    // ── By status / priority ──
    const statusCount = new Map<ConversationStatus, number>();
    const priorityCount = new Map<Priority, number>();
    for (const c of cur.conversations) {
      statusCount.set(c.status, (statusCount.get(c.status) ?? 0) + 1);
      priorityCount.set(c.priority, (priorityCount.get(c.priority) ?? 0) + 1);
    }
    const byStatus = STATUS_ORDER.map((status) => ({ status, count: statusCount.get(status) ?? 0 }));
    const byPriority = PRIORITY_ORDER.map((priority) => ({ priority, count: priorityCount.get(priority) ?? 0 }));

    // ── By team ──
    const teamName = new Map(teams.map((t) => [t.id, t.name]));
    const teamCount = new Map<string | null, number>();
    for (const c of cur.conversations) teamCount.set(c.assignedTeamId, (teamCount.get(c.assignedTeamId) ?? 0) + 1);
    const byTeam = [...teamCount.entries()]
      .map(([teamId, conversations]) => ({
        teamId,
        name: teamId ? teamName.get(teamId) ?? "Unknown team" : "Unassigned",
        conversations,
      }))
      .sort((a, b) => b.conversations - a.conversations);

    // ── By label ──
    const labelCount = new Map<string, number>();
    for (const c of cur.conversations) for (const id of c.labelIds) labelCount.set(id, (labelCount.get(id) ?? 0) + 1);
    const byLabel = labels
      .map((l) => ({ labelId: l.id, name: l.name, color: l.color, conversations: labelCount.get(l.id) ?? 0 }))
      .filter((l) => l.conversations > 0)
      .sort((a, b) => b.conversations - a.conversations);

    // ── Agent leaderboard ──
    const replyByAgent = new Map<string, number>();
    for (const m of nonInternal) {
      if (m.direction === "out" && m.authorUserId) replyByAgent.set(m.authorUserId, (replyByAgent.get(m.authorUserId) ?? 0) + 1);
    }
    const convByAgent = new Map<string, number>();
    const respByAgent = new Map<string, number[]>();
    for (const c of cur.conversations) {
      if (c.assigneeUserId) convByAgent.set(c.assigneeUserId, (convByAgent.get(c.assigneeUserId) ?? 0) + 1);
      const ms = responseMs(c);
      if (ms !== null && c.firstReplyUserId) {
        const arr = respByAgent.get(c.firstReplyUserId) ?? [];
        arr.push(ms);
        respByAgent.set(c.firstReplyUserId, arr);
      }
    }
    const agents = members
      .map((m) => ({
        userId: m.user.id,
        name: m.user.name,
        avatarColor: m.user.avatarColor ?? null,
        conversations: convByAgent.get(m.user.id) ?? 0,
        replies: replyByAgent.get(m.user.id) ?? 0,
        avgFirstResponseMs: avg(respByAgent.get(m.user.id) ?? []),
      }))
      .filter((a) => a.replies > 0 || a.conversations > 0)
      .sort((a, b) => b.replies - a.replies || b.conversations - a.conversations);

    // ── Heatmap: weekday (Mon=0) × hour, message volume ──
    const heatmap = new Array<number>(7 * 24).fill(0);
    for (const m of nonInternal) {
      const d = new Date(m.createdAt);
      const weekday = (d.getUTCDay() + 6) % 7; // Sun=0 → Mon=0
      heatmap[weekday * 24 + d.getUTCHours()]++;
    }

    // ── First-response histogram ──
    const responseBuckets = RESPONSE_BUCKETS.map((b) => ({ label: b.label, count: 0 }));
    for (const ms of responseTimes) {
      const idx = RESPONSE_BUCKETS.findIndex((b) => ms < b.maxMs);
      responseBuckets[idx === -1 ? responseBuckets.length - 1 : idx].count++;
    }

    return {
      range: { key: input.range, from: from.toISOString(), to: to.toISOString(), days },
      filters: { channel: input.channel, teamId: input.teamId, agentUserId: input.agentUserId },
      kpis: {
        conversations: convCount,
        messages: msgCount,
        inbound,
        outbound,
        newContacts: cur.newContacts,
        activeAgents,
        avgFirstResponseMs: avg(responseTimes),
        medianFirstResponseMs: median(responseTimes),
        resolved,
        resolutionRate: convCount ? resolved / convCount : 0,
        responseRate: convCount ? responded.length / convCount : 0,
        avgMessagesPerConversation: convCount ? totalConvMsgs / convCount : 0,
        prev: {
          conversations: prev.conversations.length,
          messages: prevNonInternal.length,
          newContacts: prev.newContacts,
          avgFirstResponseMs: avg(prevResponseTimes),
        },
      },
      snapshot: cur.snapshot,
      daily,
      byChannel,
      byStatus,
      byPriority,
      byTeam,
      byLabel,
      agents,
      heatmap,
      responseBuckets,
    };
  }
}
