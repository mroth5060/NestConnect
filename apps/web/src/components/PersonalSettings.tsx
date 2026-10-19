import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { UpdateMyProfileInput } from "@ding/schemas";
import {
  DEFAULT_AVAILABILITY_SCHEDULE,
  WEEKDAYS,
  availableNow,
  type AvailabilitySchedule,
  type Weekday,
} from "@ding/schemas";
import {
  useChatStatus,
  useMe,
  useUpdateMyPreferences,
  useUpdateMyProfile,
  useChangePassword,
  useSessions,
  useRevokeSession,
  useRevokeOtherSessions,
  usePushPreferences,
  useUpdatePushPreferences,
} from "../hooks";
import type { PushPreferences, SessionInfo } from "@ding/schemas";
import { TwoFactorSettings } from "./TwoFactorSettings";
import { useScrollLock } from "../lib/useScrollLock";
import { api } from "../lib/api";
import { XIcon } from "../lib/icons";
import { Avatar } from "./Avatar";


/** "Chrome on macOS" from a parsed session, degrading gracefully. */
function deviceLabel(s: SessionInfo): string {
  const browser = s.browser ?? "Unknown browser";
  return s.os ? `${browser} on ${s.os}` : browser;
}

/** Compact "time ago" for a session's last-active stamp. */
function timeAgo(iso: string): string {
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return days < 7 ? `${days}d ago` : new Date(iso).toLocaleDateString();
}

/**
 * A team member's own personal settings, opened from the avatar menu:
 *  - Profile: photo, display name, and login email.
 *  - Availability (accepting round-robin auto-assignments or not).
 *  - Position (job title), filled into the email signature of whichever
 *    channel they send from — the signature itself is designed per channel in
 *    Settings › Channels.
 *  - Password: change it after re-entering the current one.
 */
/**
 * The switches, in the order somebody reads them: mine first, then the noisy one.
 *
 * `teamInbound` is last and worded plainly because it is the one that gets
 * turned on in a quiet week and blamed in a busy one. Every other entry is
 * about something addressed to this person.
 */
const ALERT_TOGGLES: { key: keyof Pick<PushPreferences, "assigned" | "mentions" | "assignments" | "reminders" | "teamChats" | "teamInbound" | "chatMessages">; label: string; detail: string }[] = [
  { key: "assigned", label: "My conversations", detail: "A new message on something assigned to me" },
  { key: "mentions", label: "Mentions", detail: "Someone @mentions me in an internal note or in Team Chat" },
  { key: "assignments", label: "Assignments", detail: "A conversation is handed to me" },
  { key: "reminders", label: "Snooze reminders", detail: "Something I snoozed comes due" },
  { key: "teamChats", label: "New chats for my team", detail: "Every message in a chat waiting for my team, until someone takes it" },
  {
    key: "teamInbound",
    label: "Everything in my team's inboxes",
    detail: "Also messages in chats my colleagues have taken — noisy on a busy shift",
  },
  { key: "chatMessages", label: "Team Chat messages", detail: "A new message in one of my team chats, groups or direct chats" },
];

export function PersonalSettings({ onClose, onToast }: { onClose: () => void; onToast: (msg: string) => void }) {
  const { data } = useMe();
  const me = data?.user;
  const update = useUpdateMyPreferences();
  const chatOn = !!useChatStatus().data?.enabled;
  const profile = useUpdateMyProfile();
  const changePw = useChangePassword();
  const alertPrefs = usePushPreferences();
  const updateAlerts = useUpdatePushPreferences();
  const sessionsQ = useSessions();
  const revokeSession = useRevokeSession();
  const revokeOthers = useRevokeOtherSessions();
  const sessions = sessionsQ.data ?? [];
  const boxRef = useRef<HTMLDivElement>(null);
  useScrollLock(boxRef);
  const photoRef = useRef<HTMLInputElement>(null);

  // Profile
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [position, setPosition] = useState("");
  const [profSeeded, setProfSeeded] = useState(false);

  // Availability
  const [available, setAvailable] = useState(true);
  const [schedule, setSchedule] = useState<AvailabilitySchedule>(() => ({
    ...DEFAULT_AVAILABILITY_SCHEDULE,
    timezone: browserTimeZone(),
  }));
  const [seeded, setSeeded] = useState(false);

  // Password
  const [curPw, setCurPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confPw, setConfPw] = useState("");


  // Seed the profile fields once `me` loads.
  useEffect(() => {
    if (!me || profSeeded) return;
    setName(me.name);
    setEmail(me.email);
    setPosition(me.position ?? "");
    setAvatarUrl(me.avatarUrl ?? null);
    setProfSeeded(true);
  }, [me, profSeeded]);

  // Seed availability once `me` is ready.
  useEffect(() => {
    if (!me || seeded) return;
    setAvailable(me.available);
    if (me.schedule) setSchedule(me.schedule);
    setSeeded(true);
  }, [me, seeded]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);


  const pickPhoto = async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      onToast("That file isn't an image.");
      return;
    }
    if (file.size > 5_000_000) {
      onToast("Photo is too large — keep it under 5 MB.");
      return;
    }
    setUploading(true);
    try {
      const att = await api.uploadMedia(file, { kind: "image", filename: file.name });
      setAvatarUrl(att.url);
    } catch {
      onToast("Couldn’t upload that photo — please try again.");
    } finally {
      setUploading(false);
    }
  };


  const save = async () => {
    // Only send profile fields that actually changed.
    const prof: UpdateMyProfileInput = {};
    if (name.trim() && name.trim() !== me?.name) prof.name = name.trim();
    if (email.trim() && email.trim() !== me?.email) prof.email = email.trim();
    if ((avatarUrl ?? null) !== (me?.avatarUrl ?? null)) prof.avatarUrl = avatarUrl ?? "";
    if (position.trim() !== (me?.position ?? "")) prof.position = position.trim();

    try {
      if (Object.keys(prof).length) await profile.mutateAsync(prof);
      await update.mutateAsync({ available, schedule });
      onToast("Personal settings saved");
      onClose();
    } catch (e) {
      const status = (e as { status?: number })?.status;
      onToast(status === 409 ? "That email address is already in use." : "Couldn’t save — please try again.");
    }
  };

  const pwValid = curPw.length > 0 && newPw.length >= 8 && newPw === confPw;
  const updatePassword = async () => {
    if (!pwValid) return;
    try {
      const { signedOutOthers } = await changePw.mutateAsync({
        currentPassword: curPw,
        newPassword: newPw,
      });
      setCurPw("");
      setNewPw("");
      setConfPw("");
      // Say it happened. Being signed out everywhere else is the point of
      // changing a password you think someone else has, and it is also the kind
      // of surprise that generates a support message if it goes unmentioned.
      onToast(
        signedOutOthers > 0
          ? `Password updated — signed out of ${signedOutOthers} other ${signedOutOthers === 1 ? "device" : "devices"}`
          : "Password updated",
      );
    } catch (e) {
      const status = (e as { status?: number })?.status;
      onToast(status === 400 ? "Your current password is incorrect." : "Couldn’t update password.");
    }
  };


  const roleLabel = me ? me.role.charAt(0).toUpperCase() + me.role.slice(1) : "";
  const [tab, setTab] = useState<"profile" | "alerts" | "security" | "sessions">("profile");

  return createPortal(
    <div className="modal" onClick={onClose}>
      <div className="modal__box perssettings" ref={boxRef} role="dialog" aria-modal="true" aria-label="Personal settings" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <h2>Personal settings</h2>
          <button type="button" className="modal__x" onClick={onClose} aria-label="Close"><XIcon /></button>
        </div>

        <div className="pers-tabs" role="tablist" aria-label="Personal settings sections">
          <button type="button" role="tab" aria-selected={tab === "profile"} className={"pers-tab" + (tab === "profile" ? " on" : "")} onClick={() => setTab("profile")}>Profile</button>
          <button type="button" role="tab" aria-selected={tab === "alerts"} className={"pers-tab" + (tab === "alerts" ? " on" : "")} onClick={() => setTab("alerts")}>Alerts</button>
          <button type="button" role="tab" aria-selected={tab === "security"} className={"pers-tab" + (tab === "security" ? " on" : "")} onClick={() => setTab("security")}>Security</button>
          <button type="button" role="tab" aria-selected={tab === "sessions"} className={"pers-tab" + (tab === "sessions" ? " on" : "")} onClick={() => setTab("sessions")}>Sessions</button>
        </div>

        <div className="modal__body">
          {tab === "profile" && (
          <>
          {/* Profile — photo, name, email */}
          <div className="pers-field">
            <div className="pers-field__hd">
              <span className="pers-field__lbl">Profile</span>
              {roleLabel && <span className="pers-role">{roleLabel}</span>}
            </div>
            <div className="pers-prof">
              <Avatar name={name || me?.name || ""} email={email} color={me?.avatarColor} src={avatarUrl} size={72} fontSize={26} className="av pers-prof__av" />
              <div className="pers-prof__actions">
                <div className="pers-prof__btns">
                  <button type="button" className="btn-ghost" onClick={() => photoRef.current?.click()} disabled={uploading}>
                    {uploading ? "Uploading…" : avatarUrl ? "Change photo" : "Upload photo"}
                  </button>
                  {avatarUrl && (
                    <button type="button" className="btn-ghost pers-prof__remove" onClick={() => setAvatarUrl(null)} disabled={uploading}>
                      Remove
                    </button>
                  )}
                </div>
                <small className="pers-field__hint">JPG, PNG or GIF, up to 5 MB.</small>
              </div>
              <input
                ref={photoRef}
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => {
                  pickPhoto(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
            </div>
            <div className="pers-grid">
              <label className="field">
                <span>Full name</span>
                <input value={name} autoComplete="name" onChange={(e) => setName(e.target.value)} placeholder="Your name" />
              </label>
              <label className="field">
                <span>Email address</span>
                <input type="email" value={email} autoComplete="email" onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
              </label>
              <label className="field pers-col-full">
                <span>Position</span>
                <input value={position} maxLength={80} autoComplete="organization-title" onChange={(e) => setPosition(e.target.value)} placeholder="e.g. Operations Manager" />
              </label>
            </div>
            <small className="pers-field__hint">
              Your email is also your sign-in — changing it changes how you log in. Your name and position go into the
              signature of each email channel you send from.
            </small>
          </div>

          {/* Availability */}
          <div className="pers-field">
            <div className="pers-field__hd">
              <span className="pers-field__lbl">Availability</span>
              <button
                type="button"
                role="switch"
                aria-checked={available}
                className={"switch" + (available ? " on" : "")}
                onClick={() => setAvailable((v) => !v)}
              >
                <span className="switch__dot" />
              </button>
            </div>
            <p className={"pers-avail " + (availableNow({ available, schedule }) ? "is-on" : "is-off")}>
              <span className="pers-avail__dot" />
              {!available
                ? "Unavailable — new chats skip you until you’re back."
                : availableNow({ available, schedule })
                  ? "Available — you’re in the round-robin for new chats."
                  : "Outside your working hours — new chats skip you until they start."}
            </p>
          </div>

          {/* Working hours */}
          <WorkingHours schedule={schedule} onChange={setSchedule} />
          </>
          )}


          {tab === "alerts" && (
          <>
          {/* What makes a noise, and where.

              One set of switches for the phone and this browser both. They used
              to mean only "push my phone" while the desktop chimed at every
              arrival in the workspace, whoever it belonged to — which is how a
              shared inbox teaches people to turn sound off and then miss the
              message that mattered. The server now decides both from what is
              set here. */}
          <div className="pers-field">
            <div className="pers-field__hd">
              <span className="pers-field__lbl">Alert me about</span>
              <small className="pers-field__hint">Applies to this browser and your phone</small>
            </div>
            {alertPrefs.isLoading ? (
              <small className="pers-field__hint">Loading…</small>
            ) : alertPrefs.isError || !alertPrefs.data ? (
              <small className="pers-field__hint">Couldn’t load your alert settings.</small>
            ) : (
              <div className="pers-alerts">
                {ALERT_TOGGLES.filter((t) => t.key !== "chatMessages" || chatOn).map(({ key, label, detail }) => {
                  const on = alertPrefs.data[key];
                  return (
                    <div key={key} className="pers-alert">
                      <div className="pers-alert__txt">
                        <span className="pers-alert__lbl">{label}</span>
                        <small className="pers-field__hint">{detail}</small>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={on}
                        aria-label={label}
                        className={"switch" + (on ? " on" : "")}
                        disabled={updateAlerts.isPending}
                        onClick={() => updateAlerts.mutate({ [key]: !on })}
                      >
                        <span className="switch__dot" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            {/* The one people go looking for when the room goes quiet. Without
                it, "my sound stopped working" has no answer on this screen. */}
            <small className="pers-field__hint">
              A sound plays here for anything ticked above. Nothing plays for a thread you’ve muted, a
              conversation already open in front of you, or during quiet hours.
            </small>
          </div>
          </>
          )}

          {tab === "security" && (
          <>
          {/* Password */}
          <div className="pers-field">
            <div className="pers-field__hd">
              <span className="pers-field__lbl">Password</span>
              <small className="pers-field__hint">At least 8 characters</small>
            </div>
            <div className="pers-grid">
              <label className="field pers-col-full">
                <span>Current password</span>
                <input type="password" value={curPw} autoComplete="current-password" onChange={(e) => setCurPw(e.target.value)} placeholder="••••••••" />
              </label>
              <label className="field">
                <span>New password</span>
                <input type="password" value={newPw} autoComplete="new-password" onChange={(e) => setNewPw(e.target.value)} placeholder="••••••••" />
              </label>
              <label className="field">
                <span>Confirm new password</span>
                <input type="password" value={confPw} autoComplete="new-password" onChange={(e) => setConfPw(e.target.value)} placeholder="••••••••" />
              </label>
            </div>
            <div className="pers-pw__foot">
              {confPw.length > 0 && newPw !== confPw ? (
                <small className="pers-pw__warn">The new passwords don’t match.</small>
              ) : (
                <span />
              )}
              <button type="button" className="btn-ghost" onClick={updatePassword} disabled={!pwValid || changePw.isPending}>
                {changePw.isPending ? "Updating…" : "Update password"}
              </button>
            </div>
          </div>

          {/* Two-factor authentication */}
          <div className="pers-field">
            <div className="pers-field__hd">
              <span className="pers-field__lbl">Two-factor authentication</span>
            </div>
            <TwoFactorSettings onToast={onToast} />
          </div>

          </>
          )}

          {tab === "sessions" && (
          <>
          {/* Where you're signed in */}
          <div className="pers-field">
            <div className="pers-field__hd">
              <span className="pers-field__lbl">Where you’re signed in</span>
              {sessions.length > 1 && (
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() =>
                    revokeOthers.mutate(undefined, {
                      onSuccess: (r) =>
                        onToast(
                          r.revoked
                            ? `Signed out ${r.revoked} other device${r.revoked === 1 ? "" : "s"}`
                            : "No other sessions to sign out",
                        ),
                      onError: () => onToast("Couldn’t sign out other sessions"),
                    })
                  }
                  disabled={revokeOthers.isPending}
                >
                  {revokeOthers.isPending ? "Signing out…" : "Sign out all others"}
                </button>
              )}
            </div>
            <div className="pers-sessions">
              {sessionsQ.isLoading ? (
                <small className="pers-field__hint">Loading…</small>
              ) : sessions.length === 0 ? (
                <small className="pers-field__hint">No active sessions.</small>
              ) : (
                sessions.map((s) => (
                  <div key={s.id} className="pers-session">
                    <div className="pers-session__info">
                      <span className="pers-session__dev">{deviceLabel(s)}</span>
                      <span className="pers-session__meta">
                        {s.ip ? `${s.ip} · ` : ""}
                        {s.current ? "Active now" : `Last active ${timeAgo(s.lastSeenAt)}`}
                      </span>
                    </div>
                    {s.current ? (
                      <span className="pers-session__badge">This device</span>
                    ) : (
                      <button
                        type="button"
                        className="btn-ghost pers-session__revoke"
                        onClick={() =>
                          revokeSession.mutate(s.id, {
                            onSuccess: () => onToast("Signed out that device"),
                            onError: () => onToast("Couldn’t sign out that device"),
                          })
                        }
                        disabled={revokeSession.isPending}
                      >
                        Sign out
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
          </>
          )}
        </div>

        <div className="modal__foot">
          <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn-primary" onClick={save} disabled={update.isPending || profile.isPending || uploading}>
            {update.isPending || profile.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** The browser's own time zone — the right first guess for somebody's hours. */
function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/London";
  } catch {
    return "Europe/London";
  }
}

/** Every zone the browser knows, for the picker; the current one always included. */
function timeZones(current: string): string[] {
  const all =
    (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  return all.includes(current) ? all : [current, ...all];
}

const DAY_LABEL: Record<Weekday, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

/**
 * When somebody works.
 *
 * With it on, they're available only inside these hours (and with the switch
 * above on): round-robin skips them outside them, and if nobody who answers
 * the website chat is inside their hours, the chat says it's offline. Off,
 * the switch alone decides, as it always has — and the hours are kept, so
 * turning it back on doesn't mean typing them again.
 */
function WorkingHours({
  schedule,
  onChange,
}: {
  schedule: AvailabilitySchedule;
  onChange: (next: AvailabilitySchedule) => void;
}) {
  const setDay = (day: Weekday, patch: Partial<AvailabilitySchedule["days"][Weekday]>) =>
    onChange({ ...schedule, days: { ...schedule.days, [day]: { ...schedule.days[day], ...patch } } });
  return (
    <div className="pers-field">
      <div className="pers-field__hd">
        <span className="pers-field__lbl">Working hours</span>
        <button
          type="button"
          role="switch"
          aria-checked={schedule.enabled}
          aria-label="Set my working hours"
          className={"switch" + (schedule.enabled ? " on" : "")}
          onClick={() => onChange({ ...schedule, enabled: !schedule.enabled })}
        >
          <span className="switch__dot" />
        </button>
      </div>
      <p className="m-0 mt-1 text-xs text-faint">
        {schedule.enabled
          ? "Outside these hours you’re unavailable: no new chats come to you, and if nobody who answers the website chat is working, it shows as offline."
          : "Off — the switch above alone decides when you’re available."}
      </p>
      {schedule.enabled ? (
        <div className="mt-3 flex flex-col gap-2">
          <label className="field">
            <span>Time zone</span>
            <select value={schedule.timezone} onChange={(e) => onChange({ ...schedule, timezone: e.target.value })}>
              {timeZones(schedule.timezone).map((tz) => (
                <option key={tz} value={tz}>
                  {tz.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </label>
          {WEEKDAYS.map((day) => {
            const d = schedule.days[day];
            return (
              <div key={day} className="flex items-center gap-3 text-sm">
                <label className={"check w-32 flex-none" + (d.on ? " on" : "")}>
                  <input type="checkbox" checked={d.on} onChange={(e) => setDay(day, { on: e.target.checked })} />
                  {DAY_LABEL[day]}
                </label>
                {d.on ? (
                  <>
                    <input
                      type="time"
                      aria-label={`${DAY_LABEL[day]} start`}
                      value={d.start}
                      onChange={(e) => e.target.value && setDay(day, { start: e.target.value })}
                    />
                    <span className="text-faint">to</span>
                    <input
                      type="time"
                      aria-label={`${DAY_LABEL[day]} end`}
                      value={d.end}
                      onChange={(e) => e.target.value && setDay(day, { end: e.target.value })}
                    />
                    {d.end <= d.start ? <span className="text-faint text-xs">(next day)</span> : null}
                  </>
                ) : (
                  <span className="text-faint">Off</span>
                )}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
