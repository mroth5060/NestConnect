import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { FlatList, ScrollView, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import {
  api,
  chatListTime,
  chatPreview,
  useChatMutation,
  useChatRooms,
  useChatSearch,
  useChatStarred,
  useChatStatus,
  useMe,
  usePeople,
} from "@ding/client";
import type { ChatMessage, ChatRoomSummary } from "@ding/schemas";
import { ActionSheet, type SheetAction } from "../../../src/components/ActionSheet";
import { ChatAvatar } from "../../../src/components/chat/ChatAvatar";
import { NewChatSheet } from "../../../src/components/chat/ChatSheets";
import { EmptyState, QueryState } from "../../../src/components/States";
import { FilterChip } from "../../../src/components/FilterChip";
import { TAB_BAR_H } from "../../../src/components/TabBar";
import { HeaderButton, TabHeader } from "../../../src/components/TabHeader";
import { useToast } from "../../../src/components/Toast";
import { Touchable } from "../../../src/components/Touchable";
import { BackIcon, ComposeIcon, EyeIcon, PinIcon, SearchIcon, SoundOffIcon, StarIcon } from "../../../src/icons";
import { useInsets } from "../../../src/insets";
import { haptics } from "../../../src/haptics";
import { useTheme } from "../../../src/theme";

type Filter = "all" | "unread" | "groups" | "direct";

/** What the list shows: chats, and — while searching — messages too. */
type Entry =
  | { kind: "room"; key: string; room: ChatRoomSummary }
  | { kind: "label"; key: string; text: string }
  | { kind: "message"; key: string; roomId: string; where: string; group: boolean; message: ChatMessage };

/**
 * Team Chat on the phone: the list of chats, the way WhatsApp lays it out —
 * who, the last thing said, when, and a green count of what's waiting. Long
 * press a chat to pin or mute it. Only shown while the module is on (see the
 * tabs layout). See docs/team-chat.md.
 */
export default function Chat() {
  const insets = useInsets();
  const { c } = useTheme();
  const toast = useToast();
  const me = useMe().data?.user;
  const status = useChatStatus();
  const [oversee, setOversee] = useState(false);
  const rooms = useChatRooms(oversee, !!status.data?.enabled);
  const people = usePeople();
  const [query, setQuery] = useState("");
  const q = useDeferredValue(query.trim().toLowerCase());
  const [filter, setFilter] = useState<Filter>("all");
  const [newOpen, setNewOpen] = useState(false);
  const [acting, setActing] = useState<ChatRoomSummary | null>(null);
  const [showStarred, setShowStarred] = useState(false);
  // Search messages once typing pauses.
  const [term, setTerm] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setTerm(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);
  const found = useChatSearch(oversee ? "" : term);
  const starred = useChatStarred(showStarred);
  const prefs = useChatMutation(({ id, input }: { id: string; input: { muted?: boolean; pinned?: boolean } }) => api.setChatRoomPrefs(id, input));

  const mentionables = useMemo(() => (people.data ?? []).map((m) => m.user), [people.data]);
  const all = rooms.data ?? [];
  const unreadChats = all.filter((r) => r.unread > 0).length;
  const shown = useMemo(
    () =>
      all.filter((r) => {
        if (filter === "unread" && !r.unread) return false;
        if (filter === "groups" && r.kind === "direct") return false;
        if (filter === "direct" && r.kind !== "direct") return false;
        return !q || r.name.toLowerCase().includes(q) || (r.lastMessage?.body ?? "").toLowerCase().includes(q);
      }),
    [all, filter, q],
  );

  const entries: Entry[] = useMemo(() => {
    if (showStarred) {
      return (starred.data ?? []).map((st) => ({ kind: "message" as const, key: `s${st.message.id}`, roomId: st.roomId, where: st.roomName, group: true, message: st.message }));
    }
    const rows: Entry[] = shown.map((r) => ({ kind: "room" as const, key: r.id, room: r }));
    const hits = term.length >= 2 ? (found.data ?? []) : [];
    if (!hits.length) return rows;
    return [
      ...(rows.length ? [{ kind: "label" as const, key: "l-chats", text: "Chats" }, ...rows] : []),
      { kind: "label" as const, key: "l-msgs", text: "Messages" },
      ...hits.map((h) => ({ kind: "message" as const, key: `h${h.message.id}`, roomId: h.roomId, where: h.roomName, group: h.roomKind !== "direct", message: h.message })),
    ];
  }, [showStarred, starred.data, shown, term, found.data]);

  // Counted, as the Inbox's are: a filter that says how much is behind it.
  const filters: Array<{ key: Filter; label: string; count: number }> = [
    { key: "all", label: "All", count: all.length },
    { key: "unread", label: "Unread", count: unreadChats },
    { key: "groups", label: "Groups", count: all.filter((r) => r.kind !== "direct").length },
    { key: "direct", label: "Direct", count: all.filter((r) => r.kind === "direct").length },
  ];

  const open = (r: ChatRoomSummary) => router.push({ pathname: "/(app)/chat/[id]", params: { id: r.id } });
  const openAt = (roomId: string, mid: string) => router.push({ pathname: "/(app)/chat/[id]", params: { id: roomId, mid } });
  const actions: SheetAction[] = acting
    ? [
        {
          key: "pin",
          label: acting.pinned ? "Unpin chat" : "Pin chat",
          onPress: () => prefs.mutate({ id: acting.id, input: { pinned: !acting.pinned } }, { onError: (e) => toast({ text: (e as Error).message }) }),
        },
        {
          key: "mute",
          label: acting.muted ? "Unmute" : "Mute notifications",
          detail: acting.muted ? undefined : "An @mention still gets through",
          onPress: () => prefs.mutate({ id: acting.id, input: { muted: !acting.muted } }, { onError: (e) => toast({ text: (e as Error).message }) }),
        },
        ...(acting.unread
          ? [{ key: "read", label: "Mark as read", onPress: () => void api.readChatRoom(acting.id).then(() => rooms.refetch()) }]
          : []),
      ]
    : [];

  return (
    <View style={{ backgroundColor: c.bg, paddingTop: insets.top }} className="flex-1">
      {showStarred ? (
        <View className="flex-row items-center gap-1 px-2 pb-2 pt-2">
          <Touchable feel="chip" borderless onPress={() => setShowStarred(false)} accessibilityRole="button" accessibilityLabel="Back to chats" hitSlop={10} className="h-10 w-10 items-center justify-center">
            <BackIcon size={24} color={c.brand} />
          </Touchable>
          <Text accessibilityRole="header" className="flex-1 text-xl font-semibold tracking-tight text-fg">
            Starred messages
          </Text>
        </View>
      ) : (
      <>
      <TabHeader
        title={oversee ? "All chats" : "Chats"}
        subtitle={
          oversee
            ? "Every chat in the workspace"
            : status.data?.unread
              ? `${status.data.unread} unread`
              : "Your team, in one place"
        }
      >
        <HeaderButton label="Starred messages" icon={(p) => <StarIcon {...p} />} onPress={() => setShowStarred(true)} />
        {status.data?.canOversee ? (
          <HeaderButton
            label={oversee ? "Back to my chats" : "All chats in the workspace"}
            icon={(p) => <EyeIcon {...p} />}
            selected={oversee}
            onPress={() => setOversee((v) => !v)}
          />
        ) : null}
        <HeaderButton label="New chat" icon={(p) => <ComposeIcon {...p} />} fill={c.wa} onPress={() => setNewOpen(true)} />
      </TabHeader>


      <View className="px-4 pb-3">
        <View style={{ backgroundColor: c.surface2 }} className="flex-row items-center gap-2 rounded-full px-3.5">
          <SearchIcon size={17} color={c.textFaint} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={oversee ? "Search chats" : "Search chats and messages"}
            placeholderTextColor={c.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            clearButtonMode="while-editing"
            accessibilityLabel="Search chats and messages"
            style={{ color: c.text }}
            className="flex-1 py-2.5 text-lg"
          />
        </View>
      </View>

      {/* The Inbox's pills and the Inbox's row of them, so the two lists look
          like one app. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}
        className="flex-none pb-2.5"
      >
        {filters.map((f) => (
          <FilterChip
            key={f.key}
            label={f.label}
            count={f.count}
            active={filter === f.key}
            onPress={() => {
              haptics.select();
              setFilter(f.key);
            }}
          />
        ))}
      </ScrollView>
      </>
      )}

      <FlatList
        style={{ flex: 1 }}
        data={entries}
        keyExtractor={(e) => e.key}
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 + TAB_BAR_H }}
        // The Inbox's dividers: between rows, starting past the avatar.
        ItemSeparatorComponent={({ leadingItem }: { leadingItem?: Entry }) =>
          leadingItem?.kind === "room" ? <View style={{ backgroundColor: c.border }} className="ml-[80px] h-px" /> : null
        }
        renderItem={({ item }) =>
          item.kind === "label" ? (
            <Text style={{ color: c.wa }} className="px-4 pb-1 pt-3 text-2xs font-bold uppercase tracking-wide">
              {item.text}
            </Text>
          ) : item.kind === "message" ? (
            <MessageRow
              where={item.where}
              m={item.message}
              group={item.group}
              meId={me?.id}
              people={mentionables}
              onPress={() => openAt(item.roomId, item.message.id)}
            />
          ) : (
            <Row r={item.room} meId={me?.id} people={mentionables} onPress={() => open(item.room)} onLongPress={() => item.room.isMember && setActing(item.room)} />
          )
        }
        ListEmptyComponent={
          showStarred ? (
            <QueryState
              query={starred}
              what="your starred messages"
              empty={<EmptyState title="Nothing starred yet" body="Long-press a message and tap Star to find it here later." />}
            />
          ) : (
          <QueryState
            query={rooms}
            what="your chats"
            empty={
              q || filter !== "all" ? (
                <EmptyState icon="search" title="Nothing matches" />
              ) : (
                <EmptyState title="No chats yet" body="Start one with the green button above — or say hello in your team's chat." />
              )
            }
          />
          )
        }
      />

      <NewChatSheet visible={newOpen} canCreateGroups={!!status.data?.canCreateGroups} onClose={() => setNewOpen(false)} onOpened={(id) => {
        setNewOpen(false);
        setOversee(false);
        router.push({ pathname: "/(app)/chat/[id]", params: { id } });
      }} />
      <ActionSheet visible={!!acting} title={acting?.name ?? ""} actions={actions} onClose={() => setActing(null)} />
    </View>
  );
}

function Row({
  r,
  meId,
  people,
  onPress,
  onLongPress,
}: {
  r: ChatRoomSummary;
  meId: string | undefined;
  people: Array<{ name: string; email: string }>;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const { c } = useTheme();
  const preview = chatPreview(r.lastMessage, { meId, group: r.kind !== "direct", people });
  const unread = r.unread > 0;
  return (
    <Touchable
      feel="row"
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityLabel={`${r.name}${unread ? `, ${r.unread} unread` : ""}`}
      // WhatsApp's chat list, sized as it is: a 56-point face, the name at
      // 17, what was said at 15. It was the Inbox row's, a size smaller, and
      // read as cramped beside the app everybody here has open next to it.
      className="flex-row items-center gap-3 px-4 py-3.5"
    >
      <ChatAvatar room={r} size={56} />
      <View className="flex-1 gap-1">
        <View className="flex-row items-center gap-2">
          <Text numberOfLines={1} style={{ fontSize: 17, lineHeight: 22 }} className={`flex-1 text-fg ${unread ? "font-bold" : "font-semibold"}`}>
            {r.name}
          </Text>
          <Text style={{ color: unread ? c.wa : c.textFaint }} className={`text-md ${unread ? "font-semibold" : ""}`}>
            {chatListTime(r.lastActivityAt)}
          </Text>
        </View>
        <View className="flex-row items-center gap-1.5">
          <Text
            numberOfLines={1}
            style={{ color: unread ? c.text : c.textMuted, fontStyle: r.lastMessage?.deletedAt ? "italic" : "normal", fontSize: 15, lineHeight: 20 }}
            className="flex-1"
          >
            {preview || (r.kind === "team" ? "Your team's chat" : r.archived ? "Archived" : "")}
          </Text>
          {r.muted ? <SoundOffIcon size={14} color={c.textFaint} /> : null}
          {r.pinned ? (
            <View accessibilityLabel="Pinned">
              <PinIcon size={14} color={c.textFaint} />
            </View>
          ) : null}
          {r.mentioned && unread ? (
            <View style={{ backgroundColor: c.wa }} className="h-[22px] w-[22px] items-center justify-center rounded-full">
              <Text className="text-xs font-bold text-white">@</Text>
            </View>
          ) : null}
          {unread ? (
            <View style={{ backgroundColor: r.muted ? c.textFaint : c.wa }} className="h-[22px] min-w-[22px] items-center justify-center rounded-full px-1.5">
              <Text className="text-xs font-bold text-white">{r.unread > 99 ? "99+" : r.unread}</Text>
            </View>
          ) : null}
          {!r.isMember ? (
            <Text style={{ color: c.textFaint, borderColor: c.border }} className="rounded-full border px-2 text-[10px] font-bold uppercase">
              {r.archived ? "Archived" : "Not in it"}
            </Text>
          ) : null}
        </View>
      </View>
    </Touchable>
  );
}

/** A message found by search, or starred: where it was said, who said it, when. */
function MessageRow({
  where,
  m,
  group,
  meId,
  people,
  onPress,
}: {
  where: string;
  m: ChatMessage;
  group: boolean;
  meId: string | undefined;
  people: Array<{ name: string; email: string }>;
  onPress: () => void;
}) {
  const { c } = useTheme();
  return (
    <Touchable feel="row" onPress={onPress} accessibilityRole="button" accessibilityLabel={`Message in ${where}`} className="px-4 py-2.5">
      <View style={{ borderBottomColor: c.border }} className="border-b pb-2.5">
        <View className="flex-row items-center gap-2">
          <Text numberOfLines={1} className="flex-1 text-md font-semibold text-fg">
            {where}
          </Text>
          <Text className="text-2xs text-faint">{chatListTime(m.createdAt)}</Text>
        </View>
        <Text numberOfLines={2} className="mt-0.5 text-md text-muted">
          {chatPreview(m, { meId, group, people })}
        </Text>
      </View>
    </Touchable>
  );
}
