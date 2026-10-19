import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData, type QueryClient } from "@tanstack/react-query";
import {
  ChatClientEvent,
  ChatServerEvent,
  ServerEvent,
  type ChatAttachment,
  type ChatDiscussion,
  type ChatDiscussionThread,
  type ChatSharedConversation,
  type Conversation,
  type ShareConversationInput,
  type ChatCue,
  type ChatMessage,
  type ChatMessagePage,
  type ChatPerson,
  type ChatRoom,
  type ChatRoomSummary,
} from "@ding/schemas";
import { api } from "./api";
import { clientConfig } from "./config";
import { getSocket, onReconnect } from "./socket";

/*
 * Team Chat on the client: the queries, sending (with the bubble showing before
 * the server has answered), and keeping every open screen current from the
 * socket. Shared by the web app and the native apps. See docs/team-chat.md.
 */

/** A message as a screen holds it: the server's, or mine on its way there. */
export type ChatBubble = ChatMessage & { pending?: boolean; failed?: boolean };

type Pages = InfiniteData<ChatMessagePage, string | undefined>;

const keys = {
  status: ["chat", "status"] as const,
  rooms: (all: boolean) => ["chat", "rooms", all] as const,
  room: (id: string) => ["chat", "room", id] as const,
  messages: (id: string) => ["chat", "messages", id] as const,
  starred: ["chat", "starred"] as const,
  discussions: (conversationId: string) => ["chat", "discussions", conversationId] as const,
  thread: (cardId: string) => ["chat", "thread", cardId] as const,
  search: (q: string) => ["chat", "search", q] as const,
};

/* ---- which chat is on screen ---- */

let openRoom: string | null = null;

/** The chat screen says which chat it has open, so a sound for that one isn't made. */
export function setOpenChatRoom(id: string | null): void {
  openRoom = id;
}

/* ---- "a message arrived", for a screen that wants to show it ---- */

type CueListener = (cue: ChatCue & { onScreen: boolean }) => void;
const cueListeners = new Set<CueListener>();

/**
 * Hear about each chat message the server says this person should know of
 * (not muted, not their own). `onScreen` is true when that chat is open in
 * front of them, so a pop-up can stay out of the way. Returns the unsubscribe.
 */
export function onChatCue(listener: CueListener): () => void {
  cueListeners.add(listener);
  return () => {
    cueListeners.delete(listener);
  };
}

const looking = () => clientConfig().attention?.isLooking() ?? true;

/* ---- queries ---- */

export function useChatStatus(enabled = true) {
  return useQuery({ queryKey: keys.status, queryFn: () => api.chatStatus(), staleTime: 30_000, enabled });
}

export function useChatRooms(all = false, enabled = true) {
  return useQuery({ queryKey: keys.rooms(all), queryFn: () => api.chatRooms(all), staleTime: 10_000, enabled });
}

export function useChatRoom(id: string | null | undefined) {
  return useQuery({ queryKey: keys.room(id ?? ""), queryFn: () => api.chatRoom(id!), enabled: !!id, staleTime: 10_000, retry: false });
}

/** A chat's messages, oldest first, with older pages loaded on demand. */
export function useChatMessages(id: string | null | undefined) {
  const q = useInfiniteQuery({
    queryKey: keys.messages(id ?? ""),
    queryFn: ({ pageParam }) => api.chatMessages(id!, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.hasMore ? last.messages[0]?.id : undefined),
    enabled: !!id,
    staleTime: 30_000,
    retry: false,
  });
  // Pages arrive newest first; a chat reads oldest first.
  const messages: ChatBubble[] = q.data ? [...q.data.pages].reverse().flatMap((p) => p.messages) : [];
  return { ...q, messages };
}

/** Words in any of my chats. Two letters at least; the screen waits for typing to pause. */
export function useChatSearch(q: string) {
  const term = q.trim();
  return useQuery({ queryKey: keys.search(term), queryFn: () => api.searchChat(term), enabled: term.length >= 2, staleTime: 10_000 });
}

/** What I've starred, newest star first. */
export function useChatStarred(enabled = true) {
  return useQuery({ queryKey: keys.starred, queryFn: () => api.chatStarred(), staleTime: 30_000, enabled });
}

/** Star or unstar: the ids I've starred, for the star on each bubble. */
export function useChatStars() {
  const qc = useQueryClient();
  const starred = useChatStarred();
  const ids = new Set((starred.data ?? []).map((s) => s.message.id));
  const toggle = useCallback(
    async (m: ChatMessage, on: boolean) => {
      // Show it at once; the list is fetched again either way.
      qc.setQueryData(keys.starred, (cur: typeof starred.data) =>
        on
          ? [{ roomId: m.roomId, roomName: "", message: m, starredAt: new Date().toISOString() }, ...(cur ?? []).filter((s) => s.message.id !== m.id)]
          : (cur ?? []).filter((s) => s.message.id !== m.id),
      );
      try {
        await api.starChatMessage(m.id, on);
      } finally {
        qc.invalidateQueries({ queryKey: keys.starred });
      }
    },
    [qc],
  );
  return { ids, toggle };
}

/* ---- customer conversations, discussed ---- */

/** Where a customer conversation is being discussed — the bar on its thread. */
export function useChatDiscussions(conversationId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: keys.discussions(conversationId ?? ""),
    queryFn: () => api.chatDiscussions(conversationId!),
    enabled: !!conversationId && enabled,
    staleTime: 30_000,
    retry: false,
  });
}

/** One discussion: the card, and everything said in reply to it. */
export function useChatThread(cardId: string | null | undefined) {
  return useQuery({ queryKey: keys.thread(cardId ?? ""), queryFn: () => api.chatThread(cardId!), enabled: !!cardId, staleTime: 15_000, retry: false });
}

/** Bring a customer conversation (or a message from it) into a chat. */
export function useShareConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ShareConversationInput) => api.shareConversation(input),
    onSuccess: (message, input) => {
      upsertMessage(qc, message.roomId, message);
      qc.invalidateQueries({ queryKey: keys.discussions(input.conversationId) });
      refreshLists(qc);
    },
  });
}

/** A reply to a card, a card made or deleted: the discussions that show it are out of date. */
function discussionNews(qc: QueryClient, m: ChatMessage): void {
  if (m.replyTo) qc.invalidateQueries({ queryKey: keys.thread(m.replyTo.id) });
  if (m.replyTo || m.shared || m.deletedAt) qc.invalidateQueries({ queryKey: ["chat", "discussions"] });
  if (m.deletedAt) qc.invalidateQueries({ queryKey: keys.thread(m.id) });
}

/**
 * A customer conversation changed — closed, reopened, handed to someone. Every
 * card of it on screen follows, wherever it is: in a chat, a discussion, the
 * thread's bar. The conversation event already reaches everyone in the
 * workspace, so the cards need nothing of their own from the server.
 */
function followConversation(qc: QueryClient, c: Pick<Conversation, "id" | "status" | "assigneeName">): void {
  const patch = (m: ChatMessage): ChatMessage =>
    m.shared?.conversationId === c.id && m.shared.status !== null
      ? { ...m, shared: { ...m.shared, status: c.status, assigneeName: c.assigneeName ?? null } satisfies ChatSharedConversation }
      : m;
  for (const [key, data] of qc.getQueriesData<Pages>({ queryKey: ["chat", "messages"] })) {
    if (!data?.pages.some((p) => p.messages.some((m) => m.shared?.conversationId === c.id))) continue;
    qc.setQueryData<Pages>(key, { ...data, pages: data.pages.map((p) => ({ ...p, messages: p.messages.map(patch) })) });
  }
  for (const [key, data] of qc.getQueriesData<ChatDiscussionThread>({ queryKey: ["chat", "thread"] })) {
    if (data?.card.shared?.conversationId === c.id) qc.setQueryData<ChatDiscussionThread>(key, { ...data, card: patch(data.card) });
  }
  qc.setQueryData<ChatDiscussion[]>(keys.discussions(c.id), (cur) => cur?.map((d) => ({ ...d, card: patch(d.card) })));
}

/* ---- the cache, patched from wherever news arrives ---- */

/** Add a message at the end, or put a newer copy of it in place. */
function upsertMessage(qc: QueryClient, roomId: string, message: ChatBubble): void {
  qc.setQueryData<Pages>(keys.messages(roomId), (cur) => {
    if (!cur) return cur;
    let found = false;
    const pages = cur.pages.map((p) => {
      const idx = p.messages.findIndex(
        (m) => m.id === message.id || (!!message.clientId && (m as ChatBubble).pending !== undefined && m.clientId === message.clientId),
      );
      if (idx < 0) return p;
      found = true;
      const next = p.messages.slice();
      next[idx] = message;
      return { ...p, messages: next };
    });
    if (found) {
      // The socket and the send's own answer can both bring the real message; keep one.
      return { ...cur, pages: pages.map((p) => ({ ...p, messages: dedupe(p.messages) })) };
    }
    const [newest, ...rest] = pages;
    if (!newest) return cur;
    return { ...cur, pages: [{ ...newest, messages: [...newest.messages, message] }, ...rest] };
  });
}

function dedupe(list: ChatMessage[]): ChatMessage[] {
  const seen = new Set<string>();
  return list.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
}

function refreshLists(qc: QueryClient): void {
  qc.invalidateQueries({ queryKey: ["chat", "rooms"] });
  qc.invalidateQueries({ queryKey: keys.status });
}

/* ---- sending ---- */

let localSeq = 0;

/**
 * Send, showing the bubble straight away with a clock on it. When the server
 * answers it becomes the real message; if it can't be sent it stays, marked,
 * to try again.
 */
export function useSendChatMessage(roomId: string, me: ChatPerson | null) {
  const qc = useQueryClient();
  return useCallback(
    async (body: string, replyTo?: ChatMessage | null, attachments: ChatAttachment[] = []): Promise<void> => {
      const clientId = `c${Date.now().toString(36)}${(++localSeq).toString(36)}`;
      const draft: ChatBubble = {
        id: `local_${clientId}`,
        roomId,
        kind: "text",
        author: me,
        body,
        system: null,
        replyTo: replyTo
          ? { id: replyTo.id, authorId: replyTo.author?.id ?? null, authorName: replyTo.author?.name ?? "", body: replyTo.body, deleted: false }
          : null,
        reactions: [],
        mentions: [],
        attachments,
        link: null,
        shared: null,
        editedAt: null,
        deletedAt: null,
        createdAt: new Date().toISOString(),
        clientId,
        pending: true,
      };
      upsertMessage(qc, roomId, draft);
      try {
        const sent = await api.sendChatMessage(roomId, { body, replyToId: replyTo?.id ?? null, clientId, attachments });
        upsertMessage(qc, roomId, { ...sent, clientId });
        refreshLists(qc);
        // The same tick a WhatsApp reply makes: once the server has it, never
        // on a failure.
        clientConfig().cues.sent?.("whatsapp");
      } catch {
        upsertMessage(qc, roomId, { ...draft, pending: false, failed: true });
      }
    },
    [qc, roomId, me],
  );
}

/** Try a message that didn't go again: it leaves where it was and goes to the end. */
export function useRetryChatMessage(roomId: string, me: ChatPerson | null) {
  const qc = useQueryClient();
  const send = useSendChatMessage(roomId, me);
  return useCallback(
    async (failed: ChatBubble) => {
      qc.setQueryData<Pages>(keys.messages(roomId), (cur) =>
        cur ? { ...cur, pages: cur.pages.map((p) => ({ ...p, messages: p.messages.filter((m) => m.id !== failed.id) })) } : cur,
      );
      await send(
        failed.body,
        failed.replyTo ? ({ id: failed.replyTo.id, author: null, body: failed.replyTo.body } as unknown as ChatMessage) : null,
        failed.attachments,
      );
    },
    [qc, roomId, send],
  );
}

/**
 * Anything else that changes chats — edit, delete, react, mute, pin, a group's
 * name or people. A message that comes back is put in place; everything else
 * refreshes.
 */
export function useChatMutation<TArgs, TResult>(fn: (args: TArgs) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (result) => {
      const m = result as Partial<ChatMessage> | undefined;
      if (m && typeof m === "object" && m.id && m.roomId && "reactions" in m) upsertMessage(qc, m.roomId, m as ChatMessage);
      const room = result as Partial<ChatRoom> | undefined;
      if (room && typeof room === "object" && room.id && Array.isArray(room.members)) qc.setQueryData(keys.room(room.id), room);
      qc.invalidateQueries({ queryKey: ["chat", "room"] });
      refreshLists(qc);
    },
  });
}

/** I've seen this chat. Cheap to call often: it only goes out when there's news. */
export function useMarkChatRead(roomId: string | null | undefined, newestId: string | undefined, canRead: boolean) {
  const qc = useQueryClient();
  const last = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!roomId || !newestId || !canRead || newestId.startsWith("local_") || last.current === newestId) return;
    const mark = () => {
      if (!looking()) return;
      last.current = newestId;
      void api.readChatRoom(roomId).then(() => refreshLists(qc), () => undefined);
    };
    mark();
    return clientConfig().attention?.onReturn(mark);
  }, [qc, roomId, newestId, canRead]);
}

/* ---- typing ---- */

type Typists = Map<string, { name: string; until: number }>;
const typing = new Map<string, Typists>();
const typingListeners = new Set<() => void>();
let typingVersion = 0;
const bumpTyping = () => {
  typingVersion++;
  for (const l of typingListeners) l();
};

function setTyping(roomId: string, userId: string, name: string, on: boolean): void {
  const room = typing.get(roomId) ?? new Map();
  if (on) room.set(userId, { name, until: Date.now() + 6_000 });
  else room.delete(userId);
  typing.set(roomId, room);
  bumpTyping();
}

/** Who is typing in this chat right now. */
export function useChatTyping(roomId: string | null | undefined): string[] {
  useSyncExternalStore(
    (l) => {
      typingListeners.add(l);
      const t = setInterval(l, 2_000);
      return () => {
        typingListeners.delete(l);
        clearInterval(t);
      };
    },
    () => typingVersion + Math.floor(Date.now() / 2_000),
    () => 0,
  );
  if (!roomId) return [];
  const now = Date.now();
  return [...(typing.get(roomId)?.values() ?? [])].filter((t) => t.until > now).map((t) => t.name);
}

/** Tell the chat I'm typing: at most every few seconds, and "stopped" after a pause. */
export function useChatTypingSignal(roomId: string | null | undefined) {
  const lastSent = useRef(0);
  const stopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stop = useCallback(() => {
    if (stopTimer.current) clearTimeout(stopTimer.current);
    stopTimer.current = null;
    if (!roomId || !lastSent.current) return;
    lastSent.current = 0;
    getSocket().emit(ChatClientEvent.Typing, { roomId, typing: false });
  }, [roomId]);
  const typed = useCallback(() => {
    if (!roomId) return;
    const now = Date.now();
    if (now - lastSent.current > 3_000) {
      lastSent.current = now;
      getSocket().emit(ChatClientEvent.Typing, { roomId, typing: true });
    }
    if (stopTimer.current) clearTimeout(stopTimer.current);
    stopTimer.current = setTimeout(stop, 4_000);
  }, [roomId, stop]);
  useEffect(() => stop, [stop]);
  return { typed, stop };
}

/* ---- presence in one chat ---- */

/** Join the chat's room while it's open — so pushes about it aren't sent here, and typing reaches me. */
export function useChatRoomOpen(roomId: string | null | undefined): void {
  useEffect(() => {
    if (!roomId) return;
    setOpenChatRoom(roomId);
    const socket = getSocket();
    const join = () => socket.emit(ChatClientEvent.Join, { roomId });
    join();
    socket.on("connect", join);
    return () => {
      socket.off("connect", join);
      socket.emit(ChatClientEvent.Leave, { roomId });
      if (openRoom === roomId) setOpenChatRoom(null);
    };
  }, [roomId]);
}

/* ---- the socket ---- */

/**
 * Keep every chat screen current. Mounted once, near the top of the app, for
 * as long as Team Chat is on.
 */
export function useChatRealtime(enabled: boolean): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    const socket = getSocket();
    const onMessage = (p: { roomId: string; message: ChatMessage }) => {
      upsertMessage(qc, p.roomId, p.message);
      if (p.message.author) setTyping(p.roomId, p.message.author.id, p.message.author.name, false);
      // The list and the badge refetch — which is also my app telling the
      // server it has this message (the second grey tick).
      refreshLists(qc);
      if (p.message.kind === "system") qc.invalidateQueries({ queryKey: keys.room(p.roomId) });
      discussionNews(qc, p.message);
    };
    const onUpdated = (p: { roomId: string; message: ChatMessage }) => {
      upsertMessage(qc, p.roomId, p.message);
      qc.invalidateQueries({ queryKey: ["chat", "rooms"] });
      discussionNews(qc, p.message);
    };
    const onConversation = (p: { conversation: Conversation }) => followConversation(qc, p.conversation);
    const onReceipt = (p: { roomId: string; userId: string; lastReadAt: string | null; lastDeliveredAt: string | null }) => {
      qc.setQueryData<ChatRoom>(keys.room(p.roomId), (cur) =>
        cur
          ? {
              ...cur,
              members: cur.members.map((m) =>
                m.id === p.userId ? { ...m, lastReadAt: p.lastReadAt, lastDeliveredAt: p.lastDeliveredAt } : m,
              ),
            }
          : cur,
      );
    };
    const onRoom = (p: { roomId: string; removed?: boolean }) => {
      qc.invalidateQueries({ queryKey: keys.room(p.roomId) });
      if (p.removed) qc.removeQueries({ queryKey: keys.messages(p.roomId) });
      refreshLists(qc);
    };
    const onTyping = (p: { roomId: string; userId: string; name: string; typing: boolean }) => setTyping(p.roomId, p.userId, p.name, p.typing);
    const onPresence = (p: { userId: string; online: boolean; lastSeenAt: string | null }) => {
      for (const all of [false, true]) {
        qc.setQueryData<ChatRoomSummary[]>(keys.rooms(all), (cur) =>
          cur?.map((r) => (r.other?.id === p.userId ? { ...r, other: { ...r.other, online: p.online, lastSeenAt: p.lastSeenAt ?? r.other.lastSeenAt } } : r)),
        );
      }
      for (const [key, room] of qc.getQueriesData<ChatRoom>({ queryKey: ["chat", "room"] })) {
        if (!room?.members.some((m) => m.id === p.userId)) continue;
        qc.setQueryData<ChatRoom>(key, {
          ...room,
          members: room.members.map((m) => (m.id === p.userId ? { ...m, online: p.online, lastSeenAt: p.lastSeenAt ?? m.lastSeenAt } : m)),
          other: room.other?.id === p.userId ? { ...room.other, online: p.online, lastSeenAt: p.lastSeenAt ?? room.other.lastSeenAt } : room.other,
        });
      }
    };
    // The server already left out everyone muted or not asking. The chat
    // that's open in front of me rings too, as a WhatsApp conversation in the
    // inbox does: it's how you know the reply landed without looking up.
    const onCue = (cue: ChatCue) => {
      if (!cue.silent) clientConfig().cues.received?.();
      const onScreen = openRoom === cue.roomId && looking();
      for (const l of cueListeners) l({ ...cue, onScreen });
    };
    socket.on(ChatServerEvent.Message, onMessage);
    socket.on(ChatServerEvent.MessageUpdated, onUpdated);
    socket.on(ChatServerEvent.Receipt, onReceipt);
    socket.on(ChatServerEvent.Room, onRoom);
    socket.on(ChatServerEvent.Typing, onTyping);
    socket.on(ChatServerEvent.Presence, onPresence);
    socket.on(ChatServerEvent.Cue, onCue);
    socket.on(ServerEvent.ConversationUpdated, onConversation);
    socket.on(ServerEvent.ConversationAssigned, onConversation);
    // Back after a drop: the list, the count and any open chat catch up on
    // what was said meanwhile, together.
    const offReconnect = onReconnect(() => {
      refreshLists(qc);
      qc.invalidateQueries({ queryKey: ["chat", "messages"] });
    });
    return () => {
      offReconnect();
      socket.off(ServerEvent.ConversationUpdated, onConversation);
      socket.off(ServerEvent.ConversationAssigned, onConversation);
      socket.off(ChatServerEvent.Message, onMessage);
      socket.off(ChatServerEvent.MessageUpdated, onUpdated);
      socket.off(ChatServerEvent.Receipt, onReceipt);
      socket.off(ChatServerEvent.Room, onRoom);
      socket.off(ChatServerEvent.Typing, onTyping);
      socket.off(ChatServerEvent.Presence, onPresence);
      socket.off(ChatServerEvent.Cue, onCue);
    };
  }, [qc, enabled]);
}
