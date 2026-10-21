import { useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { useLogout, useMe, useSound, useTeams, useTheme, useViews } from "../hooks";
import {
  ChevronRight,
  ChevronsLeftIcon,
  ContactsIcon,
  InboxIcon,
  InsightsIcon,
  SnoozeIcon,
  TeamGlyph,
  ThemeIcon,
  SunIcon,
  SoundOnIcon,
  SoundOffIcon,
  SettingsIcon,
  LogoutIcon,
  XIcon,
  channelMeta,
} from "../lib/icons";
import { initials, avatarBg } from "../lib/format";
import { toggleTheme } from "../lib/theme";

interface Props {
  view: string;
  onSelectView: (key: string) => void;
  onSelectConversation?: (id: string) => void;
  onClose?: () => void;
  onOpenSettings?: () => void;
  onOpenCustomers?: () => void;
  /** Opens the insights dashboard (admin/manager only — the button self-hides
   *  for agents). The desktop route is the icon rail; this is the drawer route. */
  onOpenInsights?: () => void;
  /** Opens the current user's own personal settings (profile, availability,
   *  signature, password). On desktop this lives in the icon-rail avatar menu;
   *  in the drawer it's reached by tapping your profile. */
  onOpenPersonalSettings?: () => void;
  /** Desktop only: collapse the sidebar to the icon rail. */
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
}

export function Sidebar({ view, onSelectView, onSelectConversation, onClose, onOpenSettings, onOpenCustomers, onOpenInsights, onOpenPersonalSettings, isCollapsed, onToggleCollapse }: Props) {
  const { data } = useViews();
  const { data: meData } = useMe();
  const { data: teamList } = useTeams();
  const logout = useLogout();
  const sound = useSound();
  const theme = useTheme();
  const me = meData?.user;
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const teamIconFor = (key: string) => teamList?.find((tm) => `team:${tm.id}` === key)?.icon ?? null;
  const toggle = (key: string) => setCollapsed((c) => ({ ...c, [key]: !c[key] }));

  // Slide a single "capsule" highlight to the active view row (nav or sub),
  // so switching inboxes/channels animates instead of hard-jumping.
  const scrollRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLSpanElement>(null);
  const firstMove = useRef(true);
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    const thumb = thumbRef.current;
    if (!scroll || !thumb) return;
    const move = () => {
      const active = scroll.querySelector<HTMLElement>(".navrow.active, .subrow.active");
      if (!active) {
        thumb.style.opacity = "0";
        return;
      }
      const apply = () => {
        thumb.style.transform = `translate(${active.offsetLeft}px, ${active.offsetTop}px)`;
        thumb.style.width = `${active.offsetWidth}px`;
        thumb.style.height = `${active.offsetHeight}px`;
        thumb.style.opacity = "1";
      };
      if (firstMove.current) {
        // Place it without animating on first paint (no slide-from-origin flash).
        thumb.style.transition = "none";
        apply();
        void thumb.offsetHeight; // force reflow so the next change transitions
        thumb.style.transition = "";
        firstMove.current = false;
      } else {
        apply();
      }
    };
    move();
    window.addEventListener("resize", move);
    // Re-measure once the collapse/expand width transition settles, otherwise the
    // active capsule stays stuck at the collapsed (square) size after expanding.
    const aside = scroll.closest(".side");
    const onTransitionEnd = (e: Event) => {
      const p = (e as TransitionEvent).propertyName;
      if (p === "width" || p === "flex-basis") move();
    };
    aside?.addEventListener("transitionend", onTransitionEnd);
    return () => {
      window.removeEventListener("resize", move);
      aside?.removeEventListener("transitionend", onTransitionEnd);
    };
  }, [view, data, collapsed, teamList, isCollapsed]);

  // A second, subtler capsule that glides under the pointer as you hover across
  // rows (snaps in on first entry so it doesn't streak across from nowhere).
  const hoverRef = useRef<HTMLSpanElement>(null);
  const hoverRow = useRef<HTMLElement | null>(null);
  const onRowHover = (e: MouseEvent) => {
    const row = (e.target as HTMLElement).closest?.(".navrow, .subrow") as HTMLElement | null;
    const h = hoverRef.current;
    if (!h || !row || row === hoverRow.current || !scrollRef.current?.contains(row)) return;
    const firstEntry = hoverRow.current === null;
    if (firstEntry) h.style.transition = "opacity .16s ease"; // snap position, fade in
    h.style.transform = `translate(${row.offsetLeft}px, ${row.offsetTop}px)`;
    h.style.width = `${row.offsetWidth}px`;
    h.style.height = `${row.offsetHeight}px`;
    h.style.opacity = "1";
    if (firstEntry) {
      void h.offsetHeight;
      h.style.transition = "";
    }
    hoverRow.current = row;
  };
  const onRowsLeave = () => {
    hoverRow.current = null;
    if (hoverRef.current) hoverRef.current.style.opacity = "0";
  };

  if (!data)
    return <aside className={"side" + (isCollapsed ? " is-collapsed" : "")} aria-label="Inboxes" />;

  const inbound = data.my.find((m) => m.key === "inbound");
  const subs = data.my.filter((m) => m.key !== "inbound");

  return (
    <aside className={"side" + (isCollapsed ? " is-collapsed" : "")} aria-label="Inboxes">
      <div className="side__head">
        <span className="wordmark">
          Nest <span className="dot">Connect</span>
        </span>
        <span className="side__sub">Hermolis</span>
        {onToggleCollapse && (
          <button
            className="side__collapse"
            onClick={onToggleCollapse}
            aria-label={isCollapsed ? "Expand inboxes" : "Collapse inboxes"}
            title={isCollapsed ? "Expand inboxes" : "Collapse inboxes"}
          >
            <ChevronsLeftIcon />
          </button>
        )}
        {onClose && (
          <button className="side__close" onClick={onClose} aria-label="Close menu" title="Close">
            <XIcon />
          </button>
        )}
      </div>
      <div className="side__scroll" ref={scrollRef} onMouseOver={onRowHover} onMouseLeave={onRowsLeave}>
        <span className="navhover" ref={hoverRef} aria-hidden="true" />
        <span className="navthumb" ref={thumbRef} aria-hidden="true" />
        <div className="sect-label">
          My space <span className="line" />
        </div>
        {inbound && (
          <button
            className={"navrow" + (view === inbound.key ? " active" : "")}
            onClick={() => onSelectView(inbound.key)}
          >
            <span className="navicon">
              <InboxIcon />
            </span>
            <span className="lbl">{inbound.title}</span>
            <span className="badge on">{inbound.count}</span>
          </button>
        )}
        <div className="subwrap flex flex-col gap-px my-0.5 ml-[30px] [animation:subIn_.22s_var(--ease)]">
          {subs.map((s) => {
            const due = s.key === "snoozed" && (s.due ?? 0) > 0;
            return (
              <button
                key={s.key}
                className={"subrow" + (view === s.key ? " active" : "") + (due ? " has-due" : "")}
                onClick={() => onSelectView(s.key)}
                title={due ? `${s.due} due to wake` : undefined}
              >
                {due ? (
                  <span className="duebell" aria-label="Something is due">
                    <SnoozeIcon />
                  </span>
                ) : (
                  <span className="mk" />
                )}
                <span className="lbl">{s.title}</span>
                <span className={"n" + (due ? " warn" : "")}>{s.count}</span>
              </button>
            );
          })}
        </div>

        <div className="sect-label">
          Team Inboxes <span className="line" />
        </div>
        {data.shared.teams.map((t) => (
          <button
            key={t.key}
            className={"navrow" + (view === t.key ? " active" : "")}
            onClick={() => onSelectView(t.key)}
          >
            <span className="navicon">
              <TeamGlyph icon={teamIconFor(t.key)} />
            </span>
            <span className="lbl">{t.title}</span>
            <span className="badge">{t.count}</span>
          </button>
        ))}

        <div className="sect-label">
          Channels <span className="line" />
        </div>
        {data.shared.inboxes.map((i) => {
          const cm = i.channel ? channelMeta(i.channel) : null;
          const Glyph = cm?.Glyph;
          const groups = i.groups ?? [];
          const open = groups.length > 0 && !collapsed[i.key];
          const gm = channelMeta("whatsapp_group");
          const GroupGlyph = gm.Glyph;
          return (
            <div key={i.key}>
              <button
                className={"navrow" + (view === i.key ? " active" : "")}
                onClick={() => onSelectView(i.key)}
              >
                <span className="navicon chan" style={{ color: cm ? cm.color : "var(--text-faint)" }}>
                  {Glyph ? <Glyph /> : <span className="cdot" style={{ background: "var(--text-faint)" }} />}
                </span>
                <span className="lbl">{i.title}</span>
                {groups.length > 0 && (
                  <span
                    className={"navchev" + (open ? " open" : "")}
                    role="button"
                    tabIndex={-1}
                    title={open ? "Collapse groups" : "Show groups"}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle(i.key);
                    }}
                  >
                    <ChevronRight />
                  </span>
                )}
                <span className={"badge" + (i.count > 0 ? " on" : "")}>{i.count}</span>
              </button>
              {open && (
                <div className="subwrap flex flex-col gap-px my-0.5 ml-[30px] [animation:subIn_.22s_var(--ease)]">
                  {groups.map((g) => (
                    <button key={g.id} className="subrow" onClick={() => onSelectConversation?.(g.id)}>
                      <span className="navicon" style={{ color: gm.color, width: 16, flex: "0 0 16px" }}>
                        <GroupGlyph />
                      </span>
                      <span className="lbl">{g.title}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {data.shared.labels.length > 0 && (
          <>
            <div className="sect-label">
              Labels <span className="line" />
            </div>
            {data.shared.labels.map((l) => (
              <button
                key={l.key}
                className={"navrow" + (view === l.key ? " active" : "")}
                onClick={() => onSelectView(l.key)}
              >
                <span className="navicon">
                  <span className="cdot" style={{ background: l.color ?? "var(--text-faint)" }} />
                </span>
                <span className="lbl">{l.title}</span>
                <span className={"badge" + (l.count > 0 ? " on" : "")}>{l.count}</span>
              </button>
            ))}
          </>
        )}
      </div>

      <div className="side__foot">
        {/* Tapping your profile opens personal settings — the mobile route to it,
            since the icon-rail avatar menu (its desktop home) is hidden here. */}
        <button
          type="button"
          className="side__me"
          onClick={() => onOpenPersonalSettings?.()}
          disabled={!onOpenPersonalSettings}
          title="Personal settings"
          aria-label="Open your personal settings"
        >
          <span className="av" style={{ background: avatarBg(me?.name ?? "", me?.avatarColor), width: 34, height: 34, fontSize: 12 }}>
            {me?.avatarUrl ? <img className="av__photo" src={me.avatarUrl} alt="" /> : me ? initials(me.name) : "··"}
          </span>
          <div className="side__me-id">
            <b>{me?.name ?? "You"}</b>
            <small>{me?.email}</small>
          </div>
          {onOpenPersonalSettings && <span className="side__me-go" aria-hidden="true"><ChevronRight /></span>}
        </button>
        <div className="flex items-center gap-2">
          {onOpenInsights && (me?.role === "admin" || me?.role === "manager") && (
            <button className="iconbtn" title="Insights" onClick={onOpenInsights}>
              <InsightsIcon />
            </button>
          )}
          {onOpenCustomers && (
            <button className="iconbtn" title="Customers" onClick={onOpenCustomers}>
              <ContactsIcon />
            </button>
          )}
          {onOpenSettings && (
            <button className="iconbtn" title="Settings" onClick={onOpenSettings}>
              <SettingsIcon />
            </button>
          )}
          <button
            className="iconbtn"
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            onClick={toggleTheme}
          >
            {theme === "dark" ? <SunIcon /> : <ThemeIcon />}
          </button>
          <button
            className={"iconbtn" + (sound.on ? " on" : "")}
            title={sound.on ? "Mute sounds" : "Unmute sounds"}
            onClick={sound.toggle}
          >
            {sound.on ? <SoundOnIcon /> : <SoundOffIcon />}
          </button>
          <button
            className="side__signout"
            title="Sign out"
            aria-label="Sign out"
            onClick={() => logout.mutate()}
          >
            <LogoutIcon />
          </button>
        </div>
      </div>
    </aside>
  );
}
