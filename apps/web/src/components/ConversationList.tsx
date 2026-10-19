import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useConversationCounts, useConversations, useCustomFields, useSearchConversations, useRefresh, useSession, useTeams } from "../hooks";
import { filterChipFields } from "@ding/schemas";
import { listTime, slaCountdown, timeUntil } from "../lib/format";
import { Avatar } from "./Avatar";
import { channelMeta, SearchIcon, MenuIcon, CmdIcon, SnoozeIcon, RefreshIcon, ComposeIcon, PanelLeftIcon, MicIcon } from "../lib/icons";
import { NotificationBell } from "./NotificationBell";
import { usePullToRefresh } from "../lib/usePullToRefresh";
import { applyListWidth, getListWidth, setListWidth, resetListWidth, LIST_MIN, LIST_MAX } from "../lib/layout";

type Filter = "all" | "unread" | "mine" | "unassigned" | "groups" | "closed";

interface Props {
  view: string;
  title: string;
  count: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Open a Business Ops SOP from a bell notification. */
  onOpenOpsSop?: (id: string) => void;
  onOpenChat?: (roomId: string) => void;
  /** A channel that needs reconnecting, from the bell. */
  onOpenChannels?: () => void;
  onOpenCmdk: () => void;
  onCompose: () => void;
  onOpenDrawer?: () => void;
  /** Desktop only: true when the inbox sidebar is collapsed, so the list shows
   *  a button to bring it back. */
  sidebarCollapsed?: boolean;
  onExpandSidebar?: () => void;
}

export function ConversationList({ view, title, count, selectedId, onSelect, onOpenCmdk, onCompose, onOpenDrawer, sidebarCollapsed, onExpandSidebar, onOpenOpsSop, onOpenChat, onOpenChannels }: Props) {
  /**
   * Narrow the list to threads carrying one custom field.
   *
   * Server-side rather than a filter over the loaded rows, unlike the chips
   * beside it: those narrow a page you already have, and an order number is
   * precisely the thing that is three hundred rows down. Held here rather than
   * in the URL because it is a way of looking at an inbox, not a place — going
   * back should return you to the inbox, not to the filter you had on.
   */
  const [fieldKey, setFieldKey] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  // The Closed chip pages through the view's closed side, every other chip its
  // open side. Paged together, a channel whose recent threads were all closed
  // held its one open thread past the first page, and the list showed nothing.
  const listQuery = useConversations(
    view,
    fieldKey ? { key: fieldKey } : undefined,
    filter === "closed" ? "closed" : "active",
  );
  const { data, isLoading } = listQuery;
  const teams = useTeams();
  const myId = useSession().data?.user.id;
  const teamName = (id?: string | null) => (id ? teams.data?.find((t) => t.id === id)?.name : undefined);
  const [q, setQ] = useState("");
  const { refresh, refreshing } = useRefresh();
  const convsRef = useRef<HTMLDivElement>(null);
  const { pull, armed, handlers } = usePullToRefresh(convsRef, refresh, refreshing);

  const query = q.trim();
  // A non-empty query switches the list to a search over message bodies too,
  // not just the rows already loaded — but within the inbox you're in. A hit
  // from a team you don't work, surfaced by a field that lives inside "My
  // Inbound", is a result you can neither place nor act on.
  const searching = query.length > 0;
  const search = useSearchConversations(query, searching, view);
  const hasLoadedGroups = (data ?? []).some((c) => c.channel === "whatsapp_group");
  const shown = searching
    ? search.data ?? []
    : (data ?? []).filter((c) => {
        const closed = c.status === "closed";
        // Closed lives only under its own filter; every other filter hides it.
        if (filter === "closed" ? !closed : closed) return false;
        if (filter === "unread" && !c.unread) return false;
        if (filter === "mine" && c.assigneeUserId !== myId) return false;
        if (filter === "unassigned" && c.assigneeUserId) return false;
        if (filter === "groups" && c.channel !== "whatsapp_group") return false;
        return true;
      });

  // "Mine" is all-assigned-to-me and "Queue" is all-unassigned, so an Unassigned
  // filter is redundant in both.
  const showUnassigned = view !== "mine" && view !== "grabs";
  // A "Yours" filter (assigned to me) is useful in shared team/channel inboxes,
  // where a mix of agents' conversations live; redundant in the personal views.
  const showMine = view.startsWith("team:") || view.startsWith("inbox:");
  // A team inbox already scopes to one team, so the per-card team label is redundant there.
  const showTeamTag = !view.startsWith("team:");
  // Per-filter counts (WhatsApp-style), from the server over the whole view.
  // Counting the loaded rows instead is what made every chip read low until
  // the list had been scrolled to its end — it is paged, thirty at a time.
  // Fetched again whenever the list is, so they move with it.
  const serverCounts = useConversationCounts(
    view,
    fieldKey ? { key: fieldKey } : undefined,
    listQuery.dataUpdatedAt,
  ).data;
  // A group thread three pages down still earns the chip.
  const hasGroups = hasLoadedGroups || (serverCounts?.groups ?? 0) > 0;
  // The loaded rows stand in only until the server has answered once.
  const active = (data ?? []).filter((c) => c.status !== "closed");
  const countFor = (key: Filter): number =>
    serverCounts
      ? serverCounts[key]
      : key === "all"
      ? active.length
      : key === "unread"
        ? active.filter((c) => c.unread).length
        : key === "mine"
          ? active.filter((c) => c.assigneeUserId === myId).length
          : key === "unassigned"
            ? active.filter((c) => !c.assigneeUserId).length
            : key === "groups"
              ? active.filter((c) => c.channel === "whatsapp_group").length
              : (data ?? []).filter((c) => c.status === "closed").length;
  // Only the fields somebody chose to filter by, in Settings › Custom fields.
  // The rule lives in the schemas package because the phone's list applies the
  // same one, and two copies of it is how they stop agreeing.
  const fieldChips = filterChipFields(useCustomFields().data ?? []);

  const filters: { key: Filter; label: string; count: number }[] = [
    { key: "all" as Filter, label: "All" },
    { key: "unread" as Filter, label: "Unread" },
    ...(showMine ? [{ key: "mine" as Filter, label: "Yours" }] : []),
    ...(showUnassigned ? [{ key: "unassigned" as Filter, label: "Unassigned" }] : []),
    ...(hasGroups ? [{ key: "groups" as Filter, label: "Groups" }] : []),
    { key: "closed" as Filter, label: "Closed" },
  ].map((f) => ({ ...f, count: countFor(f.key) }));

  // Fall back to All if the active filter isn't available in the current view/data.
  useEffect(() => {
    if (
      (filter === "unassigned" && !showUnassigned) ||
      (filter === "mine" && !showMine) ||
      (filter === "groups" && !hasGroups)
    ) {
      setFilter("all");
    }
  }, [filter, showUnassigned, showMine, hasGroups]);

  // A filter belongs to the inbox it was set in, the chip as much as the field.
  // Carried across, "Unread" from My Inbound emptied a channel whose one
  // conversation had been read: "inbox zero", beside an All chip reading 1.
  // Each inbox opens on All.
  useEffect(() => {
    setFieldKey(null);
    setFilter("all");
  }, [view]);

  // …and the same if the chip itself goes away while it is on — somebody
  // turning the field off in Settings, or retiring it. Without this the list
  // stays filtered by a chip that is no longer on screen to turn off.
  useEffect(() => {
    if (fieldKey && !fieldChips.some((f) => f.key === fieldKey)) setFieldKey(null);
  }, [fieldKey, fieldChips]);

  // Virtualize the row list so only the visible rows mount, however long the
  // (paginated) list grows. Rows self-measure, so variable heights are fine.
  const rowVirtualizer = useVirtualizer({
    count: shown.length,
    getScrollElement: () => convsRef.current,
    estimateSize: () => 78,
    overscan: 8,
    getItemKey: (i) => shown[i].id,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  // The active paginator (search vs the view list) — fetch the next page as the
  // last rows come into view, so we never load the whole inbox up front.
  const pager = searching ? search : listQuery;
  // Also while a chip has fewer rows on screen than it counts (Unread, Yours…
  // still filter the loaded pages): with nothing on screen there is no last
  // row to scroll to, so the next page would never be asked for.
  const want = searching ? 0 : Math.min(countFor(filter), 20);
  useEffect(() => {
    const last = virtualRows[virtualRows.length - 1];
    const nearEnd = !!last && last.index >= shown.length - 6;
    if ((nearEnd || shown.length < want) && pager.hasNextPage && !pager.isFetchingNextPage) {
      void pager.fetchNextPage();
    }
  }, [virtualRows, shown.length, want, pager.hasNextPage, pager.isFetchingNextPage, pager.fetchNextPage]);

  // Drag the right edge to widen/narrow the list. The width lives in a CSS var
  // written straight to the DOM per frame — no React re-render while dragging —
  // and is persisted to localStorage only on release.
  const [resizing, setResizing] = useState(false);
  // Bumped on keyboard/reset changes so aria-valuenow re-reads the live width
  // (drag itself stays re-render-free — the CSS var drives the visual resize).
  const [, bumpWidth] = useState(0);
  const startResize = (e: ReactPointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = getListWidth();
    setResizing(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev: PointerEvent) => applyListWidth(startW + (ev.clientX - startX));
    const onUp = () => {
      setResizing(false);
      setListWidth(getListWidth());
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  const nudgeResize = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowLeft") setListWidth(getListWidth() - 16);
    else if (e.key === "ArrowRight") setListWidth(getListWidth() + 16);
    else return;
    e.preventDefault();
    bumpWidth((n) => n + 1);
  };
  const resetResize = () => {
    resetListWidth();
    bumpWidth((n) => n + 1);
  };

  return (
    <section className={"list" + (resizing ? " is-resizing" : "")} aria-label="Conversations">
      <div className="list__head">
        <div className="flex items-center gap-[9px]">
          <button className="list__burger" onClick={onOpenDrawer} aria-label="Open menu" title="Menu">
            <MenuIcon />
          </button>
          {sidebarCollapsed && onExpandSidebar && (
            <button className="list__expand" onClick={onExpandSidebar} aria-label="Show inboxes" title="Show inboxes">
              <PanelLeftIcon />
            </button>
          )}
          <h1 className="m-0 text-lg font-bold tracking-[-.01em]">{title}</h1>
          <span className="badge bg-brand-tint text-brand-strong">{count}</span>
          <button
            className={"list__refresh" + (refreshing ? " spinning" : "")}
            onClick={() => refresh()}
            disabled={refreshing}
            title="Refresh — fetch new messages"
            aria-label="Refresh"
          >
            <RefreshIcon />
          </button>
          <NotificationBell onOpenConversation={onSelect} onOpenOpsSop={onOpenOpsSop} onOpenChat={onOpenChat} onOpenChannels={onOpenChannels} />
          <button className="kbd" onClick={onOpenCmdk} title="Command menu" aria-label="Command menu">
            <CmdIcon />
            <span>K</span>
          </button>
          <button className="list__compose" onClick={onCompose} title="New message" aria-label="New message">
            <ComposeIcon />
          </button>
        </div>
        <div className="mt-[11px] flex items-center gap-2 bg-surface-2 rounded-8 py-2 px-4 text-faint [&>svg]:w-[15px] [&>svg]:h-[15px]">
          <SearchIcon />
          <input
            className="border-0 bg-transparent [outline:none] text-fg w-full text-sm"
            placeholder="Search all conversations & messages…"
            aria-label="Search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {q && (
            <button className="search__clear" onClick={() => setQ("")} aria-label="Clear search" title="Clear">
              ✕
            </button>
          )}
        </div>
        {searching ? (
          <div className="pt-2 px-1 pb-[3px] text-xs font-semibold text-muted">
            {search.isFetching ? "Searching…" : `${shown.length} result${shown.length === 1 ? "" : "s"} for “${query}”`}
          </div>
        ) : (
          <div className="chips">
            {filters.map((f) => (
              <button
                key={f.key}
                className={"chip" + (filter === f.key ? " active" : "")}
                onClick={() => setFilter(f.key)}
              >
                {f.label}
                {f.count > 0 && <span className="chipcount">{f.count}</span>}
              </button>
            ))}
            {fieldChips.map((f) => (
              <button
                key={f.id}
                className={"chip chip--field" + (fieldKey === f.key ? " active" : "")}
                onClick={() => setFieldKey(fieldKey === f.key ? null : f.key)}
                title={
                  fieldKey === f.key
                    ? `Showing only threads with a ${f.label.toLowerCase()}`
                    : `Only threads with a ${f.label.toLowerCase()}`
                }
              >
                {f.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="convs" key={view} ref={convsRef} {...handlers}>
        <div
          className={"ptr" + (refreshing ? " loading" : armed ? " armed" : "")}
          style={{ height: refreshing ? 38 : pull, opacity: refreshing ? 1 : Math.min(1, pull / 42) }}
          aria-hidden={!refreshing && pull === 0}
        >
          <span className="ptr__spin">
            <RefreshIcon />
          </span>
        </div>
        {(searching ? search.isLoading : isLoading) && <div className="empty">Loading…</div>}
        {!(searching ? search.isLoading : isLoading) && shown.length === 0 && (
          <div className="empty">
            {searching
              ? `No conversations match “${query}”.`
              : filter === "groups"
                ? "No group chats here."
                : filter === "closed"
                  ? "No closed conversations."
                  : filter === "unassigned"
                    ? "Nothing unassigned — all picked up."
                    : filter === "unread"
                      ? "Nothing unread here."
                      : filter === "mine"
                        ? "None of these are yours."
                        : "Nothing here — inbox zero."}
            {/* A chip hiding what's here says so, rather than reading as an
                empty inbox beside an All chip that isn't. */}
            {!searching && filter !== "all" && filter !== "closed" && countFor("all") > 0 && (
              <>
                {" "}
                <button type="button" className="empty__all" onClick={() => setFilter("all")}>
                  Show all {countFor("all")}
                </button>
              </>
            )}
          </div>
        )}
        {shown.length > 0 && (
          <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
            {virtualRows.map((vr) => {
              const c = shown[vr.index];
              if (!c) return null;
              // Badge the most recent channel used (a thread can span channels).
              const cm = channelMeta(c.lastChannel ?? c.channel);
              // Ownership is viewer-relative: "Yours" only when it's assigned to
              // me; a teammate's chat shows their name; unassigned shows "Queue".
              const mine = !!c.assigneeUserId && c.assigneeUserId === myId;
              const assignedOther = !!c.assigneeUserId && !mine;
              const Glyph = cm.Glyph;
              // A voice-note preview arrives as "🎤 Voice message" — swap the
              // emoji for a proper mic icon (WhatsApp-style) and keep the label.
              const voice = c.preview.startsWith("🎤");
              const previewText = voice ? c.preview.replace(/^🎤\s*/u, "") : c.preview;
              return (
                <div
                  key={vr.key}
                  data-index={vr.index}
                  ref={rowVirtualizer.measureElement}
                  style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${vr.start}px)` }}
                >
                  <button
                    className={"conv group" + (c.unread ? " unread" : "") + (selectedId === c.id ? " active" : "")}
                    onClick={() => onSelect(c.id)}
                  >
              {/* No size/fontSize props: the base .av is already 44/16, and leaving it
                  to CSS is what lets the ≤820px rule grow it for touch — an inline
                  style would win over the media query. */}
              <Avatar name={c.contact.displayName} email={c.contact.email} color={c.contact.avatarColor} className="av" />
              <div className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className={"text-md whitespace-nowrap overflow-hidden text-ellipsis flex-initial min-w-0 " + (c.unread ? "font-semibold" : "font-medium")}>{c.contact.displayName}</span>
                  {/* Channel glyph sits after the name (like the thread header),
                      not as a badge on the avatar. One channel per row. The
                      capsule behind it was decoration — the glyph's own colour
                      already identifies the channel. */}
                  <span
                    className="inline-flex items-center flex-none self-center [&>svg]:w-[13px] [&>svg]:h-[13px]"
                    style={{ color: cm.color }}
                    title={cm.label}
                    aria-label={cm.label}
                  >
                    <Glyph />
                  </span>
                  <span className="text-2xs text-faint flex-none tabular-nums ml-auto">{listTime(c.lastActivityAt)}</span>
                </div>
                <div className="flex items-center gap-1.5 mt-[3px]">
                  <p className={"m-0 text-sm whitespace-nowrap overflow-hidden text-ellipsis flex-1 " + (c.unread ? "text-fg" : "text-muted")}>
                    {/* The subject leads the line when there is one — on WhatsApp
                        and the website chat Nest writes it (custom fields, then
                        an AI topic), so the list says what each chat is about.
                        Same line as the preview, so a row keeps its height. */}
                    {c.subject && c.subject !== c.contact.displayName && (
                      <span className="text-fg font-semibold">
                        {c.subject}
                        <span className="text-faint font-normal"> — </span>
                      </span>
                    )}
                    {voice && (
                      <span className="inline-flex align-[-2px] mr-1 [&>svg]:w-[13px] [&>svg]:h-[13px]">
                        <MicIcon />
                      </span>
                    )}
                    {previewText}
                  </p>
                  {c.unread &&
                    (c.unreadCount > 0 ? (
                      <span
                        className="flex-none min-w-5 h-5 px-1.5 rounded-full bg-wa text-white text-2xs font-extrabold inline-grid place-items-center tabular-nums leading-none shadow-[0_1px_2px_rgba(13,21,18,.18)]"
                        title={`${c.unreadCount} unread`}
                      >
                        {c.unreadCount > 99 ? "99+" : c.unreadCount}
                      </span>
                    ) : (
                      <span
                        className="flex-none w-[11px] h-[11px] rounded-full bg-wa shadow-[0_1px_2px_rgba(13,21,18,.18)]"
                        title="Unread"
                        aria-label="Unread"
                      />
                    ))}
                </div>
                {/* Operational metadata — ownership, routing and urgency stay on
                    the row (agents scan these constantly), but as one quiet line
                    of text instead of four tinted capsules. Colour is spent only
                    where it means "act on this": brand for yours, amber for
                    waking/at-risk, red for breached. Everything else is muted. */}
                <div className="convmeta">
                  {c.status === "snoozed" && c.snoozedUntil ? (
                    new Date(c.snoozedUntil).getTime() <= Date.now() ? (
                      <span className="convmeta__i is-due" title={`Due since ${new Date(c.snoozedUntil).toLocaleString()}`}>
                        <SnoozeIcon />
                        Due now
                      </span>
                    ) : (
                      <span className="convmeta__i is-warn" title={`Wakes ${new Date(c.snoozedUntil).toLocaleString()}`}>
                        <SnoozeIcon />
                        Snoozed · {timeUntil(c.snoozedUntil)} left
                      </span>
                    )
                  ) : (
                    <>
                      {c.snoozedUntil && new Date(c.snoozedUntil).getTime() <= Date.now() && (
                        <span
                          className="convmeta__i is-warn"
                          title={`Back from Later — was snoozed until ${new Date(c.snoozedUntil).toLocaleString()}`}
                        >
                          <SnoozeIcon />
                          Back from Later
                        </span>
                      )}
                      <span
                        className={"convmeta__own " + (mine ? "is-mine" : assignedOther ? "is-other" : "is-queue")}
                        title={assignedOther && c.assigneeName ? `Assigned to ${c.assigneeName}` : undefined}
                      >
                        <span className="convmeta__dot" aria-hidden="true" />
                        {mine ? "Yours" : assignedOther ? c.assigneeName?.split(" ")[0] ?? "Assigned" : "Queue"}
                      </span>
                      {showTeamTag && teamName(c.assignedTeamId) && (
                        <span className="convmeta__team" title={`Routed to ${teamName(c.assignedTeamId)}`}>
                          {teamName(c.assignedTeamId)}
                        </span>
                      )}
                      {c.slaDueAt &&
                        (new Date(c.slaDueAt).getTime() <= Date.now() ? (
                          <span className="convmeta__i is-over" title="First-response SLA breached">
                            <span className="convmeta__pulse" />
                            Overdue
                          </span>
                        ) : (
                          <span className="convmeta__i is-warn tabular-nums" title="Time left to first response">
                            <span className="convmeta__pulse is-static" />
                            {slaCountdown(c.slaDueAt)}
                          </span>
                        ))}
                    </>
                  )}
                </div>
              </div>
                  </button>
                </div>
              );
            })}
          </div>
        )}
        {pager.isFetchingNextPage && <div className="empty">Loading more…</div>}
      </div>

      <div
        className={"list__resizer" + (resizing ? " active" : "")}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize conversation list"
        aria-valuenow={getListWidth()}
        aria-valuemin={LIST_MIN}
        aria-valuemax={LIST_MAX}
        tabIndex={0}
        title="Drag to resize · double-click to reset"
        onPointerDown={startResize}
        onDoubleClick={resetResize}
        onKeyDown={nudgeResize}
      >
        <span className="list__resizer-bar" />
      </div>
    </section>
  );
}
