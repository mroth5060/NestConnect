import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Text, TextInput, View, type ViewToken } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { router, useLocalSearchParams } from "expo-router";
import {
  api,
  chatDayOf,
  chatItems,
  chatLastSeen,
  useChatMessages,
  useChatMutation,
  useChatRoom,
  useChatRoomOpen,
  useChatStars,
  chatNameColour,
  useChatTyping,
  useChatTypingSignal,
  useMarkChatRead,
  useMe,
  usePeople,
  useRetryChatMessage,
  useSendChatMessage,
  type ChatBubble,
  type ChatItem,
} from "@ding/client";
import {
  CHAT_MESSAGE_MAX,
  chatSystemText,
  mentionsToNames,
  namesToHandles,
  type ChatMember,
  type ChatMessage,
  type Mentionable,
} from "@ding/schemas";
import { useStagedAttachments } from "../../../src/attachments";
import { AttachSheet } from "../../../src/components/AttachSheet";
import { BottomInset } from "../../../src/components/BottomInset";
import { HoldMic, HoldOverlay, useHoldToRecord } from "../../../src/components/HoldToRecord";
import { StagedAttachments } from "../../../src/components/StagedAttachments";
import { VoiceRecorder } from "../../../src/components/VoiceRecorder";
import { useVoiceRecording } from "../../../src/voice";
import { ChatAvatar } from "../../../src/components/chat/ChatAvatar";
import { CHAT_FACE, CHAT_TEXT, ChatBubbleRow } from "../../../src/components/chat/ChatBubble";
import { ChatInfoSheet, ChatMessageSheet } from "../../../src/components/chat/ChatSheets";
import { ReactionsSheet } from "../../../src/components/chat/ReactionsSheet";
import { ErrorState, Loading } from "../../../src/components/States";
import { useToast } from "../../../src/components/Toast";
import { Touchable } from "../../../src/components/Touchable";
import { Avatar } from "../../../src/components/Avatar";
import { mediaSource } from "../../../src/api-config";
import { haptics } from "../../../src/haptics";
import { useShrinkWhenEmpty } from "../../../src/shrink-when-empty";
import { AttachIcon, BackIcon, DetailsIcon, EditIcon, ReplyIcon, SendIcon, CheckIcon, XIcon } from "../../../src/icons";
import { useInsets } from "../../../src/insets";
import { useTheme } from "../../../src/theme";

/**
 * One Team Chat chat, open. The list is inverted — newest at the bottom, the
 * way every messaging app reads — so it opens at the latest message and older
 * pages load as you scroll up. See docs/team-chat.md.
 */
export default function ChatScreen() {
  const { id, mid } = useLocalSearchParams<{ id: string; mid?: string }>();
  const { c } = useTheme();
  const insets = useInsets();
  const toast = useToast();
  const me = useMe().data?.user;
  const room = useChatRoom(id);
  const msgs = useChatMessages(id);
  const people = usePeople();
  const typing = useChatTyping(id);
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [editing, setEditing] = useState<ChatMessage | null>(null);
  const [acting, setActing] = useState<ChatBubble | null>(null);
  // Who reacted to a message: its id (read live, so a removal shows) and the emoji tapped.
  const [whoFor, setWhoFor] = useState<{ id: string; emoji: string } | null>(null);
  const [infoFor, setInfoFor] = useState<ChatMessage | null>(null);
  const list = useRef<FlatList<ChatItem<ChatBubble>>>(null);
  const stars = useChatStars();
  useChatRoomOpen(id);

  const r = room.data;
  const mentionables: Mentionable[] = useMemo(() => (people.data ?? []).map((m) => m.user), [people.data]);
  const newest = msgs.messages.at(-1);
  useMarkChatRead(id, newest?.id, !!r?.isMember);

  // Where "unread messages" goes: fixed when the chat opens.
  const [unreadAfter, setUnreadAfter] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (r && unreadAfter === undefined) {
      const mine = r.members.find((m) => m.id === me?.id);
      setUnreadAfter(r.unread > 0 ? (mine?.lastReadAt ?? null) : null);
    }
  }, [r, me?.id, unreadAfter]);

  // Inverted: newest first.
  const items = useMemo(
    () => chatItems<ChatBubble>(msgs.messages, { meId: me?.id, unreadAfter: unreadAfter ?? null }).reverse(),
    [msgs.messages, me?.id, unreadAfter],
  );

  /*
   * The date of the day at the top of the screen, floating there as you scroll
   * — the inbox thread's sticky date, which an inverted list can't do itself
   * (React Native only sticks headers in a list read top-down). It changes as
   * the next day's line reaches the top, so a day's date stays until the next
   * one takes over. Hidden while a day's own line is the top row: that line
   * is already saying it.
   */
  const dayOf = useMemo(() => chatDayOf(items, true), [items]);
  const dayRef = useRef({ items, dayOf });
  dayRef.current = { items, dayOf };
  const [topDay, setTopDay] = useState("");
  const onViewable = useRef(({ viewableItems }: { viewableItems: ViewToken<ChatItem<ChatBubble>>[] }) => {
    // Inverted: the oldest row on screen — the highest index — is the top one.
    let top = -1;
    for (const v of viewableItems) if (v.index != null && v.index > top) top = v.index;
    const { items: rows, dayOf: days } = dayRef.current;
    setTopDay(top < 0 || rows[top]?.kind === "day" ? "" : (days[top] ?? ""));
  }).current;
  const viewability = useRef({ itemVisiblePercentThreshold: 1 }).current;

  const react = useChatMutation(({ mid, emoji }: { mid: string; emoji: string }) => api.reactChatMessage(mid, emoji));
  const remove = useChatMutation((mid: string) => api.deleteChatMessage(mid));
  const mePerson = useMemo(
    () => (me ? { id: me.id, name: me.name, avatarColor: me.avatarColor ?? null, avatarUrl: me.avatarUrl ?? null } : null),
    [me],
  );
  const retry = useRetryChatMessage(id, mePerson);
  const fail = useCallback((e: unknown) => toast({ text: (e as Error).message || "Couldn't do that" }), [toast]);

  const goTo = useCallback(
    (mid: string) => {
      const index = items.findIndex((it) => it.kind === "message" && it.message.id === mid);
      if (index < 0) return toast({ text: "That message is further back — scroll up to load it" });
      list.current?.scrollToIndex({ index, viewPosition: 0.5, animated: true });
    },
    [items, toast],
  );

  // Opened from search or starred: load back until the message is there, then show it.
  const sought = useRef<string | null>(null);
  useEffect(() => {
    if (!mid || sought.current === mid || msgs.isLoading) return;
    const index = items.findIndex((it) => it.kind === "message" && it.message.id === mid);
    if (index >= 0) {
      sought.current = mid;
      setTimeout(() => list.current?.scrollToIndex({ index, viewPosition: 0.5, animated: true }), 250);
    } else if (msgs.hasNextPage && !msgs.isFetchingNextPage) {
      void msgs.fetchNextPage();
    } else if (!msgs.hasNextPage) {
      sought.current = mid;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mid, items, msgs.hasNextPage, msgs.isFetchingNextPage, msgs.isLoading]);

  if (room.isError) {
    return (
      <View style={{ flex: 1, backgroundColor: c.bg, paddingTop: insets.top }}>
        <ErrorState error={room.error} what="this chat" onRetry={() => router.back()} />
      </View>
    );
  }
  if (!r) {
    return (
      <View style={{ flex: 1, backgroundColor: c.bg, paddingTop: insets.top }} className="items-center justify-center">
        <Loading />
      </View>
    );
  }

  // Who's here, and nothing about typing: as WhatsApp now does, that shows in
  // the conversation, where it's going to land, with the face and name of
  // whoever it is — not in the header, swapping out "online" while they type.
  const subline = r.kind === "direct" ? chatLastSeen(r.other) : membersLine(r.members, me?.id);
  const group = r.kind !== "direct" || r.oversight;
  // Moderating is for chats you're in: an admin reading one they aren't in can't delete there.
  const moderator = r.isMember && (me?.role === "admin" || r.canManage);

  return (
    <View style={{ flex: 1, backgroundColor: c.surface2 }}>
      <View style={{ borderBottomColor: c.border, backgroundColor: c.surface, paddingTop: insets.top }} className="flex-row items-center gap-2.5 border-b px-2 pb-2 pt-2">
        <Touchable feel="chip" onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back to chats" hitSlop={12} className="px-1">
          <BackIcon size={24} color={c.brand} />
        </Touchable>
        <Touchable
          feel="chip"
          onPress={() => router.push({ pathname: "/(app)/chat/info", params: { id: r.id } })}
          accessibilityRole="button"
          accessibilityLabel={`${r.name}, chat info`}
          className="flex-1 flex-row items-center gap-2.5"
        >
          <ChatAvatar room={r} size={40} />
          <View className="flex-1">
            <Text numberOfLines={1} style={{ fontSize: 17, lineHeight: 22 }} className="font-semibold text-fg">
              {r.name}
            </Text>
            <Text numberOfLines={1} className="text-sm leading-snug text-faint">
              {subline}
            </Text>
          </View>
        </Touchable>
        <Touchable
          feel="chip"
          borderless
          onPress={() => router.push({ pathname: "/(app)/chat/info", params: { id: r.id } })}
          accessibilityRole="button"
          accessibilityLabel={r.kind === "direct" ? "Contact info" : "Group info"}
          hitSlop={10}
          className="h-10 w-10 items-center justify-center"
        >
          <DetailsIcon size={20} color={c.textMuted} />
        </Touchable>
      </View>

      <View style={{ flex: 1 }}>
      <FlatList
        ref={list}
        inverted
        style={{ flex: 1 }}
        data={items}
        onViewableItemsChanged={onViewable}
        viewabilityConfig={viewability}
        keyExtractor={(it) => it.key}
        contentContainerStyle={{ paddingHorizontal: 10, paddingVertical: 10 }}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        onEndReached={() => {
          if (msgs.hasNextPage && !msgs.isFetchingNextPage) void msgs.fetchNextPage();
        }}
        onEndReachedThreshold={0.4}
        onScrollToIndexFailed={() => toast({ text: "Scroll up a little to find that message" })}
        initialNumToRender={20}
        renderItem={({ item }) => {
          if (item.kind === "day") {
            return (
              <View className="items-center py-2">
                <Text style={{ backgroundColor: c.surface, color: c.textMuted }} className="overflow-hidden rounded-8 px-3 py-1 text-2xs font-semibold">
                  {item.label}
                </Text>
              </View>
            );
          }
          if (item.kind === "unread") {
            return (
              <View style={{ backgroundColor: c.surface }} className="my-2 items-center py-1">
                <Text style={{ color: c.wa }} className="text-2xs font-bold uppercase tracking-wide">
                  {item.count} unread message{item.count === 1 ? "" : "s"}
                </Text>
              </View>
            );
          }
          const m = item.message;
          if (m.kind === "system") {
            return (
              <View className="items-center py-1">
                <Text style={{ backgroundColor: c.surface, color: c.textMuted }} className="overflow-hidden rounded-8 px-3 py-1 text-center text-2xs">
                  {m.system ? chatSystemText(m.system) : ""}
                </Text>
              </View>
            );
          }
          return (
            <ChatBubbleRow
              m={m}
              first={item.first}
              last={item.last}
              mine={m.author?.id === me?.id}
              meId={me?.id}
              // An admin or manager who stepped into a direct chat is named, not taken for the other person.
              group={group || !r.members.some((p) => p.id === m.author?.id)}
              members={r.members}
              people={mentionables}
              canAct={r.canPost}
              onReply={(x) => {
                setEditing(null);
                setReplyTo(x);
              }}
              onLongPress={setActing}
              onReact={(x, emoji) => react.mutate({ mid: x.id, emoji }, { onError: fail })}
              onShowReactions={(x, emoji) => setWhoFor({ id: x.id, emoji })}
              onQuote={goTo}
              onRetry={(x) => void retry(x)}
              starred={stars.ids.has(m.id)}
            />
          );
        }}
        ListHeaderComponent={typing.length ? <Typing names={typing} members={r.members} group={r.kind !== "direct"} /> : null}
        ListFooterComponent={
          msgs.isFetchingNextPage ? (
            <Text className="py-3 text-center text-2xs text-muted">Loading earlier messages…</Text>
          ) : !msgs.hasNextPage && !msgs.isLoading ? (
            <View className="items-center py-3">
              <Text style={{ backgroundColor: c.amberTint, color: c.textMuted }} className="overflow-hidden rounded-8 px-3 py-1.5 text-center text-2xs">
                {r.kind === "direct"
                  ? r.oversight
                    ? `This is the start of the chat between ${r.name.replace(" & ", " and ")}.`
                    : `This is the start of your chat with ${r.name}.`
                  : r.kind === "team"
                    ? `Everyone on ${r.name} is in this chat.`
                    : `Messages in ${r.name} are visible to its members.`}
              </Text>
            </View>
          ) : null
        }
      />
      {topDay ? (
        <View pointerEvents="none" style={{ position: "absolute", top: 8, left: 0, right: 0 }} className="items-center">
          <Text style={{ backgroundColor: c.surface, color: c.textMuted }} className="overflow-hidden rounded-8 px-3 py-1 text-2xs font-semibold">
            {topDay}
          </Text>
        </View>
      ) : null}
      </View>

      <KeyboardAvoidingView behavior="padding" keyboardVerticalOffset={0}>
        {r.canPost ? (
          <Composer
            roomId={r.id}
            members={r.members}
            meId={me?.id}
            people={mentionables}
            replyTo={replyTo}
            editing={editing}
            onCancelReply={() => setReplyTo(null)}
            onCancelEdit={() => setEditing(null)}
            onError={fail}
          />
        ) : r.oversight ? null : (
          // An admin reading a chat they aren't in sees no box and no notice.
          <View style={{ backgroundColor: c.surface, borderTopColor: c.border }} className="border-t px-4 py-3">
            <Text className="text-center text-md text-muted">
              {r.kind === "direct" ? "They're no longer in this workspace." : "You can't send messages here."}
            </Text>
          </View>
        )}
        <BottomInset />
      </KeyboardAvoidingView>

      <ReactionsSheet
        reactions={whoFor ? (msgs.messages.find((x) => x.id === whoFor.id)?.reactions ?? null) : null}
        initial={whoFor?.emoji ?? null}
        people={[...r.members, ...mentionables.map((p) => ({ ...p, id: (p as Mentionable & { id?: string }).id ?? "" }))]}
        meId={me?.id}
        canRemove={r.canPost}
        onRemove={(emoji) => {
          if (whoFor) react.mutate({ mid: whoFor.id, emoji }, { onError: fail });
          setWhoFor(null);
        }}
        onClose={() => setWhoFor(null)}
      />
      <ChatMessageSheet
        message={acting}
        meId={me?.id}
        mine={acting?.author?.id === me?.id}
        canAct={r.canPost}
        canDelete={!!acting && (acting.author?.id === me?.id || moderator)}
        onClose={() => setActing(null)}
        onReact={(emoji) => acting && react.mutate({ mid: acting.id, emoji }, { onError: fail })}
        onReply={() => {
          setEditing(null);
          setReplyTo(acting);
        }}
        onEdit={() => {
          setReplyTo(null);
          setEditing(acting);
        }}
        onInfo={() => setInfoFor(acting)}
        onDelete={() => acting && remove.mutate(acting.id, { onSuccess: () => haptics.success(), onError: fail })}
        starred={!!acting && stars.ids.has(acting.id)}
        onStar={(on) => {
          if (!acting) return;
          haptics.select();
          void stars.toggle(acting, on).catch(fail);
        }}
      />
      <ChatInfoSheet message={infoFor} onClose={() => setInfoFor(null)} />
    </View>
  );
}

function membersLine(members: ChatMember[], meId: string | undefined): string {
  const others = members.filter((m) => m.id !== meId).map((m) => m.name.split(" ")[0]!);
  const online = members.filter((m) => m.id !== meId && m.online).length;
  const names = [...others.slice(0, 5), ...(members.some((m) => m.id === meId) ? ["You"] : [])].join(", ");
  return `${names}${others.length > 5 ? ` +${others.length - 5}` : ""}${online ? ` · ${online} online` : ""}`;
}

/**
 * Someone typing, where their message is about to land — WhatsApp's way now.
 * In a group it reads as one of their messages would: their face beside it and
 * their name on it, so it says who as well as that. In a direct chat the dots
 * are enough; there's only one person it can be.
 */
function Typing({ names, members, group }: { names: string[]; members: ChatMember[]; group: boolean }) {
  const { c } = useTheme();
  return (
    <View className="mt-2 gap-1.5">
      {(group ? names.slice(0, 3) : names.slice(0, 1)).map((name) => {
        const who = members.find((m) => m.name === name);
        return (
          <View key={name} accessibilityLabel={`${name} is typing`} className="flex-row items-end">
            {group ? (
              <View style={{ width: CHAT_FACE + 2, marginRight: 6 }}>
                <Avatar name={name} color={who?.avatarColor} size={CHAT_FACE} photo={who?.avatarUrl ? mediaSource(who.avatarUrl) : null} />
              </View>
            ) : null}
            <View style={{ backgroundColor: c.surface, borderRadius: 14, borderBottomLeftRadius: 4 }} className="px-3 py-2">
              {group ? (
                <Text style={{ color: chatNameColour(who?.id) }} className="mb-1 text-md font-semibold">
                  {name}
                </Text>
              ) : null}
              <View style={{ height: CHAT_TEXT.lineHeight }} className="flex-row items-center gap-1">
                {[0, 1, 2].map((i) => (
                  <View key={i} style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: c.textFaint, opacity: 0.4 + i * 0.2 }} />
                ))}
              </View>
            </View>
          </View>
        );
      })}
    </View>
  );
}

/**
 * Write, reply, edit. Return sends on a hardware keyboard; on a phone the
 * green button does. `@` suggests the people in this chat.
 */
function Composer({
  roomId,
  members,
  meId,
  people,
  replyTo,
  editing,
  onCancelReply,
  onCancelEdit,
  onError,
}: {
  roomId: string;
  members: ChatMember[];
  meId: string | undefined;
  people: Mentionable[];
  replyTo: ChatMessage | null;
  editing: ChatMessage | null;
  onCancelReply: () => void;
  onCancelEdit: () => void;
  onError: (e: unknown) => void;
}) {
  const { c } = useTheme();
  const me = members.find((m) => m.id === meId);
  const send = useSendChatMessage(roomId, me ? { id: me.id, name: me.name, avatarColor: me.avatarColor, avatarUrl: me.avatarUrl } : null);
  const edit = useChatMutation(({ mid, body }: { mid: string; body: string }) => api.editChatMessage(mid, body));
  const { typed, stop } = useChatTypingSignal(roomId);
  const [text, setText] = useState("");
  // Back to one line once sent (see shrink-when-empty).
  const textBox = useShrinkWhenEmpty(text);
  const [draft, setDraft] = useState("");
  const [caret, setCaret] = useState(0);
  const input = useRef<TextInput>(null);
  const files = useStagedAttachments();
  const [attachSheet, setAttachSheet] = useState(false);
  // The inbox composer's recorder: hold the microphone to record, let go to
  // send, slide left to cancel, slide up to lock it hands-free.
  const voice = useVoiceRecording();
  const [locked, setLocked] = useState(false);
  const [sendingVoice, setSendingVoice] = useState(false);
  const hold = useHoldToRecord({ voice, onSend: () => void finishVoice(), onLock: () => setLocked(true) });

  async function finishVoice() {
    setLocked(false);
    const v = await voice.stop();
    if (!v) return;
    setSendingVoice(true);
    const name = `voice-${Date.now()}.m4a`;
    try {
      const attachment = await api.uploadMedia({ uri: v.uri, name, type: "audio/mp4" }, { kind: "voice", durationMs: v.durationMs, filename: name });
      const quoting = replyTo;
      onCancelReply();
      await send("", quoting, [attachment]);
      haptics.success();
    } catch (err) {
      onError(err);
    } finally {
      setSendingVoice(false);
    }
  }

  useEffect(() => {
    if (editing) {
      setDraft(text);
      setText(mentionsToNames(editing.body, people));
      input.current?.focus();
    }
    // Only when an edit starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);
  useEffect(() => {
    if (replyTo) input.current?.focus();
  }, [replyTo]);

  const inRoom = useMemo(() => {
    const ids = new Set(members.filter((m) => m.id !== meId).map((m) => m.id));
    return people.filter((p) => ids.has((p as Mentionable & { id?: string }).id ?? ""));
  }, [people, members, meId]);
  const before = text.slice(0, caret);
  const at = /(^|\s)@([^\s@]{0,24})$/.exec(before);
  const matches = at
    ? inRoom.filter((p) => p.name.toLowerCase().startsWith(at[2]!.toLowerCase()) || p.name.toLowerCase().includes(` ${at[2]!.toLowerCase()}`)).slice(0, 5)
    : [];

  const pick = (p: Mentionable) => {
    if (!at) return;
    const start = caret - at[2]!.length - 1;
    const next = `${text.slice(0, start)}@${p.name} ${text.slice(caret)}`;
    setText(next);
    setCaret(start + p.name.length + 2);
  };

  const ready = files.staged.filter((f) => f.status === "done" && f.attachment).map((f) => f.attachment!);
  const submit = () => {
    const body = namesToHandles(text.trim(), people);
    if (!editing && files.uploading) return onError(new Error("Still uploading — one moment"));
    if (!body && (editing || !ready.length)) return;
    stop();
    haptics.tap();
    if (editing) {
      if (body !== editing.body) edit.mutate({ mid: editing.id, body }, { onError });
      setText(draft);
      onCancelEdit();
      return;
    }
    setText("");
    const quoting = replyTo;
    onCancelReply();
    files.clear();
    void send(body, quoting, ready);
  };
  const empty = !text.trim() && !files.staged.length && !editing;

  return (
    <View style={{ backgroundColor: c.surface, borderTopColor: c.border }} className="border-t px-2 pb-2 pt-2">
      {matches.length ? (
        <View style={{ backgroundColor: c.elevated, borderColor: c.border }} className="mb-2 rounded-12 border py-1">
          {matches.map((p) => (
            <Touchable key={p.email} feel="row" onPress={() => pick(p)} accessibilityRole="button" accessibilityLabel={`Mention ${p.name}`} className="flex-row items-center gap-2.5 px-3 py-2">
              <Avatar name={p.name} size={26} photo={p.avatarUrl ? mediaSource(p.avatarUrl) : null} />
              <Text className="text-md font-medium text-fg">{p.name}</Text>
            </Touchable>
          ))}
        </View>
      ) : null}
      {replyTo || editing ? (
        <View style={{ backgroundColor: c.surface2, borderLeftColor: c.wa }} className="mx-1 mb-2 flex-row items-center gap-2 rounded-8 border-l-4 py-1.5 pl-3 pr-1">
          {editing ? <EditIcon size={16} color={c.wa} /> : <ReplyIcon size={16} color={c.wa} />}
          <View className="flex-1">
            <Text style={{ color: c.wa }} className="text-sm font-semibold">
              {editing ? "Edit message" : replyTo?.author?.id === meId ? "Replying to yourself" : `Replying to ${replyTo?.author?.name ?? ""}`}
            </Text>
            <Text numberOfLines={1} className="text-sm text-muted">
              {mentionsToNames((editing ?? replyTo)!.body, people)}
            </Text>
          </View>
          <Touchable
            feel="chip"
            borderless
            onPress={() => {
              if (editing) {
                setText(draft);
                onCancelEdit();
              } else onCancelReply();
            }}
            accessibilityRole="button"
            accessibilityLabel={editing ? "Cancel editing" : "Cancel reply"}
            hitSlop={8}
            className="h-8 w-8 items-center justify-center"
          >
            <XIcon size={16} color={c.textMuted} />
          </Touchable>
        </View>
      ) : null}
      {!editing ? <StagedAttachments items={files.staged} onRemove={files.remove} onRetry={files.retry} /> : null}
      {locked ? (
        <VoiceRecorder
          voice={voice}
          onSend={() => void finishVoice()}
          onCancel={() => {
            setLocked(false);
            void voice.cancel();
          }}
        />
      ) : sendingVoice ? (
        <View style={{ backgroundColor: c.surface2 }} className="flex-row items-center gap-3 rounded-24 px-4 py-3" accessibilityLabel="Sending voice message">
          <ActivityIndicator size="small" color={c.wa} />
          <Text className="flex-1 text-md text-muted">Sending your voice note…</Text>
        </View>
      ) : (
      <View>
      <View className="flex-row items-end gap-2">
        <View
          style={{ backgroundColor: c.surface2, opacity: hold.holding ? 0 : 1 }}
          pointerEvents={hold.holding ? "none" : "auto"}
          className="flex-1 flex-row items-end rounded-[22px] pl-1 pr-4"
        >
          {!editing ? (
            <Touchable
              feel="chip"
              borderless
              onPress={() => setAttachSheet(true)}
              accessibilityRole="button"
              accessibilityLabel="Attach"
              hitSlop={6}
              className="h-11 w-10 items-center justify-center"
            >
              <AttachIcon size={20} color={c.textMuted} />
            </Touchable>
          ) : (
            <View className="w-3" />
          )}
          <TextInput
            ref={input}
            value={text}
            onChangeText={(v) => {
              setText(v.slice(0, CHAT_MESSAGE_MAX));
              if (!editing) typed();
            }}
            onSelectionChange={(e) => setCaret(e.nativeEvent.selection.end)}
            selection={undefined}
            placeholder={editing ? "Edit your message" : "Message"}
            placeholderTextColor={c.textFaint}
            multiline
            accessibilityLabel="Message"
            onLayout={textBox.onLayout}
            style={[{ color: c.text, maxHeight: 140, fontSize: 17 }, textBox.height]}
            className="flex-1 py-2.5"
          />
        </View>
        {empty ? (
          // Nothing to send: the button records, as WhatsApp's does.
          <HoldMic hold={hold} />
        ) : (
          <Touchable
            feel="chip"
            borderless
            disabled={editing ? !text.trim() : files.uploading || (!text.trim() && !ready.length)}
            onPress={submit}
            accessibilityRole="button"
            accessibilityLabel={editing ? "Save" : "Send"}
            style={{ backgroundColor: c.wa, opacity: (editing ? text.trim() : !files.uploading && (text.trim() || ready.length)) ? 1 : 0.5 }}
            className="h-11 w-11 items-center justify-center rounded-full"
          >
            {editing ? <CheckIcon size={20} color="#fff" /> : <SendIcon size={19} color="#fff" />}
          </Touchable>
        )}
      </View>
      {empty ? <HoldOverlay hold={hold} voice={voice} /> : null}
      </View>
      )}
      <AttachSheet
        visible={attachSheet}
        onClose={() => setAttachSheet(false)}
        onCamera={() => void files.takePhoto()}
        onPhotos={() => void files.pickImages()}
        onFiles={() => void files.pickFiles()}
      />
    </View>
  );
}
