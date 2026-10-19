import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  fieldsForInbox,
  GROUP_MAX_MEMBERS,
  type ChannelType,
  type Contact,
  type Conversation,
  type ConversationWithMessages,
  type CustomField,
  type CustomFieldValue,
  type Priority,
} from "@ding/schemas";
import {
  useContact,
  useContacts,
  useConversation,
  useCustomFields,
  useCustomFieldValues,
  usePeople,
  useRemoveParticipant,
  useResetGroupInvite,
  useSession,
  useSetCustomFieldValues,
  useSetPriority,
  useTeams,
  useUpdateContact,
  useInboxes,
  startedAlongside,
} from "../hooks";
import { useQueryClient } from "@tanstack/react-query";
import { relativeTime, slaCountdown } from "../lib/format";
import { Avatar } from "./Avatar";
import { api } from "../lib/api";
import { TagEditor } from "./TagEditor";
import { channelMeta, CheckIcon, ChevronDown, ChevronRight, PhoneIcon, MailIcon, ProfileIcon, SnoozeIcon, XIcon } from "../lib/icons";
import { OrganisationBlock } from "./organisations/OrganisationPanel";

/** The NestChat mark, for the "website visitor" chip below the customer's name. */
const NestChatChip = channelMeta("nestchat").Glyph;

interface Props {
  conversationId: string | null;
  onToast: (msg: string) => void;
  onClose?: () => void;
  onOpenConversation?: (id: string) => void;
  onOpenProfile?: (contactId: string) => void;
  /** Open an organisation's full profile. */
  onOpenOrganisation?: (accountId: string) => void;
}

/** Section header used across the panel blocks. */
function Block({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <div className="psec">
      <div className="t">
        {title}
        {count != null && count > 0 && <span className="count">{count}</span>}
      </div>
      {children}
    </div>
  );
}

/**
 * One custom field, read and written in place.
 *
 * Editable from here rather than behind a form, because of when it gets typed:
 * an agent has the customer on the phone reading out an order number, and every
 * click between hearing it and recording it is a click that doesn't happen.
 *
 * Saves on blur as well as on Enter. Somebody who types a number and then
 * clicks straight into the reply box has finished with the field — losing it
 * there would be losing exactly the thing they were told to write down.
 */
function FieldRow({
  field,
  value,
  onSave,
}: {
  field: CustomField;
  value: string;
  onSave: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  // Someone else's edit, or a value the SDK has just set, should land — but not
  // over the top of what this agent is in the middle of typing.
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  const commit = () => {
    setEditing(false);
    if (draft.trim() !== value) onSave(draft.trim());
  };

  if (field.type === "select") {
    return (
      <div className="cfrow">
        <span className="cfrow__l">{field.label}</span>
        <select
          className="cfrow__v"
          value={value}
          onChange={(e) => onSave(e.target.value)}
        >
          <option value="">—</option>
          {field.options.map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
      </div>
    );
  }

  return (
    <div className="cfrow">
      <span className="cfrow__l">{field.label}</span>
      <input
        className="cfrow__v"
        value={draft}
        type={field.type === "number" ? "text" : field.type === "date" ? "date" : "text"}
        // Not `type="number"`: an order number is a reference, not a quantity,
        // and a numeric input would strip a leading zero and offer a spinner
        // for incrementing something nobody ever increments.
        inputMode={field.type === "number" ? "numeric" : undefined}
        placeholder="—"
        onFocus={() => setEditing(true)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") { setDraft(value); setEditing(false); e.currentTarget.blur(); }
        }}
      />
    </div>
  );
}

/**
 * The workspace's own facts about this thread and this customer.
 *
 * Both kinds in one block, conversation first, because the distinction matters
 * to whoever *defined* the field and not to the agent reading it — they want
 * the order number, and which table it lives in is our problem.
 *
 * Shown only when the channel has fields to show. A panel section that is
 * always there and always empty trains people to stop looking at it.
 */
function CustomFieldsBlock({
  conv,
  onToast,
}: {
  conv: ConversationWithMessages;
  onToast: (m: string) => void;
}) {
  const fields = useCustomFields();
  const convValues = useCustomFieldValues("conversation", conv.id);
  const contactValues = useCustomFieldValues("contact", conv.contact.id);
  const save = useSetCustomFieldValues();

  const all = fields.data ?? [];
  const forHere = fieldsForInbox(all, conv.inboxId);
  const convFields = forHere.filter((f) => f.entity === "conversation");
  const contactFields = forHere.filter((f) => f.entity === "contact");
  if (!convFields.length && !contactFields.length) return null;

  const valueOf = (list: CustomFieldValue[] | undefined, key: string) =>
    list?.find((v) => v.key === key)?.value ?? "";

  const write = (entity: "conversation" | "contact", entityId: string, key: string, next: string) =>
    save.mutate(
      { entity, entityId, values: { [key]: next || null } },
      {
        onError: (err) =>
          onToast(err instanceof Error ? err.message : "Couldn’t save that"),
      },
    );

  return (
    <Block title="Details">
      {convFields.map((f) => (
        <FieldRow
          key={f.id}
          field={f}
          value={valueOf(convValues.data, f.key)}
          onSave={(next) => write("conversation", conv.id, f.key, next)}
        />
      ))}
      {contactFields.map((f) => (
        <FieldRow
          key={f.id}
          field={f}
          value={valueOf(contactValues.data, f.key)}
          onSave={(next) => write("contact", conv.contact.id, f.key, next)}
        />
      ))}
      {contactFields.length > 0 && convFields.length > 0 && (
        <p className="capnote">
          The last {contactFields.length === 1 ? "one follows" : "few follow"} the customer, not this
          chat.
        </p>
      )}
    </Block>
  );
}

/** Editable customer tags, saved to the contact as you add/remove them. */
function CustomerTags({ contact, onToast }: { contact: Contact; onToast: (m: string) => void }) {
  const contacts = useContacts();
  const update = useUpdateContact();
  const [tags, setTags] = useState<string[]>(contact.tags ?? []);
  useEffect(() => {
    setTags(contact.tags ?? []);
  }, [contact.id, (contact.tags ?? []).join("")]);

  const suggestions = useMemo(() => {
    const set = new Set<string>();
    for (const c of contacts.data ?? []) for (const t of c.tags ?? []) set.add(t);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [contacts.data]);

  const save = (next: string[]) => {
    setTags(next);
    update.mutate(
      { id: contact.id, input: { tags: next } },
      { onError: () => onToast("Couldn't save tags") },
    );
  };

  return (
    <Block title="Tags">
      <TagEditor tags={tags} suggestions={suggestions} onChange={save} label="" />
    </Block>
  );
}

/** How many of a customer's threads the sidebar lists before "Show all". */
const RECENT_CONVERSATIONS = 5;

/** This customer's other threads, newest first — click to jump straight to one.
 *  The five most recent by default: a regular with a year of chats otherwise
 *  pushes everything below it off the bottom of the panel. */
function RecentConversations({
  contactId,
  currentId,
  onOpen,
}: {
  contactId: string;
  currentId: string | null;
  onOpen?: (id: string) => void;
}) {
  const detail = useContact(contactId);
  const convos: Conversation[] = detail.data?.conversations ?? [];
  const [showAll, setShowAll] = useState(false);
  // Another customer starts collapsed again.
  useEffect(() => setShowAll(false), [contactId]);
  const shown = showAll ? convos : convos.slice(0, RECENT_CONVERSATIONS);
  const hidden = convos.length - RECENT_CONVERSATIONS;

  return (
    <Block title="Recent conversations" count={convos.length}>
      {convos.length === 0 ? (
        <p className="custconvs__empty">{detail.isLoading ? "Loading…" : "No other conversations."}</p>
      ) : (
        <div className="custconvs">
          {shown.map((c) => {
            const cm = channelMeta(c.channel);
            const Glyph = cm.Glyph;
            const active = c.id === currentId;
            return (
              <button
                className={"custconv" + (active ? " is-active" : "")}
                key={c.id}
                onClick={() => !active && onOpen?.(c.id)}
                title={active ? "Current conversation" : "Open conversation"}
              >
                <span className="custconv__ic" style={{ background: cm.color }}>
                  <Glyph />
                </span>
                <span className="custconv__body">
                  <b>{c.subject || cm.label}</b>
                  <small>{c.preview || "No messages"}</small>
                </span>
                <span className={"custconv__st st-" + c.status}>{active ? "here" : c.status}</span>
                <span className="custconv__t">{relativeTime(c.lastActivityAt)}</span>
              </button>
            );
          })}
          {hidden > 0 && (
            <button type="button" className="custconvs__more" onClick={() => setShowAll((v) => !v)}>
              {showAll ? "Show fewer" : `Show all ${convos.length}`}
            </button>
          )}
        </div>
      )}
    </Block>
  );
}

/** At-a-glance counts for this customer across all their conversations. */
function StatsBlock({ contactId }: { contactId: string }) {
  const detail = useContact(contactId);
  const convos = detail.data?.conversations ?? [];
  const open = convos.filter((c) => c.status === "open" || c.status === "pending").length;
  const closed = convos.filter((c) => c.status === "closed").length;
  const tiles: [number, string][] = [
    [convos.length, "Threads"],
    [open, "Open"],
    [closed, "Closed"],
  ];
  return (
    <div className="cstats">
      {tiles.map(([n, l]) => (
        <div className="cstat" key={l}>
          <div className="cstat__n">{n}</div>
          <div className="cstat__l">{l}</div>
        </div>
      ))}
    </div>
  );
}

/** The channels this customer can be reached on. Each is a switch: clicking one
 *  opens their thread on that channel (starting one if there isn't yet). */
function ChannelsBlock({
  contact,
  activeChannel,
  onSwitch,
}: {
  contact: Contact;
  activeChannel: ChannelType;
  onSwitch: (channel: "whatsapp" | "email" | "sms") => Promise<void>;
}) {
  const [pending, setPending] = useState<string | null>(null);
  // A phone number reaches WhatsApp and SMS alike, each only where the
  // workspace has a channel of that kind to send from. A number is not a
  // WhatsApp account, so having one doesn't put WhatsApp on the list by itself.
  const inboxes = useInboxes().data ?? [];
  const hasWhatsApp = inboxes.some((i) => i.type === "whatsapp");
  const hasSms = inboxes.some((i) => i.type === "sms");
  const rows: { type: "whatsapp" | "email" | "sms"; value: string }[] = [];
  if (contact.phone && hasWhatsApp) rows.push({ type: "whatsapp", value: contact.phone });
  if (contact.phone && hasSms) rows.push({ type: "sms", value: contact.phone });
  if (contact.email) rows.push({ type: "email", value: contact.email });

  return (
    <Block title="Reach on">
      {rows.length === 0 ? (
        <p className="custconvs__empty">No phone or email on file.</p>
      ) : (
        <div className="chanrows">
          {rows.map((r) => {
            const cm = channelMeta(r.type);
            const Glyph = cm.Glyph;
            const active = activeChannel === r.type;
            const busy = pending === r.type;
            return (
              <button
                type="button"
                className={"chanrow" + (active ? " chanrow--active" : "")}
                key={r.type}
                disabled={active || busy}
                title={active ? "Current channel" : `Message on ${cm.label}`}
                onClick={
                  active
                    ? undefined
                    : async () => {
                        setPending(r.type);
                        try {
                          await onSwitch(r.type);
                        } finally {
                          setPending(null);
                        }
                      }
                }
              >
                <span className="chanrow__ic" style={{ background: cm.color }}>
                  <Glyph />
                </span>
                <span className="chanrow__m">
                  <b>{cm.label}</b>
                  <small>{r.value}</small>
                </span>
                {active ? (
                  <span className="chanrow__badge">Active</span>
                ) : busy ? (
                  <span className="chanrow__badge">Opening…</span>
                ) : (
                  <span className="chanrow__go" aria-hidden="true"><ChevronRight /></span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </Block>
  );
}

/** Colour + label for each priority level, used by the pill and its menu. */
const PRIO: Record<Priority, { label: string; dot: string; bg: string; fg: string }> = {
  urgent: { label: "Urgent", dot: "var(--danger)", bg: "var(--danger-tint)", fg: "var(--danger)" },
  high: { label: "High", dot: "#E68A00", bg: "var(--amber-tint)", fg: "#B36B00" },
  normal: { label: "Normal", dot: "var(--text-muted)", bg: "var(--surface-2)", fg: "var(--text-muted)" },
  low: { label: "Low", dot: "var(--text-faint)", bg: "var(--surface-2)", fg: "var(--text-faint)" },
};
const PRIO_ORDER: Priority[] = ["urgent", "high", "normal", "low"];

/** The priority pill, now a dropdown to set the conversation's priority. */
function PriorityControl({ conv, onToast }: { conv: Conversation; onToast: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const setPriority = useSetPriority();
  const cur = PRIO[conv.priority];
  const pick = (v: Priority) => {
    setOpen(false);
    if (v === conv.priority) return;
    setPriority.mutate(
      { id: conv.id, priority: v },
      { onSuccess: () => onToast(`Priority set to ${PRIO[v].label.toLowerCase()}`), onError: () => onToast("Couldn't set priority") },
    );
  };
  return (
    <span className="prioctl">
      <button
        type="button"
        className="prio prio-btn"
        style={{ background: cur.bg, color: cur.fg }}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {cur.label}
        <ChevronDown />
      </button>
      {open && (
        <>
          <div className="prio-scrim" onClick={() => setOpen(false)} />
          <div className="priomenu" role="menu">
            {PRIO_ORDER.map((v) => (
              <button
                key={v}
                type="button"
                role="menuitem"
                className={"priomenu__it" + (conv.priority === v ? " on" : "")}
                onClick={() => pick(v)}
              >
                <span className="pdot" style={{ background: PRIO[v].dot }} />
                {PRIO[v].label}
                {conv.priority === v && <CheckIcon />}
              </button>
            ))}
          </div>
        </>
      )}
    </span>
  );
}

function AssignmentBlock({
  conv,
  teamName,
  onToast,
}: {
  conv: Conversation;
  teamName: (id: string) => string;
  onToast: (m: string) => void;
}) {
  const { data: session } = useSession();
  const assigned = !!conv.assigneeUserId;
  const assignee = assigned
    ? conv.assigneeUserId === session?.user.id
      ? "You"
      : conv.assigneeName ?? "Assigned"
    : "Unassigned";
  const team = (conv.assignedTeamId && teamName(conv.assignedTeamId)) || null;
  const STATUS: Record<string, string> = { open: "Open", pending: "Pending", snoozed: "Snoozed", closed: "Closed" };
  const statusOpen = conv.status === "open" || conv.status === "pending";
  return (
    <Block title="Assignment">
      <div className="pcard">
        <div className="kv">
          <span className="k">Status</span>
          <span className="v">
            <span className={"cpill " + (statusOpen ? "cpill--open" : "cpill--closed")}>
              <span className="cdot" />
              {STATUS[conv.status] ?? conv.status}
            </span>
          </span>
        </div>
        <div className="kv">
          <span className="k">Assignee</span>
          <span className="v">
            {assigned ? (
              <>
                <Avatar name={assignee} className="cmini" /> {assignee}
              </>
            ) : (
              <span className="cmuted">Unassigned</span>
            )}
          </span>
        </div>
        <div className="kv">
          <span className="k">Team</span>
          <span className="v">
            {team ? (
              <span className="cteam"><span className="csq" style={{ background: "var(--brand)" }} />{team}</span>
            ) : (
              <span className="cmuted">{assigned ? "—" : "In queue"}</span>
            )}
          </span>
        </div>
        <div className="kv">
          <span className="k">Priority</span>
          <span className="v">
            <PriorityControl conv={conv} onToast={onToast} />
          </span>
        </div>
      </div>
    </Block>
  );
}

function SlaBlock({ iso, now }: { iso: string; now: number }) {
  return (
    <Block title="First response">
      <div className="csla">
        <span className="csla__ic" aria-hidden="true">
          <SnoozeIcon />
        </span>
        <span className="csla__b">
          <small>Due in</small>
          <b>{slaCountdown(iso, now)}</b>
        </span>
      </div>
    </Block>
  );
}

/** Pin a customer to a team/person so their future conversations auto-route. */
function RoutingBlock({ contact, isGroup, onToast }: { contact: Contact; isGroup: boolean; onToast: (m: string) => void }) {
  const teams = useTeams();
  const people = usePeople();
  const update = useUpdateContact();
  const [teamId, setTeamId] = useState(contact.ownerTeamId ?? "");
  const [userId, setUserId] = useState(contact.ownerUserId ?? "");
  useEffect(() => {
    setTeamId(contact.ownerTeamId ?? "");
    setUserId(contact.ownerUserId ?? "");
  }, [contact.id, contact.ownerTeamId, contact.ownerUserId]);

  const save = (patch: { ownerTeamId?: string | null; ownerUserId?: string | null }) =>
    update.mutate(
      { id: contact.id, input: patch },
      { onSuccess: () => onToast("Routing updated"), onError: () => onToast("Couldn't update routing") },
    );

  const who = isGroup ? "this group" : contact.displayName;
  return (
    <Block title="Auto-routing">
      <div className="pcard">
        <p className="routehint">New conversations from {who} go straight here.</p>
        <label className="routesel">
          <span>Team</span>
          <select
            value={teamId}
            onChange={(e) => {
              const v = e.target.value;
              setTeamId(v);
              save({ ownerTeamId: v || null });
            }}
          >
            <option value="">Automatic (channel routing)</option>
            {teams.data?.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </label>
        <label className="routesel">
          <span>Person</span>
          <select
            value={userId}
            onChange={(e) => {
              const v = e.target.value;
              setUserId(v);
              save({ ownerUserId: v || null });
            }}
          >
            <option value="">No one specific</option>
            {people.data?.map((m) => (
              <option key={m.user.id} value={m.user.id}>{m.user.name}</option>
            ))}
          </select>
        </label>
      </div>
    </Block>
  );
}

export function ContextPanel({ conversationId, onToast, onClose, onOpenConversation, onOpenProfile, onOpenOrganisation }: Props) {
  const { data: conv } = useConversation(conversationId);
  const qc = useQueryClient();
  const teams = useTeams();
  const teamName = (id: string) => teams.data?.find((t) => t.id === id)?.name ?? "—";
  const removeParticipant = useRemoveParticipant(conversationId ?? "");
  const resetInvite = useResetGroupInvite(conversationId ?? "");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!conv?.slaDueAt) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [conv?.slaDueAt]);

  if (!conv) return <aside className="panel" aria-label="Details" />;

  const isGroup = conv.channel === "whatsapp_group";
  const memberCount = conv.participants.length;
  const GroupGlyph = channelMeta("whatsapp_group").Glyph;

  const copyInvite = () => {
    if (conv.inviteLink) {
      navigator.clipboard?.writeText(conv.inviteLink);
      onToast("Invite link copied");
    }
  };

  const resetInviteLink = () => {
    if (!window.confirm("Reset the invite link? The current link stops working and anyone with it can no longer join.")) return;
    resetInvite.mutate(undefined, {
      onSuccess: () => onToast("Invite link reset"),
      onError: (err) => onToast((err as Error)?.message ?? "Couldn’t reset the link"),
    });
  };

  const copyValue = (value: string, label: string) => {
    navigator.clipboard?.writeText(value);
    onToast(`${label} copied`);
  };

  // Move this customer to another channel: open their thread there (starting one
  // if needed) and jump to it. Closing the panel reveals the thread on mobile.
  const switchChannel = async (channel: "whatsapp" | "email" | "sms") => {
    try {
      const { conversationId, alsoOpenWith } = await api.reachContact(conv.contact.id, channel);
      if (alsoOpenWith) onToast(startedAlongside(conv.contact.displayName, alsoOpenWith));
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["conversations"] }),
        qc.invalidateQueries({ queryKey: ["views"] }),
      ]);
      onOpenConversation?.(conversationId);
      onClose?.();
    } catch {
      const need = channel === "email" ? "an email address" : "a phone number";
      onToast(`Couldn't open ${channelMeta(channel).label} — check the customer has ${need} and a connected inbox.`);
    }
  };

  return (
    <aside className="panel" aria-label="Details">
      {onClose && (
        <div className="panel__mhead">
          <span>Details</span>
          <button onClick={onClose} aria-label="Close details" title="Close"><XIcon /></button>
        </div>
      )}
      <div className="panel__scroll">
        <div className="chero">
          <div className="chero__avawrap">
            <span className="chero__ring" aria-hidden="true" />
            <Avatar name={conv.contact.displayName} email={conv.contact.email} color={conv.contact.avatarColor} className="chero__ava" />
            {!isGroup && (
              <span
                className="chero__dot"
                style={{ background: channelMeta(conv.channel).color }}
                title={`On ${channelMeta(conv.channel).label}`}
              />
            )}
          </div>
          <h3 className="chero__name">{conv.contact.displayName}</h3>
          <div className="chero__sub">
            {isGroup ? (
              <span className="co-ch">
                <span className="co-ch__ic" style={{ color: "var(--group)" }}><GroupGlyph /></span>
                {memberCount} members
              </span>
            ) : (
              conv.contact.company || channelMeta(conv.channel).label
            )}
          </div>
          {!isGroup && (
            <>
              {(conv.contact.phone || conv.contact.email || conv.contact.visitorId) && (
                <div className="chero__chips">
                  {conv.contact.phone && (
                    <button
                      type="button"
                      className="cchip"
                      title="Copy phone number"
                      onClick={() => copyValue(conv.contact.phone as string, "Phone")}
                    >
                      <PhoneIcon />
                      <span>{conv.contact.phone}</span>
                    </button>
                  )}
                  {conv.contact.email && (
                    <button
                      type="button"
                      className="cchip"
                      title="Copy email address"
                      onClick={() => copyValue(conv.contact.email as string, "Email")}
                    >
                      <MailIcon />
                      <span>{conv.contact.email}</span>
                    </button>
                  )}
                  {/* A website visitor with nothing else on file: say so, rather
                      than leave the chips empty. Shown short — the full id is
                      32 hex characters and means nothing to an agent, but "this
                      person came in through the widget" does. */}
                  {conv.contact.visitorId && !conv.contact.phone && !conv.contact.email && (
                    <span className="cchip cchip--static" title="Reached us through the website chat">
                      <NestChatChip />
                      <span>Website visitor · {conv.contact.visitorId.slice(0, 6)}</span>
                    </span>
                  )}
                </div>
              )}
              <button type="button" className="cact cact--primary" onClick={() => onOpenProfile?.(conv.contact.id)}>
                <ProfileIcon />
                Open full profile
              </button>
            </>
          )}
        </div>

        {isGroup ? (
          <>
            <AssignmentBlock conv={conv} teamName={teamName} onToast={onToast} />
            <RoutingBlock contact={conv.contact} isGroup onToast={onToast} />
            {conv.slaDueAt && <SlaBlock iso={conv.slaDueAt} now={now} />}

            <Block title="Invite link">
              {conv.inviteLink ? (
                <>
                  <div className="invite">
                    <code>{conv.inviteLink}</code>
                    <button type="button" onClick={copyInvite}>Copy</button>
                  </div>
                  <div className="invite__acts">
                    <button
                      type="button"
                      className="invite__reset"
                      onClick={resetInviteLink}
                      disabled={resetInvite.isPending}
                    >
                      {resetInvite.isPending ? "Resetting…" : "Reset link"}
                    </button>
                  </div>
                  <p className="capnote">
                    Share this link to invite people — they join through it (up to {GROUP_MAX_MEMBERS}).
                  </p>
                </>
              ) : (
                <p className="capnote">No invite link yet.</p>
              )}
            </Block>
            <div className="psec">
              <div className="t">
                Members <span className="count">{memberCount} / {GROUP_MAX_MEMBERS}</span>
              </div>
              <div className="members">
                {conv.participants.map((p) => (
                  <div key={p.id} className="member">
                    <Avatar name={p.contact.displayName} email={p.contact.email} color={p.contact.avatarColor} className="mav" />
                    <span className="mname">{p.contact.displayName}</span>
                    {p.role === "admin" && <span className="mrole">admin</span>}
                    <button
                      type="button"
                      className="rm"
                      title="Remove"
                      aria-label="Remove member"
                      onClick={() => removeParticipant.mutate(p.contact.id, { onSuccess: () => onToast("Member removed") })}
                    >
                      <XIcon />
                    </button>
                  </div>
                ))}
              </div>
              {memberCount === 0 ? (
                <div className="capnote">No one has joined yet. Share the invite link to add people.</div>
              ) : memberCount >= GROUP_MAX_MEMBERS ? (
                <div className="capnote">Group is at the {GROUP_MAX_MEMBERS}-member limit.</div>
              ) : (
                <div className="capnote">People join via the invite link — WhatsApp groups have no add-by-number.</div>
              )}
            </div>
          </>
        ) : (
          <>
            {/* First: who this customer is and what everyone must know before
                acting for them — pinned instructions are no use below the fold. */}
            <OrganisationBlock conversationId={conv.id} onOpenOrganisation={(id) => onOpenOrganisation?.(id)} onToast={onToast} />
            <StatsBlock contactId={conv.contact.id} />
            <AssignmentBlock conv={conv} teamName={teamName} onToast={onToast} />
            {/* High, because an agent on a call is reading an order number off
                this panel and has no reason to scroll for it. */}
            <CustomFieldsBlock conv={conv} onToast={onToast} />
            <CustomerTags contact={conv.contact} onToast={onToast} />
            <RecentConversations contactId={conv.contact.id} currentId={conv.id} onOpen={onOpenConversation} />
            <ChannelsBlock contact={conv.contact} activeChannel={conv.channel} onSwitch={switchChannel} />
            <RoutingBlock contact={conv.contact} isGroup={false} onToast={onToast} />
            {conv.slaDueAt && <SlaBlock iso={conv.slaDueAt} now={now} />}
          </>
        )}
      </div>
    </aside>
  );
}
