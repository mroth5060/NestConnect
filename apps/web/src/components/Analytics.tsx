import { Fragment, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import type { AnalyticsRange, AnalyticsResult, ChannelType } from "@ding/schemas";
import { useAnalytics, useMe, usePeople, useTeams } from "../hooks";
import { channelMeta, InboxIcon, MailIcon, ClockIcon, CheckCircleIcon, ContactsIcon, BoltIcon } from "../lib/icons";
import { initials, avatarBg } from "../lib/format";

/* ── formatting ─────────────────────────────────────────────────────────── */
const nf = new Intl.NumberFormat("en-GB");
const fmt = (n: number) => nf.format(Math.round(n));
function humanDur(ms: number | null): string {
  if (ms == null) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm ? `${h}h ${rm}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}
const pctText = (x: number) => `${Math.round(x * 100)}%`;
/** % change vs previous period; null when there's no baseline to compare to. */
function pctDelta(cur: number, prev: number): number | null {
  if (prev === 0) return cur === 0 ? 0 : null;
  return ((cur - prev) / prev) * 100;
}

const RANGES: Array<{ key: AnalyticsRange; label: string }> = [
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "90d", label: "90 days" },
  { key: "12m", label: "12 months" },
];
const CHANNEL_LABEL: Record<ChannelType, string> = {
  whatsapp: "WhatsApp",
  whatsapp_group: "Groups",
  email: "Email",
  nestchat: "NestChat",
  sms: "SMS",
};
const channelColor = (c: ChannelType) => channelMeta(c).color;

/* ── measure hook (crisp charts at real pixel width) ────────────────────── */
function useMeasure<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setW(e.contentRect.width);
    });
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/* ── KPI card ───────────────────────────────────────────────────────────── */
function DeltaChip({ delta, inverse }: { delta: number | null; inverse?: boolean }) {
  if (delta === null) return <span className="an-kpi__delta is-new">New</span>;
  const rounded = Math.round(delta);
  const good = inverse ? rounded < 0 : rounded > 0;
  const bad = inverse ? rounded > 0 : rounded < 0;
  const cls = rounded === 0 ? "is-flat" : good ? "is-good" : bad ? "is-bad" : "is-flat";
  const arrow = rounded > 0 ? "↑" : rounded < 0 ? "↓" : "→";
  return (
    <span className={"an-kpi__delta " + cls}>
      {arrow} {Math.abs(rounded)}%
    </span>
  );
}

function Sparkline({ values, color }: { values: number[]; color: string }) {
  const W = 96;
  const H = 30;
  if (values.length < 2) return <svg className="an-kpi__spark" width={W} height={H} aria-hidden="true" />;
  const max = Math.max(...values, 1);
  const step = W / (values.length - 1);
  const pts = values.map((v, i) => [i * step, H - 2 - (v / max) * (H - 4)] as const);
  const line = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  const area = `${line} L ${W} ${H} L 0 ${H} Z`;
  const id = "sk" + color.replace(/[^a-z0-9]/gi, "");
  return (
    <svg className="an-kpi__spark" width={W} height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function Kpi(props: {
  icon?: ReactNode;
  label: string;
  value: string;
  /** Previous-period comparison; omit for metrics with no baseline (e.g. rates). */
  delta?: { cur: number; prev: number; inverse?: boolean };
  spark?: number[];
  foot?: string;
  accent?: string;
}) {
  return (
    <div className="an-kpi">
      <div className="an-kpi__top">
        <span className="an-kpi__label">
          {props.icon && <span className="an-kpi__ic" style={props.accent ? { color: props.accent } : undefined}>{props.icon}</span>}
          {props.label}
        </span>
        {props.delta && <DeltaChip delta={pctDelta(props.delta.cur, props.delta.prev)} inverse={props.delta.inverse} />}
      </div>
      <div className="an-kpi__value">{props.value}</div>
      {props.spark && props.spark.length > 1 ? (
        <Sparkline values={props.spark} color={props.accent ?? "var(--brand)"} />
      ) : props.foot ? (
        <div className="an-kpi__prev">{props.foot}</div>
      ) : null}
    </div>
  );
}

/* ── stacked area trend (inbound + outbound per day) ────────────────────── */
function TrendChart({ daily }: { daily: AnalyticsResult["daily"] }) {
  const [ref, W] = useMeasure<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const H = 260;
  const pad = { l: 6, r: 6, t: 14, b: 24 };
  const n = daily.length;
  const iw = Math.max(0, W - pad.l - pad.r);
  const ih = H - pad.t - pad.b;
  const max = Math.max(1, ...daily.map((d) => d.inbound + d.outbound));
  const x = (i: number) => pad.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v: number) => pad.t + ih - (v / max) * ih;

  const inTop = daily.map((d, i) => [x(i), y(d.inbound)] as const);
  const totTop = daily.map((d, i) => [x(i), y(d.inbound + d.outbound)] as const);
  const baseline = pad.t + ih;
  const lineOf = (pts: readonly (readonly [number, number])[]) =>
    pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  const inArea = n ? `${lineOf(inTop)} L ${x(n - 1)} ${baseline} L ${x(0)} ${baseline} Z` : "";
  const outArea = n ? `${lineOf(totTop)} ${inTop.map((p) => `L ${p[0].toFixed(1)} ${p[1].toFixed(1)}`).reverse().join(" ")} Z` : "";

  // x-axis: ~6 evenly spaced date ticks.
  const ticks = useMemo(() => {
    if (!n) return [] as Array<{ i: number; label: string }>;
    const count = Math.min(6, n);
    const out: Array<{ i: number; label: string }> = [];
    for (let k = 0; k < count; k++) {
      const i = Math.round((k / (count - 1 || 1)) * (n - 1));
      const d = new Date(daily[i].date + "T00:00:00Z");
      out.push({ i, label: d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) });
    }
    return out;
  }, [daily, n]);

  const onMove = (e: MouseEvent<SVGSVGElement>) => {
    if (!n) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const i = Math.round(((mx - pad.l) / (iw || 1)) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };
  const hd = hover != null ? daily[hover] : null;

  return (
    <div className="an-card an-card--wide">
      <div className="an-card__hd">
        <div>
          <h3 className="an-card__title">Message volume</h3>
          <p className="an-card__sub">Inbound &amp; outbound per day</p>
        </div>
        <div className="an-legend">
          <span className="an-legend__i"><i style={{ background: "var(--email)" }} />Inbound</span>
          <span className="an-legend__i"><i style={{ background: "var(--brand)" }} />Outbound</span>
        </div>
      </div>
      <div className="an-chart" ref={ref}>
        {W > 0 && (
          <svg width={W} height={H} onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img" aria-label="Daily message volume">
            <defs>
              <linearGradient id="an-in" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--email)" stopOpacity="0.30" />
                <stop offset="100%" stopColor="var(--email)" stopOpacity="0.02" />
              </linearGradient>
              <linearGradient id="an-out" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--brand)" stopOpacity="0.34" />
                <stop offset="100%" stopColor="var(--brand)" stopOpacity="0.03" />
              </linearGradient>
            </defs>
            {/* horizontal gridlines */}
            {[0.25, 0.5, 0.75, 1].map((f) => (
              <line key={f} x1={pad.l} x2={W - pad.r} y1={pad.t + ih - f * ih} y2={pad.t + ih - f * ih} className="an-grid" />
            ))}
            <path d={outArea} fill="url(#an-out)" />
            <path d={inArea} fill="url(#an-in)" />
            <path d={lineOf(totTop)} fill="none" stroke="var(--brand)" strokeWidth="2" strokeLinejoin="round" />
            <path d={lineOf(inTop)} fill="none" stroke="var(--email)" strokeWidth="1.5" strokeLinejoin="round" strokeOpacity="0.8" />
            {ticks.map((t) => (
              <text key={t.i} x={x(t.i)} y={H - 6} className="an-axis" textAnchor="middle">
                {t.label}
              </text>
            ))}
            {hover != null && hd && (
              <g>
                <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={baseline} className="an-cursor" />
                <circle cx={x(hover)} cy={y(hd.inbound + hd.outbound)} r="3.5" fill="var(--brand)" />
                <circle cx={x(hover)} cy={y(hd.inbound)} r="3" fill="var(--email)" />
              </g>
            )}
          </svg>
        )}
        {hover != null && hd && (
          <div
            className="an-tip"
            style={{ left: Math.min(Math.max(x(hover), 70), Math.max(70, W - 70)) }}
          >
            <div className="an-tip__d">{new Date(hd.date + "T00:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })}</div>
            <div className="an-tip__r"><span><i style={{ background: "var(--brand)" }} />Outbound</span><b>{fmt(hd.outbound)}</b></div>
            <div className="an-tip__r"><span><i style={{ background: "var(--email)" }} />Inbound</span><b>{fmt(hd.inbound)}</b></div>
            <div className="an-tip__r an-tip__r--t"><span>New chats</span><b>{fmt(hd.conversations)}</b></div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── donut ──────────────────────────────────────────────────────────────── */
function Donut({ segments, total, centerLabel }: { segments: Array<{ label: string; value: number; color: string }>; total: number; centerLabel: string }) {
  const r = 52;
  const C = 2 * Math.PI * r;
  let acc = 0;
  return (
    <div className="an-donut">
      <svg width="128" height="128" viewBox="0 0 128 128">
        <circle cx="64" cy="64" r={r} fill="none" stroke="var(--surface-2)" strokeWidth="16" />
        {total > 0 &&
          segments.map((s, i) => {
            const len = (s.value / total) * C;
            const el = (
              <circle
                key={i}
                cx="64"
                cy="64"
                r={r}
                fill="none"
                stroke={s.color}
                strokeWidth="16"
                strokeDasharray={`${len} ${C - len}`}
                strokeDashoffset={-acc}
                transform="rotate(-90 64 64)"
                strokeLinecap="butt"
              />
            );
            acc += len;
            return el;
          })}
        <text x="64" y="60" textAnchor="middle" className="an-donut__num">{fmt(total)}</text>
        <text x="64" y="78" textAnchor="middle" className="an-donut__lbl">{centerLabel}</text>
      </svg>
      <div className="an-donut__legend">
        {segments.map((s) => (
          <div key={s.label} className="an-donut__row">
            <span className="an-donut__sw" style={{ background: s.color }} />
            <span className="an-donut__name">{s.label}</span>
            <span className="an-donut__val">{fmt(s.value)}</span>
            <span className="an-donut__pct">{total ? Math.round((s.value / total) * 100) : 0}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── horizontal bars ────────────────────────────────────────────────────── */
function HBars({ rows, unit }: { rows: Array<{ label: string; value: number; color?: string; note?: string }>; unit?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (!rows.length) return <div className="an-empty">No data in this range.</div>;
  return (
    <div className="an-bars">
      {rows.map((r) => (
        <div className="an-bar" key={r.label}>
          <div className="an-bar__top">
            <span className="an-bar__label" title={r.label}>{r.label}</span>
            <span className="an-bar__val">
              {fmt(r.value)}
              {unit ? <span className="an-bar__unit">{unit}</span> : null}
              {r.note ? <span className="an-bar__note">{r.note}</span> : null}
            </span>
          </div>
          <div className="an-bar__track">
            <div className="an-bar__fill" style={{ width: `${(r.value / max) * 100}%`, background: r.color ?? "var(--brand)" }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── activity heatmap (weekday × hour) ──────────────────────────────────── */
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
function Heatmap({ cells }: { cells: number[] }) {
  const max = Math.max(1, ...cells);
  return (
    <div className="an-heat">
      <div className="an-heat__grid">
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h} className="an-heat__hx">{h % 6 === 0 ? `${h}` : ""}</span>
        ))}
        {WEEKDAYS.map((wd, d) => (
          <Fragment key={wd}>
            <span className="an-heat__wd">{wd}</span>
            {Array.from({ length: 24 }, (_, h) => {
              const v = cells[d * 24 + h] ?? 0;
              const a = v === 0 ? 0 : 0.12 + 0.88 * (v / max);
              return (
                <span
                  key={`${d}-${h}`}
                  className="an-heat__c"
                  title={`${wd} ${h}:00 — ${v} message${v === 1 ? "" : "s"}`}
                  style={{ background: v === 0 ? "var(--surface-2)" : `color-mix(in srgb, var(--brand) ${Math.round(a * 100)}%, transparent)` }}
                />
              );
            })}
          </Fragment>
        ))}
      </div>
      <div className="an-heat__scale">
        <span>Less</span>
        <i style={{ background: "var(--surface-2)" }} />
        <i style={{ background: "color-mix(in srgb, var(--brand) 30%, transparent)" }} />
        <i style={{ background: "color-mix(in srgb, var(--brand) 60%, transparent)" }} />
        <i style={{ background: "var(--brand)" }} />
        <span>More</span>
      </div>
    </div>
  );
}

/* ── select control ─────────────────────────────────────────────────────── */
function Select({ value, onChange, children }: { value: string; onChange: (v: string) => void; children: React.ReactNode }) {
  return (
    <div className="an-select">
      <select value={value} onChange={(e) => onChange(e.target.value)}>{children}</select>
      <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </div>
  );
}

const STATUS_META: Record<string, { label: string; color: string }> = {
  open: { label: "Open", color: "var(--brand)" },
  pending: { label: "Pending", color: "var(--amber)" },
  snoozed: { label: "Snoozed", color: "var(--group)" },
  closed: { label: "Closed", color: "var(--text-faint)" },
};
const PRIORITY_META: Record<string, { label: string; color: string }> = {
  urgent: { label: "Urgent", color: "var(--danger)" },
  high: { label: "High", color: "var(--amber)" },
  normal: { label: "Normal", color: "var(--brand)" },
  low: { label: "Low", color: "var(--text-faint)" },
};

export function Analytics() {
  const { data: me } = useMe();
  const { data: teams } = useTeams();
  const { data: people } = usePeople();
  const [range, setRange] = useState<AnalyticsRange>("30d");
  const [channel, setChannel] = useState<string>("all");
  const [teamId, setTeamId] = useState<string>("all");
  const [agentUserId, setAgentUserId] = useState<string>("all");

  const isAllowed = me?.user.role === "admin" || me?.user.role === "manager";
  const q = useAnalytics({ range, channel, teamId, agentUserId });
  const d = q.data;

  const nameById = useMemo(() => new Map((people ?? []).map((m) => [m.user.id, m.user.name])), [people]);

  if (!isAllowed) {
    return (
      <div className="an">
        <div className="an__empty-full">
          <div className="an__empty-ic"><BoltIcon /></div>
          <h2>Insights are for admins &amp; managers</h2>
          <p>Ask an administrator if you need access to team analytics.</p>
        </div>
      </div>
    );
  }

  const k = d?.kpis;
  const dailyConv = (d?.daily ?? []).map((p) => p.conversations);
  const dailyMsg = (d?.daily ?? []).map((p) => p.inbound + p.outbound);

  return (
    <div className="an">
      <header className="an__head">
        <div className="an__head-l">
          <h1 className="an__title">Insights</h1>
          <p className="an__sub">
            {d ? `${new Date(d.range.from).toLocaleDateString("en-GB", { day: "numeric", month: "short" })} – ${new Date(d.range.to).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : "Team performance & volumes"}
          </p>
        </div>
        <div className="an__filters">
          <div className="an-seg">
            {RANGES.map((r) => (
              <button key={r.key} className={"an-seg__b" + (range === r.key ? " on" : "")} onClick={() => setRange(r.key)}>
                {r.label}
              </button>
            ))}
          </div>
          <Select value={channel} onChange={setChannel}>
            <option value="all">All channels</option>
            <option value="whatsapp">WhatsApp</option>
            <option value="whatsapp_group">Groups</option>
            <option value="email">Email</option>
          </Select>
          <Select value={teamId} onChange={setTeamId}>
            <option value="all">All teams</option>
            {(teams ?? []).map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </Select>
          <Select value={agentUserId} onChange={setAgentUserId}>
            <option value="all">All agents</option>
            {(people ?? []).map((m) => (
              <option key={m.user.id} value={m.user.id}>{m.user.name}</option>
            ))}
          </Select>
        </div>
      </header>

      <div className={"an__scroll" + (q.isFetching ? " is-loading" : "")}>
        {!d ? (
          <div className="an__loading">{q.isError ? "Couldn’t load analytics." : "Loading insights…"}</div>
        ) : (
          <>
            {/* KPI row */}
            <section className="an__kpis">
              <Kpi icon={<InboxIcon />} accent="var(--brand)" label="Conversations" value={fmt(k!.conversations)} delta={{ cur: k!.conversations, prev: k!.prev.conversations }} spark={dailyConv} />
              <Kpi icon={<MailIcon />} accent="var(--email)" label="Messages" value={fmt(k!.messages)} delta={{ cur: k!.messages, prev: k!.prev.messages }} spark={dailyMsg} />
              <Kpi icon={<ContactsIcon />} accent="var(--group)" label="New customers" value={fmt(k!.newContacts)} delta={{ cur: k!.newContacts, prev: k!.prev.newContacts }} foot={`vs ${fmt(k!.prev.newContacts)} previous`} />
              <Kpi icon={<ClockIcon />} accent="var(--amber)" label="First response" value={humanDur(k!.avgFirstResponseMs)} delta={{ cur: k!.avgFirstResponseMs ?? 0, prev: k!.prev.avgFirstResponseMs ?? 0, inverse: true }} foot={`vs ${humanDur(k!.prev.avgFirstResponseMs)} previous`} />
              <Kpi icon={<CheckCircleIcon />} accent="var(--brand)" label="Resolution rate" value={pctText(k!.resolutionRate)} foot={`${fmt(k!.resolved)} resolved`} />
              <Kpi icon={<BoltIcon />} accent="var(--brand-strong)" label="Response rate" value={pctText(k!.responseRate)} foot={`${fmt(Math.round(k!.responseRate * k!.conversations))} answered`} />
            </section>

            {/* snapshot strip */}
            <section className="an__snap">
              <div className="an-snap"><span className="an-snap__n">{fmt(d.snapshot.open)}</span><span className="an-snap__l">Open now</span></div>
              <div className="an-snap"><span className="an-snap__n">{fmt(d.snapshot.pending)}</span><span className="an-snap__l">Pending</span></div>
              <div className="an-snap"><span className="an-snap__n">{fmt(d.snapshot.snoozed)}</span><span className="an-snap__l">Snoozed</span></div>
              <div className="an-snap"><span className="an-snap__n">{fmt(d.snapshot.unassigned)}</span><span className="an-snap__l">Unassigned</span></div>
              <div className="an-snap"><span className="an-snap__n">{humanDur(k!.medianFirstResponseMs)}</span><span className="an-snap__l">Median response</span></div>
              <div className="an-snap"><span className="an-snap__n">{k!.avgMessagesPerConversation.toFixed(1)}</span><span className="an-snap__l">Msgs / chat</span></div>
            </section>

            {/* main grid */}
            <section className="an__grid">
              <TrendChart daily={d.daily} />

              <div className="an-card">
                <div className="an-card__hd"><div><h3 className="an-card__title">By channel</h3><p className="an-card__sub">Conversations started</p></div></div>
                <Donut
                  total={d.byChannel.reduce((a, c) => a + c.conversations, 0)}
                  centerLabel="chats"
                  segments={d.byChannel.map((c) => ({ label: CHANNEL_LABEL[c.channel], value: c.conversations, color: channelColor(c.channel) }))}
                />
              </div>

              <div className="an-card">
                <div className="an-card__hd"><div><h3 className="an-card__title">First response time</h3><p className="an-card__sub">Distribution across answered chats</p></div></div>
                <HBars rows={d.responseBuckets.map((b, i) => ({ label: b.label, value: b.count, color: ["var(--brand)", "var(--brand)", "var(--wa)", "var(--amber)", "var(--amber)", "var(--danger)"][i] }))} />
              </div>

              <div className="an-card">
                <div className="an-card__hd"><div><h3 className="an-card__title">Conversation status</h3><p className="an-card__sub">Of chats started in range</p></div></div>
                <HBars rows={d.byStatus.map((s) => ({ label: STATUS_META[s.status]?.label ?? s.status, value: s.count, color: STATUS_META[s.status]?.color }))} />
              </div>

              <div className="an-card">
                <div className="an-card__hd"><div><h3 className="an-card__title">By team</h3><p className="an-card__sub">Conversations handled</p></div></div>
                <HBars rows={d.byTeam.map((t) => ({ label: t.name, value: t.conversations }))} />
              </div>

              <div className="an-card">
                <div className="an-card__hd"><div><h3 className="an-card__title">By priority</h3><p className="an-card__sub">Chats started in range</p></div></div>
                <HBars rows={d.byPriority.map((p) => ({ label: PRIORITY_META[p.priority]?.label ?? p.priority, value: p.count, color: PRIORITY_META[p.priority]?.color }))} />
              </div>

              {d.byLabel.length > 0 && (
                <div className="an-card">
                  <div className="an-card__hd"><div><h3 className="an-card__title">By label</h3><p className="an-card__sub">Tagged conversations</p></div></div>
                  <HBars rows={d.byLabel.map((l) => ({ label: l.name, value: l.conversations, color: l.color }))} />
                </div>
              )}

              {/* Agent leaderboard */}
              <div className="an-card an-card--wide">
                <div className="an-card__hd"><div><h3 className="an-card__title">Agent leaderboard</h3><p className="an-card__sub">Replies sent, chats owned & response time</p></div></div>
                {d.agents.length === 0 ? (
                  <div className="an-empty">No agent activity in this range.</div>
                ) : (
                  <div className="an-lead">
                    <div className="an-lead__head">
                      <span>Agent</span><span>Replies</span><span>Chats</span><span>Avg response</span>
                    </div>
                    {(() => {
                      const maxReplies = Math.max(1, ...d.agents.map((a) => a.replies));
                      return d.agents.map((a, i) => (
                        <div className="an-lead__row" key={a.userId}>
                          <span className="an-lead__who">
                            <span className="an-lead__rank">{i + 1}</span>
                            <span className="an-lead__av" style={{ background: avatarBg(a.name, a.avatarColor) }}>{initials(nameById.get(a.userId) ?? a.name)}</span>
                            <span className="an-lead__name">{nameById.get(a.userId) ?? a.name}</span>
                          </span>
                          <span className="an-lead__replies">
                            <span className="an-lead__barwrap"><span className="an-lead__bar" style={{ width: `${(a.replies / maxReplies) * 100}%` }} /></span>
                            <b>{fmt(a.replies)}</b>
                          </span>
                          <span className="an-lead__num">{fmt(a.conversations)}</span>
                          <span className="an-lead__num">{humanDur(a.avgFirstResponseMs)}</span>
                        </div>
                      ));
                    })()}
                  </div>
                )}
              </div>

              {/* Heatmap */}
              <div className="an-card an-card--wide">
                <div className="an-card__hd"><div><h3 className="an-card__title">Busiest times</h3><p className="an-card__sub">Message volume by day &amp; hour (UTC)</p></div></div>
                <Heatmap cells={d.heatmap} />
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
