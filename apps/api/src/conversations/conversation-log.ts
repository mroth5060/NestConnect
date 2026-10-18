import { Logger } from "@nestjs/common";
import type { ConversationEvent, ConversationEventType, Team, User } from "@ding/schemas";
import type { ConversationEventRow, ConversationState, Store } from "../data/store";

/**
 * The conversation log — everything that happens to a conversation besides its
 * messages. See docs/conversation-log.md.
 *
 * Two ways in. `record` writes one entry for something only the caller knows
 * the meaning of (routed, and why; labels; an organisation). `track` wraps a
 * change and writes whatever it did to status, assignment and priority, by
 * comparing before and after — so a reply that also claims the chat, or a
 * customer message that reopens it, is logged as such without every place that
 * can cause it having to remember to.
 *
 * Logging never fails the change it describes: a log write that errors is
 * warned about and dropped.
 */

export type LogActor = { kind: "agent"; userId: string } | { kind: "customer"; name: string } | { kind: "system" };
export const SYSTEM: LogActor = { kind: "system" };
export const agent = (userId: string): LogActor => ({ kind: "agent", userId });
export const customer = (name: string): LogActor => ({ kind: "customer", name });

const logger = new Logger("ConversationLog");

export class ConversationLog {
  constructor(private readonly store: Store) {}

  async record(conversationId: string, type: ConversationEventType, actor: LogActor, data: Record<string, unknown> = {}): Promise<void> {
    try {
      await this.store.logConversationEvent(conversationId, {
        type,
        actorKind: actor.kind,
        actorUserId: actor.kind === "agent" ? actor.userId : null,
        data: actor.kind === "customer" ? { customerName: actor.name, ...data } : data,
      });
    } catch (err) {
      logger.warn(`Couldn't log ${type} on ${conversationId}: ${String(err)}`);
    }
  }

  /** Run a change, then log what it did to status, assignment and priority. */
  async track<T>(conversationId: string, actor: LogActor, change: () => Promise<T>, extra: Record<string, unknown> = {}): Promise<T> {
    const before = await this.state(conversationId);
    const out = await change();
    const after = await this.state(conversationId);
    if (before && after) await this.diff(conversationId, actor, before, after, extra);
    return out;
  }

  private async state(id: string): Promise<ConversationState | undefined> {
    try {
      return await this.store.conversationState(id);
    } catch {
      return undefined;
    }
  }

  private async diff(id: string, actor: LogActor, b: ConversationState, a: ConversationState, extra: Record<string, unknown>): Promise<void> {
    if (b.status !== a.status) {
      if (a.status === "closed") await this.record(id, "closed", actor, extra);
      else if (a.status === "snoozed") await this.record(id, "snoozed", actor, { until: a.snoozedUntil, ...extra });
      else if (b.status === "snoozed" && actor.kind === "system") await this.record(id, "woke", actor, extra);
      else await this.record(id, "reopened", actor, { from: b.status, to: a.status, ...extra });
    } else if (a.status === "snoozed" && a.snoozedUntil !== b.snoozedUntil) {
      await this.record(id, "snoozed", actor, { until: a.snoozedUntil, ...extra });
    }

    if (a.assigneeUserId !== b.assigneeUserId) {
      if (a.assigneeUserId) {
        await this.record(id, "assigned", actor, {
          toUserId: a.assigneeUserId,
          fromUserId: b.assigneeUserId,
          ...(a.assignedTeamId !== b.assignedTeamId ? { toTeamId: a.assignedTeamId } : {}),
          ...extra,
        });
      } else {
        await this.record(id, "unassigned", actor, { fromUserId: b.assigneeUserId, ...extra });
      }
    } else if (a.assignedTeamId !== b.assignedTeamId) {
      await this.record(id, "team_changed", actor, { toTeamId: a.assignedTeamId, fromTeamId: b.assignedTeamId, ...extra });
    }

    if (a.priority !== b.priority) await this.record(id, "priority", actor, { from: b.priority, to: a.priority });
  }
}

/* ------------------------------- reading it ------------------------------- */

const CHANNEL: Record<string, string> = {
  whatsapp: "WhatsApp",
  whatsapp_group: "a WhatsApp group",
  email: "email",
  nestchat: "live chat",
  sms: "SMS",
};
const PRIORITY: Record<string, string> = { low: "Low", normal: "Normal", high: "High", urgent: "Urgent" };
const STATUS: Record<string, string> = { open: "Open", pending: "Pending", snoozed: "Snoozed", closed: "Closed" };
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const quote = (v: unknown): string => (str(v) ? `“${v}”` : "—");

/**
 * Entries as people read them: names resolved now (so a renamed teammate reads
 * by their current name), a sentence, and a second line where there is one.
 */
export function renderConversationEvents(
  rows: ConversationEventRow[],
  people: Map<string, Pick<User, "id" | "name" | "avatarColor" | "avatarUrl">>,
  teams: Map<string, Pick<Team, "id" | "name">>,
): ConversationEvent[] {
  const person = (id: unknown) => (str(id) ? (people.get(id as string)?.name ?? "a former teammate") : null);
  const team = (id: unknown) => (str(id) ? (teams.get(id as string)?.name ?? "a team that's since been deleted") : null);

  return rows.map((r) => {
    const d = r.data;
    const u = r.actorUserId ? people.get(r.actorUserId) : undefined;
    const actor: ConversationEvent["actor"] =
      r.actorKind === "agent"
        ? { kind: "agent", id: r.actorUserId ?? "", name: u?.name ?? "A former teammate", avatarColor: u?.avatarColor ?? null, avatarUrl: u?.avatarUrl ?? null }
        : r.actorKind === "customer"
          ? { kind: "customer", name: str(d.customerName) ?? "The customer" }
          : { kind: "system" };
    const who = actor.kind === "agent" ? actor.name : actor.kind === "customer" ? actor.name : "NestConnect";
    let text = "";
    let detail: string | null = null;
    let until: string | null = null;

    switch (r.type) {
      case "created": {
        const on = CHANNEL[str(d.channel) ?? ""] ?? "a channel";
        text = `${who} started the conversation on ${on}`;
        break;
      }
      case "routed": {
        const t = team(d.teamId);
        const p = person(d.userId);
        text = t || p ? `Routed to ${[t, p].filter(Boolean).join(" · ")}` : "Left in the queue — no team to route to";
        const reason = str(d.reason);
        detail =
          reason === "menu"
            ? `They picked ${quote(d.option)} in the chat menu`
            : reason === "outreach"
              ? `Answering ${p ?? "an agent"}'s message`
              : reason === "contact"
              ? "The customer's own routing"
              : reason === "organisation"
                ? `Via their organisation, ${str(d.organisation) ?? "since removed"}`
                : reason === "channel"
                  ? "The channel's own routing"
                  : null;
        break;
      }
      case "assigned": {
        const to = person(d.toUserId) ?? "someone";
        if (actor.kind === "agent" && actor.id === d.toUserId) text = `${who} took the conversation`;
        else if (actor.kind === "agent") text = `${who} assigned it to ${to}`;
        else text = `Assigned to ${to}`;
        const parts = [d.claimed ? "By replying" : null, str(d.toTeamId) ? `In ${team(d.toTeamId)}` : null, str(d.fromUserId) ? `Was ${person(d.fromUserId)}` : null];
        detail = parts.filter(Boolean).join(" · ") || null;
        break;
      }
      case "unassigned":
        text = actor.kind === "customer" ? "Unassigned — the customer wrote back to a closed conversation" : `${who} unassigned it`;
        detail = str(d.fromUserId) ? `Was ${person(d.fromUserId)}` : null;
        break;
      case "team_changed":
        text = str(d.toTeamId) ? `${actor.kind === "agent" ? `${who} moved it` : "Moved"} to ${team(d.toTeamId)}` : `${who} took it out of its team`;
        detail = str(d.fromTeamId) ? `From ${team(d.fromTeamId)}` : null;
        break;
      case "closed":
        text = `${who} closed the conversation`;
        break;
      case "reopened":
        if (str(d.to) === "pending") text = `${who} marked it as Pending`;
        else if (actor.kind === "customer") text = `Reopened — ${who} wrote back`;
        else if (d.byReply) text = `${who} reopened it by replying`;
        else text = `${who} reopened the conversation`;
        detail = str(d.from) ? `Was ${STATUS[d.from as string] ?? d.from}` : null;
        break;
      case "snoozed":
        text = `${who} snoozed it`;
        until = str(d.until);
        break;
      case "woke":
        text = "Back from snooze";
        break;
      case "priority":
        text = `${who} set the priority to ${PRIORITY[str(d.to) ?? ""] ?? d.to}`;
        detail = str(d.from) ? `Was ${PRIORITY[d.from as string] ?? d.from}` : null;
        break;
      case "labels": {
        const added = (Array.isArray(d.added) ? d.added : []) as string[];
        const removed = (Array.isArray(d.removed) ? d.removed : []) as string[];
        if (d.byChannel && added.length === 1) {
          text = `Labelled “${added[0]}”`;
          detail = "Every conversation on this channel is";
        } else if (added.length === 1 && !removed.length) text = `${who} added the label “${added[0]}”`;
        else if (removed.length === 1 && !added.length) text = `${who} removed the label “${removed[0]}”`;
        else {
          text = `${who} changed the labels`;
          detail = [added.length ? `Added ${added.join(", ")}` : null, removed.length ? `Removed ${removed.join(", ")}` : null].filter(Boolean).join(" · ");
        }
        break;
      }
      case "subject":
        text = actor.kind === "system" ? `Subject set to ${quote(d.to)}` : `${who} changed the subject`;
        detail = actor.kind === "system" ? null : `${quote(d.from)} → ${quote(d.to)}`;
        break;
      case "organisation":
        text = str(d.name) ? `${who} filed it under ${d.name}` : `${who} removed its organisation`;
        detail = str(d.fromName) ? `Was ${d.fromName}` : null;
        break;
      case "fields": {
        const changes = (Array.isArray(d.changes) ? d.changes : []) as Array<{ label?: string; from?: string | null; to?: string | null }>;
        text = changes.length === 1 ? `${who} updated ${changes[0]!.label ?? "a field"}` : `${who} updated ${changes.length} fields`;
        detail = changes.map((c) => `${c.label ?? "Field"}: ${c.from || "—"} → ${c.to || "—"}`).join(" · ") || null;
        break;
      }
      case "message_failed":
        text = "A message couldn't be sent";
        detail = [str(d.reason), str(d.preview) ? quote(d.preview) : null].filter(Boolean).join(" · ") || null;
        break;
      case "message_retried":
        text = `${who} retried a message that failed`;
        detail = str(d.preview) ? quote(d.preview) : null;
        break;
      case "shared_to_chat": {
        // A direct chat is named by the person; a group or team by itself.
        const where = str(d.withUserId) ? person(d.withUserId) : str(d.roomName);
        text = `${who} shared it with ${where ?? "a team chat"}`;
        detail = [d.messageId ? "One message" : null, str(d.line) ? quote(d.line) : null].filter(Boolean).join(" · ") || null;
        break;
      }
    }
    return { id: r.id, type: r.type, at: r.createdAt, actor, text, detail, until };
  });
}
