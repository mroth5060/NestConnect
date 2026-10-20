import { useMemo, useState } from "react";
import { ActivityIndicator, FlatList, ScrollView, Text, TextInput, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import {
  api,
  chatNameColour,
  clockTime,
  useChatDiscussions,
  useChatRoom,
  useChatRooms,
  useChatStatus,
  useChatThread,
  useMe,
  usePeople,
  useShareConversation,
} from "@ding/client";
import { CHAT_MESSAGE_MAX, mentionsToNames, namesToHandles, type ChatSharedConversation, type Mentionable } from "@ding/schemas";
import { haptics } from "../../haptics";
import { useShrinkWhenEmpty } from "../../shrink-when-empty";
import { CheckIcon, SearchIcon, SendIcon, TeamChatIcon, channelColor, channelMeta } from "../../icons";
import { useTheme } from "../../theme";
import { ActionSheet, type SheetAction } from "../ActionSheet";
import { Avatar } from "../Avatar";
import { Button } from "../Button";
import { Sheet } from "../Sheet";
import { Touchable } from "../Touchable";
import { mediaSource } from "../../api-config";
import { ChatAvatar } from "./ChatAvatar";

/*
 * A customer conversation, discussed in Team Chat — the app's half: the card
 * in a chat, picking where to send it, the bar on the thread, and the
 * discussion in a sheet. The same rules as the web's chat/Discuss.tsx; see
 * docs/team-chat.md.
 */

const STATUS: Record<string, string> = { open: "Open", pending: "Pending", snoozed: "Snoozed", closed: "Resolved" };

/** The card a shared customer conversation makes. Its status and owner follow the conversation live. */
export function SharedCard({ shared, onOpen }: { shared: ChatSharedConversation; onOpen?: () => void }) {
  const { c } = useTheme();
  const gone = shared.status === null;
  const ch = channelMeta(shared.channel);
  const tone = shared.status === "closed" ? c.textMuted : shared.status === "open" ? c.wa : c.amber;
  const inner = (
    <View style={{ borderLeftColor: c.wa, backgroundColor: "rgba(0,0,0,0.04)" }} className="gap-1.5 rounded-8 border-l-4 px-2.5 py-2">
      <View className="flex-row items-center gap-2">
        <Avatar name={shared.contactName} color={shared.contactAvatarColor} size={28} />
        <View className="min-w-0 flex-1">
          <Text numberOfLines={1} className="text-md font-semibold text-fg">
            {shared.contactName}
          </Text>
          <Text numberOfLines={1} style={{ color: channelColor(shared.channel, c) }} className="text-2xs font-semibold">
            {ch.label}
            {shared.subject ? <Text style={{ color: c.textMuted }}>{` · ${shared.subject}`}</Text> : null}
          </Text>
        </View>
      </View>
      {shared.quote ? (
        <View style={{ backgroundColor: shared.quote.internal ? c.amberTint : c.surface }} className="rounded-8 px-2 py-1.5">
          <Text className="text-2xs font-semibold text-muted">{shared.quote.internal ? `Note · ${shared.quote.authorName}` : shared.quote.authorName}</Text>
          <Text numberOfLines={3} className="text-sm text-fg">
            {shared.quote.body}
          </Text>
        </View>
      ) : null}
      <View className="flex-row items-center gap-2">
        {gone ? (
          <Text className="text-2xs italic text-muted">This conversation was deleted</Text>
        ) : (
          <>
            <Text style={{ color: tone }} className="text-2xs font-bold">
              {shared.status === "closed" ? "✓ " : ""}
              {STATUS[shared.status!] ?? shared.status}
            </Text>
            <Text numberOfLines={1} className="flex-1 text-2xs text-muted">
              {shared.assigneeName ? `Assigned to ${shared.assigneeName}` : "Unassigned"}
            </Text>
          </>
        )}
      </View>
    </View>
  );
  if (!onOpen || gone) return inner;
  return (
    <Touchable feel="chip" onPress={onOpen} accessibilityRole="button" accessibilityLabel={`${shared.contactName}, open the conversation`}>
      {inner}
    </Touchable>
  );
}

/** Pick a chat and send a customer conversation (or one message from it) there to discuss. */
export function ShareSheet({
  visible,
  conversationId,
  contactName,
  message,
  onClose,
  onDone,
}: {
  visible: boolean;
  conversationId: string;
  contactName: string;
  message?: { id: string; who: string; text: string } | null;
  onClose: () => void;
  onDone: (text: string) => void;
}) {
  const { c } = useTheme();
  const rooms = useChatRooms(false, visible);
  const share = useShareConversation();
  const [q, setQ] = useState("");
  const [roomId, setRoomId] = useState<string | null>(null);
  const [line, setLine] = useState("");
  const [error, setError] = useState<string | null>(null);
  const writable = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (rooms.data ?? []).filter((r) => r.isMember && !r.archived && (!term || r.name.toLowerCase().includes(term)));
  }, [rooms.data, q]);
  const room = (rooms.data ?? []).find((r) => r.id === roomId);

  const close = () => {
    setRoomId(null);
    setLine("");
    setQ("");
    setError(null);
    onClose();
  };
  const send = () => {
    if (!roomId) return;
    share.mutate(
      { roomId, conversationId, messageId: message?.id ?? null, body: line.trim() },
      {
        onSuccess: () => {
          haptics.success();
          onDone(`Shared with ${room?.name ?? "the chat"}`);
          close();
        },
        onError: (e) => setError((e as Error).message || "Couldn't share it"),
      },
    );
  };

  return (
    <Sheet visible={visible} onClose={close} closeLabel="Cancel">
      <Text className="text-2xs font-semibold uppercase tracking-wide text-faint">Discuss with the team</Text>
      <Text numberOfLines={2} className="pb-3 pt-0.5 text-md text-muted">
        {contactName}
        {message ? ` — ${message.who}: “${message.text}”` : " — the whole conversation"}
      </Text>
      <View style={{ backgroundColor: c.surface2 }} className="flex-row items-center gap-2 rounded-full px-3.5">
        <SearchIcon size={17} color={c.textFaint} />
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder="Search chats"
          placeholderTextColor={c.textFaint}
          autoCorrect={false}
          accessibilityLabel="Search chats"
          style={{ color: c.text }}
          className="flex-1 py-2.5 text-lg"
        />
      </View>
      <View className="mt-2 h-[220px]">
        <FlatList
          data={writable}
          keyExtractor={(r) => r.id}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => {
            const on = item.id === roomId;
            return (
              <Touchable
                feel="row"
                onPress={() => setRoomId(item.id)}
                accessibilityRole="radio"
                accessibilityState={{ selected: on }}
                accessibilityLabel={item.name}
                className="flex-row items-center gap-3 py-2"
              >
                <ChatAvatar room={item} size={38} />
                <View className="flex-1">
                  <Text numberOfLines={1} className="text-lg font-medium text-fg">
                    {item.name}
                  </Text>
                  <Text className="text-sm text-muted">{item.kind === "team" ? "Team chat" : item.kind === "group" ? `${item.memberCount} people` : "Direct message"}</Text>
                </View>
                <View
                  style={{ backgroundColor: on ? c.wa : "transparent", borderColor: on ? c.wa : c.borderStrong }}
                  className="h-6 w-6 items-center justify-center rounded-full border"
                >
                  {on ? <CheckIcon size={14} color="#fff" /> : null}
                </View>
              </Touchable>
            );
          }}
          ListEmptyComponent={
            rooms.isLoading ? <ActivityIndicator color={c.brand} className="py-8" /> : <Text className="py-8 text-center text-md text-muted">No chats match.</Text>
          }
        />
      </View>
      <TextInput
        value={line}
        onChangeText={(v) => setLine(v.slice(0, CHAT_MESSAGE_MAX))}
        placeholder="Add a message — can someone check stock?"
        placeholderTextColor={c.textFaint}
        multiline
        accessibilityLabel="Add a message"
        style={{ color: c.text, backgroundColor: c.surface2, maxHeight: 96 }}
        className="mt-2 rounded-12 px-3.5 py-2.5 text-md"
      />
      {error ? <Text style={{ color: c.danger }} className="pt-2 text-sm">{error}</Text> : null}
      <View className="pt-3">
        <Button title={room ? `Send to ${room.name}` : "Pick a chat"} disabled={!roomId} busy={share.isPending} onPress={send} />
      </View>
    </Sheet>
  );
}

/** On the thread: where this conversation is being discussed. Nothing when it isn't, or Team Chat is off. */
export function DiscussionBar({ conversationId, onOpen }: { conversationId: string; onOpen: (cardId: string) => void }) {
  const { c } = useTheme();
  const status = useChatStatus();
  const found = useChatDiscussions(conversationId, !!status.data?.enabled);
  const people = usePeople();
  const list = found.data ?? [];
  if (!list.length) return null;
  const first = list[0]!;
  const mentionables = (people.data ?? []).map((m) => m.user);
  const latest = first.latest;
  const line = latest
    ? `${latest.author?.name.split(" ")[0] ?? "Someone"}: ${mentionsToNames(latest.body, mentionables) || "📎"}`
    : `${first.card.author?.name.split(" ")[0] ?? "Someone"} shared it${first.card.body ? `: ${mentionsToNames(first.card.body, mentionables)}` : ""}`;
  return (
    <Touchable
      feel="row"
      onPress={() => onOpen(first.card.id)}
      accessibilityRole="button"
      accessibilityLabel={`Discussed in ${first.roomName}${first.replies ? `, ${first.replies} replies` : ""}`}
      style={{ backgroundColor: c.surface, borderBottomColor: c.border }}
      className="flex-row items-center gap-2.5 border-b px-4 py-2"
    >
      <TeamChatIcon size={18} color={c.wa} />
      <View className="min-w-0 flex-1">
        <Text numberOfLines={1} className="text-xs text-muted">
          Discussed in <Text className="font-semibold text-fg">{first.roomName}</Text>
          {first.replies ? ` · ${first.replies} ${first.replies === 1 ? "reply" : "replies"}` : ""}
          {list.length > 1 ? ` · +${list.length - 1} more` : ""}
        </Text>
        <Text numberOfLines={1} className="text-sm text-fg">
          {line}
        </Text>
      </View>
    </Touchable>
  );
}

/** One discussion, in a sheet over the thread: the card, the replies, and a box to answer in. */
export function DiscussionSheet({
  conversationId,
  cardId,
  onClose,
  onOpenChat,
}: {
  conversationId: string;
  cardId: string | null;
  onClose: () => void;
  onOpenChat: (roomId: string) => void;
}) {
  const { c } = useTheme();
  const qc = useQueryClient();
  const all = useChatDiscussions(conversationId, !!cardId);
  const t = useChatThread(cardId);
  const people = usePeople();
  const mentionables: Mentionable[] = useMemo(() => (people.data ?? []).map((m) => m.user), [people.data]);
  const [text, setText] = useState("");
  // Back to one line once sent (see shrink-when-empty).
  const replyBox = useShrinkWhenEmpty(text);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [current, setCurrent] = useState<string | null>(null);
  const shownId = current ?? cardId;
  const shown = useChatThread(shownId !== cardId ? shownId : null);
  const d = shownId !== cardId ? shown.data : t.data;
  const others = (all.data ?? []).filter((x) => x.card.id !== shownId);

  // @-mentions, as in the chat itself: only people in that chat, never yourself.
  const room = useChatRoom(d?.roomId);
  const me = useMe();
  const [caret, setCaret] = useState(0);
  const inRoom = useMemo(() => {
    const members = room.data?.members;
    const ids = members ? new Set(members.map((m) => m.id)) : null;
    return mentionables.filter((p) => {
      const id = (p as Mentionable & { id?: string }).id ?? "";
      return id !== me.data?.user.id && (!ids || ids.has(id));
    });
  }, [mentionables, room.data?.members, me.data?.user.id]);
  const at = /(^|\s)@([^\s@]{0,24})$/.exec(text.slice(0, caret));
  const matches = at
    ? inRoom.filter((p) => p.name.toLowerCase().startsWith(at[2]!.toLowerCase()) || p.name.toLowerCase().includes(` ${at[2]!.toLowerCase()}`)).slice(0, 5)
    : [];
  const pick = (p: Mentionable) => {
    if (!at) return;
    const start = caret - at[2]!.length - 1;
    setText(`${text.slice(0, start)}@${p.name} ${text.slice(caret)}`);
    setCaret(start + p.name.length + 2);
  };

  const send = async () => {
    const body = namesToHandles(text.trim(), mentionables);
    if (!d || !body || busy) return;
    setBusy(true);
    try {
      await api.sendChatMessage(d.roomId, { body, replyToId: d.card.id, clientId: null, attachments: [] });
      setText("");
      haptics.success();
      qc.invalidateQueries({ queryKey: ["chat", "thread", d.card.id] });
      qc.invalidateQueries({ queryKey: ["chat", "discussions"] });
    } catch {
      haptics.error();
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    setCurrent(null);
    setText("");
    onClose();
  };
  const switchActions: SheetAction[] = others.map((x) => ({
    key: x.card.id,
    label: x.roomName,
    detail: x.replies ? `${x.replies} ${x.replies === 1 ? "reply" : "replies"}` : "No replies yet",
    onPress: () => setCurrent(x.card.id),
  }));

  return (
    <Sheet visible={!!cardId} onClose={close} closeLabel="Close discussion">
      <View style={{ flexShrink: 1 }}>
        <View className="flex-row items-center gap-2 pb-2">
          <TeamChatIcon size={18} color={c.wa} />
          <View className="flex-1">
            <Text className="text-2xs text-muted">Discussion</Text>
            <Text numberOfLines={1} className="text-lg font-semibold text-fg">
              {d?.roomName ?? "…"}
            </Text>
          </View>
          {others.length ? (
            <Touchable feel="chip" onPress={() => setPicking(true)} accessibilityRole="button" style={{ backgroundColor: c.surface2 }} className="rounded-full px-3 py-1.5">
              <Text className="text-sm font-medium text-muted">+{others.length} more</Text>
            </Touchable>
          ) : null}
          {d ? (
            <Touchable
              feel="chip"
              onPress={() => {
                close();
                onOpenChat(d.roomId);
              }}
              accessibilityRole="button"
              style={{ backgroundColor: c.surface2 }}
              className="rounded-full px-3 py-1.5"
            >
              <Text className="text-sm font-medium text-fg">Open chat</Text>
            </Touchable>
          ) : null}
        </View>
        <ScrollView style={{ flexShrink: 1, maxHeight: 420 }} keyboardShouldPersistTaps="handled">
          {!d ? (
            <ActivityIndicator color={c.brand} className="py-8" />
          ) : (
            <View className="gap-2 pb-2">
              <Text className="text-2xs text-faint">
                {d.card.author?.name ?? "Someone"} shared it · {clockTime(d.card.createdAt)}
              </Text>
              {d.card.shared ? <SharedCard shared={d.card.shared} /> : null}
              {d.card.body ? <Text className="text-md text-fg">{mentionsToNames(d.card.body, mentionables)}</Text> : null}
              {d.replies.map((r) => (
                <View key={r.id} style={{ backgroundColor: c.surface2 }} className="rounded-12 px-3 py-2">
                  <View className="flex-row items-baseline gap-2">
                    <Text style={{ color: chatNameColour(r.author?.id) }} className="text-sm font-semibold">
                      {r.author?.name ?? "Former teammate"}
                    </Text>
                    <Text className="text-2xs text-faint">{clockTime(r.createdAt)}</Text>
                  </View>
                  <Text style={r.deletedAt ? { fontStyle: "italic", color: c.textMuted } : undefined} className="text-md text-fg">
                    {r.deletedAt ? "This message was deleted" : mentionsToNames(r.body, mentionables) || (r.attachments.length ? "📎 Attachment" : "")}
                  </Text>
                </View>
              ))}
              {!d.replies.length ? <Text className="py-2 text-center text-sm text-faint">No replies yet.</Text> : null}
            </View>
          )}
        </ScrollView>
        {d?.canPost && matches.length ? (
          <View style={{ backgroundColor: c.elevated, borderColor: c.border }} className="mt-2 rounded-12 border py-1">
            {matches.map((p) => (
              <Touchable key={p.email} feel="row" onPress={() => pick(p)} accessibilityRole="button" accessibilityLabel={`Mention ${p.name}`} className="flex-row items-center gap-2.5 px-3 py-2">
                <Avatar name={p.name} size={26} photo={p.avatarUrl ? mediaSource(p.avatarUrl) : null} />
                <Text className="text-md font-medium text-fg">{p.name}</Text>
              </Touchable>
            ))}
          </View>
        ) : null}
        {d?.canPost ? (
          <View className="flex-row items-end gap-2 pt-2">
            <TextInput
              value={text}
              onChangeText={(v) => setText(v.slice(0, CHAT_MESSAGE_MAX))}
              onSelectionChange={(e) => setCaret(e.nativeEvent.selection.end)}
              placeholder={`Reply in ${d.roomName}`}
              placeholderTextColor={c.textFaint}
              multiline
              accessibilityLabel="Reply in the discussion"
              onLayout={replyBox.onLayout}
              style={[{ color: c.text, backgroundColor: c.surface2, maxHeight: 110 }, replyBox.height]}
              className="flex-1 rounded-[22px] px-4 py-2.5 text-lg"
            />
            <Touchable
              feel="chip"
              borderless
              disabled={!text.trim() || busy}
              onPress={() => void send()}
              accessibilityRole="button"
              accessibilityLabel="Send"
              style={{ backgroundColor: c.wa, opacity: text.trim() && !busy ? 1 : 0.5 }}
              className="h-11 w-11 items-center justify-center rounded-full"
            >
              <SendIcon size={19} color="#fff" />
            </Touchable>
          </View>
        ) : null}
      </View>
      <ActionSheet visible={picking} title="Also discussed in" actions={switchActions} onClose={() => setPicking(false)} />
    </Sheet>
  );
}

/** On a note: send it on to a chat as well. A chip that opens the list of chats. */
export function AlsoSendTo({ value, onChange }: { value: string | null; onChange: (roomId: string | null) => void }) {
  const { c } = useTheme();
  const status = useChatStatus();
  const rooms = useChatRooms(false, !!status.data?.enabled);
  const [open, setOpen] = useState(false);
  const writable = (rooms.data ?? []).filter((r) => r.isMember && !r.archived);
  if (!status.data?.enabled || !writable.length) return null;
  const chosen = writable.find((r) => r.id === value);
  const actions: SheetAction[] = [
    ...(value ? [{ key: "none", label: "Don't send it on", onPress: () => onChange(null) }] : []),
    ...writable.map((r) => ({ key: r.id, label: r.name, detail: r.kind === "team" ? "Team chat" : r.kind === "group" ? "Group" : "Direct message", onPress: () => onChange(r.id) })),
  ];
  return (
    <>
      <Touchable
        feel="chip"
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={chosen ? `Also sending to ${chosen.name}` : "Also send this note to a chat"}
        style={{ backgroundColor: chosen ? c.brandTint : c.surface2 }}
        className="mb-2 flex-row items-center gap-1.5 self-start rounded-full px-3 py-1"
      >
        <TeamChatIcon size={14} color={chosen ? c.wa : c.textMuted} />
        <Text style={{ color: chosen ? c.wa : c.textMuted }} className="text-xs font-medium">
          {chosen ? `Also send to ${chosen.name}` : "Also send to a chat…"}
        </Text>
      </Touchable>
      <ActionSheet visible={open} title="Also send this note to" actions={actions} onClose={() => setOpen(false)} />
    </>
  );
}
