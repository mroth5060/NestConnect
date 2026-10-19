import { forwardRef, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { Linkify } from "../Linkify";
import {
  canEditChatMessage,
  chatSystemText,
  chatTicks,
  joinNames,
  mentionParts,
  type ChatMember,
  type ChatMessage,
  type ChatRoom,
  type Mentionable,
} from "@ding/schemas";
import {
  api,
  chatDays,
  chatItems,
  chatLastSeen,
  chatNameColour,
  chatReactors,
  clockTime,
  isJumboEmoji,
  useChatMessages,
  useChatMutation,
  useChatRoom,
  useChatRoomOpen,
  useChatStars,
  useChatTyping,
  useMarkChatRead,
  useMe,
  usePeople,
  useRetryChatMessage,
  type ChatBubble,
} from "../../hooks";
import {
  AlertIcon,
  AttachIcon,
  BackIcon,
  CheckDouble,
  CheckSingle,
  ChevronDown,
  ClockIcon,
  CopyIcon,
  DetailsIcon,
  EditIcon,
  EmojiIcon,
  ReplyIcon,
  StarIcon,
  TrashIcon,
  XIcon,
} from "../../lib/icons";
import { AttachmentView } from "../media/media";
import { ChatComposer, type ChatComposerHandle } from "./ChatComposer";
import { SharedCard } from "./Discuss";
import { ChatInfoPanel } from "./ChatInfoPanel";
import { MessageInfoDialog } from "./ChatDialogs";
import { RoomAvatar } from "./RoomAvatar";
import { Avatar } from "../Avatar";

export const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

/** One chat, open: header, the messages, and the composer. */
export function ChatConversation({
  roomId,
  focusMessageId,
  onOpenConversation,
  visible = true,
  onBack,
  onClosed,
  onOpenRoom,
  onToast,
}: {
  roomId: string;
  /** Open at this message — from search or starred. */
  focusMessageId?: string | null;
  onOpenConversation?: (id: string) => void;
  /** Put away (the pop-up closed): it isn't open, so nothing is read and sounds still play. */
  visible?: boolean;
  onBack?: () => void;
  onClosed: () => void;
  onOpenRoom: (id: string) => void;
  onToast: (m: string) => void;
}) {
  const me = useMe().data?.user;
  const room = useChatRoom(roomId);
  const msgs = useChatMessages(roomId);
  const people = usePeople();
  const typing = useChatTyping(roomId);
  const [infoOpen, setInfoOpen] = useState(false);
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [editing, setEditing] = useState<ChatMessage | null>(null);
  const [infoFor, setInfoFor] = useState<ChatMessage | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const composer = useRef<ChatComposerHandle>(null);
  const stars = useChatStars();
  useChatRoomOpen(visible ? roomId : null);

  const r = room.data;
  const mentionables: Mentionable[] = useMemo(() => (people.data ?? []).map((m) => m.user), [people.data]);
  const newest = msgs.messages.at(-1);
  useMarkChatRead(roomId, newest?.id, !!r?.isMember && visible);

  // Where "unread messages" goes: fixed when the chat opens, so it doesn't
  // jump away the moment the chat is marked read.
  const [unreadAfter, setUnreadAfter] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (r && unreadAfter === undefined) {
      const mine = r.members.find((m) => m.id === me?.id);
      setUnreadAfter(r.unread > 0 ? (mine?.lastReadAt ?? null) : null);
    }
  }, [r, me?.id, unreadAfter]);

  const items = useMemo(
    () => chatItems<ChatBubble>(msgs.messages, { meId: me?.id, unreadAfter: unreadAfter ?? null }),
    [msgs.messages, me?.id, unreadAfter],
  );
  const days = useMemo(() => chatDays(items), [items]);

  /* ---- scrolling ---- */
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const [newBelow, setNewBelow] = useState(0);
  const firstId = msgs.messages[0]?.id;
  const prevFirst = useRef<string | undefined>(undefined);
  const prevHeight = useRef(0);
  const opened = useRef(false);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !msgs.messages.length) return;
    if (!opened.current) {
      // Open at the unread line if there is one, else at the bottom.
      const line = el.querySelector(".tc-unreadline");
      if (line) (line as HTMLElement).scrollIntoView({ block: "center" });
      else el.scrollTop = el.scrollHeight;
      opened.current = true;
    } else if (prevFirst.current && firstId !== prevFirst.current) {
      // Older messages arrived above: keep what I was reading where it was.
      el.scrollTop += el.scrollHeight - prevHeight.current;
    } else if (atBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
    prevFirst.current = firstId;
    prevHeight.current = el.scrollHeight;
  }, [msgs.messages, firstId]);

  // Something new while scrolled up: count it on the jump button.
  const lastSeenNewest = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!newest) return;
    if (lastSeenNewest.current && newest.id !== lastSeenNewest.current && !atBottom.current && newest.author?.id !== me?.id) {
      setNewBelow((n) => n + 1);
    }
    if (newest.author?.id === me?.id && scroller.current) {
      // My own message always brings me to the bottom.
      scroller.current.scrollTop = scroller.current.scrollHeight;
      atBottom.current = true;
    }
    lastSeenNewest.current = newest.id;
  }, [newest, me?.id]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    atBottom.current = bottom;
    setShowJump(!bottom);
    if (bottom) setNewBelow(0);
    if (el.scrollTop < 120 && msgs.hasNextPage && !msgs.isFetchingNextPage) {
      prevHeight.current = el.scrollHeight;
      void msgs.fetchNextPage();
    }
  };
  const jump = () => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setNewBelow(0);
  };
  const goTo = (id: string) => {
    const el = scroller.current?.querySelector(`[data-mid="${id}"]`);
    if (!el) return onToast("That message is further back — scroll up to load it");
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    setFlash(id);
    window.setTimeout(() => setFlash(null), 1400);
  };

  // Opened from search or starred: load back until the message is there, then show it.
  const sought = useRef<string | null>(null);
  useEffect(() => {
    if (!focusMessageId || sought.current === focusMessageId || msgs.isLoading) return;
    if (msgs.messages.some((m) => m.id === focusMessageId)) {
      sought.current = focusMessageId;
      requestAnimationFrame(() => goTo(focusMessageId));
    } else if (msgs.hasNextPage && !msgs.isFetchingNextPage) {
      prevHeight.current = scroller.current?.scrollHeight ?? 0;
      void msgs.fetchNextPage();
    } else if (!msgs.hasNextPage) {
      sought.current = focusMessageId;
      onToast("That message isn't here any more");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusMessageId, msgs.messages, msgs.hasNextPage, msgs.isFetchingNextPage, msgs.isLoading]);

  useEffect(() => {
    if (!lightbox) return;
    const close = (e: KeyboardEvent) => e.key === "Escape" && setLightbox(null);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [lightbox]);

  // Files dropped anywhere on the chat go to the composer.
  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes("Files");
  const dropProps = {
    onDragEnter: (e: DragEvent) => {
      if (!hasFiles(e) || !composer.current) return;
      e.preventDefault();
      dragDepth.current += 1;
      setDragging(true);
    },
    onDragOver: (e: DragEvent) => {
      if (hasFiles(e) && composer.current) e.preventDefault();
    },
    onDragLeave: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (!dragDepth.current) setDragging(false);
    },
    onDrop: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      const files = Array.from(e.dataTransfer.files);
      if (files.length) composer.current?.addFiles(files);
    },
  };

  /* ---- actions ---- */
  const react = useChatMutation(({ id, emoji }: { id: string; emoji: string }) => api.reactChatMessage(id, emoji));
  const remove = useChatMutation((id: string) => api.deleteChatMessage(id));
  const retry = useRetryChatMessage(roomId, me ? { id: me.id, name: me.name, avatarColor: me.avatarColor ?? null, avatarUrl: me.avatarUrl ?? null } : null);

  if (room.isError) {
    return (
      <section className="tc-chat tc-chat--gone">
        <p>This chat isn't available — you may have left it, or been removed.</p>
        <button type="button" className="btn-ghost" onClick={onClosed}>
          Back to chats
        </button>
      </section>
    );
  }
  if (!r) return <section className="tc-chat tc-chat--loading" aria-busy="true" />;

  const subline = typing.length
    ? r.kind === "direct"
      ? "typing…"
      : `${joinNames(typing.map((n) => n.split(" ")[0]!))} ${typing.length === 1 ? "is" : "are"} typing…`
    : r.kind === "direct"
      ? chatLastSeen(r.other)
      : membersLine(r.members, me?.id);
  // Moderating is for chats you're in: an admin reading one they aren't in can't delete there.
  const moderator = r.isMember && (me?.role === "admin" || r.canManage);

  return (
    <div className="tc-main">
      <section className="tc-chat" aria-label={`Chat: ${r.name}`} {...dropProps}>
        {dragging && (
          <div className="comp-drop tc-drop" aria-hidden="true">
            <span>
              <AttachIcon /> Drop to send
            </span>
          </div>
        )}
        <header className="tc-chat__head">
          {onBack && (
            <button type="button" className="iconbtn" aria-label="Back to chats" onClick={onBack}>
              <BackIcon />
            </button>
          )}
          <button type="button" className="tc-chat__who" onClick={() => setInfoOpen((v) => !v)} aria-label={`${r.name} — chat info`}>
            <RoomAvatar room={r} size={38} />
            <span className="tc-chat__names">
              <span className="tc-chat__name">{r.name}</span>
              <span className={"tc-chat__sub" + (typing.length ? " typing" : "")}>{subline}</span>
            </span>
          </button>
          <button
            type="button"
            className={"iconbtn" + (infoOpen ? " on" : "")}
            title={r.kind === "direct" ? "Contact info" : "Group info"}
            aria-label={r.kind === "direct" ? "Contact info" : "Group info"}
            onClick={() => setInfoOpen((v) => !v)}
          >
            <DetailsIcon />
          </button>
        </header>

        <div className="tc-msgs-wrap">
          <div className="tc-msgs" ref={scroller} onScroll={onScroll} role="log" aria-live="polite">
            {msgs.isFetchingNextPage && <div className="tc-loading-older">Loading earlier messages…</div>}
            {!msgs.hasNextPage && !msgs.isLoading && (
              <div className="tc-start">
                {r.kind === "direct"
                  ? r.oversight
                    ? `This is the start of the chat between ${r.name.replace(" & ", " and ")}.`
                    : `This is the start of your chat with ${r.name}.`
                  : r.kind === "team"
                    ? `Everyone on ${r.name} is in this chat. People join and leave it with the team.`
                    : `Messages in ${r.name} are visible to its members.`}
              </div>
            )}
            {/* One section per day, as in the inbox: a day's date sticks at
                the top while you read that day, and the next day's pushes it
                off — a sticky element only sticks within its parent. */}
            {days.map((day) => (
              <section key={day.key} className="tc-dayg">
                {day.label && (
                  <div className="tc-day">
                    <span>{day.label}</span>
                  </div>
                )}
                {day.items.map((it) =>
                  it.kind === "unread" ? (
                    <div key={it.key} className="tc-unreadline">
                      <span>
                        {it.count} unread message{it.count === 1 ? "" : "s"}
                      </span>
                    </div>
                  ) : it.message.kind === "system" ? (
                    <div key={it.key} className="tc-sys" data-mid={it.message.id}>
                      <span>{it.message.system ? chatSystemText(it.message.system) : ""}</span>
                    </div>
                  ) : (
                    <Bubble
                      key={it.key}
                      m={it.message}
                      first={it.first}
                      last={it.last}
                      mine={it.message.author?.id === me?.id}
                      meId={me?.id}
                      // Reading someone else's direct chat, there are two other people: say who's who.
                      // And in your own, an admin or manager who stepped in is named, not taken for them.
                      group={r.kind !== "direct" || r.oversight || !r.members.some((p) => p.id === it.message.author?.id)}
                      room={r}
                      people={mentionables}
                      flash={flash === it.message.id}
                      canAct={r.canPost}
                      moderator={moderator}
                      onReply={() => {
                        setEditing(null);
                        setReplyTo(it.message);
                      }}
                      onEdit={() => {
                        setReplyTo(null);
                        setEditing(it.message);
                      }}
                      onDelete={() => {
                        if (window.confirm("Delete this message for everyone?")) remove.mutate(it.message.id, { onError: (e) => onToast((e as Error).message) });
                      }}
                      onReact={(emoji) => react.mutate({ id: it.message.id, emoji }, { onError: (e) => onToast((e as Error).message) })}
                      onInfo={() => setInfoFor(it.message)}
                      onCopy={() => {
                        void navigator.clipboard?.writeText(it.message.body).then(() => onToast("Copied"));
                      }}
                      onQuote={goTo}
                      onRetry={() => void retry(it.message)}
                      onImage={setLightbox}
                      onOpenConversation={onOpenConversation}
                      starred={stars.ids.has(it.message.id)}
                      onStar={(on) => void stars.toggle(it.message, on).catch(() => onToast("Couldn't star that message"))}
                    />
                  ),
                )}
              </section>
            ))}
            {typing.length > 0 && (
              <div className="tc-typing" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
            )}
          </div>
          {showJump && (
            <button type="button" className="jumpbtn tc-jump" aria-label="Jump to latest" onClick={jump}>
              <ChevronDown />
              {newBelow > 0 && <span className="tc-jump__n">{newBelow}</span>}
            </button>
          )}
        </div>

        {r.canPost ? (
          <ChatComposer
            ref={composer}
            room={r}
            people={mentionables}
            replyTo={replyTo}
            editing={editing}
            onCancelReply={() => setReplyTo(null)}
            onCancelEdit={() => setEditing(null)}
            onToast={onToast}
          />
        ) : r.oversight ? null : (
          // An admin reading a chat they aren't in sees no box and no notice.
          <div className="tc-cantpost">{r.kind === "direct" ? "They're no longer in this workspace." : "You can't send messages here."}</div>
        )}
      </section>
      {infoOpen && (
        <ChatInfoPanel
          room={r}
          onClose={() => setInfoOpen(false)}
          onLeft={onClosed}
          onOpenRoom={onOpenRoom}
          onToast={onToast}
        />
      )}
      {infoFor && <MessageInfoDialog message={infoFor} onClose={() => setInfoFor(null)} />}
      {lightbox && (
        <div className="lightbox" role="dialog" aria-modal="true" aria-label="Image preview" onClick={() => setLightbox(null)}>
          <img className="lightbox__img" src={lightbox} alt="" />
          <button type="button" className="lightbox__close" onClick={() => setLightbox(null)} aria-label="Close preview">
            <XIcon />
          </button>
        </div>
      )}
    </div>
  );
}

/** "Amara, James, You" — who's in it, as the header's second line. */
function membersLine(members: ChatMember[], meId: string | undefined): string {
  const others = members.filter((m) => m.id !== meId).map((m) => m.name.split(" ")[0]!);
  const online = members.filter((m) => m.id !== meId && m.online).length;
  const names = [...others.slice(0, 6), ...(members.some((m) => m.id === meId) ? ["You"] : [])].join(", ");
  const more = others.length > 6 ? ` +${others.length - 6}` : "";
  return `${names}${more}${online ? ` · ${online} online` : ""}`;
}

function Bubble({
  m,
  first,
  last,
  mine,
  meId,
  group,
  room,
  people,
  flash,
  canAct,
  moderator,
  onReply,
  onEdit,
  onDelete,
  onReact,
  onInfo,
  onCopy,
  onQuote,
  onRetry,
  onImage,
  starred,
  onStar,
  onOpenConversation,
}: {
  m: ChatBubble;
  first: boolean;
  last: boolean;
  mine: boolean;
  meId: string | undefined;
  group: boolean;
  room: ChatRoom;
  people: Mentionable[];
  flash: boolean;
  canAct: boolean;
  moderator: boolean;
  onReply: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onReact: (emoji: string) => void;
  onInfo: () => void;
  onCopy: () => void;
  onQuote: (id: string) => void;
  onRetry: () => void;
  onImage: (url: string) => void;
  starred: boolean;
  onStar: (on: boolean) => void;
  onOpenConversation?: (id: string) => void;
}) {
  const [menu, setMenu] = useState<"react" | "more" | "who" | null>(null);
  // Which reaction's people the list shows; null for everyone.
  const [whoTab, setWhoTab] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const deleted = !!m.deletedAt;
  const files = deleted ? [] : (m.attachments ?? []);
  const jumbo = !deleted && !m.replyTo && !files.length && !m.shared && isJumboEmoji(m.body);
  // A photo or video on its own sits in the bubble edge to edge, the time over it.
  const visual = files.length > 0 && files.every((a) => a.kind === "image" || a.kind === "video");
  const bare = visual && !m.body && !m.replyTo;
  const ticks = mine && !m.pending && !m.failed ? chatTicks(m, room.members, m.author?.id ?? "") : null;
  const settled = !m.pending && !m.failed && !deleted;

  // The inbox's rule: an open picker or menu stays open until you click
  // somewhere else or press Esc — not the moment the pointer drifts off.
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setMenu(null);
    };
    // Captured, so this Esc closes the menu and not the Team Chat pop-up too.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setMenu(null);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [menu]);
  // Keep what opened inside the message list: slide it sideways off an edge,
  // and turn the menu upward (the picker downward) where there's no room.
  const pop = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = pop.current;
    const box = root.current?.closest(".tc-msgs")?.getBoundingClientRect();
    if (!menu || !el || !box) return;
    // Measured at its full size. It opens growing from a corner, and a rect
    // taken in that first frame is the shrunken one: a picker by a short
    // incoming message looked as if it fitted, and then grew out past the
    // list's edge, under the chats beside it. Pausing the animation for the
    // measurement restarts it from the start, which is where it was anyway.
    el.style.animation = "none";
    const r = el.getBoundingClientRect();
    el.style.animation = "";
    if ((menu === "more" || menu === "who") && r.bottom > box.bottom - 6 && r.top - r.height - 30 > box.top) el.classList.add("up");
    if (menu === "react" && r.top < box.top + 6) el.classList.add("down");
    const x = r.left < box.left + 6 ? box.left + 6 - r.left : r.right > box.right - 6 ? box.right - 6 - r.right : 0;
    if (x) el.style.translate = `${x}px 0`;
  }, [menu]);
  const pick = (e: string) => {
    setMenu(null);
    onReact(e);
  };

  return (
    <div
      className={
        "tc-msg " +
        (mine ? "out" : "in") +
        (first ? " first" : "") +
        (last ? " last" : "") +
        (flash ? " flash" : "") +
        (jumbo ? " jumbo" : "") +
        // Room for the sender's face — only a group shows one.
        (group && !mine ? " grp" : "")
      }
      data-mid={m.id}
      ref={root}
      // Right-click, or a long press on a phone: the same menu as the corner chevron.
      onContextMenu={(e) => {
        if (!settled || window.getSelection()?.toString()) return;
        e.preventDefault();
        setMenu("more");
      }}
    >
      {group && !mine && last && (
        <span className="tc-msg__av">
          <RoomAvatar
            room={{
              id: m.author?.id ?? "",
              kind: "direct",
              name: m.author?.name ?? "",
              emoji: null,
              teamId: null,
              other: m.author ? { ...m.author, online: false, lastSeenAt: null } : null,
              memberCount: 2,
              lastMessage: null,
              lastActivityAt: m.createdAt,
              unread: 0,
              mentioned: false,
              pinned: false,
              muted: false,
              isMember: true,
              archived: false,
            }}
            size={28}
          />
        </span>
      )}
      <div className={"tc-wrap" + (menu ? " open" : "")}>
      <div className={"tc-bubble" + (deleted ? " deleted" : "") + (files.length ? " has-files" : "") + (visual ? " visual" : "") + (bare ? " bare" : "") + (m.shared ? " has-card" : "")}>
        {group && !mine && first && (
          <span className="tc-bubble__name" style={{ color: chatNameColour(m.author?.id) }}>
            {m.author?.name ?? "Former teammate"}
          </span>
        )}
        {m.replyTo && !deleted && (
          <button type="button" className="tc-quote" onClick={() => onQuote(m.replyTo!.id)} style={{ borderColor: chatNameColour(m.replyTo.authorId) }}>
            <span className="tc-quote__who" style={{ color: chatNameColour(m.replyTo.authorId) }}>
              {m.replyTo.authorId && m.replyTo.authorId === meId ? "You" : m.replyTo.authorName}
            </span>
            <span className="tc-quote__text">{m.replyTo.deleted ? "This message was deleted" : m.replyTo.body}</span>
          </button>
        )}
        {m.shared && !deleted && (
          <SharedCard shared={m.shared} onOpen={onOpenConversation ? () => onOpenConversation(m.shared!.conversationId) : undefined} />
        )}
        {files.length > 0 && (
          <div className={"tc-files" + (visual && files.length > 1 ? " grid" : "")}>
            {files.map((a) => (
              <AttachmentView key={a.id} att={a} onImage={onImage} />
            ))}
          </div>
        )}
        {deleted ? (
          <span className="tc-bubble__text tc-deleted">{mine ? "You deleted this message" : "This message was deleted"}</span>
        ) : !m.body ? null : (
          <span className="tc-bubble__text">
            {mentionParts(m.body, people).map((p, i) =>
              p.mention ? (
                <span key={i} className="tc-mention">
                  {p.text}
                </span>
              ) : (
                <Linkify key={i} text={p.text} className="tc-link" />
              ),
            )}
          </span>
        )}
        {m.link && !deleted && (
          <a className="tc-linkcard" href={m.link.url} target="_blank" rel="noopener noreferrer">
            {m.link.siteName && <span className="tc-linkcard__site">{m.link.siteName}</span>}
            <span className="tc-linkcard__title">{m.link.title}</span>
            {m.link.description && <span className="tc-linkcard__desc">{m.link.description}</span>}
          </a>
        )}
        {!bare && <span className="tc-stamp-space" aria-hidden="true" />}
        <span className="tc-stamp">
          {starred && !deleted && (
            <span className="tc-starred" aria-label="Starred">
              <StarIcon filled />
            </span>
          )}
          {m.editedAt && !deleted && <span className="tc-edited">Edited</span>}
          <time dateTime={m.createdAt} title={new Date(m.createdAt).toLocaleString()}>
            {clockTime(m.createdAt)}
          </time>
          {mine && !deleted && (
            <span className={"tc-tick" + (ticks === "read" ? " read" : "")} aria-label={m.pending ? "Sending" : m.failed ? "Not sent" : ticks === "read" ? "Read" : ticks === "delivered" ? "Delivered" : "Sent"}>
              {m.pending ? <ClockIcon /> : m.failed ? <AlertIcon /> : ticks === "sent" ? <CheckSingle /> : <CheckDouble />}
            </span>
          )}
        </span>
        {m.failed && (
          <button type="button" className="tc-retry" onClick={onRetry}>
            Not sent · Retry
          </button>
        )}
        {settled && (
          <button
            type="button"
            className="tc-menubtn"
            aria-label="Message actions"
            aria-haspopup="menu"
            aria-expanded={menu === "more"}
            onClick={() => setMenu(menu === "more" ? null : "more")}
          >
            <ChevronDown />
          </button>
        )}
      </div>

      {m.reactions.length > 0 && (
        // As WhatsApp: a reaction opens who reacted, rather than reacting.
        <div className="tc-reacts">
          {m.reactions.map((rx) => (
            <button
              key={rx.emoji}
              type="button"
              className={"tc-react" + (meId && rx.userIds.includes(meId) ? " mine" : "")}
              title={rx.userIds.map((id) => room.members.find((x) => x.id === id)?.name ?? "Someone").join(", ")}
              aria-haspopup="dialog"
              aria-expanded={menu === "who" && whoTab === rx.emoji}
              onClick={() => {
                const again = menu === "who" && whoTab === rx.emoji;
                setWhoTab(rx.emoji);
                setMenu(again ? null : "who");
              }}
            >
              {rx.emoji}
              {rx.userIds.length > 1 && <span>{rx.userIds.length}</span>}
            </button>
          ))}
        </div>
      )}
      {menu === "who" && (
        <ReactionsList
          ref={pop}
          reactions={m.reactions}
          people={[...room.members, ...people.map((p) => ({ ...p, id: (p as Mentionable & { id?: string }).id ?? "" }))]}
          meId={meId}
          tab={whoTab}
          onTab={setWhoTab}
          canRemove={canAct}
          onRemove={(emoji) => {
            setMenu(null);
            onReact(emoji);
          }}
        />
      )}

      {settled && canAct && (
        <button type="button" className="tc-reactbtn" aria-label="React to message" title="React" onClick={() => setMenu(menu === "react" ? null : "react")}>
          <EmojiIcon />
        </button>
      )}
      {menu === "react" && (
        <div className="tc-reactpick" ref={pop} role="menu" aria-label="Pick a reaction">
          {QUICK_REACTIONS.map((e) => (
            <button
              key={e}
              type="button"
              role="menuitem"
              aria-label={`React ${e}`}
              className={m.reactions.some((rx) => rx.emoji === e && !!meId && rx.userIds.includes(meId)) ? "sel" : undefined}
              onClick={() => pick(e)}
            >
              {e}
            </button>
          ))}
        </div>
      )}
      {menu === "more" && (
        <div className="tc-msgmenu" ref={pop} role="menu">
          {canAct && (
            // No hover smiley on a phone, so a long press reacts from here.
            <div className="tc-msgmenu__reacts">
              {QUICK_REACTIONS.map((e) => (
                <button key={e} type="button" role="menuitem" aria-label={`React ${e}`} onClick={() => pick(e)}>
                  {e}
                </button>
              ))}
            </div>
          )}
          {canAct && (
            <button type="button" role="menuitem" onClick={() => { setMenu(null); onReply(); }}>
              <ReplyIcon /> Reply
            </button>
          )}
          {!!m.body && (
            <button type="button" role="menuitem" onClick={() => { setMenu(null); onCopy(); }}>
              <CopyIcon /> Copy
            </button>
          )}
          <button type="button" role="menuitem" onClick={() => { setMenu(null); onStar(!starred); }}>
            <StarIcon filled={starred} /> {starred ? "Unstar" : "Star"}
          </button>
          {mine && canEditChatMessage(m) && (
            <button type="button" role="menuitem" onClick={() => { setMenu(null); onEdit(); }}>
              <EditIcon /> Edit
            </button>
          )}
          {mine && (
            <button type="button" role="menuitem" onClick={() => { setMenu(null); onInfo(); }}>
              <DetailsIcon /> Info
            </button>
          )}
          {(mine || moderator) && (
            <button type="button" role="menuitem" className="danger" onClick={() => { setMenu(null); onDelete(); }}>
              <TrashIcon /> Delete for everyone
            </button>
          )}
        </div>
      )}
      </div>
    </div>
  );
}

/**
 * Who reacted, as WhatsApp shows it when a reaction is tapped: "All" and a tab
 * per emoji, a row per person, and yours first — click it to take it back.
 */
const ReactionsList = forwardRef<
  HTMLDivElement,
  {
    reactions: ChatMessage["reactions"];
    people: Array<{ id: string; name: string; avatarColor?: string | null; avatarUrl?: string | null }>;
    meId: string | undefined;
    tab: string | null;
    onTab: (emoji: string | null) => void;
    canRemove: boolean;
    onRemove: (emoji: string) => void;
  }
>(function ReactionsList({ reactions, people, meId, tab, onTab, canRemove, onRemove }, ref) {
  const all = chatReactors(reactions, people, meId);
  const rows = tab ? all.filter((r) => r.emoji === tab) : all;
  return (
    <div className="tc-reactwho" ref={ref} role="dialog" aria-label="Reactions">
      <div className="tc-reactwho__tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === null} className={tab === null ? "on" : ""} onClick={() => onTab(null)}>
          All {all.length}
        </button>
        {reactions.map((rx) => (
          <button key={rx.emoji} type="button" role="tab" aria-selected={tab === rx.emoji} className={tab === rx.emoji ? "on" : ""} onClick={() => onTab(rx.emoji)}>
            {rx.emoji} {rx.userIds.length}
          </button>
        ))}
      </div>
      <ul className="tc-reactwho__list">
        {rows.map((r) => {
          const body = (
            <>
              <Avatar name={r.name} color={r.avatarColor ?? undefined} src={r.avatarUrl ?? undefined} size={30} fontSize={11} />
              <span className="tc-reactwho__who">
                <b>{r.mine ? "You" : r.name}</b>
                {r.mine && canRemove && <small>Click to remove</small>}
              </span>
              <span className="tc-reactwho__emoji">{r.emoji}</span>
            </>
          );
          return (
            <li key={`${r.userId}:${r.emoji}`}>
              {r.mine && canRemove ? (
                <button type="button" className="tc-reactwho__row" onClick={() => onRemove(r.emoji)} aria-label={`Remove your ${r.emoji} reaction`}>
                  {body}
                </button>
              ) : (
                <div className="tc-reactwho__row">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
});
