import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type JSX, type ReactNode } from "react";
import { Linkify } from "./Linkify";
import type { ChangeEvent as RChangeEvent, ClipboardEvent as RClipboardEvent, DragEvent as RDragEvent, PointerEvent as RPointerEvent } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import type { Message, Contact, Macro, Mentionable, MessageStatus, ChannelType, TemplateFillContext, WaWindow } from "@ding/schemas";
import { ClientEvent, FORWARD_MAX_TARGETS, autoTemplateParams, autoTemplateSlot, fillTemplatePreview, inboxLabel, isEmailAddress, macroQueryAt, mentionLabel, mentionParts, namesToHandles, noteMentionCandidates, renderEmailSignature, replyTargetsFor, resolveTemplateDefault, searchMacros, sendingInbox, signedAsLine, templatesForWaba, typingPingMs } from "@ding/schemas";
import { useConversation, useMe, useSendMessage, useAssign, useSetStatus, useSnooze, useTeams, useMarkRead, useMarkUnread, useReact, useLoadOlderMessages, usePeople, useRetryMessage, useIntegrations, useTemplates, useContacts, useForwardMessage, useMediaQuery, useInboxes, useTypingPresence, useConversationMacros, useChatStatus, useShareConversation } from "../hooks";
import { api } from "../lib/api";
import { LabelPicker } from "./LabelPicker";
import { AttachmentView, StagedChip, analyzeAudio, imageSize, kindOfFile, pickAudioMime, type Staged } from "./media/media";
import { GlideMenu } from "./GlideMenu";
import { ConversationLog } from "./ConversationLog";
import { AlsoSendTo, DiscussionBar, ShareDialog } from "./chat/Discuss";
import { FollowUpBar } from "./FollowUpBar";
import { getSocket } from "../lib/socket";
import { relativeTime, seenAt, lastActive, clockTime, initials, formatDuration, windowLeft, avatarBg, groupMessagesByDay, speakerKey } from "../lib/format";
import { hasOtherRecipients, replyAllRecipients } from "@ding/client";
import { Avatar } from "./Avatar";
import { useHoverGlide } from "../lib/useHoverGlide";
import { unlock } from "../lib/sound";
import { emailFit } from "../lib/email-fit";
import { TemplatePicker } from "./TemplatePicker";
import { RecipientField, recipientsReady } from "./RecipientField";
import {
  channelMeta,
  ClockIcon,
  ChevronDown,
  SnoozeIcon,
  TagIcon,
  DetailsIcon,
  HistoryIcon,
  MoreIcon,
  SendIcon,
  SparkleIcon,
  AttachIcon,
  EmojiIcon,
  LinkIcon,
  NoteIcon,
  ProfileIcon,
  RouteIcon,
  InboxIcon,
  MailIcon,
  CheckCircleIcon,
  ReopenIcon,
  BackIcon,
  BoltIcon,
  CheckSingle,
  CheckDouble,
  EyeIcon,
  AlertIcon,
  ReplyIcon,
  ForwardIcon,
  ReplyAllIcon,
  ImageIcon,
  PauseIcon,
  XIcon,
  MicIcon,
  TrashIcon,
  EditIcon,
  SearchIcon,
  MacroIcon,
  TeamChatIcon,
} from "../lib/icons";

interface Props {
  conversationId: string | null;
  showPanel: boolean;
  onTogglePanel: () => void;
  onToast: (msg: string) => void;
  onBack?: () => void;
  onClosed?: () => void;
  /** True only when this thread pane is actually the one on-screen. On mobile the
   *  list and the thread are separate panes (never both), and the thread stays
   *  MOUNTED behind the list — so this gates read receipts to when the agent can
   *  really see the message. Defaults to true (desktop always shows the thread). */
  active?: boolean;
  /** The Team Chat discussion open beside this thread, if any (its card's id). */
  discussion?: string | null;
  /** Open a discussion of this conversation beside the thread. */
  onOpenDiscussion?: (cardId: string) => void;
}

/** Escape text so it can be safely interpolated into forwarded-email HTML. The
 *  server re-sanitizes the whole body before send; this just prevents a stray
 *  "<" or "&" in the original from mangling the composed markup. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Plain text → the minimal HTML the email editor understands: a paragraph per
 *  blank-line-separated block, a <br> for a single newline. Escaped first, so a
 *  draft containing "<" survives as text rather than becoming markup. */
function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/** A note's text with its @mentions picked out, shown by name ("@Nathan A")
 *  rather than the stored handle ("@nathan") the server routes by. */
function renderMention(body: string, people: Mentionable[]): JSX.Element[] {
  return mentionParts(body, people).map((part, i) =>
    part.mention ? (
      <span key={i} className="men">
        {part.text}
      </span>
    ) : (
      <span key={i}>
        <Linkify text={part.text} />
      </span>
    ),
  );
}

/** Compact WhatsApp-style player for audio + voice notes. One <audio> element
 *  driven by state/refs: round play/pause, a seekable waveform (or progress
 *  bar), and an m:ss readout. */
const WA_WINDOW_MS = 24 * 60 * 60 * 1000;
/** The WhatsApp 24-hour window derived from a thread's own messages. Used when
 *  the composer targets WhatsApp on a thread whose primary channel is *not*
 *  WhatsApp (a cross-channel reply) — the server-computed `conv.waWindow` already
 *  covers the WhatsApp-primary case. Open while the last WhatsApp inbound is
 *  under 24h old; closed (template required) when there's never been one. */
function computeWaWindow(messages: Message[]): WaWindow {
  const lastWaInbound = [...messages]
    .reverse()
    .find((m) => m.direction === "in" && (m.channel === "whatsapp" || m.channel === "whatsapp_group"));
  if (!lastWaInbound) return { open: false, expiresAt: null };
  const expires = new Date(lastWaInbound.createdAt).getTime() + WA_WINDOW_MS;
  return { open: Date.now() < expires, expiresAt: new Date(expires).toISOString() };
}

/** Pick whichever window expires later. The server value can go stale between
 *  refetches, so we merge it with one re-derived from the live message list —
 *  a new inbound is patched into the cache in realtime, which then resets the
 *  countdown here without needing a page refresh. */
function laterWindow(a: WaWindow | null, b: WaWindow | null): WaWindow | null {
  const ax = a?.expiresAt ? new Date(a.expiresAt).getTime() : 0;
  const bx = b?.expiresAt ? new Date(b.expiresAt).getTime() : 0;
  return bx > ax ? b : a;
}

/** Outbound delivery ticks: the full WhatsApp ladder
 *  Queued → Sent → Delivered → Read (blue), plus a red Failed indicator.
 *  Maps a message's status to a glyph, a tick class, and a human title. */
function StatusTick({ status }: { status: MessageStatus }) {
  let cls = "tick";
  let title: string;
  let icon: JSX.Element;
  switch (status) {
    // Both pre-sent states show WhatsApp's clock: "queued" (accepted, awaiting
    // dispatch) and "sending" (mid dispatch to Meta, not yet acked). Without the
    // "sending" case it fell through to the single-tick default, so a message
    // briefly showed 1 tick before it had actually been sent.
    case "queued":
    case "sending":
      cls += " pending";
      title = "Sending…";
      icon = <ClockIcon />;
      break;
    case "delivered":
      title = "Delivered";
      icon = <CheckDouble />;
      break;
    case "read":
      cls += " read";
      title = "Read";
      icon = <CheckDouble />;
      break;
    case "failed":
      cls += " failed";
      title = "Not delivered — tap to retry";
      icon = <AlertIcon />;
      break;
    case "sent":
    default:
      title = "Sent";
      icon = <CheckSingle />;
      break;
  }
  return (
    <span className={cls} role="img" aria-label={title} title={title}>
      {icon}
    </span>
  );
}

/** Collapsed preview height for a long email body before "Read more". Kept
 *  short deliberately: the preview is there to show what the message is, not to
 *  read it in place — a tall bubble pushes the rest of the thread off-screen. */
const EMAIL_COLLAPSED_MAX = 220;

/** Renders a sanitized email HTML body inside a locked-down iframe. There is no
 *  `allow-scripts`, so nothing in the message can execute; a strict CSP blocks
 *  remote resources, and remote images stay hidden until the agent reveals them.
 *  `allow-same-origin` (without scripts) is only so the parent can read the
 *  content height to size the frame; `allow-popups` lets links open in a tab. */
function EmailHtml({ html }: { html: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  // The email's own height, in its own (unscaled) pixels.
  const [contentHeight, setContentHeight] = useState(80);
  // How wide the email lays itself out, when that's wider than the column.
  // Designed emails are often a fixed 600px; they're scaled down to fit rather
  // than cut off on the right (see emailFit).
  const [contentWidth, setContentWidth] = useState(0);
  const [boxWidth, setBoxWidth] = useState(0);
  const fit = emailFit(contentWidth, boxWidth);
  const height = Math.ceil(contentHeight * fit.scale);
  // Remote images show by default; the bar below lets you hide them per message.
  const [showImages, setShowImages] = useState(true);
  // Long emails are clamped to a preview height with a "Read more" toggle, so a
  // tall message doesn't force endless scrolling (WhatsApp-style).
  const [expanded, setExpanded] = useState(false);
  const overflows = height > EMAIL_COLLAPSED_MAX + 48;
  const collapsed = overflows && !expanded;
  const hasBlocked = html.includes("data-blocked-src");

  const srcDoc = useMemo(() => {
    const body = showImages ? html.replace(/data-blocked-src=/g, "src=") : html;
    const imgSrc = showImages ? "img-src data: https: http:" : "img-src data:";
    const csp = `default-src 'none'; ${imgSrc}; style-src 'unsafe-inline'; font-src data:; media-src data:`;
    return (
      `<!doctype html><html><head><meta charset="utf-8">` +
      `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
      `<base target="_blank">` +
      // overscroll-behavior:none keeps a drag inside the frame from chaining out
      // to the page (iOS pull-to-refresh) even before the touch-forwarder attaches.
      `<style>html,body{margin:0;padding:0;overscroll-behavior:none}` +
      `body{padding:1px 2px;background:#fff;color:#1a1a1a;` +
      `font:14px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;` +
      `word-break:break-word;overflow-wrap:anywhere}` +
      `img{max-width:100%;height:auto}a{color:#0a7c66}` +
      `table{max-width:100%;border-collapse:collapse}` +
      `blockquote{margin:6px 0 6px 4px;padding-left:11px;border-left:3px solid #dcdcdc;color:#555}` +
      `pre{white-space:pre-wrap;word-break:break-word}` +
      `</style></head><body>${body}</body></html>`
    );
  }, [html, showImages]);

  // With allow-same-origin (and no scripts) the parent can read the rendered
  // height. Re-measure after load and a couple of beats for late reflow.
  const measure = () => {
    const d = ref.current?.contentDocument;
    if (d?.body) {
      const h = Math.max(d.body.scrollHeight, d.documentElement?.scrollHeight ?? 0);
      setContentHeight(Math.min(4000, Math.max(40, h + 6)));
      // Measured at whatever width the frame has now: the column's, or the
      // email's own once it's being scaled. Either way, anything wider is
      // content that would otherwise be cut off.
      setContentWidth(Math.max(d.body.scrollWidth, d.documentElement?.scrollWidth ?? 0));
    }
  };
  useEffect(() => {
    // A new body, images toggled or a new column width: lay out afresh at the
    // column's width first, so an email that can reflow does, and only one
    // that genuinely can't fit is scaled.
    setContentWidth(0);
    const timers = [60, 260, 700, 1500].map((d) => window.setTimeout(measure, d));
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [srcDoc, boxWidth]);

  // Follow the column as the window, sidebar or panel changes its width.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const read = () => setBoxWidth(box.clientWidth);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(box);
    return () => ro.disconnect();
  }, []);

  // The sandboxed iframe is its own scrolling context, so a gesture that starts
  // over the email doesn't reach the thread's scroll container — it escapes to
  // the page (which scrolls, and on iOS triggers pull-to-refresh). Forward both
  // wheel (desktop) and touch-drag (iPad/touch) from inside the frame to the
  // thread's scroller so scrolling over the email scrolls the chat, and swallow
  // the default so the page can't scroll or reload.
  useEffect(() => {
    const iframe = ref.current;
    const scroller = iframe?.closest(".msgs") as HTMLElement | null;
    if (!iframe || !scroller) return;
    let doc: Document | null = null;
    let ty = 0;
    let tx = 0;
    const onWheel = (e: WheelEvent) => {
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? scroller.clientHeight : 1;
      scroller.scrollTop += e.deltaY * unit;
      scroller.scrollLeft += e.deltaX * unit;
      e.preventDefault();
    };
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return; // let two-finger pinch-zoom through
      ty = e.touches[0].clientY;
      tx = e.touches[0].clientX;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const y = e.touches[0].clientY;
      const x = e.touches[0].clientX;
      scroller.scrollTop += ty - y;
      scroller.scrollLeft += tx - x;
      ty = y;
      tx = x;
      e.preventDefault(); // keep the gesture off the page (no scroll, no pull-to-refresh)
    };
    const attach = () => {
      doc?.removeEventListener("wheel", onWheel);
      doc?.removeEventListener("touchstart", onTouchStart);
      doc?.removeEventListener("touchmove", onTouchMove);
      doc = iframe.contentDocument;
      doc?.addEventListener("wheel", onWheel, { passive: false });
      doc?.addEventListener("touchstart", onTouchStart, { passive: false });
      doc?.addEventListener("touchmove", onTouchMove, { passive: false });
    };
    attach();
    iframe.addEventListener("load", attach);
    return () => {
      doc?.removeEventListener("wheel", onWheel);
      doc?.removeEventListener("touchstart", onTouchStart);
      doc?.removeEventListener("touchmove", onTouchMove);
      iframe.removeEventListener("load", attach);
    };
  }, [srcDoc]);

  return (
    <div className="emailhtml">
      {hasBlocked && (
        <button type="button" className="emailhtml__imgbar" onClick={() => setShowImages((s) => !s)}>
          <ImageIcon />
          <span className="emailhtml__imgtxt">
            {showImages ? "Remote images shown" : "Images hidden for your privacy"}
          </span>
          <span className="emailhtml__show">{showImages ? "Hide" : "Show images"}</span>
        </button>
      )}
      <div
        ref={boxRef}
        className={"emailhtml__clip" + (collapsed ? " is-clamped" : "")}
        style={{ height, maxHeight: collapsed ? EMAIL_COLLAPSED_MAX : undefined }}
      >
        <iframe
          ref={ref}
          className="emailhtml__frame"
          title="Email message"
          sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          srcDoc={srcDoc}
          style={
            fit.width
              ? { height: contentHeight, width: fit.width, transform: `scale(${fit.scale})`, transformOrigin: "0 0" }
              : { height: contentHeight }
          }
          onLoad={measure}
        />
      </div>
      {overflows && (
        <button
          type="button"
          className={"emailhtml__more" + (expanded ? " is-open" : "")}
          onClick={() => setExpanded((e) => !e)}
        >
          <span>{expanded ? "Show less" : "Read more"}</span>
          <ChevronDown />
        </button>
      )}
    </div>
  );
}

/** Emoji offered in the quick-reaction bar (WhatsApp's default set). */
const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

/** A compact, curated set for the composer's emoji picker (no dependency). */
/**
 * Where each thread was last left, so re-opening one puts you back where you
 * were rather than at a computed guess.
 *
 * `atBottom` is stored separately from `top`: someone who was reading the
 * latest message wants the latest message again, even though new ones have
 * arrived since and the old scrollTop now points mid-thread.
 *
 * Mirrored into sessionStorage so a reload comes back to the same places. It's
 * sessionStorage, not localStorage, on purpose: positions stay good for as long
 * as the tab is open, and a new session starts at the newest message rather
 * than restoring somewhere from days ago — which would look like the very
 * randomness this replaced.
 */
type ScrollMark = { top: number; atBottom: boolean };
const SCROLL_KEY = "nest:thread-scroll";
/** Plenty for a working session; keeps the stored blob small. */
const SCROLL_MAX_THREADS = 60;

const threadScroll: Map<string, ScrollMark> = (() => {
  try {
    const raw = sessionStorage.getItem(SCROLL_KEY);
    if (raw) return new Map(Object.entries(JSON.parse(raw) as Record<string, ScrollMark>));
  } catch {
    // Private mode, disabled storage, or corrupt JSON — fall back to memory.
  }
  return new Map();
})();

function flushScroll() {
  try {
    // Map preserves insertion order, so the oldest entries are the ones dropped.
    while (threadScroll.size > SCROLL_MAX_THREADS) {
      threadScroll.delete(threadScroll.keys().next().value as string);
    }
    sessionStorage.setItem(SCROLL_KEY, JSON.stringify(Object.fromEntries(threadScroll)));
  } catch {
    // Storage unavailable or full — the in-memory map still works this session.
  }
}

let scrollFlushTimer = 0;
/** Record a position now; persist it shortly after (scrolling fires a lot). */
function rememberScroll(id: string, mark: ScrollMark) {
  // Re-insert so this thread counts as the most recently used for the trim.
  threadScroll.delete(id);
  threadScroll.set(id, mark);
  if (scrollFlushTimer) return;
  scrollFlushTimer = window.setTimeout(() => {
    scrollFlushTimer = 0;
    flushScroll();
  }, 400);
}

// A reload can land inside the debounce window, so write on the way out too.
window.addEventListener("pagehide", flushScroll);

const COMPOSER_EMOJIS = [
  "😀","😄","😁","😅","😂","🙂","😉","😊","😍","😘","😎","🤩","🤗","🤔","😐","😴",
  "😌","🙃","😇","🥳","😢","😭","😤","😡","😱","🤯","🥺","😬","👍","👎","👏","🙏",
  "💪","🙌","👌","🤝","👋","🤙","💯","🔥","✨","🎉","🎊","❤️","🧡","💛","💚","💙",
  "💜","✅","❌","⚠️","⭐","💡","🚀","🎯","💰","📦","📅","⏰","💬","📞","📧","☕",
];

/** One-line label for a quoted message: media get an icon + kind, else the text. */
function quotedSnippet(q: Message): string {
  const body = (q.body ?? "").trim();
  if (body) return body;
  const a = q.attachments?.[0];
  if (a) {
    switch (a.kind) {
      case "image": return "📷 Photo";
      case "video": return "🎥 Video";
      case "voice": return "🎤 Voice message";
      case "audio": return "🎵 Audio";
      case "sticker": return "Sticker";
      default: return "📄 " + (a.filename || "Document");
    }
  }
  if (q.messageType === "location") return "📍 Location";
  if (q.messageType === "contact") return "👤 Contact";
  return "Message";
}

/** Forward an email on to other people. Collects recipient(s) + an optional
 *  note; the original email is quoted automatically. The send goes out as a
 *  fresh "Fwd:" email addressed to those people — not a reply to the customer —
 *  while still being logged in this conversation (Front-style). */
function ForwardModal({
  message,
  contactName,
  subject,
  contacts,
  onSubmit,
  onClose,
}: {
  message: Message;
  contactName: string;
  subject: string;
  /** The customer directory, for the To field's suggestions. */
  contacts: Contact[];
  onSubmit: (to: string[], note: string) => void;
  onClose: () => void;
}) {
  const [to, setTo] = useState<string[]>([]);
  const [note, setNote] = useState("");
  // Enabled once there's a recipient and every one is a real address.
  const valid = recipientsReady(to);
  const who = message.direction === "out" ? message.authorName || "You" : message.authorName || contactName;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid) onSubmit(to, note);
  };
  return (
    <div className="modal" onClick={onClose}>
      <form className="modal__box modal--form" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="modal__head">
          <h2>Forward email</h2>
          <button type="button" className="modal__x" onClick={onClose} aria-label="Close"><XIcon /></button>
        </div>
        <div className="modal__body">
          <div className="field">
            <span>To</span>
            <RecipientField
              value={to}
              onChange={setTo}
              contacts={contacts}
              ariaLabel="Forward to"
              placeholder="Search customers, or type an email address"
              autoFocus
            />
          </div>
          <label className="field">
            <span>Note <em className="field__opt">optional</em></span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Add a message above the forwarded email…"
              rows={3}
            />
          </label>
          <div className="fwdprev">
            <div className="fwdprev__subj">Fwd: {subject || "(no subject)"}</div>
            <div className="fwdprev__meta">From {who}</div>
            <div className="fwdprev__snip">{quotedSnippet(message)}</div>
          </div>
          <p className="fieldhint">
            This goes out as a new email to the people above — it won’t reply to the customer, but it stays
            logged in this conversation. Pick customers as you type, or enter any address.
          </p>
        </div>
        <div className="modal__foot">
          <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary fwd-go" disabled={!valid}>
            <ForwardIcon />
            Forward
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * Forward a WhatsApp message on to other customers' chats.
 *
 * A different shape from forwarding an email, because WhatsApp is a different
 * thing: an email forward goes to addresses you type, a WhatsApp forward goes to
 * chats you pick. So this is a customer picker, capped at the same number of
 * chats WhatsApp itself allows in one go.
 */
function ForwardToChatsModal({
  message,
  busy,
  onSubmit,
  onClose,
}: {
  message: Message;
  busy: boolean;
  onSubmit: (contactIds: string[]) => void;
  onClose: () => void;
}) {
  const { data: contacts } = useContacts();
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());

  // A WhatsApp forward needs a number to land on; a blocked customer is one we
  // deliberately don't message.
  const reachable = useMemo(
    () => (contacts ?? []).filter((c) => c.phone && !c.blocked),
    [contacts],
  );
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return reachable;
    return reachable.filter(
      (c) =>
        c.displayName.toLowerCase().includes(needle) ||
        (c.company ?? "").toLowerCase().includes(needle) ||
        (c.phone ?? "").includes(needle),
    );
  }, [reachable, q]);

  const atCap = picked.size >= FORWARD_MAX_TARGETS;
  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      // Silently ignoring a tap past the cap would read as a broken checkbox, so
      // the rows disable themselves instead (see `blocked` below).
      else if (next.size < FORWARD_MAX_TARGETS) next.add(id);
      return next;
    });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (picked.size && !busy) onSubmit([...picked]);
  };

  return (
    <div className="modal" onClick={onClose}>
      <form className="modal__box modal--form" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="modal__head">
          <h2>Forward to…</h2>
          <button type="button" className="modal__x" onClick={onClose} aria-label="Close"><XIcon /></button>
        </div>
        <div className="modal__body">
          <div className="fwdprev">
            <div className="fwdprev__snip">{quotedSnippet(message)}</div>
          </div>
          <div className="bpick">
            <div className="setsearch bpick__search">
              <SearchIcon />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search customers by name or number…"
                autoFocus
              />
            </div>
            {reachable.length === 0 ? (
              <div className="setempty">No customers with a WhatsApp number yet.</div>
            ) : filtered.length === 0 ? (
              <div className="setempty">No customer matches “{q.trim()}”.</div>
            ) : (
              <div className="bpick__list">
                {filtered.map((c) => {
                  const on = picked.has(c.id);
                  const blocked = !on && atCap;
                  return (
                    <label
                      key={c.id}
                      className={"bpick__row" + (on ? " on" : "") + (blocked ? " bpick__row--off" : "")}
                    >
                      <input type="checkbox" checked={on} disabled={blocked} onChange={() => toggle(c.id)} />
                      <span className="bpick__name">{c.displayName}</span>
                      <span className="bpick__phone">{c.phone}</span>
                    </label>
                  );
                })}
              </div>
            )}
            <small className="fieldhint">
              {atCap
                ? `That's the most WhatsApp forwards to at once (${FORWARD_MAX_TARGETS}).`
                : `Pick up to ${FORWARD_MAX_TARGETS} chats. Each gets its own copy, marked “Forwarded”.`}
            </small>
          </div>
        </div>
        <div className="modal__foot">
          <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary fwd-go" disabled={!picked.size || busy}>
            <ForwardIcon />
            {busy ? "Forwarding…" : picked.size > 1 ? `Forward to ${picked.size}` : "Forward"}
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * Long-press on a phone browser: reactions from the top, actions from the bottom.
 *
 * The same split the native app uses, and for the same reason — reacting is a
 * glance-and-tap that belongs where your eye already is, the actions are a list
 * you read that belongs under your thumb. Before this the web's touch path only
 * ever showed the emoji row: Reply was swipe-only and Forward was unreachable on
 * a WhatsApp bubble, because the ⌄ chevron is hidden on touch for everything but
 * email.
 *
 * Desktop keeps its own affordances (hover smiley + corner chevron) and never
 * mounts this — the two are different input models, not two sizes of one.
 */
function HoldOverlay({
  message,
  contactName,
  mine,
  onReact,
  onReply,
  onForward,
  onReceipts,
  onClose,
}: {
  message: Message;
  contactName: string;
  /** The agent's current reaction on this message, if any — tapping it clears it. */
  mine?: string;
  onReact: (emoji: string) => void;
  onReply?: () => void;
  onForward?: () => void;
  onReceipts?: () => void;
  onClose: () => void;
}) {
  // Escape closes it, like every other overlay in the app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="hold" onClick={onClose} role="dialog" aria-label="Message actions">
      <div className="hold__top">
        <div className="hold__react" role="menu" aria-label="Pick a reaction">
          {QUICK_REACTIONS.map((e, i) => (
            <button
              key={e}
              type="button"
              className={"hold__e" + (mine === e ? " sel" : "")}
              style={{ animationDelay: `${i * 26}ms` }}
              onClick={(ev) => {
                ev.stopPropagation();
                onReact(mine === e ? "" : e);
              }}
              aria-label={mine === e ? `Remove ${e}` : `React ${e}`}
            >
              {e}
            </button>
          ))}
        </div>
      </div>

      <div className="hold__sheet" onClick={(e) => e.stopPropagation()}>
        <span className="hold__grab" aria-hidden="true" />
        {/* What the actions apply to. It's the sheet's header rather than a card
            floating over the thread, where it would sit on top of the real
            bubble and read as a duplicate of it. */}
        <p className="hold__what">{quotedSnippet(message)}</p>
        {onReply && (
          <button type="button" className="hold__act" onClick={onReply}>
            <ReplyIcon />
            <span>Reply</span>
          </button>
        )}
        {onForward && (
          <button type="button" className="hold__act" onClick={onForward}>
            <ForwardIcon />
            <span>Forward</span>
          </button>
        )}
        {onReceipts && (
          <button type="button" className="hold__act" onClick={onReceipts}>
            <EyeIcon />
            <span>Read receipts</span>
          </button>
        )}
        {!onReply && !onForward && (
          <p className="hold__note">
            {message.internal
              ? "An internal note stays with your team — it can't be replied to or forwarded."
              : `Only your team sees this reaction — ${contactName} won't.`}
          </p>
        )}
      </div>
    </div>
  );
}

/** Per-message affordances threaded down from the Thread (react + reply). */
interface MsgActions {
  /** Display name to attribute the customer's reaction to. */
  contactName: string;
  /** Mobile long-press state — the reaction row is shown, centred above the msg. */
  held: boolean;
  /** Is this message's desktop actions (chevron) menu open? */
  menuOpen: boolean;
  /** Open the reaction row on this message (mobile long-press). */
  onHold: () => void;
  /** Toggle the desktop actions menu for this message. */
  onMenuToggle: () => void;
  /** Apply (or, with "", remove) the agent's reaction. */
  onReact: (emoji: string) => void;
  /** Start a quoted reply to this message. */
  onReply: () => void;
  /** Reply, copying everyone else on the original. Absent when there is nobody
   *  else — two menu items that do the same thing is a decoy. */
  onReplyAll?: () => void;
  /** Forward this email on to someone else (email messages only; absent otherwise). */
  onForward?: () => void;
  /** Open the read-receipts view for this sent email (email with recipients only). */
  onReceipts?: () => void;
  /** Take this message to a Team Chat to discuss (when Team Chat is on). */
  onDiscuss?: () => void;
  /** Scroll to a quoted message when its preview is tapped. */
  onJump: (messageId: string) => void;
}

/** Per-recipient read receipts under an outbound email bubble (Front-style): a
 *  compact "Seen by N of M" line plus one row per To/Cc recipient with their open
 *  time (or "Sent" while unopened). Each recipient got their own tracked copy. */
function ReadReceipts({
  recipients,
}: {
  recipients: { address: string; kind: "to" | "cc"; openedAt?: string | null }[];
}) {
  const seen = recipients.filter((r) => r.openedAt).length;
  const total = recipients.length;
  const summary =
    seen === 0
      ? "Not seen yet"
      : seen === total
        ? total === 1
          ? "Seen"
          : "Seen by everyone"
        : `Seen by ${seen} of ${total}`;
  return (
    <div className="rcpts">
      <div className={"rcpts__head" + (seen ? " rcpts__head--seen" : "")}>
        <EyeIcon />
        <span>{summary}</span>
      </div>
      <div className="rcpts__list">
        {recipients.map((r) => (
          <div key={r.kind + r.address} className={"rcpt" + (r.openedAt ? " rcpt--seen" : "")}>
            <span className="rcpt__ic">
              {r.openedAt ? <CheckDouble /> : <span className="rcpt__dot" aria-hidden="true" />}
            </span>
            <span className="rcpt__addr" title={r.address}>
              {r.address}
            </span>
            {r.kind === "cc" && <span className="rcpt__cc">Cc</span>}
            <span
              className="rcpt__time"
              title={r.openedAt ? new Date(r.openedAt).toLocaleString() : undefined}
            >
              {r.openedAt ? seenAt(r.openedAt) : "Sent"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Read receipts for a sent email, opened from the message's ⌄ menu (kept out of
 *  the thread itself). Live: reflects opens as they arrive over the socket. */
function ReceiptsModal({
  recipients,
  subject,
  onClose,
}: {
  recipients: { address: string; kind: "to" | "cc"; openedAt?: string | null }[];
  subject: string;
  onClose: () => void;
}) {
  return (
    <div className="modal" onClick={onClose}>
      {/* modal--dialog: short, read-only — stays a centred card on mobile
          rather than becoming a full-screen sheet. */}
      <div className="modal__box modal--dialog rcptmodal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <h2>Read receipts</h2>
          <button type="button" className="modal__x" onClick={onClose} aria-label="Close">
            <XIcon />
          </button>
        </div>
        <div className="modal__body">
          {subject && <div className="rcptmodal__subj">{subject}</div>}
          <ReadReceipts recipients={recipients} />
          <p className="fieldhint">
            A “Seen” is recorded when the recipient’s email app loads images. Some apps (e.g. Apple Mail)
            load them automatically, so treat this as a strong signal, not a guarantee.
          </p>
        </div>
      </div>
    </div>
  );
}

/** A single customer/agent message bubble, with any media rendered above an
 *  optional caption. Carries a quoted-reply preview, an emoji-reaction chip, and
 *  a hover toolbar (reply + react). Text-only markup is otherwise unchanged. */
function MessageBubble({
  m,
  quoted,
  onImage,
  actions,
  convChannel,
  sentFrom,
  onRetry,
  cont,
  midGroup,
}: {
  m: Message;
  quoted?: Message;
  onImage: (url: string) => void;
  actions?: MsgActions;
  /** The conversation's own channel — a message on a different one (cross-channel
   *  reply) carries a small badge so the mixed thread stays legible. */
  convChannel: ChannelType;
  /** Which of our numbers/addresses this went out from — set ONLY when it isn't
   *  the thread's usual one. A shared inbox with two numbers can send a reply
   *  from the other one without anything on screen saying so; printing it on
   *  every bubble instead would be noise on the 99% that went the usual way. */
  sentFrom?: string;
  /** Re-attempt delivery of this message (shown only on a failed outbound send). */
  onRetry?: (messageId: string) => void;
  /** True when the message above is from the same sender — tightens the gap and
   *  suppresses the repeated sender name. Presentation only. */
  cont?: boolean;
  /** True when the message BELOW is from the same sender, i.e. this is not the
   *  last of the run, so it drops its tail. Presentation only. */
  midGroup?: boolean;
}) {
  const out = m.direction === "out";

  // Touch gestures (mobile), WhatsApp-style: a long-press opens the reaction row,
  // a rightward swipe starts a reply. Both begin from one pointerdown — a
  // horizontal drag cancels the press and follows the finger (imperatively, via a
  // ref, so there's no per-frame React state), a vertical drag hands scrolling
  // back to the list. Mouse/pen (desktop) is ignored here; desktop uses hover.
  const bubbleRef = useRef<HTMLDivElement>(null);
  const hintRef = useRef<HTMLSpanElement>(null);
  const gestureRef = useRef<{ x: number; y: number; lp: number; swiping: boolean; active: boolean } | null>(null);
  // Inbound swipes right, outbound swipes left — mirrored, like WhatsApp. `dir`
  // flips the translate direction; the reply arrow side is mirrored in CSS.
  const dir = out ? -1 : 1;
  const setSwipe = (px: number) => {
    if (bubbleRef.current) bubbleRef.current.style.transform = px ? `translateX(${dir * px}px)` : "";
    if (hintRef.current) {
      // Reply arrow fades and grows as the bubble slides, snapping to full size
      // right at the commit threshold (WhatsApp feel).
      const t = Math.min(px / 56, 1);
      hintRef.current.style.opacity = String(t);
      hintRef.current.style.transform = `translateY(-50%) scale(${(0.55 + t * 0.45).toFixed(3)})`;
      hintRef.current.classList.toggle("ready", px >= 52);
    }
  };
  const endGesture = (commit: boolean) => {
    const b = bubbleRef.current;
    if (b) {
      // Spring the bubble back to rest — this smooth slide-back is the feedback,
      // no ring flash.
      b.style.transition = "transform .2s var(--ease)";
      b.style.transform = "";
      window.setTimeout(() => { if (b) b.style.transition = ""; }, 220);
    }
    if (hintRef.current) {
      hintRef.current.style.opacity = "0";
      hintRef.current.style.transform = "";
      hintRef.current.classList.remove("ready");
    }
    if (commit && actions) {
      navigator.vibrate?.(12);
      actions.onReply();
    }
  };
  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (!actions || e.pointerType !== "touch") return;
    const g = { x: e.clientX, y: e.clientY, swiping: false, active: true, lp: 0 };
    gestureRef.current = g;
    g.lp = window.setTimeout(() => {
      if (gestureRef.current === g && !g.swiping) {
        g.active = false;
        actions.onHold();
        navigator.vibrate?.(8);
      }
    }, 450);
  };
  const onPointerMove = (e: RPointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    if (!g || !g.active) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    const along = dx * dir; // positive when swiping in the reply direction for this bubble
    if (!g.swiping) {
      if (Math.abs(dy) > 12 && Math.abs(dy) >= Math.abs(dx)) { g.active = false; window.clearTimeout(g.lp); return; }
      if (along > 10 && along > Math.abs(dy)) { g.swiping = true; window.clearTimeout(g.lp); }
    }
    if (g.swiping) setSwipe(Math.max(0, Math.min(along, 92)));
  };
  const onPointerEnd = (e: RPointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    if (!g) return;
    window.clearTimeout(g.lp);
    if (g.swiping) endGesture((e.clientX - g.x) * dir > 52);
    gestureRef.current = null;
  };
  const atts = m.attachments ?? [];
  const hasMedia = atts.length > 0;
  const hasCaption = !!m.body && m.body.trim().length > 0;
  const single = atts.length === 1 ? atts[0] : null;
  const stickerOnly = !!single && single.kind === "sticker" && !hasCaption;
  // a lone image/video with no caption carries the floating timestamp chip
  const overlay = !!single && !hasCaption && (single.kind === "image" || single.kind === "video");
  // other media with no caption gets the timestamp on its own row underneath
  const blockStamp = hasMedia && !hasCaption && !overlay;
  const fallback = m.messageType === "location" ? "Location shared" : m.messageType === "contact" ? "Contact shared" : "";
  const showText = hasCaption || !hasMedia;
  const bodyText = hasCaption ? m.body : hasMedia ? "" : m.body || fallback;

  const reactions = m.reactions ?? [];
  const mine = reactions.find((r) => r.by === "user")?.emoji;
  const reactTitle = reactions
    .map((r) => `${r.emoji} ${r.by === "user" ? "You" : actions?.contactName ?? "Customer"}`)
    .join(",  ") + (mine ? " · tap to remove yours" : "");
  // A rich email body renders in its own sandboxed frame (below any media).
  const isEmailHtml = !!m.bodyHtml;
  // An email message reads as an email — a white bubble, not the WhatsApp green.
  // Rich HTML emails already get the white .bubble--email card; this covers the
  // plain-text ones.
  const isMailMsg = (m.channel ?? convChannel) === "email";
  // A message sent/received on a channel other than the thread's own is badged.
  const crossMeta = m.channel && m.channel !== convChannel ? channelMeta(m.channel) : null;
  const CrossGlyph = crossMeta?.Glyph;
  // Outbound (non-internal) messages carry a "SENT BY {agent}" label in their
  // meta row — so a shared inbox shows who replied, on WhatsApp and email alike.
  // It needs the flow (block) stamp layout, not the compact absolute overlay,
  // to fit a variable-width name beside the time + ticks.
  const namedMeta = out && !m.internal && !!m.authorName;
  // The inline WhatsApp-style overlay (+ its reserved spacer) is only used when
  // the stamp isn't already a block row or an image chip.
  const inlineStamp = !(isEmailHtml || blockStamp || namedMeta || overlay);

  return (
    <div
      className={"msg " + (out ? "out" : "in") + (actions ? " msg--gesture" : "") + (isMailMsg ? " msg--mail" : "") + (cont ? " msg--cont" : "") + (midGroup ? " msg--midgroup" : "")}
      data-mid={m.id}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      {!out && m.authorName && <div className="sender">{m.authorName}</div>}
      <div className="bubblewrap">
        <div
          ref={bubbleRef}
          className={
            "bubble" +
            (hasMedia ? " has-media" : "") +
            (stickerOnly ? " bubble--plain" : "") +
            (isEmailHtml ? " bubble--email" : "") +
            (isMailMsg && !isEmailHtml ? " bubble--mail" : "")
          }
        >
          {m.email &&
            (m.email.subject || m.email.cc?.length || m.email.bcc?.length || m.email.forwardedTo?.length || m.email.via) && (
              <div className="emailmeta">
                {m.email.forwardedTo?.length ? (
                  <div className="emailmeta__row emailmeta__fwd">
                    <span className="emailmeta__lbl">
                      <ForwardIcon />
                      Forwarded to
                    </span>
                    {m.email.forwardedTo.join(", ")}
                  </div>
                ) : null}
                {m.email.subject && <div className="emailmeta__subj">{m.email.subject}</div>}
                {/* Sent from one address, Reply-To the customer (a website form, say). */}
                {m.email.via ? (
                  <div className="emailmeta__row" title="This email asked for replies to go to the customer, not to the address it came from">
                    <span className="emailmeta__lbl">Via</span>
                    {m.email.via}
                  </div>
                ) : null}
                {m.email.cc?.length ? (
                  <div className="emailmeta__row">
                    <span className="emailmeta__lbl">Cc</span>
                    {m.email.cc.join(", ")}
                  </div>
                ) : null}
                {m.email.bcc?.length ? (
                  <div className="emailmeta__row">
                    <span className="emailmeta__lbl">Bcc</span>
                    {m.email.bcc.join(", ")}
                  </div>
                ) : null}
              </div>
            )}
          {quoted && (
            <button
              type="button"
              className="quoted"
              onClick={() => actions?.onJump(quoted.id)}
              title="View replied message"
            >
              <span className="quoted__accent" aria-hidden="true" />
              <span className="quoted__body">
                <span className="quoted__who">
                  {quoted.direction === "out" ? "You" : quoted.authorName || actions?.contactName || "Customer"}
                </span>
                <span className="quoted__txt">{quotedSnippet(quoted)}</span>
              </span>
            </button>
          )}
          {/* WhatsApp's "Forwarded" tell, above the content it qualifies: these
              aren't the sender's own words, and that's worth knowing before you
              read them. Same label whichever direction it came from. */}
          {m.forwarded && (
            <span className="fwdmark">
              <ForwardIcon />
              Forwarded
            </span>
          )}
          {/* Nest said this, not a person: the website chat's reply while
              nobody was online — what the customer was told before you came. */}
          {m.auto && <span className="fwdmark automark">Automatic reply · nobody was online</span>}
          {hasMedia && atts.map((a) => <AttachmentView key={a.id} att={a} onImage={onImage} />)}
          {isEmailHtml ? (
            <EmailHtml html={m.bodyHtml as string} />
          ) : (
            showText && (
              <span className="txt">
                <Linkify text={bodyText} />
                {inlineStamp && <span className="stampspace" aria-hidden="true" />}
              </span>
            )
          )}
          <span
            className={"stamp" + (isEmailHtml || blockStamp || namedMeta ? " stamp--block" : overlay ? " stamp--over" : "")}
          >
            {namedMeta && (
              <span className="stamp__by" title={`Sent by ${m.authorName}`}>
                Sent by {m.authorName}
              </span>
            )}
            {crossMeta && CrossGlyph && (
              <span className="stamp__chan" style={{ color: crossMeta.color }} title={`Via ${crossMeta.label}`}>
                <CrossGlyph />
              </span>
            )}
            {sentFrom && (
              <span className="stamp__from" title={`Sent from ${sentFrom}`}>
                from {sentFrom}
              </span>
            )}
            {clockTime(m.createdAt)}
            {out && !m.internal && <StatusTick status={m.status} />}
          </span>
        </div>

        {out && m.status === "failed" && (
          <div className="msgfail" role="alert">
            <AlertIcon />
            <span className="msgfail__txt">{m.failureReason || "Not delivered"}</span>
            {onRetry && (
              <button type="button" className="msgfail__retry" onClick={() => onRetry(m.id)}>
                Retry
              </button>
            )}
          </div>
        )}

        {actions && (
          <>
            {/* Desktop: chevron in the bubble's inner corner → actions menu (hover) */}
            <button
              type="button"
              className="msg__menubtn"
              aria-label="Message actions"
              aria-haspopup="menu"
              aria-expanded={actions.menuOpen}
              onClick={actions.onMenuToggle}
            >
              <ChevronDown />
            </button>
            {/* Desktop: a smiley on the outer side of the bubble; click it to open
                the reaction picker (WhatsApp-web). Hidden on touch (long-press there). */}
            <button
              type="button"
              className="msg__reactbtn"
              aria-label="React to message"
              onClick={actions.onHold}
            >
              <EmojiIcon />
            </button>
            {actions.menuOpen && (
              <div className="msg__menu" role="menu">
                {/* React lives in the menu too — it's the reliable path on touch,
                    where the long-press gesture can't reach an email bubble's
                    iframe. Opens the same quick-reaction row. */}
                <button type="button" className="msg__menuitem msg__menuitem--touch" role="menuitem" onClick={actions.onHold}>
                  <EmojiIcon />
                  <span>React</span>
                </button>
                <button type="button" className="msg__menuitem" role="menuitem" onClick={actions.onReply}>
                  <ReplyIcon />
                  <span>Reply</span>
                </button>
                {actions.onReplyAll && (
                  <button type="button" className="msg__menuitem" role="menuitem" onClick={actions.onReplyAll}>
                    <ReplyAllIcon />
                    <span>Reply all</span>
                  </button>
                )}
                {actions.onForward && (
                  <button type="button" className="msg__menuitem" role="menuitem" onClick={actions.onForward}>
                    <ForwardIcon />
                    <span>Forward</span>
                  </button>
                )}
                {actions.onReceipts && (
                  <button type="button" className="msg__menuitem" role="menuitem" onClick={actions.onReceipts}>
                    <EyeIcon />
                    <span>Read receipts</span>
                  </button>
                )}
                {actions.onDiscuss && (
                  <button type="button" className="msg__menuitem" role="menuitem" onClick={actions.onDiscuss}>
                    <TeamChatIcon />
                    <span>Discuss…</span>
                  </button>
                )}
              </div>
            )}
            {/* Quick-reaction row — desktop: above the near corner (hover); mobile: centred (held) */}
            <div className={"msg__react" + (actions.held ? " held" : "")} role="menu" aria-label="Pick a reaction">
              {QUICK_REACTIONS.map((e, i) => (
                <button
                  key={e}
                  type="button"
                  className={"msg__react-e" + (mine === e ? " sel" : "")}
                  style={{ animationDelay: `${i * 25}ms` }}
                  onClick={() => actions.onReact(mine === e ? "" : e)}
                  aria-label={mine === e ? `Remove ${e}` : `React ${e}`}
                >
                  {e}
                </button>
              ))}
            </div>
            {/* Swipe-to-reply hint, revealed behind the bubble as it slides (touch) */}
            <span className="msg__swipehint" aria-hidden="true" ref={hintRef}>
              <ReplyIcon />
            </span>
          </>
        )}
        {reactions.length > 0 && (
          <div
            className={"reacts" + (mine ? " reacts--mine" : "")}
            role={mine && actions ? "button" : undefined}
            tabIndex={mine && actions ? 0 : undefined}
            title={reactTitle}
            onClick={mine && actions ? () => actions.onReact("") : undefined}
            onKeyDown={
              mine && actions
                ? (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      actions.onReact("");
                    }
                  }
                : undefined
            }
          >
            {reactions.map((r, i) => (
              <span key={i} className="reacts__e">{r.emoji}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* dayLabel + groupMessagesByDay moved to @ding/client — the native thread has
   to break days on exactly the same boundaries, and two copies of that rule
   would drift. Imported at the top of this file. */

/** One macro in the composer's list: its shortcut, name and opening words. */
function MacroRow({
  macro,
  fill,
  selected,
  onHover,
  onPick,
}: {
  macro: Macro;
  fill: TemplateFillContext;
  selected: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  // Keep the highlighted row in view as the arrow keys walk a long list.
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  return (
    <button
      ref={ref}
      type="button"
      role="option"
      aria-selected={selected}
      className={"mentionpop__row" + (selected ? " sel" : "")}
      onMouseEnter={onHover}
      // Keep focus in the reply box so the caret lands after the text.
      onMouseDown={(e) => {
        e.preventDefault();
        onPick();
      }}
    >
      <span className="mentionpop__meta">
        <b>{macro.name}</b>
        {/* As it will read in this chat, not as written in settings. */}
        <small>{resolveTemplateDefault(macro.body, fill).replace(/\s+/g, " ")}</small>
      </span>
      {macro.shortcut && <span className="macropop__sc">/{macro.shortcut}</span>}
    </button>
  );
}

export function Thread({ conversationId, showPanel, onTogglePanel, onToast, onBack, onClosed, active = true, discussion = null, onOpenDiscussion }: Props) {
  const { data: conv } = useConversation(conversationId);
  const { loadOlder, loading: loadingOlder } = useLoadOlderMessages(conversationId);
  const { data: me } = useMe();
  const { data: teams } = useTeams();
  const send = useSendMessage();
  const assign = useAssign();
  const setStatus = useSetStatus();
  const snooze = useSnooze();
  const { mutate: markRead } = useMarkRead();
  const { mutate: markUnread } = useMarkUnread();
  const { mutate: react } = useReact();
  const { mutate: retry } = useRetryMessage();
  const forward = useForwardMessage();
  const { data: people } = usePeople();
  // The customer directory, for suggestions in Forward and Cc/Bcc (cached, shared).
  const { data: contacts } = useContacts();
  // Teammates as @mentions: who "@Nathan A" means, and whose name "@nathan" shows as.
  const mentionPeople = useMemo(() => (people ?? []).map((m) => m.user), [people]);
  // Used far below, for reply-all's "don't copy ourselves" filter. It is called
  // *here* rather than at its use site because this component returns early
  // while the conversation loads: a hook below those returns runs on some
  // renders and not others, which is React error #310 and a blank screen.
  const { data: inboxes } = useInboxes();
  // Saved replies this conversation's team inbox offers (the server decides
  // which). Up here for the same early-return reason as the inboxes above.
  const { data: macros } = useConversationMacros(conversationId, conv?.assignedTeamId);
  // Team Chat: discuss this conversation, or a message in it, with the team;
  // and send a note on to a chat as well. Up here for the same reason.
  const chatOn = !!useChatStatus().data?.enabled;
  const shareToChat = useShareConversation();
  const [sharing, setSharing] = useState<{ message: { id: string; who: string; text: string } | null } | null>(null);
  const [alsoTo, setAlsoTo] = useState<string | null>(null);
  useEffect(() => {
    setSharing(null);
    setAlsoTo(null);
  }, [conversationId]);

  const [text, setText] = useState("");
  // The message being quoted in a reply (shown as a cue above the composer), and
  // which message's quick-reaction bar is open. Both reset when the thread changes.
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [reactFor, setReactFor] = useState<string | null>(null);
  // Touch, not "narrow": the hold overlay replaces affordances that only exist
  // because a pointer can hover, so the input model is what decides — matching
  // the `@media (hover:none)` block the touch styles already live in.
  const touch = useMediaQuery("(hover: none)");
  const [menuFor, setMenuFor] = useState<string | null>(null);
  // The message currently being forwarded (drives whichever forward modal fits
  // its channel: addresses for email, a chat picker for WhatsApp).
  const [forwardMsg, setForwardMsg] = useState<Message | null>(null);
  // The id of the sent email whose read receipts are open (resolved live from the
  // thread each render, so the modal updates as opens arrive over the socket).
  const [receiptsMsgId, setReceiptsMsgId] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  // Rich-text HTML for an email reply (mirrors the Tiptap editor's content).
  const [html, setHtml] = useState("");
  // Drives whether the Polish button exists at all: no Claude key, no button.
  const aiConfigured = Boolean(useIntegrations().data?.anthropic?.configured);
  // Needed for the closed-window fallback below (react-query caches it, so this
  // is one shared fetch, not one per thread).
  const templates = useTemplates().data;
  // Composer emoji picker, and the email Cc/Bcc fields (revealed on demand).
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [showCc, setShowCc] = useState(false);
  const [cc, setCc] = useState<string[]>([]);
  const [bcc, setBcc] = useState<string[]>([]);
  // The editable email subject (the thread's subject; empty on a fresh email).
  const [subjectDraft, setSubjectDraft] = useState(conv?.subject ?? "");
  // Subject shows compact ("Subject: …" + pencil) until you tap to edit it.
  const [editingSubject, setEditingSubject] = useState(false);
  // Who is writing on THIS conversation, and on NestChat what they've written so
  // far. Auto-clears after four seconds of silence and on an explicit
  // typing:false, and is torn down on switch/unmount so a stale indicator can't
  // bleed across conversations. Shared with the phone — this used to be a second
  // copy of the same socket listener living here.
  const typing = useTypingPresence(conversationId ?? null);
  const [menu, setMenu] = useState(false);
  const [snoozeMenu, setSnoozeMenu] = useState(false);
  const [labelMenu, setLabelMenu] = useState(false);
  const [moreMenu, setMoreMenu] = useState(false);
  const [internal, setInternal] = useState(false);
  // @-mention autocomplete for internal notes: the active "@query" being typed
  // (with the '@' index in `text`), and the highlighted candidate.
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  const [mentionSel, setMentionSel] = useState(0);
  // Macros: the "/shortcut" being typed in a reply (same shape as a mention),
  // its highlighted row, and the picker the Macros button opens.
  const [slash, setSlash] = useState<{ query: string; start: number } | null>(null);
  const [slashSel, setSlashSel] = useState(0);
  const [macroOpen, setMacroOpen] = useState(false);
  const [macroQ, setMacroQ] = useState("");
  const [macroSel, setMacroSel] = useState(0);
  // The channel the composer is currently replying on. null → follow the
  // conversation's own channel; set (via the channel switcher) to reply on
  // another channel the customer is reachable on, within this one open thread.
  const [composeChannelState, setComposeChannelState] = useState<ChannelType | null>(null);
  // AI assist. `prePolish` holds the draft as it was before the last polish so
  // one tap puts it back; it also carries the polished text, so the Undo bar
  // hides itself the moment the agent edits (undoing would discard that edit).
  const [polishing, setPolishing] = useState(false);
  const [prePolish, setPrePolish] = useState<{ text: string; html: string; polished: string } | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  // Ticks so the WhatsApp 24-hour window countdown stays live without a reload.
  const [now, setNow] = useState(() => Date.now());
  const endRef = useRef<HTMLDivElement>(null);
  // Scroll-to-latest button: shown once the thread is scrolled up off the bottom.
  const msgsRef = useRef<HTMLDivElement>(null);
  const [showJump, setShowJump] = useState(false);
  // Whether the reader is essentially at the latest message. Read the instant
  // the keyboard starts to open, to decide whether to keep the newest bubble
  // pinned above it (WhatsApp) — never yank someone who's scrolled up reading.
  const nearBottomRef = useRef(true);
  // True from opening a thread until the restore has settled; see onMsgsScroll.
  const restoringRef = useRef(false);
  // Set the instant "Load earlier messages" is pressed, to the reader's distance
  // from the *bottom* of the scroller. Older messages are prepended, so every
  // pixel of new content lands above the viewport and everything the reader was
  // looking at slides down by exactly that much; the distance from the bottom is
  // the one measure that survives it. Restored in the layout effect below.
  const olderAnchorRef = useRef<{ from: number; len: number } | null>(null);
  const olderTimersRef = useRef<number[]>([]);
  const loadEarlier = () => {
    const el = msgsRef.current;
    if (el && conv) {
      olderAnchorRef.current = { from: el.scrollHeight - el.scrollTop, len: conv.messages.length };
      restoringRef.current = true; // don't let the reflow's scroll events overwrite the mark
    }
    void loadOlder();
  };
  const onMsgsScroll = () => {
    const el = msgsRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowJump(dist > 260);
    nearBottomRef.current = dist < 120;
    // Remember the spot so coming back lands here (see threadScroll) — but not
    // while we're restoring: a freshly mounted scroller sits at 0 and fires a
    // scroll event of its own, which would overwrite the position we're about
    // to put back.
    if (conversationId && !restoringRef.current) {
      rememberScroll(conversationId, { top: el.scrollTop, atBottom: dist < 120 });
    }
  };
  const jumpToBottom = () => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    setShowJump(false);
  };
  // ─── Read receipts + typing indicator bookkeeping ───
  // Track the last-seen (conversation, message-count) so we can mark-read exactly
  // once on open and again only when a *new inbound* message lands while open.
  const seenRef = useRef<{ id: string | null; len: number }>({ id: null, len: 0 });
  const typingSentRef = useRef(false); // have we emitted typing:true since the last stop?
  const typingThrottleRef = useRef(0); // last time we emitted typing:true (ms epoch)
  const typingStopRef = useRef<number | null>(null); // idle timer that emits typing:false
  const waTypingRef = useRef(0); // last time we pinged WhatsApp's typing indicator (ms epoch)
  const taRef = useRef<HTMLTextAreaElement>(null);
  // Latest typing-signal fn, so the editor's (once-created) onUpdate calls the
  // current one without a stale closure.
  const typingSignalRef = useRef<() => void>(() => {});
  // Maintained rich-text editor for email replies (replaces document.execCommand).
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: false }), // email bodies don't need headings
      Underline,
      Link.configure({
        openOnClick: false,
        autolink: true,
        HTMLAttributes: { rel: "noopener noreferrer nofollow", target: "_blank" },
      }),
      Placeholder.configure({ placeholder: "Write a reply…" }),
    ],
    editorProps: {
      attributes: { class: "richedit", role: "textbox", "aria-multiline": "true" },
    },
    onUpdate: ({ editor }) => {
      setHtml(editor.getHTML());
      setText(editor.getText());
      typingSignalRef.current();
    },
  });
  // Conversations we've already auto-opened the template picker for (cold WA starts).
  const autoTemplateRef = useRef<Set<string>>(new Set());
  const modeThumbRef = useRef<HTMLSpanElement>(null);
  const { containerRef: modeRef, thumbRef: modeHoverRef, hoverProps: modeHover } = useHoverGlide<HTMLDivElement>(".modebtn", "x");

  // ─── Composer media state ───
  const [staged, setStaged] = useState<Staged[]>([]);
  const [dragging, setDragging] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recPaused, setRecPaused] = useState(false);
  const [recSecs, setRecSecs] = useState(0);
  const stagedRef = useRef<Staged[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recStreamRef = useRef<MediaStream | null>(null);
  const recChunksRef = useRef<Blob[]>([]);
  const recTimerRef = useRef<number | null>(null);
  const recStartRef = useRef(0);
  const recBaseRef = useRef(0); // ms accumulated across pause/resume segments
  const recCancelRef = useRef(false);
  const recSendRef = useRef(false); // send the clip the instant it finalizes

  // Scroll behaviour:
  //  • Opening a thread → back to exactly where you left it, WhatsApp-style.
  //    If you were at the latest message (or have never opened this thread), it
  //    goes to the bottom. Instant, and re-applied once after late reflow —
  //    images and email frames size up after first paint, and anything smooth
  //    or single-shot lands somewhere arbitrary when they do.
  //  • A new message in the already-open thread → smooth-scroll to the bottom.
  //    "New" means the newest message changed, not that the list got longer:
  //    loading earlier messages also makes it longer, and jumping to the latest
  //    is the exact opposite of what someone reading history just asked for.
  const openedRef = useRef<string | null>(null);
  const lastIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!conv) return;
    const newest = conv.messages[conv.messages.length - 1]?.id ?? null;
    const opening = openedRef.current !== conversationId;
    if (!opening) {
      if (newest !== lastIdRef.current) endRef.current?.scrollIntoView({ behavior: "smooth" });
      lastIdRef.current = newest;
      return;
    }
    openedRef.current = conversationId ?? null;
    lastIdRef.current = newest;
    const saved = conversationId ? threadScroll.get(conversationId) : undefined;
    const jump = () => {
      const el = msgsRef.current;
      // No memory of this thread, or you were at the latest when you left:
      // show the latest. Otherwise put the scroller back where it was.
      if (!saved || saved.atBottom || !el) {
        endRef.current?.scrollIntoView({ behavior: "auto" });
        return;
      }
      // Clamp: the thread may have grown or shrunk since.
      el.scrollTop = Math.min(saved.top, el.scrollHeight - el.clientHeight);
    };
    restoringRef.current = true;
    const raf = requestAnimationFrame(jump);
    const correct = window.setTimeout(jump, 220); // re-settle after late reflow
    // Hand scroll-tracking back a beat after the last correction, so the
    // position we record from here on is the reader's, not ours.
    const settled = window.setTimeout(() => {
      restoringRef.current = false;
    }, 300);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(correct);
      window.clearTimeout(settled);
      restoringRef.current = false;
    };
  }, [conv, conversationId]);

  // The other half of loadEarlier: the older messages have landed, so put the
  // reader back on the message they were reading. In a layout effect, before
  // paint, so the jump is never seen. Re-applied once after a beat because
  // images and email frames in the newly loaded messages size up after first
  // paint and push everything down again. The length check is what makes this
  // wait for the *prepend* specifically — any other re-render in the meantime
  // (a socket update, a refetch) leaves the anchor alone.
  useLayoutEffect(() => {
    const anchor = olderAnchorRef.current;
    if (!anchor || !conv || conv.messages.length <= anchor.len) return;
    olderAnchorRef.current = null;
    const el = msgsRef.current;
    if (!el) {
      restoringRef.current = false;
      return;
    }
    const put = () => {
      el.scrollTop = el.scrollHeight - anchor.from;
    };
    put();
    olderTimersRef.current.forEach(window.clearTimeout);
    olderTimersRef.current = [
      window.setTimeout(put, 220),
      window.setTimeout(() => {
        restoringRef.current = false;
      }, 300),
    ];
  }, [conv]);

  // Deliberately keyed on the thread, not on `conv`: the corrections above must
  // survive the re-renders that happen while they're pending, and only be
  // dropped when the thread they belong to goes away.
  useEffect(
    () => () => {
      olderTimersRef.current.forEach(window.clearTimeout);
      olderTimersRef.current = [];
      olderAnchorRef.current = null;
    },
    [conversationId],
  );

  // Keyboard open/close (mobile): the shell shrinks to sit above the keyboard, so
  // the message scroller shrinks with it. If the reader was already at the latest
  // message, keep it pinned to the bottom (above the keyboard) as WhatsApp does;
  // if they'd scrolled up, leave them exactly where they were. We read
  // nearBottom *synchronously* when the resize fires — before the shrink clamps
  // scrollTop — then re-pin after layout. Message scroller only; never the window.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => {
      if (!window.matchMedia("(max-width:820px)").matches) return; // desktop untouched
      if (!nearBottomRef.current) return;
      const el = msgsRef.current;
      if (!el) return;
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight; // instant, so the latest stays glued to the keyboard
      });
    };
    vv.addEventListener("resize", onResize);
    return () => vv.removeEventListener("resize", onResize);
  }, []);

  // Auto-grow the plain (WhatsApp / note) textarea upward as lines are added, up
  // to the CSS max-height, after which it scrolls internally — like WhatsApp. The
  // composer is a fixed-size flex child, so as it grows the message list gives up
  // the space and the input stays anchored above the keyboard. When the email
  // (rich) editor is active the textarea isn't mounted, so taRef is null and this
  // no-ops — that editor grows on its own via contentEditable. Kept above the
  // early returns below so the hook order never changes between renders.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`;
  }, [text]);

  // Close the image lightbox on Esc while it's open.
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightbox(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox]);

  // Re-tick the WhatsApp window countdown ~every 30s; cleared on unmount.
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);

  // A newly-opened conversation should show a fresh countdown immediately and
  // drop any pending reply-quote / open reaction bar from the previous thread.
  useEffect(() => {
    setNow(Date.now());
    setPicker(false);
    setReplyTo(null);
    setReactFor(null);
    setHtml("");
    setEmojiOpen(false);
    setShowCc(false);
    setCc([]);
    setBcc([]);
    setComposeChannelState(null);
    setPrePolish(null);
    editor?.commands.clearContent();
  }, [conversationId, editor]);

  // Keep the editable email subject synced to the thread: it resets when
  // switching threads and reflects a subject set elsewhere. conv.subject only
  // changes on a send, so this never clobbers an in-progress edit.
  useEffect(() => {
    setSubjectDraft(conv?.subject ?? "");
  }, [conversationId, conv?.subject]);

  // Starting a *new* WhatsApp conversation lands on a cold, window-closed thread
  // where an approved template is the only way to open the conversation — so
  // present the template picker straight away (once per conversation).
  useEffect(() => {
    if (!conv) return;
    const isWa = conv.channel === "whatsapp" || conv.channel === "whatsapp_group";
    const coldStart = isWa && !!conv.waWindow && !conv.waWindow.open && conv.messages.length === 0;
    if (coldStart && !autoTemplateRef.current.has(conv.id)) {
      autoTemplateRef.current.add(conv.id);
      setPicker(true);
    }
  }, [conv?.id, conv?.channel, conv?.waWindow?.open, conv?.messages.length]);

  // Dismiss the composer emoji picker on outside click or Esc.
  useEffect(() => {
    if (!emojiOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest(".emojipop") && !t.closest(".tool--emoji")) setEmojiOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setEmojiOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [emojiOpen]);

  // The Macros picker closes the same way.
  useEffect(() => {
    if (!macroOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest(".macropop") && !t.closest(".tool--macro")) setMacroOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [macroOpen]);

  // A half-typed "/shortcut" or an open picker doesn't follow you to another chat.
  useEffect(() => {
    setSlash(null);
    setMacroOpen(false);
    setLogOpen(false);
  }, [conversationId]);

  // Dismiss an open reaction row / actions menu on outside click or Esc.
  useEffect(() => {
    if (!reactFor && !menuFor) return;
    const onDown = (e: Event) => {
      const t = e.target as HTMLElement;
      // `.hold` (the touch overlay) owns its own dismissal — its scrim closes it
      // on click. Without it here, this pointerdown clears `reactFor` and
      // unmounts the sheet before the button the finger is on ever fires its
      // click, so Reply and Forward silently do nothing.
      if (
        !t.closest(".msg__react") &&
        !t.closest(".msg__reactbtn") &&
        !t.closest(".msg__menubtn") &&
        !t.closest(".hold")
      ) {
        setReactFor(null);
      }
      if (!t.closest(".msg__menu") && !t.closest(".msg__menubtn")) setMenuFor(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setReactFor(null); setMenuFor(null); }
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [reactFor, menuFor]);

  // Slide the mode thumb under the active tab (a channel, or Note). Positioned by
  // querying the active button — the compose channel isn't resolved until after
  // the loading guards below, so we can't thread a ref through per tab. Written to
  // the DOM directly (no state) so the slide starts on the click's own frame.
  useLayoutEffect(() => {
    const thumb = modeThumbRef.current;
    const btn = modeRef.current?.querySelector<HTMLElement>(".modebtn.active");
    if (btn && thumb) {
      thumb.style.transform = `translateX(${btn.offsetLeft}px)`;
      thumb.style.width = `${btn.offsetWidth}px`;
    }
    // conv.messages.length: the default tab follows the thread's last-used
    // channel, so an inbound on the other channel can move the active tab
    // without composeChannelState changing.
  }, [internal, composeChannelState, conversationId, conv?.status, conv?.messages.length]);

  // Mirror staged items into a ref so teardown can revoke URLs without re-binding.
  useEffect(() => {
    stagedRef.current = staged;
  }, [staged]);

  // Release object URLs, the mic stream and timers when the thread unmounts.
  useEffect(() => {
    return () => {
      stagedRef.current.forEach((s) => s.previewUrl && URL.revokeObjectURL(s.previewUrl));
      recStreamRef.current?.getTracks().forEach((t) => t.stop());
      if (recTimerRef.current != null) window.clearInterval(recTimerRef.current);
      const rec = mediaRecorderRef.current;
      if (rec && rec.state !== "inactive") {
        recCancelRef.current = true;
        try {
          rec.stop();
        } catch {
          /* already stopped */
        }
      }
    };
  }, []);

  // Switching conversations abandons any half-composed media + recording, so an
  // attachment can never be sent to the wrong thread.
  useEffect(() => {
    stagedRef.current.forEach((s) => s.previewUrl && URL.revokeObjectURL(s.previewUrl));
    setStaged([]);
    const rec = mediaRecorderRef.current;
    if (rec && rec.state !== "inactive") {
      recCancelRef.current = true;
      try {
        rec.stop();
      } catch {
        /* already stopped */
      }
    }
    recStreamRef.current?.getTracks().forEach((t) => t.stop());
    recStreamRef.current = null;
    if (recTimerRef.current != null) {
      window.clearInterval(recTimerRef.current);
      recTimerRef.current = null;
    }
    recSendRef.current = false;
    setRecording(false);
    setRecPaused(false);
  }, [conversationId]);

  // Track browser-tab focus: a read receipt should only go out when the agent can
  // actually see the message, so a backgrounded tab (or a phone with the screen
  // off) never marks a customer's message read behind their back.
  const [docVisible, setDocVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState === "visible",
  );
  useEffect(() => {
    const onVis = () => setDocVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);
  // Read receipts fire only when the thread is genuinely on-screen: it's the
  // active pane (on mobile the thread stays mounted behind the list) AND the tab
  // is focused. Otherwise a new inbound arriving while you're back on the list
  // would send the customer blue ticks you never earned.
  const canMarkRead = active && docVisible;

  // Mark the conversation read on open, and again whenever a fresh inbound
  // message arrives WHILE THE THREAD IS ON-SCREEN — clearing the unread badge and
  // sending a WhatsApp read receipt. When it isn't on-screen the effect bails
  // BEFORE recording the new message count, so returning to the thread (or
  // refocusing the tab) still marks the messages that arrived while you were away.
  useEffect(() => {
    if (!conversationId || !conv || !canMarkRead) return;
    const len = conv.messages.length;
    const prev = seenRef.current;
    seenRef.current = { id: conversationId, len };
    if (prev.id !== conversationId) {
      markRead(conversationId);
    } else if (len > prev.len) {
      const newest = conv.messages[len - 1];
      if (newest && newest.direction === "in" && !newest.internal) markRead(conversationId);
    }
  }, [conversationId, conv, markRead, canMarkRead]);

  // Stop broadcasting our own typing when leaving/switching a conversation.
  useEffect(() => {
    const id = conversationId;
    return () => {
      if (typingStopRef.current != null) {
        window.clearTimeout(typingStopRef.current);
        typingStopRef.current = null;
      }
      if (id && typingSentRef.current) {
        getSocket().emit(ClientEvent.Typing, { conversationId: id, typing: false });
      }
      typingSentRef.current = false;
      typingThrottleRef.current = 0;
    };
  }, [conversationId]);

  if (!conversationId) {
    return (
      <main className="thread">
        <div className="center-note">Select a conversation to get started.</div>
      </main>
    );
  }
  if (!conv) {
    return (
      <main className="thread">
        <div className="center-note">Loading…</div>
      </main>
    );
  }

  // Every channel this thread actually spans — the header badges each one, since
  // a conversation can move between WhatsApp and email. Newest-used first;
  // internal notes carry no channel, and a message with none rides the thread's own.
  const threadChannels: ChannelType[] = (() => {
    const seen = new Set<ChannelType>();
    const out: ChannelType[] = [];
    for (let i = conv.messages.length - 1; i >= 0; i--) {
      const m = conv.messages[i];
      if (m.internal) continue;
      const ch = (m.channel ?? conv.channel) as ChannelType;
      if (!seen.has(ch)) {
        seen.add(ch);
        out.push(ch);
      }
    }
    if (out.length === 0) out.push(conv.channel);
    return out;
  })();
  // ─── Reply channel (cross-channel thread) ───
  // The thread's own channel is its identity; the *composer* may target any
  // channel the customer is reachable on, within this one open thread.
  const convIsEmail = conv.channel === "email";
  const isGroup = conv.channel === "whatsapp_group";
  // The reply-target channels shown in the composer's mode switcher (before the
  // Note tab) — shared with the phone so the two can't drift apart on it.
  const replyTargets: ChannelType[] = replyTargetsFor(conv, (inboxes ?? []).map((i) => i.type));
  // Default the composer to the channel the thread most recently used, not the
  // conversation's own channel. Those are the same for most threads and only
  // diverge once someone has actually replied on the other one — which is
  // exactly when answering on the thread's original channel is the wrong guess.
  // A group is always answered in the group. Falls back to the conversation's
  // channel if the last-used one isn't a reachable target (e.g. the thread has
  // email history but no address on the contact record).
  const lastUsedChannel = threadChannels[0];
  const defaultComposeChannel: ChannelType =
    !isGroup && lastUsedChannel && replyTargets.includes(lastUsedChannel) ? lastUsedChannel : conv.channel;
  const composeChannel: ChannelType = (!isGroup && composeChannelState) || defaultComposeChannel;
  /* Which of our numbers/addresses this thread sends from.
     `threadInbox` is what it uses when nobody switches channel — the baseline a
     bubble is only worth labelling against. `composeInbox` is what the message
     being typed right now would go from, which is the thing an agent cannot
     otherwise see: switching the composer to WhatsApp on an email thread quietly
     changes which number the customer hears from. Same function the server sends
     with, so the label cannot promise one number and the send use another. */
  const threadInbox = sendingInbox(inboxes ?? [], conv);
  const composeInbox = sendingInbox(inboxes ?? [], conv, { channel: composeChannel });
  // What the server will append to this email: the sending mailbox's signature
  // with my details in it. Shown as one quiet line so nobody types their own.
  const sigContext = {
    agentName: me?.user.name,
    agentPosition: me?.user.position,
    agentEmail: me?.user.email,
    teamName: teams?.find((t) => t.id === (conv.assignedTeamId ?? composeInbox?.teamIds[0]))?.name,
    channelName: composeInbox?.name,
    channelEmail: composeInbox?.handle,
  };
  const willSign = composeInbox?.type === "email" && !!renderEmailSignature(composeInbox.signature, sigContext);
  const isEmail = composeChannel === "email";
  const isClosed = conv.status === "closed";
  const owned = !!conv.assigneeUserId;
  const assignedToMe = conv.assigneeUserId === me?.user.id;
  // Resolve who the conversation is actually assigned to (name + avatar colour),
  // so the header shows the real owner — not the viewer — when it's someone else's.
  const assigneeUser = conv.assigneeUserId
    ? people?.find((p) => p.user.id === conv.assigneeUserId)?.user
    : undefined;
  const assigneeName = assigneeUser?.name ?? conv.assigneeName ?? "a teammate";
  // The presence line under the contact name. WhatsApp's Cloud API doesn't hand
  // businesses a customer's real online/last-seen status, so instead of a fake
  // "online" we show an honest "last active", derived from when the contact
  // last messaged us (their most recent inbound, ignoring internal notes).
  const lastInboundAt = (() => {
    for (let i = conv.messages.length - 1; i >= 0; i--) {
      const m = conv.messages[i];
      if (m.direction === "in" && !m.internal) return m.createdAt;
    }
    return null;
  })();
  const sub = convIsEmail
    ? (conv.contact.email ?? "")
    : lastInboundAt
      ? conv.channel === "whatsapp_group"
        ? `group · ${lastActive(lastInboundAt)}`
        : lastActive(lastInboundAt)
      : conv.channel === "whatsapp_group"
        ? "group"
        : (conv.contact.phone ?? "");

  /* ─── AI assist: one-tap Polish ───────────────────────────────────
     Polish only rewrites the draft the agent has already typed — it never
     sends, and never composes a reply of its own. The pre-polish draft is
     kept so Undo restores it byte-for-byte (including the email HTML). */
  const runPolish = async () => {
    const draft = text.trim();
    if (!draft || polishing) return;
    setPolishing(true);
    try {
      const res = await api.polishDraft({ text: draft, channel: composeChannel, internal, conversationId });
      if (!res.changed) {
        onToast("That already reads well — nothing to polish");
        return;
      }
      setPrePolish({ text, html, polished: res.text });
      // emitUpdate: true — Tiptap's setContent defaults to NOT firing onUpdate,
      // which would leave `text`/`html` holding the pre-polish draft and send
      // the unpolished body.
      if (isRich && editor) editor.commands.setContent(textToHtml(res.text), true);
      else setText(res.text);
    } catch (err) {
      // The API client forwards the server's message, which is written for an
      // agent to act on ("Claude rejected the API key — check it in Settings").
      onToast(err instanceof Error && err.message ? err.message : "Couldn't polish that draft");
    } finally {
      setPolishing(false);
    }
  };

  const undoPolish = () => {
    if (!prePolish) return;
    if (isRich && editor) editor.commands.setContent(prePolish.html || textToHtml(prePolish.text), true);
    else setText(prePolish.text);
    setPrePolish(null);
  };

  // Offer Undo only while the draft is still exactly what Polish produced —
  // once the agent edits, restoring the old draft would throw that edit away.
  const canUndoPolish = !!prePolish && text.trim() === prePolish.polished.trim();

  const readyAtts = staged.filter((s) => s.status === "done" && s.attachment);
  const uploadingAtts = staged.some((s) => s.status === "uploading");
  const canSend = (text.trim().length > 0 || readyAtts.length > 0) && !uploadingAtts;
  const canRecord = typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

  // ─── WhatsApp 24-hour window ───
  // Everything below tracks the *compose* channel, so a cross-channel reply is
  // gated correctly. `waWindow` is null on email (no restriction). On WhatsApp it
  // says whether you may still free-type; once closed, only a template gets through.
  const isWhatsApp = composeChannel === "whatsapp" || composeChannel === "whatsapp_group";
  // Email replies compose in a rich-text editor; notes + other channels stay plain.
  const isRich = isEmail && !internal;
  // Resolve a quoted reply's target message by id for in-bubble rendering.
  const msgById = new Map(conv.messages.map((m) => [m.id, m]));
  // The WhatsApp window that applies to the compose channel: the server-computed
  // one when replying on the thread's own WhatsApp channel; else derived from the
  // thread's WhatsApp inbounds (a cross-channel WhatsApp reply). Null off WhatsApp.
  const waWindow: WaWindow | null = !isWhatsApp
    ? null
    : composeChannel === conv.channel
      ? laterWindow(conv.waWindow, computeWaWindow(conv.messages))
      : computeWaWindow(conv.messages);
  /** The WhatsApp account behind this conversation's number, if it has one.
   *  Declared here rather than beside `ourAddress` below because the default
   *  template a few lines down needs it. */
  const ourWabaId = inboxes?.find((i) => i.id === conv.inboxId)?.channelConfigPublic?.wabaId;
  const windowClosed = isWhatsApp && !!waWindow && !waWindow.open;
  const msLeft = waWindow?.expiresAt ? new Date(waWindow.expiresAt).getTime() - now : null;
  const showCountdown = isWhatsApp && waWindow?.open === true && msLeft != null;
  const closingSoon = msLeft != null && msLeft < 60 * 60 * 1000;
  // Once the window closes, only a template can reach the customer. Rather than
  // shutting the composer and making the agent go and fill a form, we keep it
  // open and send the workspace's default template with what they typed as its
  // variable — the same keystrokes, the same Send. That only works when the
  // default takes exactly one {{1}}; anything else can't be filled from one box.
  // From this number's own account. The default is what the composer sends by
  // itself once the window closes, so another account's default here would be a
  // template Meta rejects, chosen automatically, at the moment an agent is
  // trying to get back to somebody.
  // It needs exactly one variable without a saved default — that one is the
  // message; the others (the agent's name, say) fill themselves in.
  const defaultTemplate =
    templatesForWaba(templates ?? [], ourWabaId).find((t) => t.isDefault && autoTemplateSlot(t) !== null) ?? null;
  const templateFill: TemplateFillContext = {
    contactName: conv.contact.displayName,
    contactCompany: conv.contact.company,
    contactPhone: conv.contact.phone,
    contactEmail: conv.contact.email,
    agentName: me?.user.name,
    channelName: inboxes?.find((i) => i.id === conv.inboxId)?.name,
  };
  const templateFallback = windowClosed && !internal && !!defaultTemplate;
  // Free-form replies are blocked when the window is closed — but internal notes
  // bypass the window, and the template fallback keeps the composer usable, so
  // it only truly locks when there's no default to fall back on.
  const composeLocked = windowClosed && !internal && !defaultTemplate;

  const clearStaged = () => {
    setStaged((cur) => {
      cur.forEach((s) => s.previewUrl && URL.revokeObjectURL(s.previewUrl));
      return [];
    });
  };

  // Emit typing:false now and disarm the idle timer (called on stop/send/blur).
  const stopTyping = () => {
    if (typingStopRef.current != null) {
      window.clearTimeout(typingStopRef.current);
      typingStopRef.current = null;
    }
    typingThrottleRef.current = 0;
    if (typingSentRef.current) {
      typingSentRef.current = false;
      getSocket().emit(ClientEvent.Typing, { conversationId: conv.id, typing: false, who: me?.user.name });
    }
  };
  // Broadcast that we're typing — throttled to ≤1 "true" every 2s — and (re)arm a
  // 2.5s idle timer that emits "false" once the agent stops.
  const signalTyping = () => {
    const t = Date.now();
    if (t - typingThrottleRef.current > 2000) {
      typingThrottleRef.current = t;
      typingSentRef.current = true;
      getSocket().emit(ClientEvent.Typing, { conversationId: conv.id, typing: true, who: me?.user.name });
    }
    // Also show the *customer* a "typing…" indicator, on the channels that have
    // one. The cadence is the channel's, not ours: WhatsApp holds an indicator
    // ~25s per ping, the NestChat widget drops its dots after a few seconds.
    const pingEvery = typingPingMs(composeChannel);
    if (pingEvery != null && !internal && !composeLocked && t - waTypingRef.current > pingEvery) {
      waTypingRef.current = t;
      void api.sendTyping(conv.id).catch(() => {});
    }
    if (typingStopRef.current != null) window.clearTimeout(typingStopRef.current);
    typingStopRef.current = window.setTimeout(stopTyping, 2500);
  };
  // Keep the editor's onUpdate pointing at the current signalTyping closure.
  typingSignalRef.current = signalTyping;

  /** Our address on this inbox, so reply-all never copies the inbox into its
   *  own thread. The query itself is called at the top of the component, above
   *  the early returns — only the lookup happens here. */
  const ourAddress = inboxes?.find((i) => i.id === conv.inboxId)?.handle;

  // Start (or switch) a quoted reply to a message: force Reply mode and focus
  // the composer. Notes can't quote a customer message out to WhatsApp.

  const startReply = (m: Message) => {
    setReplyTo(m);
    setReactFor(null);
    setMenuFor(null);
    setInternal(false);
    requestAnimationFrame(() => taRef.current?.focus());
  };

  /**
   * Reply, copying everyone else who was on the original.
   *
   * Same send as Reply — the only difference is the Cc, which is why this is
   * `startReply` plus two lines rather than a second path. The list comes from
   * the shared `replyAllRecipients` so the phone copies exactly the same people.
   */
  const startReplyAll = (m: Message) => {
    startReply(m);
    setCc(replyAllRecipients(m, { exclude: [ourAddress] }).map((a) => a.toLowerCase()));
    setShowCc(true);
  };

  // Open the forward modal for a message (which one depends on its channel).
  const startForward = (m: Message) => {
    setForwardMsg(m);
    setReactFor(null);
    setMenuFor(null);
  };

  // Forward a WhatsApp message on to other customers' chats. Each target is
  // reported separately by the server, so the toast says what actually happened
  // rather than claiming a clean sweep — a closed 24-hour window on one chat is
  // the normal partial failure, and the agent needs to know which one it was.
  const submitForwardToChats = (contactIds: string[]) => {
    const m = forwardMsg;
    if (!m) return;
    forward.mutate(
      { conversationId: conv.id, messageId: m.id, contactIds },
      {
        onSuccess: (results) => {
          setForwardMsg(null);
          const sent = results.filter((r) => r.ok);
          const failed = results.filter((r) => !r.ok);
          if (!failed.length) {
            onToast(sent.length === 1 ? `Forwarded to ${sent[0].name}` : `Forwarded to ${sent.length} chats`);
          } else if (!sent.length) {
            onToast(failed.length === 1 ? `${failed[0].name}: ${failed[0].error}` : "Couldn’t forward to any of those chats");
          } else {
            onToast(`Forwarded to ${sent.length} — ${failed.map((f) => f.name).join(", ")} didn’t go`);
          }
        },
        onError: () => onToast("Couldn’t forward that message. Please try again."),
      },
    );
  };

  // Forward `forwardMsg` on to `toRaw` (comma/space-separated addresses) with an
  // optional note. Sends a fresh "Fwd:" email — logged in this conversation, but
  // addressed to the new recipients, not the customer (Front-style).
  const submitForward = (toList: string[], note: string) => {
    const m = forwardMsg;
    if (!m || !toList.length) return;
    const subject = m.email?.subject ?? conv.subject ?? "";
    const who = m.direction === "out" ? m.authorName || "You" : m.authorName || conv.contact.displayName;
    const when = new Date(m.createdAt).toLocaleString();
    const origHtml = m.bodyHtml?.trim() || escapeHtml(m.body).replace(/\n/g, "<br>");
    const noteHtml = note.trim() ? `<p>${escapeHtml(note.trim()).replace(/\n/g, "<br>")}</p>` : "";
    const forwardHtml =
      `${noteHtml}<p>---------- Forwarded message ----------<br>` +
      `From: ${escapeHtml(who)}<br>` +
      (subject ? `Subject: ${escapeHtml(subject)}<br>` : "") +
      `Date: ${escapeHtml(when)}</p><blockquote>${origHtml}</blockquote>`;
    send.mutate(
      // `forwardOfId`: the original's attachments go along with it.
      { id: conv.id, body: note.trim(), bodyHtml: forwardHtml, forwardTo: toList, forwardOfId: m.id },
      { onError: () => onToast("Couldn’t forward the email. Please try again.") },
    );
    setForwardMsg(null);
  };

  // Apply or remove the agent's reaction to a message; the bar closes after.
  const applyReaction = (messageId: string, emoji: string) => {
    react({ conversationId: conv.id, messageId, emoji });
    setReactFor(null);
  };

  // Re-attempt a failed send; a genuinely un-retryable one (e.g. channel still
  // not connected) surfaces as a toast rather than silently doing nothing.
  const retrySend = (messageId: string) => {
    retry(
      { conversationId: conv.id, messageId },
      { onError: () => onToast("Couldn’t retry — check the channel is connected in Settings.") },
    );
  };

  // Scroll to a quoted message and flash it so the reply's target is obvious.
  const jumpToMessage = (messageId: string) => {
    const el = document.querySelector<HTMLElement>(`[data-mid="${messageId}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.remove("msg--flash");
    void el.offsetWidth; // restart the animation if it's still mid-flash
    el.classList.add("msg--flash");
    window.setTimeout(() => el.classList.remove("msg--flash"), 1200);
  };

  // Toggle a link on the current selection via the editor (replaces execCommand).
  const toggleLink = () => {
    if (!editor) return;
    if (editor.isActive("link")) {
      editor.chain().focus().unsetLink().run();
      return;
    }
    const url = window.prompt("Link URL");
    if (!url) return;
    const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    editor.chain().focus().setLink({ href }).run();
  };

  // Insert an emoji at the caret of whichever composer input is active.
  const insertEmoji = (emoji: string) => {
    if (isRich && editor) {
      editor.chain().focus().insertContent(emoji).run();
    } else {
      const ta = taRef.current;
      if (ta) {
        const start = ta.selectionStart ?? text.length;
        const end = ta.selectionEnd ?? text.length;
        const next = text.slice(0, start) + emoji + text.slice(end);
        setText(next);
        requestAnimationFrame(() => {
          ta.focus();
          const pos = start + emoji.length;
          ta.setSelectionRange(pos, pos);
        });
      } else {
        setText(text + emoji);
      }
    }
    setEmojiOpen(false);
  };

  // ─── @-mention autocomplete (internal notes) ───
  // Teammates matching the current @query — empty unless a note @token is open.
  // The people on this conversation's inbox (and its assigned team) first,
  // then everyone else, with a divider between.
  const mentionInboxTeams = [
    ...(inboxes?.find((i) => i.id === conv.inboxId)?.teamIds ?? []),
    ...(conv.assignedTeamId ? [conv.assignedTeamId] : []),
  ];
  const { list: mentionList, here: mentionHere } = mention
    ? noteMentionCandidates(people ?? [], mentionInboxTeams, mention.query)
    : { list: [], here: 0 };

  // On each note keystroke, detect an "@query" ending at the caret and open the
  // picker. Only in note mode — customers can't be @-mentioned.
  const onNoteInput = (value: string, caret: number) => {
    setText(value);
    signalTyping();
    const m = internal ? /(?:^|\s)@([\w.+-]*)$/.exec(value.slice(0, caret)) : null;
    if (m) {
      setMention({ query: m[1], start: caret - m[1].length - 1 });
      setMentionSel(0);
    } else {
      setMention(null);
    }
    // "/" in a reply looks up a macro. Not in notes — a note isn't sent to anyone.
    const sq = !internal && macros?.length ? macroQueryAt(value, caret) : null;
    setSlash(sq);
    if (sq) setSlashSel(0);
  };

  // Replace the open "@query" with the teammate's handle (@email-local-part —
  // the token the server matches to route the note to their @Mentions inbox).
  const insertMention = (u: { name: string; email: string }) => {
    if (!mention) return;
    // The name, not the handle: "@Nathan A" reads as a person. It becomes
    // "@nathan" (what the server routes by) only when the note is sent.
    const handle = mentionLabel(u, mentionPeople) + " ";
    const before = text.slice(0, mention.start);
    const after = text.slice(mention.start + 1 + mention.query.length);
    setText(before + handle + after);
    setMention(null);
    const caret = (before + handle).length;
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(caret, caret);
      }
    });
  };

  // ─── Macros ───
  // What "/query" matches, best first; empty while no "/" is being typed.
  // All of them: the list scrolls, so "/" on its own shows every macro this chat has.
  const slashList = slash ? searchMacros(macros ?? [], slash.query) : [];
  const macroList = macroOpen ? searchMacros(macros ?? [], macroQ) : [];

  /**
   * Put a macro in the reply box, its placeholders filled for this chat. From
   * "/", it replaces what was typed; from the picker it lands at the caret. It
   * is only a draft: the agent edits it and presses Send as usual — and on a
   * closed WhatsApp window that send goes out through the default template.
   */
  const insertMacro = (m: Macro) => {
    const filled = resolveTemplateDefault(m.body, templateFill);
    setSlash(null);
    setMacroOpen(false);
    setMacroQ("");
    if (isRich && editor) {
      // One paragraph goes in where the caret is; several become paragraphs.
      const content = /\n{2,}/.test(filled) ? textToHtml(filled) : escapeHtml(filled).replace(/\n/g, "<br>");
      editor.chain().focus().insertContent(content).run();
      return;
    }
    const ta = taRef.current;
    const from = slash ? slash.start : (ta?.selectionStart ?? text.length);
    const to = slash ? slash.start + 1 + slash.query.length : (ta?.selectionEnd ?? text.length);
    const next = text.slice(0, from) + filled + text.slice(to);
    setText(next);
    signalTyping();
    const caret = from + filled.length;
    requestAnimationFrame(() => {
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(caret, caret);
    });
  };

  const handleSend = () => {
    if (!canSend || composeLocked) return;
    // A note's "@Nathan A" goes out as "@nathan", the handle that notifies them.
    const body = internal ? namesToHandles(text.trim(), mentionPeople) : text.trim();
    const wasInternal = internal;
    // A quote only rides on a real (non-note) reply.
    const quotedMsgId = !internal ? replyTo?.id : undefined;
    // A rich email reply carries the editor's HTML; the server sanitizes it.
    const bodyHtml = isRich && body ? html || undefined : undefined;
    // Optional Cc/Bcc on an email reply, picked or typed in their fields.
    const ccList = isEmail && !internal ? cc : [];
    const bccList = isEmail && !internal ? bcc : [];
    const badCopy = [...ccList, ...bccList].find((a) => !isEmailAddress(a));
    if (badCopy) {
      // Said now, not after the provider bounces it.
      onToast(`“${badCopy}” isn't a valid email address — fix or remove it in Cc/Bcc.`);
      return;
    }
    // The email thread's subject (verbatim topic; the server adds "Re:" on a reply).
    const subject = isEmail && !internal ? subjectDraft.trim() : undefined;
    unlock();
    const attachmentIds = readyAtts.map((s) => s.attachment!.id);
    // A note can go on to a team chat too, as a card quoting it.
    const sendOnTo = internal && chatOn ? alsoTo : null;
    send.mutate(
      {
        id: conv.id,
        // The window is shut: this goes as the default template, with the
        // agent's text in its open variable and the rest from their defaults.
        // The server renders the body from the template, so `body` is ignored
        // on this path.
        ...(templateFallback ? { template: { id: defaultTemplate!.id, params: autoTemplateParams(defaultTemplate!, body, templateFill)! } } : {}),
        body,
        internal,
        attachmentIds: attachmentIds.length ? attachmentIds : undefined,
        quotedMsgId,
        bodyHtml,
        subject,
        cc: ccList.length ? ccList : undefined,
        bcc: bccList.length ? bccList : undefined,
        // Only send an override when replying off the conversation's own channel.
        channel: !internal && composeChannel !== conv.channel ? composeChannel : undefined,
      },
      {
        onSuccess: (note) => {
          if (!sendOnTo || !note) return;
          shareToChat.mutate(
            { roomId: sendOnTo, conversationId: conv.id, messageId: note.id, body: "" },
            { onError: () => onToast("The note was saved, but couldn't be sent on to the chat.") },
          );
        },
        onError: (err) => {
          const status = (err as { status?: number }).status;
          // A closed-window race: the window shut between load and send.
          if (isWhatsApp && !wasInternal && status && status >= 400 && status < 500) {
            onToast("The 24-hour window has closed — send a template to reply.");
          } else {
            onToast("Couldn’t send your message. Please try again.");
          }
        },
      },
    );
    stopTyping();
    setText("");
    setHtml("");
    editor?.commands.clearContent();
    clearStaged();
    setInternal(false);
    setAlsoTo(null);
    setMention(null);
    setSlash(null);
    setReplyTo(null);
    setCc([]);
    setBcc([]);
    setShowCc(false);
  };

  const uploadStaged = async (item: Staged) => {
    try {
      const meta: {
        filename: string;
        kind?: string;
        durationMs?: number;
        width?: number;
        height?: number;
        waveform?: number[];
      } = { filename: item.name };
      if (item.kind === "image") {
        const { width, height } = await imageSize(item.file);
        meta.kind = "image";
        if (width) meta.width = width;
        if (height) meta.height = height;
      } else if (item.kind === "voice") {
        meta.kind = "voice";
        if (item.durationMs != null) meta.durationMs = item.durationMs;
        if (item.waveform) meta.waveform = item.waveform;
      }
      const attachment = await api.uploadMedia(item.file, meta);
      setStaged((cur) =>
        cur.map<Staged>((x) => (x.localId === item.localId ? { ...x, status: "done", attachment } : x)),
      );
    } catch {
      setStaged((cur) =>
        cur.map<Staged>((x) => (x.localId === item.localId ? { ...x, status: "error" } : x)),
      );
      onToast("Couldn’t upload " + item.name);
    }
  };

  const addFiles = (files: File[]) => {
    for (const file of files) {
      const name = file.name || "file";
      const kind = kindOfFile(file, name);
      const item: Staged = {
        localId: crypto.randomUUID(),
        file,
        name,
        previewUrl: kind === "image" ? URL.createObjectURL(file) : undefined,
        kind,
        status: "uploading",
      };
      setStaged((cur) => [...cur, item]);
      void uploadStaged(item);
    }
  };

  const removeStaged = (localId: string) => {
    setStaged((cur) => {
      const item = cur.find((x) => x.localId === localId);
      if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
      return cur.filter((x) => x.localId !== localId);
    });
  };

  const retryStaged = (localId: string) => {
    const item = stagedRef.current.find((x) => x.localId === localId);
    if (!item) return;
    setStaged((cur) => cur.map<Staged>((x) => (x.localId === localId ? { ...x, status: "uploading" } : x)));
    void uploadStaged({ ...item, status: "uploading" });
  };

  const teardownRec = () => {
    recStreamRef.current?.getTracks().forEach((t) => t.stop());
    recStreamRef.current = null;
    if (recTimerRef.current != null) {
      window.clearInterval(recTimerRef.current);
      recTimerRef.current = null;
    }
  };

  // Tick the elapsed readout from the accumulated base + the running segment, so
  // pausing freezes the clock and resuming continues from where it stopped.
  const startRecTimer = () => {
    if (recTimerRef.current != null) window.clearInterval(recTimerRef.current);
    recTimerRef.current = window.setInterval(() => {
      setRecSecs(Math.floor((recBaseRef.current + (Date.now() - recStartRef.current)) / 1000));
    }, 250);
  };

  // Fold the running segment into the accumulator — call right before pausing or
  // stopping so the final duration is correct even after several pauses.
  const finalizeElapsed = () => {
    const rec = mediaRecorderRef.current;
    if (rec && rec.state === "recording") recBaseRef.current += Date.now() - recStartRef.current;
  };

  // Upload a freshly recorded clip and send it immediately — WhatsApp-style
  // record → send, with no intermediate "staged in the composer" step. Empty
  // body; rides the current compose channel.
  const sendVoiceNote = async (
    blob: Blob,
    name: string,
    durationMs: number,
    waveform: number[] | undefined,
  ) => {
    try {
      const attachment = await api.uploadMedia(blob, { filename: name, kind: "voice", durationMs, waveform });
      unlock();
      send.mutate(
        {
          id: conv.id,
          body: "",
          internal: false,
          attachmentIds: [attachment.id],
          channel: composeChannel !== conv.channel ? composeChannel : undefined,
        },
        { onError: () => onToast("Couldn’t send your voice message. Please try again.") },
      );
    } catch {
      onToast("Couldn’t send your voice message. Please try again.");
    }
  };

  const finishRecording = async () => {
    const rec = mediaRecorderRef.current;
    const mime = rec?.mimeType || "audio/webm";
    const chunks = recChunksRef.current;
    const elapsedMs = recBaseRef.current;
    const shouldSend = recSendRef.current;
    mediaRecorderRef.current = null;
    recChunksRef.current = [];
    recSendRef.current = false;
    teardownRec();
    if (recCancelRef.current || chunks.length === 0) return;
    const blob = new Blob(chunks, { type: mime });
    const { durationMs, waveform } = await analyzeAudio(blob, elapsedMs);
    const ext = mime.includes("ogg") ? "ogg" : "webm";
    const name = "voice-message." + ext;
    // Record → send: skip staging and fire it straight off.
    if (shouldSend) {
      void sendVoiceNote(blob, name, durationMs, waveform);
      return;
    }
    const item: Staged = {
      localId: crypto.randomUUID(),
      file: blob,
      name,
      kind: "voice",
      status: "uploading",
      durationMs,
      waveform,
    };
    setStaged((cur) => [...cur, item]);
    void uploadStaged(item);
  };

  const startRecording = async () => {
    if (recording || mediaRecorderRef.current) return;
    if (!canRecord) {
      onToast("Recording isn’t supported here");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      onToast("Microphone permission denied");
      return;
    }
    recStreamRef.current = stream;
    recCancelRef.current = false;
    recSendRef.current = false;
    recChunksRef.current = [];
    recBaseRef.current = 0;
    const mime = pickAudioMime();
    const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    mediaRecorderRef.current = rec;
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) recChunksRef.current.push(e.data);
    };
    rec.onstop = () => {
      void finishRecording();
    };
    rec.start();
    recStartRef.current = Date.now();
    setRecSecs(0);
    setRecPaused(false);
    setRecording(true);
    startRecTimer();
  };

  // Pause/resume the recording (MediaRecorder buffers across the gap). Guarded
  // in case a browser doesn't support pause — the UI state only flips on success.
  const togglePause = () => {
    const rec = mediaRecorderRef.current;
    if (!rec) return;
    try {
      if (rec.state === "recording") {
        rec.pause();
        // Segment ended: fold its elapsed into the accumulator, then freeze the clock.
        recBaseRef.current += Date.now() - recStartRef.current;
        if (recTimerRef.current != null) {
          window.clearInterval(recTimerRef.current);
          recTimerRef.current = null;
        }
        setRecPaused(true);
      } else if (rec.state === "paused") {
        rec.resume();
        recStartRef.current = Date.now();
        startRecTimer();
        setRecPaused(false);
      }
    } catch {
      onToast("Pause isn’t supported here");
    }
  };

  // Stop and send the clip in one action (the paper-plane in the recording bar).
  const sendRecording = () => {
    const rec = mediaRecorderRef.current;
    recSendRef.current = true;
    finalizeElapsed();
    setRecording(false);
    setRecPaused(false);
    if (rec && rec.state !== "inactive") rec.stop();
    else teardownRec();
  };

  const cancelRecording = () => {
    recCancelRef.current = true;
    recSendRef.current = false;
    const rec = mediaRecorderRef.current;
    setRecording(false);
    setRecPaused(false);
    if (rec && rec.state !== "inactive") rec.stop();
    else teardownRec();
  };

  const onComposerDragOver = (e: RDragEvent<HTMLDivElement>) => {
    if (e.dataTransfer.types.includes("Files")) e.preventDefault();
  };
  const onComposerDragEnter = (e: RDragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  };
  const onComposerDragLeave = (e: RDragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const onComposerDrop = (e: RDragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (composeLocked) return; // window closed — free-form attachments blocked
    const files = Array.from(e.dataTransfer.files);
    if (files.length) addFiles(files);
  };
  const onTextareaPaste = (e: RClipboardEvent<HTMLTextAreaElement>) => {
    const files: File[] = [];
    for (const item of Array.from(e.clipboardData.items)) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  };
  const onFileInputChange = (e: RChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length) addFiles(files);
    e.target.value = "";
  };

  const take = () => {
    assign.mutate({ id: conv.id, input: { assigneeUserId: me?.user.id ?? null, assignedTeamId: conv.assignedTeamId }, assigneeName: me?.user.name ?? null });
    setMenu(false);
    onToast("Assigned to you");
  };
  /** Hand it to a named person, keeping whichever team it's routed to. */
  const assignTo = (userId: string, name: string) => {
    assign.mutate({ id: conv.id, input: { assigneeUserId: userId, assignedTeamId: conv.assignedTeamId }, assigneeName: name });
    setMenu(false);
    onToast(`Assigned to ${name}`);
  };
  const routeTeam = (teamId: string, name: string) => {
    assign.mutate({ id: conv.id, input: { assigneeUserId: null, assignedTeamId: teamId } });
    setMenu(false);
    onToast(`Routed to ${name}`);
  };
  const unassign = () => {
    assign.mutate({ id: conv.id, input: { assigneeUserId: null } });
    setMenu(false);
    onToast("Sent back to queue");
  };

  /** Everyone this could be handed to — the routed team's members when it's on
   *  a team, otherwise the whole workspace. Never yourself (that's "Assign to
   *  me") and never whoever already has it. */
  const assignable = (people ?? []).filter(
    (m) =>
      m.user.id !== me?.user.id &&
      m.user.id !== conv.assigneeUserId &&
      (!conv.assignedTeamId || m.teamIds.includes(conv.assignedTeamId)),
  );
  const closeConversation = () => {
    setMenu(false);
    setStatus.mutate(
      { id: conv.id, status: "closed" },
      { onSuccess: () => { onToast("Conversation closed"); onClosed?.(); } },
    );
  };
  const reopenConversation = () => {
    setStatus.mutate({ id: conv.id, status: "open" }, { onSuccess: () => onToast("Conversation reopened") });
  };
  const doSnooze = (until: string, label: string) => {
    setSnoozeMenu(false);
    snooze.mutate(
      { id: conv.id, until },
      { onSuccess: () => { onToast(`Snoozed · ${label}`); onClosed?.(); } },
    );
  };
  const inMin = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
  const tomorrow9am = () => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return d.toISOString();
  };
  const snoozeOpts = [
    { label: "10 minutes", short: "10 min", until: () => inMin(10) },
    { label: "30 minutes", short: "30 min", until: () => inMin(30) },
    { label: "1 hour", short: "1 hour", until: () => inMin(60) },
    { label: "Tomorrow, 9 AM", short: "tomorrow 9 AM", until: tomorrow9am },
  ];

  // The composer context line: note privacy, email/group target, or — on
  // WhatsApp — the live 24-hour window state (open countdown / closing / closed).
  let ctxNode: ReactNode;
  if (internal) {
    ctxNode = "Only your team can see this";
  } else if (isEmail) {
    ctxNode = `Email · ${conv.contact.displayName}`;
  } else if (isWhatsApp && showCountdown && msLeft != null) {
    ctxNode = (
      <span className={"wawin" + (closingSoon ? " soon" : "")}>
        <span className="wawin__dot" />
        {closingSoon ? "Window closing" : "Window open"} · {windowLeft(msLeft)} left
      </span>
    );
  } else if (isWhatsApp && windowClosed) {
    ctxNode = (
      <span className="wawin wawin--closed">
        <span className="wawin__dot" />
        24-hour window closed
      </span>
    );
  } else {
    // Named from the channel actually being composed on. It used to fall back
    // to a hard-coded "WhatsApp", which told a NestChat visitor's thread it was
    // about to send to WhatsApp.
    ctxNode =
      composeChannel === "whatsapp_group"
        ? `Group · ${conv.contact.displayName}`
        : `${channelMeta(composeChannel).label} · ${conv.contact.displayName}`;
  }

  return (
    <main className="thread" aria-label="Conversation">
      <header className="thread__head">
        {onBack && (
          <button className="thread__back" title="Back" onClick={onBack} aria-label="Back to conversations">
            <BackIcon />
          </button>
        )}
        <div className="thread__id">
          <Avatar name={conv.contact.displayName} email={conv.contact.email} color={conv.contact.avatarColor} className="av" size={40} fontSize={14} />
          <div className="min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              {/* leading-tight (1.25 = --lh-tight): the default 1.5 leaves ~4px of
                  dead space under the name that reads as a gap above the presence
                  line. */}
              <h2 className="min-w-0 flex-initial m-0 text-lg font-bold leading-tight whitespace-nowrap overflow-hidden text-ellipsis max-[820px]:text-md">{conv.contact.displayName}</h2>
              {/* Channel pill sits inline to the right of the name (fills the
                  header's empty space); the presence line drops below it. */}
              <span className="inline-flex items-center gap-[5px] text-2xs font-medium text-faint flex-none" aria-label={threadChannels.map((ch) => channelMeta(ch).label).join(" + ")}>
                {threadChannels.map((ch) => {
                  const m = channelMeta(ch);
                  const G = m.Glyph;
                  return (
                    <span key={ch} className="inline-grid place-items-center [&>svg]:w-[13px] [&>svg]:h-[13px]" style={{ color: m.color }} title={m.label}>
                      <G />
                    </span>
                  );
                })}
              </span>
            </div>
            {conv.subject && conv.subject !== conv.contact.displayName && (
              <div className="text-xs text-fg font-semibold whitespace-nowrap overflow-hidden text-ellipsis" title={conv.subject}>{conv.subject}</div>
            )}
            {/* Presence/contact line: secondary to the name, so it sits a step
                down the type scale (11px) and a step lighter (faint) — it's
                context, not content. */}
            {(sub || threadInbox) && (
              <div className="flex items-center gap-2 text-2xs leading-snug text-faint min-w-0">
                {sub && <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{sub}</span>}
                {/* Our side of it. Hidden on a narrow window, where the header has
                    no room and the composer's own "From" is a step away anyway. */}
                {threadInbox && (
                  <span className="thread__from" title={`This thread sends from ${inboxLabel(threadInbox)}`}>
                    via {inboxLabel(threadInbox)}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="thread__actions">
          {isClosed ? (
            <button className="resolvebtn reopened" onClick={reopenConversation} title="Reopen conversation" aria-label="Reopen conversation">
              <ReopenIcon />
            </button>
          ) : (
            // Icons, not words: the header carries the log, Discuss, labels and
            // more now, and the room is better spent on who and what it's about.
            <button className="resolvebtn" onClick={closeConversation} title="Resolve conversation" aria-label="Resolve conversation">
              <CheckCircleIcon />
            </button>
          )}
          <button
            className="assignbtn"
            onClick={() => { setMenu((v) => !v); setSnoozeMenu(false); }}
            title={!owned ? "Take this conversation" : assignedToMe ? "Assigned to you" : `Assigned to ${assigneeName}`}
            aria-label={!owned ? "Take this conversation" : assignedToMe ? "Assigned to you — change" : `Assigned to ${assigneeName} — change`}
          >
            {owned ? (
              <>
                <span
                  className="mini"
                  style={{
                    background: assignedToMe
                      ? avatarBg(me?.user.name ?? "", me?.user.avatarColor)
                      : avatarBg(assigneeName, assigneeUser?.avatarColor),
                  }}
                >
                  {assignedToMe ? (me ? initials(me.user.name) : "") : initials(assigneeName)}
                </span>
              </>
            ) : (
              <span className="assignbtn__ic">
                <ProfileIcon />
              </span>
            )}
            <ChevronDown />
          </button>
          <div className="snoozewrap">
            <button
              className={"iconbtn hide-sm fold" + (snoozeMenu ? " on" : "")}
              title="Snooze"
              onClick={() => { setSnoozeMenu((v) => !v); setMenu(false); }}
            >
              <SnoozeIcon />
            </button>
            {snoozeMenu && (
              <>
                <div className="menu-backdrop" onClick={() => setSnoozeMenu(false)} />
                <GlideMenu className="menu snoozemenu" role="menu">
                  <div className="menu__hd">Snooze until</div>
                  {snoozeOpts.map((o) => (
                    <button key={o.short} onClick={() => doSnooze(o.until(), o.short)}>
                      <SnoozeIcon /> {o.label}
                    </button>
                  ))}
                </GlideMenu>
              </>
            )}
          </div>
          <div className="labelwrap">
            <button
              className={"iconbtn hide-sm fold" + (labelMenu ? " on" : "")}
              title="Labels"
              aria-label="Labels"
              aria-haspopup="menu"
              aria-expanded={labelMenu}
              onClick={() => { setLabelMenu((v) => !v); setSnoozeMenu(false); setMenu(false); }}
            >
              <TagIcon />
            </button>
            {labelMenu && (
              <>
                <div className="menu-backdrop" onClick={() => setLabelMenu(false)} />
                <div className="menu labelmenu has-glide" role="menu">
                  <div className="menu__hd">Labels</div>
                  <LabelPicker conversationId={conv.id} current={conv.labels} />
                </div>
              </>
            )}
          </div>
          {chatOn && (
            <button className={"iconbtn hide-sm fold" + (sharing ? " on" : "")} title="Discuss with the team" aria-label="Discuss with the team" onClick={() => setSharing({ message: null })}>
              <TeamChatIcon />
            </button>
          )}
          <button className={"iconbtn hide-sm fold" + (logOpen ? " on" : "")} title="Conversation log" aria-label="Conversation log" onClick={() => setLogOpen(true)}>
            <HistoryIcon />
          </button>
          <button className={"iconbtn hide-sm" + (showPanel ? " on" : "")} title="Details" onClick={onTogglePanel}>
            <DetailsIcon />
          </button>
          {/* Phone-only overflow: the header keeps just Resolve + Assign; Snooze,
              Labels and Details live here so the contact name always has room. */}
          <div className="morewrap show-sm">
            <button
              className={"iconbtn" + (moreMenu ? " on" : "")}
              title="More"
              aria-label="More actions"
              aria-haspopup="menu"
              aria-expanded={moreMenu}
              onClick={() => { setMoreMenu((v) => !v); setMenu(false); setSnoozeMenu(false); setLabelMenu(false); }}
            >
              <MoreIcon />
            </button>
            {moreMenu && (
              <>
                <div className="menu-backdrop" onClick={() => setMoreMenu(false)} />
                <GlideMenu className="menu moremenu" role="menu">
                  <button onClick={() => { setMoreMenu(false); setSnoozeMenu(true); }}>
                    <SnoozeIcon /> Snooze…
                  </button>
                  <button onClick={() => { setMoreMenu(false); setLabelMenu(true); }}>
                    <TagIcon /> Add label…
                  </button>
                  <button onClick={() => { setMoreMenu(false); onTogglePanel(); }}>
                    <DetailsIcon /> {showPanel ? "Hide details" : "Details"}
                  </button>
                  <button onClick={() => { setMoreMenu(false); setLogOpen(true); }}>
                    <HistoryIcon /> Conversation log
                  </button>
                  {chatOn && (
                    <button onClick={() => { setMoreMenu(false); setSharing({ message: null }); }}>
                      <TeamChatIcon /> Discuss with the team
                    </button>
                  )}
                </GlideMenu>
              </>
            )}
          </div>
        </div>
      </header>
      <FollowUpBar conv={conv} />
      {chatOn && onOpenDiscussion && <DiscussionBar conversationId={conv.id} active={discussion} onOpen={onOpenDiscussion} />}

      {menu && (
        <>
          <div className="menu-backdrop" onClick={() => setMenu(false)} />
          <GlideMenu className="menu" role="menu">
            {conv.assigneeUserId !== me?.user.id && (
              <button onClick={take}>
                <ProfileIcon /> Assign to me
              </button>
            )}
            {/* Hand it to someone specific.
                Routing to a team said who *should* deal with it; this says who
                actually will, which is the step that was missing — the menu
                offered teams and yourself and no one else, so a manager
                triaging a queue could route work to a group but never to the
                person in it who ought to pick it up.
                Scoped to the routed team's members when there is one: those are
                the people it's realistically going to, and dropping the whole
                org in makes the common case a scroll. Everyone shows when it's
                on no team. */}
            {assignable.map((m) => (
              <button key={m.user.id} onClick={() => assignTo(m.user.id, m.user.name)}>
                <ProfileIcon /> Assign to {m.user.name}
                {!m.user.available && <span className="menu__hint">away</span>}
              </button>
            ))}
            {(teams ?? [])
              .filter((t) => t.id !== conv.assignedTeamId)
              .map((t) => (
                <button key={t.id} onClick={() => routeTeam(t.id, t.name)}>
                  <RouteIcon /> Route to {t.name}
                </button>
              ))}
            {conv.assigneeUserId && (
              <button onClick={unassign}>
                <InboxIcon /> Send back to queue
              </button>
            )}
            <div className="sep" />
            {conv.unread ? (
              <button onClick={() => { setMenu(false); markRead(conv.id); }}>
                <MailIcon /> Mark as read
              </button>
            ) : (
              <button
                onClick={() => {
                  setMenu(false);
                  markUnread(conv.id);
                  onToast("Marked as unread");
                  onClosed?.();
                }}
              >
                <MailIcon /> Mark as unread
              </button>
            )}
            {isClosed ? (
              <button onClick={reopenConversation}>
                <ReopenIcon /> Reopen conversation
              </button>
            ) : (
              <button onClick={closeConversation}>
                <CheckCircleIcon /> Close conversation
              </button>
            )}
          </GlideMenu>
        </>
      )}

      <div className="msgs-wrap">
      <div className={"msgs" + (isClosed ? " is-closed" : "")} ref={msgsRef} onScroll={onMsgsScroll}>
        {conv.hasMoreMessages && (
          <div className="loadolder">
            <button className="loadolder__btn" onClick={loadEarlier} disabled={loadingOlder}>
              {loadingOlder ? "Loading earlier messages…" : "Load earlier messages"}
            </button>
          </div>
        )}
        {groupMessagesByDay(conv.messages).map((group) => (
          <section className="daygroup" key={group.key}>
            <div className="daysep">{group.label}</div>
            {group.items.map((m, mi) => {
              // Same speaker as the message directly above? (direction, note-ness
              // and author must all match.) Purely visual grouping.
              const prev = group.items[mi - 1];
              const next = group.items[mi + 1];
              // The grouping key. Channel is part of it: a WhatsApp message and
              // an email are different conversations to the eye even when the
              // same agent sent them back to back, so they must not collapse
              // into one run — each keeps its own spacing, name and tail.
              const who = (x: Message) => speakerKey(x, conv.channel);
              const cont = !!prev && who(prev) === who(m);
              // Followed by the same sender => not the last of the run, so this
              // bubble gives up its tail (the tail sits on the bottom corner).
              const midGroup = !!next && who(next) === who(m);
              return m.internal ? (
                <div
                  key={m.id}
                  className={"note" + (m.authorUserId === me?.user.id ? " note--out" : " note--in") + (cont ? " msg--cont" : "")}
                >
                  <div className="note__bubble">
                    <div className="note__head">
                      <span className="note__ic" aria-hidden="true">
                        <NoteIcon />
                      </span>
                      <b className="note__who">{m.authorName ?? "Teammate"}</b>
                      <span className="note__tag">Internal</span>
                      <span className="note__t">{relativeTime(m.createdAt)}</span>
                    </div>
                    {/* A note can carry files: a photo of the damage, the signed PDF. */}
                    {(m.attachments?.length ?? 0) > 0 && (
                      <div className="note__atts">
                        {m.attachments!.map((a) => <AttachmentView key={a.id} att={a} onImage={setLightbox} />)}
                      </div>
                    )}
                    {m.body.trim() && <div className="note__body">{renderMention(m.body, mentionPeople)}</div>}
                  </div>
                </div>
              ) : (
                <MessageBubble
                  key={m.id}
                  m={m}
                  convChannel={conv.channel}
                  sentFrom={(() => {
                    if (m.direction !== "out" || m.internal) return undefined;
                    const from = sendingInbox(inboxes ?? [], conv, {
                      channel: m.channel,
                      recordedInboxId: m.inboxId,
                    });
                    return from && from.id !== threadInbox?.id ? inboxLabel(from) : undefined;
                  })()}
                  quoted={m.quotedMsgId ? msgById.get(m.quotedMsgId) : undefined}
                  onImage={setLightbox}
                  onRetry={retrySend}
                  actions={{
                    // React + reply on every channel. On WhatsApp the reaction is
                    // delivered to the customer; on email it's an internal agent
                    // annotation (the API stores it and skips provider dispatch).
                    contactName: conv.contact.displayName,
                    held: reactFor === m.id,
                    menuOpen: menuFor === m.id,
                    onHold: () => { setMenuFor(null); setReactFor(m.id); },
                    // On touch there's one path, and it's the hold overlay. The
                    // chevron survives there only on email bubbles (whose iframe
                    // swallows the long-press), so it opens the same thing rather
                    // than a second, differently-shaped menu.
                    onMenuToggle: touch
                      ? () => { setMenuFor(null); setReactFor(m.id); }
                      : () => { setReactFor(null); setMenuFor((cur) => (cur === m.id ? null : m.id)); },
                    onReact: (emoji) => applyReaction(m.id, emoji),
                    onReply: () => startReply(m),
                    // Forward means something on both channels, but not the same
                    // thing: an email goes on to addresses you type, a WhatsApp
                    // message goes on to chats you pick. Either way it's the same
                    // menu item, opening whichever modal fits.
                    //
                    // Not offered on an internal note — that's the team talking to
                    // itself, and the server refuses it too.
                    onReplyAll:
                      !m.internal && hasOtherRecipients(m, { exclude: [ourAddress] })
                        ? () => startReplyAll(m)
                        : undefined,
                    onForward: m.internal ? undefined : () => startForward(m),
                    // Read receipts — only on a sent email that has tracked recipients.
                    onReceipts:
                      m.direction === "out" && !m.internal && m.email?.recipients?.length
                        ? () => { setMenuFor(null); setReceiptsMsgId(m.id); }
                        : undefined,
                    onDiscuss: chatOn
                      ? () => {
                          setMenuFor(null);
                          setReactFor(null);
                          const words = m.body.replace(/\s+/g, " ").trim();
                          setSharing({
                            message: {
                              id: m.id,
                              who: m.internal ? `Note · ${m.authorName ?? "Teammate"}` : m.authorName || (m.direction === "in" ? conv.contact.displayName : "Teammate"),
                              text: words.length > 140 ? `${words.slice(0, 139)}…` : words || "📎 Attachment",
                            },
                          });
                        }
                      : undefined,
                    onJump: jumpToMessage,
                  }}
                  cont={cont}
                  midGroup={midGroup}
                />
              );
            })}
          </section>
        ))}
        {conv.messages.length === 0 && (
          <div className="thread-empty">No messages yet — start the conversation.</div>
        )}
        {typing && (
          /* With a draft it takes the shape of the message it's about to be, so
             the eye reads it where the answer will land — dimmed and dashed,
             because it is not one yet and may never be. Without one it stays the
             small dotted line it has always been. */
          <div
            className={typing.preview ? "typing typing--draft" : "typing"}
            role="status"
            aria-live="polite"
          >
            <span className="typing__dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            {typing.preview ? (
              <span className="typing__draft">
                <span className="typing__label">{typing.who} is typing</span>
                <span className="typing__text">{typing.preview}</span>
              </span>
            ) : (
              <span className="typing__who">{typing.who} is typing…</span>
            )}
          </div>
        )}
        <div ref={endRef} />
      </div>
      {showJump && (
        <button
          type="button"
          className="jumpbtn"
          onClick={jumpToBottom}
          aria-label="Scroll to latest messages"
          title="Scroll to latest"
        >
          <ChevronDown />
        </button>
      )}
      </div>

      {isClosed ? (
        <div className="closedbar">
          <div className="closedbar__txt">
            <CheckCircleIcon />
            <span>This conversation is closed.</span>
          </div>
          <button className="closedbar__btn" onClick={reopenConversation}>
            <ReopenIcon /> Reopen to reply
          </button>
        </div>
      ) : (
        <div
          className="composer"
          onDragEnter={onComposerDragEnter}
          onDragOver={onComposerDragOver}
          onDragLeave={onComposerDragLeave}
          onDrop={onComposerDrop}
        >
          <div className="compbar">
            {/* One 3-way switcher: reply on each reachable channel, or add a Note. */}
            <div className="compmode" role="tablist" ref={modeRef} {...modeHover}>
              <span className="seg-hover" ref={modeHoverRef} />
              <span className="seg-thumb" ref={modeThumbRef} />
              {replyTargets.map((ch) => {
                const meta = channelMeta(ch);
                const ChG = meta.Glyph;
                const active = !internal && composeChannel === ch;
                return (
                  <button
                    key={ch}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    aria-label={replyTargets.length > 1 ? meta.label : "Reply"}
                    className={"modebtn" + (active ? " active" : "")}
                    onClick={() => {
                      setInternal(false);
                      // Always store the pick. This used to store null for the
                      // conversation's own channel, treating null as "the
                      // default" — which silently ignored the click whenever
                      // the default was some other channel.
                      setComposeChannelState(ch);
                    }}
                    title={replyTargets.length > 1 ? `Reply via ${meta.label}` : undefined}
                  >
                    <span className="modebtn__ic" style={active ? { color: meta.color } : undefined}>
                      <ChG />
                    </span>
                    <span className="modebtn__lbl">{replyTargets.length > 1 ? meta.label : "Reply"}</span>
                  </button>
                );
              })}
              <button
                type="button"
                role="tab"
                aria-selected={internal}
                aria-label="Note"
                className={"modebtn modenote" + (internal ? " active" : "")}
                onClick={() => setInternal(true)}
                title="Internal note"
              >
                <span className="modebtn__ic">
                  <NoteIcon />
                </span>
                <span className="modebtn__lbl">Note</span>
              </button>
            </div>
            {!internal && composeInbox && (
              /* The answer to "which of our numbers is this about to go from",
                 at the moment it is being decided. It follows the mode switcher
                 above, because switching channel is exactly what changes it. */
              <span className="compfrom" title={`Sending from ${inboxLabel(composeInbox)}`}>
                <span className="compfrom__lbl">From</span>
                {inboxLabel(composeInbox)}
              </span>
            )}
            {internal && chatOn && <AlsoSendTo value={alsoTo} onChange={setAlsoTo} />}
            <span className="compctx">{ctxNode}</span>
          </div>
          {composeInbox?.signedOut && !internal && (
            /* Said before they write the reply, not after it fails. */
            <div className="reauth-note" role="note">
              <AlertIcon />
              <span>
                <b>{composeInbox.handle}</b> needs reconnecting — Google signed it out, so replies from it can't be sent.
                {me?.user.role === "admin" || me?.user.role === "manager" ? " Reconnect it in Settings › Channels." : " An admin or manager can reconnect it."}
              </span>
            </div>
          )}
          {isEmail && !internal && (
            <div className="emailhdr">
              <div className="emailhdr__row">
                <span className="emailhdr__lbl">Subject</span>
                {editingSubject ? (
                  <input
                    className="emailhdr__in"
                    value={subjectDraft}
                    onChange={(e) => setSubjectDraft(e.target.value)}
                    placeholder="Add a subject"
                    aria-label="Email subject"
                    autoFocus
                    onBlur={() => setEditingSubject(false)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === "Escape") {
                        e.preventDefault();
                        setEditingSubject(false);
                      }
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="emailhdr__subjbtn"
                    onClick={() => setEditingSubject(true)}
                    title="Edit subject"
                  >
                    <span className={"emailhdr__subj" + (subjectDraft.trim() ? "" : " placeholder")}>
                      {subjectDraft.trim() || "Add a subject"}
                    </span>
                    <EditIcon />
                  </button>
                )}
                <button
                  type="button"
                  className={"emailhdr__cc" + (showCc ? " on" : "")}
                  onClick={() => setShowCc((v) => !v)}
                >
                  Cc/Bcc
                </button>
              </div>
              {willSign && (
                <div className="emailhdr__sig" title="Added when the email is sent. Each email channel's signature is set in Settings › Channels.">
                  Signed as <b>{signedAsLine(sigContext) || "you"}</b> with the {composeInbox!.handle} signature
                </div>
              )}
              {showCc && (
                <>
                  <div className="emailhdr__row">
                    <span className="emailhdr__lbl">Cc</span>
                    <RecipientField compact value={cc} onChange={setCc} contacts={contacts ?? []} ariaLabel="Cc" placeholder="Search customers or type an address" />
                  </div>
                  <div className="emailhdr__row">
                    <span className="emailhdr__lbl">Bcc</span>
                    <RecipientField compact value={bcc} onChange={setBcc} contacts={contacts ?? []} ariaLabel="Bcc" placeholder="Search customers or type an address" />
                  </div>
                </>
              )}
            </div>
          )}
          {replyTo && !internal && (
            <div className="reply-cue">
              <span className="reply-cue__accent" aria-hidden="true" />
              <div className="reply-cue__body">
                <span className="reply-cue__who">
                  <ReplyIcon />
                  Replying to {replyTo.direction === "out" ? "yourself" : replyTo.authorName || conv.contact.displayName}
                </span>
                <span className="reply-cue__txt">{quotedSnippet(replyTo)}</span>
              </div>
              <button
                type="button"
                className="reply-cue__x"
                onClick={() => setReplyTo(null)}
                title="Cancel reply"
                aria-label="Cancel reply"
              >
                <XIcon />
              </button>
            </div>
          )}
          {staged.length > 0 && (
            <div className="comp-atts">
              {staged.map((s) => (
                <StagedChip
                  key={s.localId}
                  s={s}
                  onRemove={() => removeStaged(s.localId)}
                  onRetry={() => retryStaged(s.localId)}
                />
              ))}
            </div>
          )}
          {isRich && !composeLocked && !recording && (
            <div className="richbar" role="toolbar" aria-label="Formatting">
              <button type="button" className={"richbar__b" + (editor?.isActive("bold") ? " on" : "")} title="Bold" aria-label="Bold" onMouseDown={(e) => e.preventDefault()} onClick={() => editor?.chain().focus().toggleBold().run()}>
                <b>B</b>
              </button>
              <button type="button" className={"richbar__b" + (editor?.isActive("italic") ? " on" : "")} title="Italic" aria-label="Italic" onMouseDown={(e) => e.preventDefault()} onClick={() => editor?.chain().focus().toggleItalic().run()}>
                <i>I</i>
              </button>
              <button type="button" className={"richbar__b" + (editor?.isActive("underline") ? " on" : "")} title="Underline" aria-label="Underline" onMouseDown={(e) => e.preventDefault()} onClick={() => editor?.chain().focus().toggleUnderline().run()}>
                <u>U</u>
              </button>
              <span className="richbar__sep" aria-hidden="true" />
              <button type="button" className={"richbar__b" + (editor?.isActive("bulletList") ? " on" : "")} title="Bulleted list" aria-label="Bulleted list" onMouseDown={(e) => e.preventDefault()} onClick={() => editor?.chain().focus().toggleBulletList().run()}>
                •&nbsp;—
              </button>
              <button type="button" className={"richbar__b" + (editor?.isActive("orderedList") ? " on" : "")} title="Numbered list" aria-label="Numbered list" onMouseDown={(e) => e.preventDefault()} onClick={() => editor?.chain().focus().toggleOrderedList().run()}>
                1.&nbsp;—
              </button>
              <span className="richbar__sep" aria-hidden="true" />
              <button type="button" className={"richbar__b richbar__b--ico" + (editor?.isActive("link") ? " on" : "")} title="Insert link" aria-label="Insert link" onMouseDown={(e) => e.preventDefault()} onClick={toggleLink}>
                <LinkIcon />
              </button>
            </div>
          )}
          {composeLocked ? (
            <div className="wa-closed" role="note">
              <div className="wa-closed__txt">
                <ClockIcon />
                <span>
                  The 24-hour window has closed. Send an approved template to re-open the
                  conversation.
                </span>
              </div>
              <button type="button" className="wa-closed__btn" onClick={() => setPicker(true)}>
                <BoltIcon /> Choose a template
              </button>
            </div>
          ) : recording ? (
            <div className="comp-rec" role="group" aria-label="Recording voice message">
              <button
                type="button"
                className="comp-rec__del"
                onClick={cancelRecording}
                title="Delete"
                aria-label="Delete recording"
              >
                <TrashIcon />
              </button>
              <span className={"comp-rec__dot" + (recPaused ? " paused" : "")} aria-hidden="true" />
              <span className="comp-rec__time tnum">{formatDuration(recSecs * 1000)}</span>
              <span className="comp-rec__hint">{recPaused ? "Paused" : "Recording…"}</span>
              <button
                type="button"
                className="comp-rec__pause"
                onClick={togglePause}
                title={recPaused ? "Resume" : "Pause"}
                aria-label={recPaused ? "Resume recording" : "Pause recording"}
              >
                {recPaused ? <MicIcon /> : <PauseIcon />}
              </button>
              <button
                type="button"
                className="send comp-rec__send"
                onClick={sendRecording}
                title="Send"
                aria-label="Send voice message"
              >
                <SendIcon />
              </button>
            </div>
          ) : (
            <>
            {/* Window shut, but a default template is standing in: say so, show
                what will actually be sent, and keep the picker one tap away. */}
            {templateFallback && (
              <div className="tplfallback" role="note">
                <ClockIcon />
                <span className="tplfallback__txt">
                  Window closed — sending as <b>{defaultTemplate!.name}</b>
                  <em>{fillTemplatePreview(defaultTemplate!.body, autoTemplateParams(defaultTemplate!, text.trim() || "your message", templateFill)!)}</em>
                </span>
                <button type="button" className="tplfallback__btn" onClick={() => setPicker(true)}>
                  Change
                </button>
              </div>
            )}
            {canUndoPolish && (
              <div className="polishbar" role="status">
                <SparkleIcon />
                <span>Polished by Claude</span>
                <button type="button" className="polishbar__undo" onClick={undoPolish}>
                  Undo
                </button>
              </div>
            )}
            <div className={"compinput" + (isRich ? " compinput--rich" : "")}>
              {emojiOpen && (
                <div className="emojipop" role="menu" aria-label="Insert emoji">
                  {COMPOSER_EMOJIS.map((e) => (
                    <button
                      key={e}
                      type="button"
                      className="emojipop__e"
                      onClick={() => insertEmoji(e)}
                      aria-label={`Insert ${e}`}
                    >
                      {e}
                    </button>
                  ))}
                </div>
              )}
              {internal && mention && mentionList.length > 0 && (
                <div className="mentionpop" role="listbox" aria-label="Mention a teammate">
                  {mentionList.map((u, i) => (
                    <Fragment key={u.email}>
                    {i === mentionHere && mentionHere > 0 && <div className="mentionpop__sep">Others</div>}
                    <button
                      type="button"
                      role="option"
                      aria-selected={i === mentionSel}
                      className={"mentionpop__row" + (i === mentionSel ? " sel" : "")}
                      onMouseEnter={() => setMentionSel(i)}
                      // Keep focus on the textarea so the caret restore lands.
                      onMouseDown={(e) => {
                        e.preventDefault();
                        insertMention(u);
                      }}
                    >
                      <Avatar name={u.name} email={u.email} color={u.avatarColor} src={u.avatarUrl} className="av mentionpop__av" />
                      <span className="mentionpop__meta">
                        <b>{u.name}</b>
                        <small>{u.position || u.email}</small>
                      </span>
                    </button>
                    </Fragment>
                  ))}
                </div>
              )}
              {!internal && slash && slashList.length > 0 && (
                <div className="mentionpop macropop" role="listbox" aria-label="Macros">
                  {slashList.map((m, i) => (
                    <MacroRow
                      key={m.id}
                      macro={m}
                      fill={templateFill}
                      selected={i === slashSel}
                      onHover={() => setSlashSel(i)}
                      onPick={() => insertMacro(m)}
                    />
                  ))}
                </div>
              )}
              {macroOpen && (
                <div className="mentionpop macropop" role="dialog" aria-label="Macros">
                  <div className="macropop__search">
                    <SearchIcon />
                    <input
                      autoFocus
                      value={macroQ}
                      placeholder="Search macros…"
                      aria-label="Search macros"
                      onChange={(e) => {
                        setMacroQ(e.target.value);
                        setMacroSel(0);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "ArrowDown" && macroList.length) {
                          e.preventDefault();
                          setMacroSel((i) => (i + 1) % macroList.length);
                        } else if (e.key === "ArrowUp" && macroList.length) {
                          e.preventDefault();
                          setMacroSel((i) => (i - 1 + macroList.length) % macroList.length);
                        } else if (e.key === "Enter") {
                          e.preventDefault();
                          if (macroList[macroSel]) insertMacro(macroList[macroSel]);
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          setMacroOpen(false);
                        }
                      }}
                    />
                  </div>
                  <div role="listbox" aria-label="Macros">
                    {macroList.map((m, i) => (
                      <MacroRow
                        key={m.id}
                        macro={m}
                      fill={templateFill}
                        selected={i === macroSel}
                        onHover={() => setMacroSel(i)}
                        onPick={() => insertMacro(m)}
                      />
                    ))}
                  </div>
                  {macroList.length === 0 && <div className="macropop__empty">No macro matches “{macroQ}”.</div>}
                </div>
              )}
              <button
                type="button"
                className={"tool tool--emoji" + (emojiOpen ? " on" : "")}
                title="Emoji"
                aria-label="Emoji"
                onClick={() => setEmojiOpen((v) => !v)}
              >
                <EmojiIcon />
              </button>
              {isRich ? (
                <EditorContent
                  editor={editor}
                  className="richedit-host"
                  aria-label={`Reply to ${conv.contact.displayName}`}
                  onBlur={stopTyping}
                  onKeyDown={(e) => {
                    // Enter adds a line; ⌘/Ctrl+Enter sends (email convention).
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                />
              ) : (
                <textarea
                  ref={taRef}
                  value={text}
                  rows={1}
                  onChange={(e) => onNoteInput(e.target.value, e.target.selectionStart ?? e.target.value.length)}
                  onBlur={stopTyping}
                  onPaste={onTextareaPaste}
                  onKeyDown={(e) => {
                    // Same for the "/" macro list.
                    if (!internal && slash && slashList.length > 0) {
                      if (e.key === "ArrowDown") {
                        e.preventDefault();
                        setSlashSel((i) => (i + 1) % slashList.length);
                        return;
                      }
                      if (e.key === "ArrowUp") {
                        e.preventDefault();
                        setSlashSel((i) => (i - 1 + slashList.length) % slashList.length);
                        return;
                      }
                      if (e.key === "Enter" || e.key === "Tab") {
                        e.preventDefault();
                        insertMacro(slashList[slashSel] ?? slashList[0]);
                        return;
                      }
                      if (e.key === "Escape") {
                        e.preventDefault();
                        setSlash(null);
                        return;
                      }
                    }
                    // While the @-mention picker is open, the arrow/enter/tab keys
                    // drive it instead of the textarea (or sending).
                    if (mention && mentionList.length > 0) {
                      if (e.key === "ArrowDown") {
                        e.preventDefault();
                        setMentionSel((i) => (i + 1) % mentionList.length);
                        return;
                      }
                      if (e.key === "ArrowUp") {
                        e.preventDefault();
                        setMentionSel((i) => (i - 1 + mentionList.length) % mentionList.length);
                        return;
                      }
                      if (e.key === "Enter" || e.key === "Tab") {
                        e.preventDefault();
                        insertMention(mentionList[mentionSel]);
                        return;
                      }
                      if (e.key === "Escape") {
                        e.preventDefault();
                        setMention(null);
                        return;
                      }
                    }
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                  placeholder={
                    internal
                      ? "Write an internal note… use @name to mention"
                      : `Message ${conv.contact.displayName}…`
                  }
                />
              )}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                accept="image/*,video/*,audio/*,application/pdf,.doc,.docx,.xls,.xlsx,.txt"
                onChange={onFileInputChange}
              />
              {/* Every channel, email included — a macro is just text. Shown
                  only when this chat's team inbox has some. */}
              {!internal && (macros?.length ?? 0) > 0 && (
                <button
                  type="button"
                  className={"tool tool--macro" + (macroOpen ? " on" : "")}
                  title="Insert a macro — or type / in the message"
                  aria-label="Macros"
                  aria-expanded={macroOpen}
                  onClick={() => {
                    setMacroOpen((v) => !v);
                    setMacroQ("");
                    setMacroSel(0);
                    setSlash(null);
                  }}
                >
                  <MacroIcon />
                </button>
              )}
              {isWhatsApp && !internal && (
                <button
                  className="tool"
                  title="Send a template"
                  onClick={() => setPicker(true)}
                  aria-label="Templates"
                >
                  <BoltIcon />
                </button>
              )}
              {/* AI assist. Present only once Claude is configured, and only
                  with something to work on — it edits a draft, it can't make one. */}
              {aiConfigured && (
                <button
                  className={"tool tool--polish" + (polishing ? " is-busy" : "")}
                  title={polishing ? "Polishing…" : "Polish this draft"}
                  aria-label="Polish this draft with AI"
                  aria-busy={polishing}
                  disabled={polishing || !text.trim()}
                  onClick={runPolish}
                >
                  <SparkleIcon />
                </button>
              )}
              {/* A text message carries text: SMS has no attachments (a note does). */}
              {(composeChannel !== "sms" || internal) && (
                <button
                  className="tool"
                  title="Attach"
                  aria-label="Attach files"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <AttachIcon />
                </button>
              )}
              {/* One trailing button, WhatsApp-style: a mic while there's nothing
                  to send (voice-capable WhatsApp threads only), which becomes the
                  send paper-plane the moment there's text or an attachment. */}
              {isWhatsApp && canRecord && !internal && !canSend ? (
                <button
                  key="mic"
                  className="send send--mic"
                  onClick={startRecording}
                  title="Record voice message"
                  aria-label="Record voice message"
                >
                  <MicIcon />
                </button>
              ) : (
                <button
                  key="send"
                  className="send"
                  onClick={handleSend}
                  disabled={!canSend}
                  title="Send"
                  aria-label="Send"
                >
                  <SendIcon />
                </button>
              )}
            </div>
            </>
          )}
          {dragging && !composeLocked && (
            <div className="comp-drop" aria-hidden="true">
              <span>
                <AttachIcon /> Drop to attach
              </span>
            </div>
          )}
        </div>
      )}

      {lightbox && (
        <div
          className="lightbox"
          role="dialog"
          aria-modal="true"
          aria-label="Image preview"
          onClick={() => setLightbox(null)}
        >
          <img className="lightbox__img" src={lightbox} alt="" />
          <button className="lightbox__close" onClick={() => setLightbox(null)} aria-label="Close preview">
            <XIcon />
          </button>
        </div>
      )}

      {picker && (
        <TemplatePicker
          conversationId={conv.id}
          inboxId={conv.inboxId}
          fill={{
            contactName: conv.contact.displayName,
            contactCompany: conv.contact.company,
            contactPhone: conv.contact.phone,
            contactEmail: conv.contact.email,
            agentName: me?.user.name,
            channelName: inboxes?.find((i) => i.id === conv.inboxId)?.name,
          }}
          channel={composeChannel}
          onClose={() => setPicker(false)}
          onToast={onToast}
        />
      )}

      {/* Which forward this is depends on the message's own channel, not the
          conversation's — a cross-channel thread can hold both. */}
      {forwardMsg &&
        ((forwardMsg.channel ?? conv.channel) === "email" ? (
          <ForwardModal
            message={forwardMsg}
            contactName={conv.contact.displayName}
            subject={forwardMsg.email?.subject ?? conv.subject ?? ""}
            contacts={contacts ?? []}
            onSubmit={submitForward}
            onClose={() => setForwardMsg(null)}
          />
        ) : (
          <ForwardToChatsModal
            message={forwardMsg}
            busy={forward.isPending}
            onSubmit={submitForwardToChats}
            onClose={() => setForwardMsg(null)}
          />
        ))}

      {/* Touch only: the long-press overlay. Resolved from the thread each render
          so a reaction landing over the socket is reflected while it's open. */}
      {touch &&
        (() => {
          const hm = reactFor ? conv.messages.find((m) => m.id === reactFor) : undefined;
          if (!hm) return null;
          const canQuoteOrForward = !hm.internal;
          return (
            <HoldOverlay
              message={hm}
              contactName={conv.contact.displayName}
              mine={(hm.reactions ?? []).find((r) => r.by === "user")?.emoji}
              onReact={(emoji) => applyReaction(hm.id, emoji)}
              onReply={canQuoteOrForward ? () => { setReactFor(null); startReply(hm); } : undefined}
              onForward={canQuoteOrForward ? () => startForward(hm) : undefined}
              onReceipts={
                hm.direction === "out" && !hm.internal && hm.email?.recipients?.length
                  ? () => { setReactFor(null); setReceiptsMsgId(hm.id); }
                  : undefined
              }
              onClose={() => setReactFor(null)}
            />
          );
        })()}

      {logOpen && <ConversationLog conversationId={conv.id} onClose={() => setLogOpen(false)} />}

      {sharing && (
        <ShareDialog
          conversationId={conv.id}
          contactName={conv.contact.displayName}
          message={sharing.message}
          onClose={() => setSharing(null)}
          onToast={onToast}
        />
      )}

      {(() => {
        // Resolve the message live from the thread so opens arriving over the
        // socket update the modal while it's open.
        const rm = receiptsMsgId ? conv.messages.find((m) => m.id === receiptsMsgId) : undefined;
        if (!rm?.email?.recipients?.length) return null;
        return (
          <ReceiptsModal
            recipients={rm.email.recipients}
            subject={rm.email.subject ?? conv.subject ?? ""}
            onClose={() => setReceiptsMsgId(null)}
          />
        );
      })()}
    </main>
  );
}
