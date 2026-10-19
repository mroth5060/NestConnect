import { useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent } from "react";
import type { ChannelType, Contact, ContactAccount, ContactDuplicateGroup, Team } from "@ding/schemas";
import { routingAccount } from "@ding/schemas";
import {
  useContact,
  useContacts,
  useContactDuplicates,
  useCreateContact,
  useDeleteContact,
  useMergeContacts,
  usePeople,
  useTeams,
  useUpdateContact,
  useContactAccounts,
} from "../hooks";
import { relativeTime } from "../lib/format";
import { filterCustomers, isFiltered, tagCounts } from "../lib/customer-filter";
import { Avatar } from "./Avatar";
import { GlideMenu } from "./GlideMenu";
import { ImportCustomers } from "./ImportCustomers";
import { CustomerBulkBar } from "./CustomerBulk";
import { TagEditor } from "./TagEditor";
import {
  channelMeta,
  AlertIcon,
  EditIcon,
  MailIcon,
  PhoneIcon,
  CheckIcon,
  ChevronDown,
  DownloadIcon,
  PlusIcon,
  TagIcon,
  RouteIcon,
  SearchIcon,
  TrashIcon,
  XIcon,
} from "../lib/icons";
import { ContactOrganisations } from "./organisations/OrganisationPanel";

interface Props {
  onClose: () => void;
  onToast: (msg: string) => void;
  onOpenConversation: (id: string) => void;
  /** When opened from a chat's "profile" action, edit this customer. */
  focusContactId?: string | null;
  /** Open an organisation's profile (from a customer's organisations). */
  onOpenOrganisation?: (accountId: string) => void;
}

/** The team-routing + person-routing controls that pin a customer's new
 *  conversations. Shared by the add + edit modal. */
function RoutingPicker({
  teams,
  people,
  ownerTeamId,
  ownerUserId,
  onTeam,
  onUser,
  inherited,
}: {
  teams: Team[];
  people: { user: { id: string; name: string } }[];
  ownerTeamId: string | null;
  ownerUserId: string | null;
  onTeam: (id: string | null) => void;
  onUser: (id: string | null) => void;
  /** What "Automatic" means for this customer: their organisation's routing, if one decides. */
  inherited?: string | null;
}) {
  const auto = !ownerTeamId && !ownerUserId;
  return (
    <>
      <div className="field">
        <span>Auto-route new conversations to</span>
        <div className="checks">
          <label className={"check" + (auto ? " on" : "")}>
            <input
              type="radio"
              checked={auto}
              onChange={() => {
                onTeam(null);
                onUser(null);
              }}
            />
            Automatic
          </label>
          {teams.map((t) => (
            <label key={t.id} className={"check" + (ownerTeamId === t.id ? " on" : "")}>
              <input
                type="radio"
                checked={ownerTeamId === t.id}
                onChange={() => onTeam(ownerTeamId === t.id ? null : t.id)}
              />
              {t.name}
            </label>
          ))}
        </div>
        {auto && inherited && <small className="routing-inherit"><RouteIcon /> {inherited}</small>}
      </div>
      <label className="field">
        <span>
          Straight to a person <em>optional</em>
        </span>
        <select value={ownerUserId ?? ""} onChange={(e) => onUser(e.target.value || null)}>
          <option value="">No one specific</option>
          {people.map((p) => (
            <option key={p.user.id} value={p.user.id}>
              {p.user.name}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}

/**
 * What "Automatic" does for a customer with no routing of their own: follow
 * their organisation's, when one decides (`routingAccount`), or say why not.
 */
function inheritedRouting(
  orgs: ContactAccount[],
  teams: Team[],
  people: { user: { id: string; name: string } }[],
): string | null {
  const { account, ambiguous } = routingAccount(orgs.map((o) => o.account));
  if (ambiguous) return "In several organisations that route — the channel decides until you pick a team here";
  if (!account) return null;
  const team = teams.find((t) => t.id === account.routeTeamId)?.name ?? "its team";
  const who = account.routeUserId ? people.find((p) => p.user.id === account.routeUserId)?.user.name : null;
  return `Follows ${account.name}: ${team}${who ? ` · ${who}` : ""}`;
}

/** One modal for both adding and editing a customer. */
function CustomerModal({
  contact,
  suggestions,
  onClose,
  onToast,
  onOpenConversation,
  onOpenOrganisation,
}: {
  contact: Contact | null;
  suggestions: string[];
  onClose: () => void;
  onToast: (msg: string) => void;
  onOpenConversation: (id: string) => void;
  onOpenOrganisation?: (accountId: string) => void;
}) {
  const isEdit = !!contact;
  const teams = useTeams();
  const people = usePeople();
  const orgs = useContactAccounts(contact?.id);
  const create = useCreateContact();
  const update = useUpdateContact();
  const del = useDeleteContact();
  const detail = useContact(contact?.id ?? null);
  const [displayName, setName] = useState(contact?.displayName ?? "");
  const [phone, setPhone] = useState(contact?.phone ?? "");
  const [email, setEmail] = useState(contact?.email ?? "");
  const [tags, setTags] = useState<string[]>(contact?.tags ?? []);
  const [ownerTeamId, setOwnerTeamId] = useState<string | null>(contact?.ownerTeamId ?? null);
  const [ownerUserId, setOwnerUserId] = useState<string | null>(contact?.ownerUserId ?? null);
  const [blocked, setBlocked] = useState(contact?.blocked ?? false);
  const busy = create.isPending || update.isPending || del.isPending;

  const remove = () => {
    if (!contact) return;
    if (!window.confirm(`Delete ${contact.displayName}? This permanently removes the customer and their conversation history.`)) return;
    del.mutate(contact.id, {
      onSuccess: () => { onToast(`${contact.displayName} deleted`); onClose(); },
      onError: () => onToast("Couldn't delete customer"),
    });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const name = displayName.trim();
    if (!name) return;
    if (isEdit && contact) {
      update.mutate(
        {
          id: contact.id,
          input: {
            displayName: name,
            phone: phone.trim(),
            email: email.trim(),
            tags,
            ownerTeamId,
            ownerUserId,
            blocked,
          },
        },
        {
          onSuccess: () => {
            onToast("Customer updated");
            onClose();
          },
          onError: () => onToast("Couldn't update customer"),
        },
      );
    } else {
      create.mutate(
        {
          displayName: name,
          phone: phone.trim() || undefined,
          email: email.trim() || undefined,
          tags,
          ownerTeamId,
          ownerUserId,
        },
        {
          onSuccess: (res) => {
            // Get-or-create: if the phone/email already matched a customer, we
            // opened theirs instead of forking a duplicate — say so.
            onToast(res.existed ? `Already on file — ${res.contact.displayName}` : `Added ${name}`);
            onClose();
          },
          onError: () => onToast("Couldn't add customer"),
        },
      );
    }
  };

  const convos = detail.data?.conversations ?? [];

  return (
    <div className="modal" onClick={onClose}>
      <form className="modal__box modal--form" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="modal__head">
          <h2>{isEdit ? "Edit customer" : "New customer"}</h2>
          <button type="button" className="modal__x" onClick={onClose} aria-label="Close">
            <XIcon />
          </button>
        </div>
        <div className="modal__body">
          <div className="setform__grid two">
            <label className="field" style={{ gridColumn: "1 / -1" }}>
              <span>Name</span>
              <input value={displayName} autoFocus onChange={(e) => setName(e.target.value)} placeholder="The Ivy House" required />
            </label>
            <label className="field">
              <span>Phone <em>optional</em></span>
              <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+44 117 496 0122" />
            </label>
            <label className="field">
              <span>Email <em>optional</em></span>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ops@theivyhouse.co.uk" />
            </label>
          </div>
          <TagEditor tags={tags} suggestions={suggestions} onChange={setTags} />
          <RoutingPicker
            teams={teams.data ?? []}
            people={people.data ?? []}
            ownerTeamId={ownerTeamId}
            ownerUserId={ownerUserId}
            onTeam={setOwnerTeamId}
            onUser={setOwnerUserId}
            inherited={inheritedRouting(orgs.data ?? [], teams.data ?? [], people.data ?? [])}
          />
          {isEdit && contact && (
            <ContactOrganisations
              contactId={contact.id}
              onOpenOrganisation={(id) => { onClose(); onOpenOrganisation?.(id); }}
              onToast={onToast}
            />
          )}
          {isEdit && (
            <div className="field">
              <span>Conversations {convos.length > 0 && `· ${convos.length}`}</span>
              {convos.length === 0 ? (
                <p className="custconvs__empty">{detail.isLoading ? "Loading…" : "No conversations yet."}</p>
              ) : (
                <div className="custconvs">
                  {convos.map((c) => {
                    const cm = channelMeta(c.channel);
                    const Glyph = cm.Glyph;
                    return (
                      <button className="custconv" key={c.id} type="button" onClick={() => onOpenConversation(c.id)} title="Open conversation">
                        <span className="custconv__ic" style={{ color: cm.color }}><Glyph /></span>
                        <span className="custconv__body">
                          <b>{c.subject || cm.label}</b>
                          <small>{c.preview || "No messages"}</small>
                        </span>
                        <span className={"custconv__st st-" + c.status}>{c.status}</span>
                        <span className="custconv__t">{relativeTime(c.lastActivityAt)}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          {isEdit && (
            <label className={"custblock" + (blocked ? " on" : "")}>
              <input type="checkbox" checked={blocked} onChange={(e) => setBlocked(e.target.checked)} />
              <span>
                <b>Block this customer</b>
                <small>Their inbound messages are dropped and they’re hidden from the directory.</small>
              </span>
            </label>
          )}
        </div>
        <div className={"modal__foot" + (isEdit ? " modal__foot--split" : "")}>
          {isEdit && (
            <button type="button" className="btn-ghost btn-danger" onClick={remove}>
              <TrashIcon /> Delete
            </button>
          )}
          <div className="setform__footactions">
            <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={busy || !displayName.trim()}>
              {isEdit ? "Save changes" : "Add customer"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

/** One possible-duplicate cluster: shows why the contacts matched, lets the
 *  agent choose which record survives, and merges the rest into it. */
function DuplicateGroupCard({
  group,
  busy,
  onOpen,
  onMerge,
}: {
  group: ContactDuplicateGroup;
  busy: boolean;
  onOpen: (c: Contact) => void;
  onMerge: (winner: Contact, loserIds: string[]) => void;
}) {
  const [winnerId, setWinnerId] = useState(group.contacts[0].id);
  const winner = group.contacts.find((c) => c.id === winnerId) ?? group.contacts[0];
  const loserIds = group.contacts.filter((c) => c.id !== winner.id).map((c) => c.id);
  return (
    <div className="dupgroup">
      <div className="dupgroup__why">
        {group.reasons.map((r, j) => (
          <span className="dupreason" key={j} title={r.kind === "phone" ? "Shared number" : "Shared email"}>
            {r.kind === "phone" ? <PhoneIcon /> : <MailIcon />} {r.value}
          </span>
        ))}
      </div>
      <div className="dupgroup__members">
        {group.contacts.map((c) => (
          <button
            type="button"
            className={"dupmember" + (c.id === winner.id ? " keep" : "")}
            key={c.id}
            onClick={() => onOpen(c)}
            title="Open this customer"
          >
            <Avatar name={c.displayName} email={c.email} color={c.avatarColor} className="dupmember__av av" />
            <span className="dupmember__x">
              <b>{c.displayName}{c.blocked && <span className="dupblocked">Blocked</span>}</b>
              <small>{c.company || c.phone || c.email || "No details"}</small>
            </span>
            {c.id === winner.id && <span className="dupmember__tag">Keeps</span>}
          </button>
        ))}
      </div>
      <div className="dupgroup__act">
        <label className="dupkeep">
          Keep
          <select value={winnerId} onChange={(e) => setWinnerId(e.target.value)} disabled={busy}>
            {group.contacts.map((c) => (
              <option key={c.id} value={c.id}>{c.displayName}</option>
            ))}
          </select>
        </label>
        <button type="button" className="btn-primary dupmerge" disabled={busy} onClick={() => onMerge(winner, loserIds)}>
          Merge {loserIds.length} into {winner.displayName}
        </button>
      </div>
    </div>
  );
}

export function Customers({ onClose, onToast, onOpenConversation, focusContactId, onOpenOrganisation }: Props) {
  const contacts = useContacts();
  const teams = useTeams();
  const [q, setQ] = useState("");
  const [showBlocked, setShowBlocked] = useState(false);
  const duplicates = useContactDuplicates();
  const [showDupes, setShowDupes] = useState(false);
  const merge = useMergeContacts();
  // null = closed; { contact: null } = add; { contact } = edit.
  const [modal, setModal] = useState<{ contact: Contact | null } | null>(null);

  // Opened from a chat's "profile" action: open that customer's editor.
  useEffect(() => {
    if (!focusContactId) return;
    const c = (contacts.data ?? []).find((x) => x.id === focusContactId);
    if (c) setModal({ contact: c });
  }, [focusContactId, contacts.data]);

  const teamName = (id: string) => teams.data?.find((t) => t.id === id)?.name ?? "team";
  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const c of contacts.data ?? []) for (const t of c.tags ?? []) set.add(t);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [contacts.data]);

  const [importing, setImporting] = useState(false);
  /** Tags narrow (a customer must have all of them); channels widen (reachable
   *  on any). Both live in `lib/customer-filter`, where the two combinators are
   *  stated and tested — the asymmetry is deliberate, not an oversight. */
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [channelFilter, setChannelFilter] = useState<ChannelType[]>([]);
  const [tagMenu, setTagMenu] = useState(false);
  const blockedCount = (contacts.data ?? []).filter((c) => c.blocked).length;

  const filter = useMemo(
    () => ({ query: q, tags: tagFilter, channels: channelFilter, showBlocked }),
    [q, tagFilter, channelFilter, showBlocked],
  );
  const filtered = useMemo(
    () => filterCustomers(contacts.data ?? [], filter),
    [contacts.data, filter],
  );
  /** Counted across everyone, not the filtered list: a count that fell to zero
   *  as you ticked things would make the menu unusable for adding a second tag. */
  const tagOptions = useMemo(() => tagCounts(contacts.data ?? []), [contacts.data]);
  const toggleTag = (t: string) =>
    setTagFilter((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));
  const toggleChannel = (ch: ChannelType) =>
    setChannelFilter((cur) => (cur.includes(ch) ? cur.filter((x) => x !== ch) : [...cur, ch]));
  const clearFilters = () => {
    setQ("");
    setTagFilter([]);
    setChannelFilter([]);
  };

  // Ticked customers, kept across filter changes; anyone since deleted or
  // merged away drops out.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const lastPicked = useRef<string | null>(null);
  const selected = useMemo(() => (contacts.data ?? []).filter((c) => picked.has(c.id)), [contacts.data, picked]);
  const shownPicked = filtered.filter((c) => picked.has(c.id)).length;
  const allShown = filtered.length > 0 && shownPicked === filtered.length;
  /** Tick or untick one; with Shift, everything shown between it and the last one ticked. */
  const togglePick = (c: Contact, e: MouseEvent) => {
    e.stopPropagation();
    const on = !picked.has(c.id);
    const next = new Set(picked);
    const from = lastPicked.current ? filtered.findIndex((x) => x.id === lastPicked.current) : -1;
    const to = filtered.findIndex((x) => x.id === c.id);
    const range = e.shiftKey && from >= 0 && to >= 0 ? filtered.slice(Math.min(from, to), Math.max(from, to) + 1) : [c];
    for (const x of range) (on ? next.add(x.id) : next.delete(x.id));
    lastPicked.current = c.id;
    setPicked(next);
  };
  const toggleAllShown = () =>
    setPicked((cur) => {
      const next = new Set(cur);
      for (const c of filtered) (allShown ? next.delete(c.id) : next.add(c.id));
      return next;
    });

  const routing = (c: Contact) =>
    c.ownerTeamId
      ? { label: teamName(c.ownerTeamId), pinned: true }
      : c.ownerUserId
        ? { label: "Direct", pinned: true }
        : { label: "Automatic", pinned: false };

  const handleMerge = (winner: Contact, loserIds: string[]) => {
    if (merge.isPending) return;
    const n = loserIds.length;
    if (!window.confirm(
      `Merge ${n} duplicate${n === 1 ? "" : "s"} into ${winner.displayName}? Their conversations and details move onto this record and the duplicate${n === 1 ? " is" : "s are"} deleted. This can't be undone.`,
    )) return;
    merge.mutate(
      { winnerId: winner.id, loserIds },
      {
        onSuccess: (res) => onToast(`Merged into ${res.contact.displayName}`),
        onError: () => onToast("Couldn't merge those customers"),
      },
    );
  };

  return (
    <div className="settings" role="region" aria-label="Customers">
      <header className="settings__head">
        <h1>Customers</h1>
        <button className="settings__x" onClick={onClose} aria-label="Close customers" title="Close">
          <XIcon />
        </button>
      </header>
      <div className="settings__pane">
        <div className="setpane setpane--wide">
          <div className="setpane__head">
            <div>
              <h2>Customers <span className="setcount">{contacts.data?.length ?? 0}</span></h2>
              <p>Everyone who's messaged you, plus contacts you add by hand. Tag them and pin a customer to a team so their messages always land in the right place.</p>
            </div>
            {/* `setpane__headacts` is the existing pane-header pair — Settings ›
                Templates uses it for the same ghost-plus-primary shape, and it
                already sizes both icons. Import sits beside Add rather than
                behind a menu: a directory that starts empty is the normal case,
                and "bring my list in" is the first thing anyone does with it. */}
            <div className="setpane__headacts">
              <button className="btn-ghost" onClick={() => setImporting(true)}>
                <DownloadIcon /> Import
              </button>
              <button className="btn-primary" onClick={() => setModal({ contact: null })}>
                <PlusIcon /> Add customer
              </button>
            </div>
          </div>

          <div className="setbar">
            <div className="setsearch">
              <SearchIcon />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, organisation, number, email or tag…" />
            </div>
            {/* Channels first: two chips, always the same two, so they stay a
                fixed landmark rather than a list that changes shape. */}
            {(["whatsapp", "email"] as ChannelType[]).map((ch) => (
              <button
                key={ch}
                type="button"
                className={"setfilterchip" + (channelFilter.includes(ch) ? " on" : "")}
                onClick={() => toggleChannel(ch)}
                aria-pressed={channelFilter.includes(ch)}
              >
                {channelMeta(ch).label}
              </button>
            ))}

            {/* Tags behind a menu rather than inline: a directory accumulates
                dozens, and a chip row that wraps to four lines pushes the table
                off the screen. The count on the button is what a row of chips
                was there to tell you. */}
            {tagOptions.length > 0 && (
              <div className="custtagfilter">
                <button
                  type="button"
                  className={"setfilterchip" + (tagFilter.length ? " on" : "")}
                  onClick={() => setTagMenu((v) => !v)}
                  aria-expanded={tagMenu}
                  aria-haspopup="true"
                >
                  <TagIcon />
                  {tagFilter.length ? `Tags · ${tagFilter.length}` : "Tags"}
                  <ChevronDown />
                </button>
                {tagMenu && (
                  <>
                    {/* A full-screen sink rather than a document listener: it
                        closes on any outside click including one that lands on
                        another control, without that control also firing. */}
                    <div className="custtagfilter__sink" onClick={() => setTagMenu(false)} />
                    <GlideMenu className="menu custtagmenu" role="menu">
                      {tagOptions.map(({ tag, count }) => {
                        const on = tagFilter.some((t) => t.toLowerCase() === tag.toLowerCase());
                        return (
                          <button
                            key={tag}
                            type="button"
                            role="menuitemcheckbox"
                            aria-checked={on}
                            className={on ? "on" : ""}
                            onClick={() => toggleTag(tag)}
                          >
                            <span className="custtagmenu__tick">{on ? <CheckIcon /> : null}</span>
                            <span className="custtagmenu__name">{tag}</span>
                            <span className="custtagmenu__n">{count}</span>
                          </button>
                        );
                      })}
                    </GlideMenu>
                  </>
                )}
              </div>
            )}

            {blockedCount > 0 && (
              <button
                type="button"
                className={"setfilterchip" + (showBlocked ? " on" : "")}
                onClick={() => setShowBlocked((v) => !v)}
              >
                {showBlocked ? "Hide blocked" : `Show blocked · ${blockedCount}`}
              </button>
            )}

            {isFiltered(filter) && (
              <button type="button" className="setfilterchip custclear" onClick={clearFilters}>
                <XIcon /> Clear
              </button>
            )}

            {/* What the filters actually did. Without it, a narrow filter and an
                empty directory look identical. */}
            {isFiltered(filter) && contacts.data && (
              <span className="custcount">
                {filtered.length} of {contacts.data.length}
              </span>
            )}
          </div>

          {(duplicates.data?.length ?? 0) > 0 && (
            <div className="dupwrap">
              <button
                type="button"
                className={"dupbanner" + (showDupes ? " open" : "")}
                onClick={() => setShowDupes((v) => !v)}
                aria-expanded={showDupes}
              >
                <span className="dupbanner__ic"><AlertIcon /></span>
                <span className="dupbanner__main">
                  <b>{duplicates.data!.length} possible duplicate{duplicates.data!.length === 1 ? "" : "s"}</b>
                  <small>These customers share a phone number or email — likely the same person on file more than once.</small>
                </span>
                <span className="dupbanner__act">{showDupes ? "Hide" : "Review"}</span>
              </button>
              {showDupes && (
                <div className="dupgroups">
                  {duplicates.data!.map((g, i) => (
                    <DuplicateGroupCard
                      key={i}
                      group={g}
                      busy={merge.isPending}
                      onOpen={(c) => setModal({ contact: c })}
                      onMerge={handleMerge}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {selected.length > 0 && (
            <CustomerBulkBar
              selected={selected}
              suggestions={allTags}
              shown={filtered.length}
              onSelectShown={() => setPicked((cur) => new Set([...cur, ...filtered.map((c) => c.id)]))}
              onClear={() => setPicked(new Set())}
              onToast={onToast}
            />
          )}

          <div className="dwrap">
            <div className="dtable dtable--cust">
              <div className="dtable__head">
                <span className="dsel">
                  <input
                    type="checkbox"
                    aria-label={allShown ? "Unselect everyone shown" : "Select everyone shown"}
                    checked={allShown}
                    ref={(el) => {
                      if (el) el.indeterminate = shownPicked > 0 && !allShown;
                    }}
                    onChange={toggleAllShown}
                    disabled={!filtered.length}
                  />
                </span>
                <span>Name</span>
                <span>Organisation</span>
                <span>Contact</span>
                <span>Channels</span>
                <span>Tags</span>
                <span>Routing</span>
                <span />
              </div>
              {filtered.map((c) => {
                const r = routing(c);
                return (
                  <div
                    className={"dtable__row" + (c.blocked ? " dtable__row--blocked" : "") + (picked.has(c.id) ? " dtable__row--picked" : "")}
                    key={c.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => setModal({ contact: c })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setModal({ contact: c }); }
                    }}
                  >
                    <span className="dcell dsel" onClick={(e) => togglePick(c, e)}>
                      <input
                        type="checkbox"
                        aria-label={`Select ${c.displayName}`}
                        checked={picked.has(c.id)}
                        // The cell takes the click (with Shift for a range) — the box's
                        // own click, and Space on it, bubble up to it.
                        onChange={() => undefined}
                        // …but not to the row, whose Space and Enter open the customer.
                        onKeyDown={(e) => e.stopPropagation()}
                      />
                    </span>
                    <span className="dcell dname">
                      <Avatar name={c.displayName} email={c.email} color={c.avatarColor} className="dname__av av" />
                      <span className="dname__x">
                        <span className="dcell__t">
                          {c.displayName}
                          {c.blocked && <span className="dbadge dbadge--blocked">Blocked</span>}
                        </span>
                      </span>
                    </span>
                    <span className="dcell dcell--muted">{c.company || "—"}</span>
                    <span className="dcell">
                      {c.phone ? <div className="dcell__t" style={{ fontWeight: 550, fontSize: "var(--fs-sm)" }}>{c.phone}</div> : null}
                      {c.email ? <div className="dcell__s">{c.email}</div> : null}
                      {!c.phone && !c.email ? <span className="dcell--muted">—</span> : null}
                    </span>
                    <span className="dcell dchips">
                      {/* A number is a phone; WhatsApp only for someone who's
                          written to us there (see Contact.onWhatsApp). */}
                      {c.phone && (
                        <span title="Phone" style={{ color: "var(--text-muted)", display: "inline-flex" }}>
                          <PhoneIcon />
                        </span>
                      )}
                      {c.onWhatsApp && (
                        <span title="On WhatsApp" style={{ color: channelMeta("whatsapp").color, display: "inline-flex" }}>
                          {(() => { const G = channelMeta("whatsapp").Glyph; return <G />; })()}
                        </span>
                      )}
                      {c.email && (
                        <span title="Email" style={{ color: channelMeta("email").color, display: "inline-flex" }}>
                          {(() => { const G = channelMeta("email").Glyph; return <G />; })()}
                        </span>
                      )}
                      {!c.phone && !c.email && <span className="dcell--muted">—</span>}
                    </span>
                    <span className="dcell dtags">
                      {(c.tags ?? []).slice(0, 3).map((t) => <span className="dtag" key={t}>{t}</span>)}
                      {(c.tags?.length ?? 0) > 3 && <span className="dtag">+{(c.tags?.length ?? 0) - 3}</span>}
                      {(c.tags?.length ?? 0) === 0 && <span className="dcell--muted">—</span>}
                    </span>
                    <span className="dcell">
                      <span className={"dpill " + (r.pinned ? "dpill--on" : "dpill--off")} title={r.pinned ? `Pinned to ${r.label}` : "Follows channel routing"}>
                        <RouteIcon /> {r.label}
                      </span>
                    </span>
                    <span className="dcell dcell--end"><span className="dchev"><EditIcon /></span></span>
                  </div>
                );
              })}
            </div>
          </div>

          {contacts.data && filtered.length === 0 && (
            <div className="setzero">
              {q ? (
                <p>No customers match “{q}”.</p>
              ) : (
                <>
                  <span className="setzero__ic"><PhoneIcon /></span>
                  <p>No customers yet. They appear here automatically when someone messages you — or add one now.</p>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {modal && (
        <CustomerModal
          contact={modal.contact}
          suggestions={allTags}
          onClose={() => setModal(null)}
          onToast={onToast}
          onOpenConversation={onOpenConversation}
          onOpenOrganisation={onOpenOrganisation}
        />
      )}

      {importing && (
        <ImportCustomers
          existingTags={allTags}
          onClose={() => setImporting(false)}
          onToast={onToast}
        />
      )}
    </div>
  );
}
