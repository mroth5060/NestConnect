import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, SectionList, Text, View } from "react-native";
import Animated from "react-native-reanimated";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { router, useLocalSearchParams } from "expo-router";
import {
  buildForwardedEmail,
  clockTime,
  groupMessagesByDay,
  speakerKey,
  useAssign,
  useConversation,
  useForwardMessage,
  useLoadOlderMessages,
  useMarkRead,
  usePeople,
  useReact,
  useRealtime,
  useRetryMessage,
  useSession,
  useInboxes,
  useSendMessage,
  useSetStatus,
  useSnooze,
  useTeams,
  useTypingPresence,
  useChatStatus,
  type TypingPresence,
} from "@ding/client";
import { DiscussionBar, DiscussionSheet, ShareSheet } from "../../../src/components/chat/Discuss";
import { inboxLabel, mentionParts, sendingInbox, type ChannelType, type ConversationWithMessages, type Message } from "@ding/schemas";
import { ActionSheet, LEADING, type SheetAction } from "../../../src/components/ActionSheet";
import { Attachments } from "../../../src/components/Attachments";
import { Avatar } from "../../../src/components/Avatar";
import { Composer } from "../../../src/components/Composer";
import { useSendQueue } from "../../../src/send-queue";
import { DetailsPanel } from "../../../src/components/DetailsPanel";
import { ConversationLogSheet } from "../../../src/components/ConversationLogSheet";
import { LabelSheet } from "../../../src/components/LabelSheet";
import { QueuedBubble } from "../../../src/components/QueuedBubble";
import { MessageActions } from "../../../src/components/MessageActions";
import { ForwardSheet } from "../../../src/components/ForwardSheet";
import { EmailForwardSheet } from "../../../src/components/EmailForwardSheet";
import { ReadLog, readSummary } from "../../../src/components/ReadLog";
import { Reactions } from "../../../src/components/Reactions";
import { SwipeToReply } from "../../../src/components/SwipeToReply";
import { BottomInset } from "../../../src/components/BottomInset";
import { ErrorState, Loading } from "../../../src/components/States";
import { Tail, tailCorner } from "../../../src/components/Tail";
import { EmailBody } from "../../../src/components/EmailBody";
import { Ticks } from "../../../src/components/Ticks";
import { useToast } from "../../../src/components/Toast";
import {
  BackIcon,
  CheckCircleIcon,
  DetailsIcon,
  EyeIcon,
  ForwardIcon,
  InboxIcon,
  MoreIcon,
  ProfileIcon,
  ReopenIcon,
  SnoozeIcon,
  TagIcon,
  TeamChatIcon,
  TeamGlyph,
  channelColor,
  channelMeta,
} from "../../../src/icons";
import { haptics } from "../../../src/haptics";
import { enter } from "../../../src/motion";
import { locateMessage } from "../../../src/thread-nav";
import { useTheme } from "../../../src/theme";
import { useInsets } from "../../../src/insets";
import { useNow } from "../../../src/now";
import { threadClocks } from "../../../src/clocks";
import { Touchable } from "../../../src/components/Touchable";
import { FollowUpBar } from "../../../src/components/FollowUpBar";
import { LinkedText } from "../../../src/components/LinkedText";

/** One day of the thread. `isLastDay` rides along because `renderItem` is told
 *  which section it is in, but not which number — and the final day is the one
 *  that must not draw a divider under its last message. */
type DaySection = { key: string; label: string; data: Message[]; isLastDay: boolean };

/** Snooze presets. The same five the web offers, so "snooze till tomorrow"
 *  means the same thing whichever one an agent reaches for. */
const inMin = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
const tomorrow9am = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
};
const SNOOZE = [
  // `said` is what the confirmation reads afterwards. "Snoozed until 10 minutes"
  // is not a sentence, so the preposition belongs to the preset rather than to
  // the toast that reports it.
  { label: "10 minutes", said: "Snoozed for 10 minutes", until: () => inMin(10) },
  { label: "30 minutes", said: "Snoozed for 30 minutes", until: () => inMin(30) },
  { label: "1 hour", said: "Snoozed for an hour", until: () => inMin(60) },
  { label: "Tomorrow, 9 AM", said: "Snoozed until tomorrow, 9 AM", until: tomorrow9am },
  { label: "Next week", said: "Snoozed until next week", until: () => inMin(60 * 24 * 7) },
];

/**
 * A note body with its @mentions picked out, by name.
 *
 * The same `mentionParts` the web uses, so a note written on a laptop and read
 * on a phone highlights the same people. The point isn't decoration: a note is
 * often addressed to one person in a team of six, and the mention is the only
 * thing that says which.
 */
function NoteBody({ body, color }: { body: string; color: string }) {
  // Shown by name ("@Nathan A"); the stored "@nathan" is only what routes it.
  const { data: people } = usePeople();
  const parts = mentionParts(body, (people ?? []).map((m) => m.user));
  return (
    <Text className="text-lg leading-snug text-fg">
      {parts.map((part, i) =>
        part.mention ? (
          <Text key={i} style={{ color }} className="font-semibold">
            {part.text}
          </Text>
        ) : (
          <LinkedText key={i} text={part.text} />
        ),
      )}
    </Text>
  );
}

/** What the ⋯ menu's Labels row says underneath itself: the labels already on
 *  this conversation, so the common case (checking, not changing) needs no tap
 *  at all. */
function labelSummary(conv: ConversationWithMessages): string {
  const names = (conv.labels ?? []).map((l) => l.name);
  if (!names.length) return "None yet";
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 3).join(", ")} +${names.length - 3}`;
}

export default function Thread() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useInsets();
  const { c } = useTheme();
  const conv = useConversation(id);
  const session = useSession();
  const { data: people } = usePeople();
  const assign = useAssign();
  const setStatus = useSetStatus();
  const snooze = useSnooze();
  const markRead = useMarkRead();
  const retry = useRetryMessage();
  const react = useReact();
  const forward = useForwardMessage();
  /** Email forward goes through the ordinary send path with `forwardTo` set —
   *  it is a new outbound email, not the WhatsApp "drop into another chat". */
  const sendEmail = useSendMessage();
  /** Our own address on this inbox, so reply-all never copies the inbox back
   *  into itself — a support address answering its own email is a loop with a
   *  customer watching. */
  const inboxes = useInboxes();
  const queue = useSendQueue();
  const teams = useTeams();
  const toast = useToast();
  const teamName = (id: string | null) =>
    (id ? teams.data?.find((t) => t.id === id)?.name : undefined) ?? "the team";
  const [sheet, setSheet] = useState<null | "assign" | "snooze" | "more" | "details" | "labels" | "log">(
    null,
  );
  // The message a long-press opened the action sheet for, and the one the
  // composer is quoting. Separate: acting on a message doesn't quote it.
  const [acting, setActing] = useState<Message | null>(null);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [readLog, setReadLog] = useState<Message | null>(null);
  // The message being forwarded on to other chats (drives the picker sheet).
  const [forwarding, setForwarding] = useState<Message | null>(null);
  /** The same, for email — a different sheet, because it forwards to typed
   *  addresses rather than to customers. See `EmailForwardSheet`. */
  const [emailForwarding, setEmailForwarding] = useState<Message | null>(null);
  /** Reply-all's request to the composer: seed the Cc with these and unfold it.
   *  A token rather than an array so pressing it twice re-seeds. */
  const [ccPrefill, setCcPrefill] = useState<{ at: number; addresses: string[] } | null>(null);
  // Team Chat: take this conversation (or one message) to a chat, and the
  // discussion it's part of, opened from the bar under the header.
  const chatOn = !!useChatStatus().data?.enabled;
  const [sharing, setSharing] = useState<{ message: { id: string; who: string; text: string } | null } | null>(null);
  const [discussion, setDiscussion] = useState<string | null>(null);
  const list = useRef<SectionList<Message, DaySection>>(null);
  // Another agent writing on this thread, from the shared hook. The web has had
  // this since typing indicators shipped; the phone showed nothing at all.
  const typing = useTypingPresence(id);
  // The message a "jump to quoted" landed on, flashed briefly so the eye can
  // find it. Scrolling somewhere without saying where you arrived is how people
  // end up asking whether the tap did anything.
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
  }, []);
  const marked = useRef(false);
  /**
   * Is the reader at the newest message?
   *
   * The only piece of scroll state the thread still keeps. Prepend anchoring is
   * the platform's job now (`maintainVisibleContentPosition`), which retired
   * the height/offset/viewport trio this used to need.
   *
   * True to start: a thread you have just opened is showing its newest message.
   */
  const atBottom = useRef(true);
  /**
   * How close to the end still counts as "at the end".
   *
   * It was 120, and 120pt is most of a message. Scroll up slowly from the
   * newest one and you were still inside it, so the next thing that changed the
   * content's height — an image finishing, the next batch of older messages
   * rendering as you approached them — read you as still at the bottom and
   * scrolled you back down. That is the "when I scroll up slowly it jumps".
   *
   * A number small enough that it only means "has not moved": one line of text
   * and the padding under it.
   */
  const AT_BOTTOM_SLACK = 24;
  /**
   * Has the reader taken control of the scroll yet?
   *
   * A virtualised list does not arrive at its full height in one go: it renders
   * a screenful, measures, renders more. So a single "scroll to the end" on the
   * first layout lands at what was the end a frame ago, and the content then
   * grows underneath it — which is how the thread opened a thousand pixels
   * short of its newest message. Until the reader actually drags, the list is
   * pinned to the bottom through every one of those growth steps.
   */
  const pinned = useRef(true);
  /** Id of the newest message, so a genuinely new one can be told from a
   *  reflow — the first scrolls with animation, the second must not. */
  const lastMsgId = useRef<string | null>(null);

  useRealtime(id);

  const data = conv.data;

  /**
   * Everything below exists to keep <Bubble> from re-rendering when nothing
   * about its message changed.
   *
   * This mattered more when the thread was a plain ScrollView and every loaded
   * message was mounted — 300 of them after a few taps of "load earlier", so
   * opening the details sheet re-rendered all 300, because each bubble took a
   * fresh arrow function for every callback and the whole conversation object
   * besides. Measured on a 6x-throttled CPU that was a 2.5-second frozen frame:
   * not a slow list, a hung app.
   *
   * The list virtualises now, so the blast radius is a screenful rather than a
   * thread — but the memoisation is what keeps a virtualised list cheap too: an
   * unstable `renderItem` makes it re-render every visible row on every parent
   * render, which is most of what virtualising was for.
   *
   * So: the derivations are memoised, the handlers take the message as an
   * argument instead of closing over it, and the mutations they need are read
   * through a ref rather than listed as dependencies — a react-query mutation
   * object is new on every render and would defeat the memo from the inside.
   */
  const days = useMemo(() => (data ? groupMessagesByDay(data.messages) : []), [data]);
  const byId = useMemo(() => {
    const m = new Map<string, Message>();
    for (const msg of data?.messages ?? []) m.set(msg.id, msg);
    return m;
  }, [data]);

  /**
   * Which messages should print their subject.
   *
   * A subject on every email is what a mail client shows in a *list*, where each
   * row is a different thread. Inside one thread it's the same line over and
   * over — four bubbles deep it stops being information and starts being the
   * reason you can't see the messages. The header already carries the thread's
   * current subject persistently.
   *
   * So a bubble prints its subject only when it says something new: the first
   * email in the thread, and any message where the subject changed. That turns
   * the line into an event — "this is where it was renamed" — which is worth the
   * space. Computed over the flat list, because a rename can happen across a day
   * boundary and the per-day grouping would miss it.
   */
  const showsSubject = useMemo(() => {
    const out = new Set<string>();
    let last: string | null = null;
    for (const m of data?.messages ?? []) {
      const s = m.email?.subject?.trim();
      if (!s) continue;
      if (s !== last) out.add(m.id);
      last = s;
    }
    return out;
  }, [data]);

  const live = useRef({ id, react, retry });
  live.current = { id, react, retry };

  const onLongPress = useCallback((m: Message) => {
    haptics.tap();
    setActing(m);
  }, []);
  const onReply = useCallback((m: Message) => setReplyTo(m), []);
  const onOpenReadLog = useCallback((m: Message) => setReadLog(m), []);
  // Sending the same emoji again is how the server clears it.
  const onRemoveReaction = useCallback((m: Message) => {
    const { id: convId, react: r } = live.current;
    r.mutate({
      conversationId: convId,
      messageId: m.id,
      emoji: m.reactions?.find((x) => x.by === "user")?.emoji ?? "",
    });
  }, []);
  const onRetry = useCallback((m: Message) => {
    const { id: convId, retry: rt } = live.current;
    rt.mutate({ conversationId: convId, messageId: m.id });
  }, []);

  /**
   * The thread as sections — one per day, which is what a `SectionList` sticks.
   *
   * This used to be one flat array of elements with a parallel array of indices
   * for `stickyHeaderIndices`, because that prop only understands *direct*
   * children of a ScrollView and a per-day wrapper hid the separator from it.
   * That worked, and it meant the whole thread had to be mounted at once: a
   * 400-message conversation built 400 bubbles, their attachments, reactions,
   * quote previews and status ticks, and kept every one of them alive.
   *
   * A section per day says the same thing to a list that can virtualise it, and
   * `stickySectionHeadersEnabled` pins the date without any index bookkeeping to
   * get wrong.
   */
  // Read from the session rather than the `me` derived further down: this memo
  // is a hook, so it must run before the loading/error early returns, and `me`
  // is only in scope after them.
  const myId = session.data?.user?.id;
  const sections = useMemo(
    () =>
      days.map((group, gi) => ({
        key: group.key,
        label: group.label,
        data: group.items,
        /** The last day needs no divider below it — the composer's gap is the
         *  end of the thread. Carried on the section because `renderItem` is
         *  told which section it is in, but not which number. */
        isLastDay: gi === days.length - 1,
      })),
    [days],
  );

  const renderDay = useCallback(
    ({ section }: { section: { label: string } }) => (
      // Transparent around an opaque pill, so the thread passes either side of
      // it as it scrolls under — WhatsApp's floating date, not a full-width bar.
      <View className="items-center pb-1 pt-1.5">
        {/* No lift: a drop shadow on a small pill reads as a sticker.
            `elevated`, not `surface2` — the thread's ground is `surface2` now,
            and a pill in the same colour as the page it floats over is not a
            pill. */}
        <View style={{ backgroundColor: c.elevated }} className="rounded-full px-3 py-1">
          <Text className="text-2xs font-medium text-muted">{section.label}</Text>
        </View>
      </View>
    ),
    [c.surface2],
  );

  /**
   * Jump to the message a reply is quoting.
   *
   * The quoted block has always looked like a link and behaved like a label —
   * tapping it did nothing, which is the one thing a quote in a chat app is
   * expected to do. `scrollToLocation` needs coordinates rather than an id, so
   * `locateMessage` supplies them, and a miss is reported rather than guessed
   * at: a thread pages older messages in, so a reply to something from weeks
   * back genuinely isn't loaded yet.
   */
  const onJumpTo = useCallback(
    (messageId: string) => {
      const at = locateMessage(sections, messageId);
      if (!at) {
        toast({ text: "That message isn't loaded yet — pull down to load older ones." });
        return;
      }
      list.current?.scrollToLocation({
        ...at,
        // Mid-screen rather than at the top: the quoted message is context, and
        // context reads better with what surrounds it visible.
        viewPosition: 0.5,
        animated: true,
      });
      haptics.select();
      setHighlightId(messageId);
      if (highlightTimer.current) clearTimeout(highlightTimer.current);
      highlightTimer.current = setTimeout(() => setHighlightId(null), 1600);
    },
    [sections, toast],
  );

  /*
   * Which of our numbers/addresses a message went from — but only when it isn't
   * the one this thread usually sends from. That is the case nothing else on
   * screen shows, and the only one worth a line on a bubble; printing it on all
   * of them would be noise on the overwhelming majority that went the usual way.
   *
   * Returns a string rather than the inbox, so <Bubble> keeps taking primitives
   * and its memo keeps doing its job.
   */
  const sentFromFor = useCallback(
    (m: Message): string | undefined => {
      if (!data || m.direction !== "out" || m.internal) return undefined;
      const list = inboxes.data ?? [];
      const usual = sendingInbox(list, data);
      const from = sendingInbox(list, data, { channel: m.channel, recordedInboxId: m.inboxId });
      return from && from.id !== usual?.id ? inboxLabel(from) : undefined;
    },
    [data, inboxes.data],
  );

  const renderMessage = useCallback(
    ({
      item: m,
      index: i,
      section,
    }: {
      item: Message;
      index: number;
      section: { data: Message[]; isLastDay: boolean };
    }) => {
      if (!data) return null;
      const prev = section.data[i - 1];
      const next = section.data[i + 1];
      const who = (x: Message) => speakerKey(x, data.channel);
      return (
        <Bubble
          message={m}
          // Primitives and one resolved message rather than the whole
          // conversation: `conv` is a new object on every refetch, and passing
          // it would re-render every bubble for a change to one.
          channel={data.channel}
          contactName={data.contact.displayName}
          quoted={m.quotedMsgId ? byId.get(m.quotedMsgId) : undefined}
          onJumpTo={onJumpTo}
          highlighted={highlightId === m.id}
          meId={myId}
          // Same speaker above? Part of a run: loses the name and most of the
          // gap above it. Same speaker below? Not the last of the run, so the
          // tail belongs to whichever bubble is.
          continues={!!prev && who(prev) === who(m)}
          endsRun={!next || who(next) !== who(m)}
          showSubject={showsSubject.has(m.id)}
          firstOfDay={i === 0}
          // Only when another day follows: the last message in the thread wants
          // the composer's own gap, not a divider's.
          lastOfDay={!next && !section.isLastDay}
          onLongPress={onLongPress}
          onReply={onReply}
          onOpenReadLog={onOpenReadLog}
          onRemoveReaction={onRemoveReaction}
          onRetry={onRetry}
          sentFrom={sentFromFor(m)}
        />
      );
    },
    [data, byId, myId, showsSubject, highlightId, sentFromFor, onJumpTo, onLongPress, onReply, onOpenReadLog, onRemoveReaction, onRetry],
  );

  // Send `forwarding` on to the picked customers. The server reports each target
  // separately — a closed 24-hour window on one chat is the normal partial
  // failure — so the toast names what didn't go rather than claiming it all did.
  const submitForward = (contactIds: string[]) => {
    const m = forwarding;
    if (!m) return;
    forward.mutate(
      { conversationId: id, messageId: m.id, contactIds },
      {
        onSuccess: (results) => {
          setForwarding(null);
          const sent = results.filter((r) => r.ok);
          const failed = results.filter((r) => !r.ok);
          // Only a clean sweep gets the success buzz; a partial forward is not
          // a thing to congratulate someone for.
          if (failed.length) haptics.warning();
          else haptics.success();
          if (!failed.length) {
            toast({ text: sent.length === 1 ? `Forwarded to ${sent[0].name}` : `Forwarded to ${sent.length} chats` });
          } else if (!sent.length) {
            toast({
              text: failed.length === 1 ? `${failed[0].name}: ${failed[0].error}` : "Couldn't forward to any of those chats",
              tone: "error",
            });
          } else {
            toast({
              text: `Forwarded to ${sent.length} — ${failed.map((f) => f.name).join(", ")} didn't go`,
              tone: "info",
            });
          }
        },
        onError: () => toast({ text: "Couldn't forward that message. Please try again.", tone: "error" }),
      },
    );
  };

  // Opening a thread is reading it — clear the badge and send the WhatsApp read
  // receipt, once per visit rather than on every re-render.
  useEffect(() => {
    if (!id || marked.current || !conv.data) return;
    marked.current = true;
    markRead.mutate(id);
  }, [id, conv.data, markRead]);

  /**
   * A conversation opened from the inbox never lands here: `useConversation`
   * hands back the list row as placeholder data, so `isLoading` is already
   * false and the header, avatar, channel and subject render on the first
   * frame. This is the cold path — a push notification, a deep link, a restart
   * — where there is genuinely nothing cached to show yet.
   */
  if (conv.isLoading) {
    return (
      <View style={{ backgroundColor: c.bg }} className="flex-1 items-center justify-center">
        <Loading />
      </View>
    );
  }
  // A failed load and a conversation that genuinely isn't there are different
  // things, and only one of them is worth trying again.
  if (conv.isError) {
    return (
      <View style={{ backgroundColor: c.bg, paddingTop: insets.top }} className="flex-1 justify-center">
        <ErrorState error={conv.error} what="this conversation" onRetry={() => void conv.refetch()} />
        <Touchable feel="chip" onPress={() => router.back()} accessibilityRole="button" className="items-center py-2">
          <Text style={{ color: c.brand }} className="text-md font-medium">
            Back to inbox
          </Text>
        </Touchable>
      </View>
    );
  }
  if (!data) {
    return (
      <View style={{ backgroundColor: c.bg, paddingTop: insets.top }} className="flex-1 items-center justify-center px-8">
        <Text className="text-lg font-medium text-fg">This conversation isn't available</Text>
        <Text className="mt-1 text-center text-md text-muted">
          It may have been merged into another thread, or you no longer have access to it.
        </Text>
        <Touchable feel="chip" onPress={() => router.back()} accessibilityRole="button" className="mt-4">
          <Text style={{ color: c.brand }} className="text-lg font-medium">
            Back to inbox
          </Text>
        </Touchable>
      </View>
    );
  }

  const me = session.data?.user;
  const closed = data.status === "closed";

  /**
   * Every action below reports itself and offers a way back.
   *
   * These all happen inside a sheet, and when the sheet closes the thread looks
   * identical — the only change is a word in the subtitle. Without a toast the
   * honest reading of the screen is "nothing happened", and the natural next
   * move is to do it again. The undo matters as much: assigning to the wrong
   * person is one mis-tap in a list of names, and this is the only moment the
   * previous assignee is still known without a round trip.
   */
  /**
   * Both halves of an assignment restored together.
   *
   * Person and team are separate fields, and routing to a team clears the
   * person — so an undo that only put the person back would leave the
   * conversation on the new team with its old owner, a state nobody chose.
   */
  const restoreAssignment = () => {
    const assigneeUserId = data.assigneeUserId ?? null;
    const assignedTeamId = data.assignedTeamId ?? null;
    const assigneeName = data.assigneeName ?? null;
    return () => assign.mutate({ id: data.id, input: { assigneeUserId, assignedTeamId }, assigneeName });
  };
  /** `assigneeName` is only for the optimistic row — the server resolves the
   *  real one — so that the list and the header don't read "Unassigned" for the
   *  length of a round trip. Null whenever the assignment is to a team. */
  const doAssign = (
    input: { assigneeUserId?: string | null; assignedTeamId?: string | null },
    said: string,
    assigneeName?: string | null,
  ) => {
    const undo = restoreAssignment();
    haptics.success();
    assign.mutate({ id: data.id, input, assigneeName });
    toast({ text: said, undo });
  };

  /**
   * Who can take this, and where it can be sent.
   *
   * Two different acts, so two groups. Assigning names a person who now owns
   * it; routing hands it to a team's queue for whoever picks it up. They were
   * one undivided list of names before, with no way to do the second at all —
   * which meant a conversation could only ever move sideways between
   * individuals, never back to a team that should own it.
   *
   * People are ordered by the team the conversation is already on: if it sits
   * with Support, Support's members are the ones you're realistically handing
   * it to, and they shouldn't be interleaved with everyone else.
   */
  const currentTeam = data.assignedTeamId ?? null;
  const inTeam = (m: { teamIds: string[] }) => !!currentTeam && m.teamIds.includes(currentTeam);
  const others = (people ?? []).filter((m) => m.user.id !== me?.id);
  const ranked = [...others].sort((a, b) => Number(inTeam(b)) - Number(inTeam(a)));

  const assignActions: SheetAction[] = [
    {
      key: "me",
      section: "Assign to a person",
      label: "Assign to me",
      leading: me ? <Avatar name={me.name} color={me.avatarColor} size={LEADING} /> : undefined,
      selected: data.assigneeUserId === me?.id,
      onPress: () => doAssign({ assigneeUserId: me?.id ?? null }, "Assigned to you", me?.name ?? null),
    },
    ...ranked.map((m) => ({
      key: m.user.id,
      label: m.user.name,
      leading: <Avatar name={m.user.name} color={m.user.avatarColor} size={LEADING} />,
      detail: !m.user.available
        ? "Not accepting work"
        : inTeam(m)
          ? teamName(currentTeam)
          : undefined,
      selected: data.assigneeUserId === m.user.id,
      onPress: () => doAssign({ assigneeUserId: m.user.id }, `Assigned to ${m.user.name}`, m.user.name),
    })),
    ...(teams.data ?? []).map((t, i) => ({
      key: `team:${t.id}`,
      // Only the first row carries the caption; the rest continue the group.
      section: i === 0 ? "Route to a team" : undefined,
      label: t.name,
      leading: <TeamGlyph icon={t.icon} size={21} color={c.textMuted} />,
      detail: t.id === currentTeam ? "Already here" : "Unassigns, leaves it for the team",
      selected: t.id === currentTeam && !data.assigneeUserId,
      // Routing clears the person on purpose: it means "nobody in particular
      // owns this, the team does", which is what puts it up for grabs.
      onPress: () => doAssign({ assigneeUserId: null, assignedTeamId: t.id }, `Routed to ${t.name}`),
    })),
    {
      key: "queue",
      section: "Or",
      label: "Back to the queue",
      leading: <InboxIcon size={21} color={c.textMuted} />,
      detail: currentTeam ? `Unassign, leave it with ${teamName(currentTeam)}` : "Unassign, leave it for the team",
      selected: !data.assigneeUserId,
      onPress: () => doAssign({ assigneeUserId: null }, "Back in the queue"),
    },
  ];

  const snoozeActions: SheetAction[] = SNOOZE.map((s) => ({
    key: s.label,
    label: s.label,
    onPress: () => {
      haptics.success();
      snooze.mutate({ id: data.id, until: s.until() });
      // Un-snoozing is reopening: there is no "previous snooze" to restore, and
      // the thing the agent wants back is the conversation in the inbox.
      toast({ text: s.said, undo: () => setStatus.mutate({ id: data.id, status: "open" }) });
    },
  }));

  // Every row carries a glyph. A list where one item has an icon and the rest
  // don't reads as three plain rows and one mistake — the eye goes to the odd
  // one out rather than down the list.
  const moreActions: SheetAction[] = [
    {
      key: "status",
      label: closed ? "Reopen conversation" : "Resolve conversation",
      leading: closed
        ? <ReopenIcon size={20} color={c.textMuted} />
        : <CheckCircleIcon size={20} color={c.textMuted} />,
      detail: closed ? "Move it back into the inbox" : "Close it — a new message reopens it",
      onPress: () => {
        haptics.success();
        setStatus.mutate({ id: data.id, status: closed ? "open" : "closed" });
        toast({
          text: closed ? "Reopened" : "Resolved",
          undo: () => setStatus.mutate({ id: data.id, status: closed ? "closed" : "open" }),
        });
      },
    },
    {
      key: "snooze",
      label: "Snooze…",
      leading: <SnoozeIcon size={20} color={c.textMuted} />,
      detail: "Hide it until later",
      onPress: () => setSheet("snooze"),
    },
    {
      key: "assign",
      label: "Assign…",
      leading: <ProfileIcon size={20} color={c.textMuted} />,
      detail: data.assigneeName ? `With ${data.assigneeName}` : "Nobody yet",
      onPress: () => setSheet("assign"),
    },
    {
      key: "labels",
      label: "Labels…",
      leading: <TagIcon size={20} color={c.textMuted} />,
      detail: labelSummary(data),
      onPress: () => setSheet("labels"),
    },
    ...(chatOn
      ? [
          {
            key: "discuss",
            label: "Discuss with the team",
            leading: <TeamChatIcon size={20} color={c.textMuted} />,
            detail: "Send it to a Team Chat",
            onPress: () => setSharing({ message: null }),
          },
        ]
      : []),
  ];

  return (
    // A plain View owns the screen, and the avoiding view wraps the composer
    // and nothing else.
    //
    // Every arrangement that put this screen's sizing through
    // KeyboardAvoidingView has come back wrong in a different way: the padding
    // it was given disappeared, then the flex it was given disappeared, then
    // the message list flexed into it and came out zero tall. Whatever it does
    // with a style prop, it is not a thing to hang a layout on.
    //
    // So it doesn't hold one any more. A View fills the screen, the header pads
    // itself for the status bar, the list flexes into the space between — all
    // plain components that can be relied on — and the avoiding view is left
    // with its one real job: adding padding under the composer equal to the
    // keyboard, which is exactly what `behavior="padding"` means. It sizes to
    // its own content there, which is correct rather than something to work
    // around.
    //
    // The ground is `surface2`, not `bg`, and that is the counterpart to the
    // bubbles losing their border. A bordered bubble can sit on almost
    // anything; an unbordered one has to be separated from the page by its own
    // fill, and `bg` (#FAFAF9) against `surface` (#FFFFFF) is a difference of
    // about one and a half percent — an inbound message would dissolve into the
    // thread. `surface2` gives white something to be white *against*, which is
    // the arrangement every messaging app uses and the reason none of them need
    // a border on a bubble.
    <View style={{ flex: 1, backgroundColor: c.surface2 }}>
      <Header
        conv={data}
        insetTop={insets.top}
        onDetails={() => setSheet("details")}
        onMore={() => setSheet("more")}
      />
      <FollowUpBar conv={data} />
      {chatOn ? <DiscussionBar conversationId={data.id} onOpen={setDiscussion} /> : null}

      {/* A section per day, so the date pill can stick without the whole thread
          having to be mounted for it. The web keeps its separator pinned
          (`position: sticky`) so you always know what day you're reading, and a
          phone needs that more than a desktop does, not less.

          No container gap: spacing is per-bubble so a run can close up. A
          uniform gap would space every pair identically and there'd be no
          visible grouping at all. */}
      <SectionList
        ref={list}
        sections={sections}
        keyExtractor={(m) => m.id}
        renderItem={renderMessage}
        renderSectionHeader={renderDay}
        stickySectionHeadersEnabled
        // `flex: 1`, or the thread sizes itself to its messages instead of to
        // the space between the header and the composer. Both ends of that go
        // wrong: one message and the list is short, so the composer sits
        // halfway up the screen; a full thread and it grows past the bottom,
        // taking the composer off the screen with it. The container style is
        // the padding inside the scroll, which is a different thing.
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 12, paddingBottom: 16 }}
        /**
         * What replaced the anchoring arithmetic.
         *
         * Loading history makes the content taller *above* the reader, which
         * used to slide everything they were reading downward — so the old code
         * recorded the height and offset before the fetch and re-derived the
         * offset from the growth afterwards, across four refs. The platform
         * does it natively: pin to the first real item and content inserted
         * above it doesn't move the viewport at all. Index 0 is the load-older
         * header, hence 1.
         */
        maintainVisibleContentPosition={{ minIndexForVisible: 1 }}
        onScroll={(e) => {
          const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
          atBottom.current =
            contentOffset.y + layoutMeasurement.height >= contentSize.height - AT_BOTTOM_SLACK;
        }}
        // The reader is driving now, so stop pinning to the bottom. Only a drag
        // counts: the programmatic scrolls below fire `onScroll` too, and
        // treating those as intent is what left the thread stranded mid-history.
        onScrollBeginDrag={() => {
          pinned.current = false;
        }}
        scrollEventThrottle={16}
        /**
         * Stay glued to the bottom, and only that.
         *
         * All three cases the old twenty-five-line handler distinguished — a new
         * message arriving, an image finishing loading and reflowing, the first
         * layout of a freshly opened thread — are the same question: does the
         * reader want to be at the bottom? Until they have dragged, yes,
         * through every step of the list measuring itself. After that, only if
         * that is where they already were.
         */
        /**
         * Two different reasons to be at the bottom, and they are not the same
         * rule.
         *
         * **Settling.** A freshly opened thread is measuring itself: a
         * screenful renders, the list measures, another batch renders, an image
         * loads and reflows. Every one of those fires this. Through all of them
         * the reader has asked for nothing and belongs at the newest message,
         * so every one of them scrolls.
         *
         * **Following.** Once the reader has dragged, the list is theirs. Being
         * near the bottom is no longer permission to move them — only a message
         * that has genuinely just arrived is, and only if they were already at
         * the bottom to see it land.
         *
         * Those were one branch (`!pinned && !atBottom` → return), which meant
         * that after a drag, *any* reflow near the bottom scrolled. Combined
         * with `maintainVisibleContentPosition` pulling the other way, that is
         * the thread jumping on its own several times on open.
         */
        onContentSizeChange={() => {
          const newest = data?.messages[data.messages.length - 1]?.id ?? null;
          const isNewMessage = lastMsgId.current !== null && newest !== lastMsgId.current;
          lastMsgId.current = newest;

          if (!(pinned.current || (atBottom.current && isNewMessage))) return;

          // Animated only for a message that has genuinely just arrived. The
          // first layout and an image reflowing must not glide — that reads as
          // the thread drifting on its own.
          //
          // The scroll responder rather than `scrollToLocation`: the end of the
          // content is past the last message — the queued-message footer and the
          // container's bottom padding both live below it — and an index-based
          // scroll would stop short of them and need guarding for a thread with
          // no messages besides.
          list.current?.getScrollResponder()?.scrollToEnd({ animated: isNewMessage });
        }}
        keyboardDismissMode="interactive"
        // Bounded work per frame. The default renders far more than a phone
        // screen can show, which is most of the cost virtualisation was for.
        initialNumToRender={18}
        maxToRenderPerBatch={12}
        windowSize={9}
        // A thread that scrolls fast shouldn't leave the reader on blank space,
        // and a bubble is cheap enough to keep a screen's worth either side.
        removeClippedSubviews={false}
        ListHeaderComponent={
          <>
            {/* Asking for history is as clear a statement of "I am reading up
                here" as a drag is, and it arrives without one — so it releases
                the bottom pin too. Otherwise the prepend's content-size change
                would scroll the reader straight back down to the newest
                message, which is the opposite of what they just asked for. */}
            <LoadOlder
              conv={data}
              onLoad={() => {
                pinned.current = false;
              }}
            />
            {/* The header is already real — it came from the row that was
                tapped — but the messages haven't landed. Say so, rather than
                showing what looks like a conversation nobody has written in. */}
            {conv.isPlaceholderData ? (
              <View className="items-center py-10">
                <Loading />
              </View>
            ) : null}
          </>
        }
        ListFooterComponent={
          // Written but not yet accepted by the server — shown in place so a
          // reply composed offline doesn't look like it vanished. Then whoever
          // is writing back, last, because that is the next thing to arrive.
          <>
            {queue.forConversation(id).map((q) => (
              <QueuedBubble
                key={q.id}
                item={q}
                onRetry={() => void queue.retry(q.id)}
                onDiscard={() => void queue.discard(q.id)}
              />
            ))}
            {typing ? <TypingBubble typing={typing} /> : null}
          </>
        }
      />

      <KeyboardAvoidingView behavior="padding" keyboardVerticalOffset={0}>
        {closed ? (
        <View style={{ backgroundColor: c.surface, borderTopColor: c.border }} className="border-t px-4 py-3">
          <Text className="text-center text-md text-muted">
            This conversation is resolved.{" "}
            <Text
              onPress={() => setStatus.mutate({ id: data.id, status: "open" })}
              style={{ color: c.brand }}
              className="font-medium"
            >
              Reopen
            </Text>{" "}
            to reply.
          </Text>
        </View>
        ) : (
          <Composer
            conv={data}
            replyTo={replyTo}
            onClearReply={() => setReplyTo(null)}
            ccPrefill={ccPrefill}
          />
        )}
        <BottomInset />
      </KeyboardAvoidingView>

      <ActionSheet visible={sheet === "assign"} title="Assign this conversation" actions={assignActions} onClose={() => setSheet(null)} />
      <ActionSheet visible={sheet === "snooze"} title="Snooze until…" actions={snoozeActions} onClose={() => setSheet(null)} />
      <DetailsPanel
        conv={data}
        visible={sheet === "details"}
        onClose={() => setSheet(null)}
        onOpenConversation={(id) => router.replace({ pathname: "/(app)/thread/[id]", params: { id } })}
        onOpenLog={() => setSheet("log")}
      />
      <ConversationLogSheet conversationId={data.id} visible={sheet === "log"} onClose={() => setSheet(null)} />
      <ReadLog message={readLog} visible={!!readLog} onClose={() => setReadLog(null)} />
      <MessageActions
        message={acting}
        conv={data}
        onReact={(emoji) => {
          haptics.select();
          react.mutate({ conversationId: data.id, messageId: acting!.id, emoji });
        }}
        onReply={() => setReplyTo(acting)}
        onReplyAll={(cc) => setCcPrefill({ at: Date.now(), addresses: cc })}
        onForward={() => {
          // Two different acts behind one word: a WhatsApp forward drops this
          // into another customer's chat, an email forward sends it to typed
          // addresses. The channel decides which sheet opens.
          if ((acting?.channel ?? data.channel) === "email") setEmailForwarding(acting);
          else setForwarding(acting);
        }}
        onReceipts={() => setReadLog(acting)}
        onDiscuss={
          chatOn
            ? () => {
                const m = acting;
                if (!m) return;
                const words = m.body.replace(/\s+/g, " ").trim();
                setSharing({
                  message: {
                    id: m.id,
                    who: m.internal ? `Note · ${m.authorName ?? "Teammate"}` : m.authorName || (m.direction === "in" ? data.contact.displayName : "Teammate"),
                    text: words.length > 120 ? `${words.slice(0, 119)}…` : words || "📎 Attachment",
                  },
                });
              }
            : undefined
        }
        onClose={() => setActing(null)}
        selfAddresses={[inboxes.data?.find((i) => i.id === data.inboxId)?.handle]}
      />
      <ForwardSheet
        message={forwarding}
        busy={forward.isPending}
        onSubmit={submitForward}
        onClose={() => setForwarding(null)}
      />
      <EmailForwardSheet
        message={emailForwarding}
        busy={sendEmail.isPending}
        onSubmit={(to, note) => {
          const m = emailForwarding;
          if (!m) return;
          // Same body the web builds, from the same function — see
          // `buildForwardedEmail`. `forwardTo` makes the server send it as a
          // fresh "Fwd:" rather than as a reply to the customer.
          sendEmail.mutate({
            id: data.id,
            body: note.trim(),
            bodyHtml: buildForwardedEmail(m, {
              note,
              fallbackSubject: data.subject,
              fromLabel: data.contact.displayName,
            }),
            forwardTo: to,
            // The original's attachments go along with it.
            forwardOfId: m.id,
          });
          setEmailForwarding(null);
        }}
        onClose={() => setEmailForwarding(null)}
      />
      <ActionSheet visible={sheet === "more"} title={data.contact.displayName} actions={moreActions} onClose={() => setSheet(null)} />
      <LabelSheet conv={data} visible={sheet === "labels"} onClose={() => setSheet(null)} />
      <ShareSheet
        visible={!!sharing}
        conversationId={data.id}
        contactName={data.contact.displayName}
        message={sharing?.message ?? null}
        onClose={() => setSharing(null)}
        onDone={(text) => toast({ text })}
      />
      <DiscussionSheet
        conversationId={data.id}
        cardId={discussion}
        onClose={() => setDiscussion(null)}
        onOpenChat={(roomId) => router.push({ pathname: "/(app)/chat/[id]", params: { id: roomId } })}
      />
    </View>
  );
}


/**
 * Somebody is writing, shown at the foot of the thread where their message will
 * land.
 *
 * It used to live in the header, taking over the assignee line. That was a
 * reasonable read of a phone's cramped chrome and a bad read of what a chat is:
 * nobody looks at the top of the screen to find out whether a reply is coming,
 * because no messaging app has put it there in a decade. It belongs at the
 * bottom of the messages, in the place the message itself is about to occupy.
 *
 * On NestChat it also carries their draft as they write it. Outlined rather than
 * filled, because an unsent sentence must not be able to pass for a message that
 * arrived — every real bubble on this screen has a fill, so having none is the
 * difference you notice before you read the label.
 *
 * The web draws that outline dashed. This doesn't: Android ignores
 * `borderStyle: "dashed"` on anything with a border radius and quietly draws a
 * solid line, so asking for it here would mean the comment and the phone
 * disagreed. An unfilled bubble carries the meaning on its own.
 */
function TypingBubble({ typing }: { typing: TypingPresence }) {
  const { c } = useTheme();
  return (
    <Animated.View entering={enter.row} className="mt-1.5 flex-row px-3">
      <View
        style={{
          backgroundColor: typing.preview ? "transparent" : c.surface,
          borderColor: c.border,
          borderWidth: typing.preview ? 1 : 0,
          maxWidth: "82%",
        }}
        className="rounded-2xl rounded-bl-md px-3 py-2"
      >
        {typing.preview ? (
          <>
            <Text style={{ color: c.textFaint }} className="text-2xs font-semibold uppercase tracking-wide">
              {`${typing.who} is typing`}
            </Text>
            <Text style={{ color: c.textMuted }} className="mt-0.5 text-md leading-snug">
              {typing.preview}
            </Text>
          </>
        ) : (
          <Text style={{ color: c.textMuted }} className="text-xs font-medium">
            {`${typing.who} is typing…`}
          </Text>
        )}
      </View>
    </Animated.View>
  );
}

function Header({
  conv,
  insetTop,
  onDetails,
  onMore,
}: {
  conv: ConversationWithMessages;
  /** Status-bar height. The header owns the top safe area because it's the
   *  topmost thing on the screen and a plain View can be relied on to apply
   *  padding it's given. */
  insetTop: number;
  onDetails: () => void;
  onMore: () => void;
}) {
  const { c } = useTheme();
  const ChannelGlyph = channelMeta(conv.channel).Glyph;
  // One countdown on screen rather than forty, so this can afford the precise
  // one. `slaCountdown` renders seconds, so it needs a second to tick on.
  const { slaText, slaOver, statusText } = threadClocks(conv, useNow(1_000));

  return (
    <View
      style={{ borderBottomColor: c.border, backgroundColor: c.surface, paddingTop: insetTop }}
      className="flex-row items-center gap-2.5 border-b px-2 pb-2 pt-2"
    >
      <Touchable feel="chip" onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back to inbox" hitSlop={12} className="px-1">
        <BackIcon size={24} color={c.brand} />
      </Touchable>
      <Avatar name={conv.contact.displayName} color={conv.contact.avatarColor} size={38} />
      <View className="flex-1">
        {/* Name and channel sit on one line, as on the web: the glyph is the
            thread's identity, so it belongs beside the name, not below it. */}
        <View className="flex-row items-center gap-1.5">
          <Text numberOfLines={1} className="flex-shrink text-lg font-semibold leading-tight text-fg">
            {conv.contact.displayName}
          </Text>
          <ChannelGlyph size={13} color={channelColor(conv.channel, c)} />
        </View>
        {/* An email thread is identified by its subject, not by who it's with —
            "Re: invoice 4471" is the thread; the customer may have five. Shown
            above the assignee line, and only when it says something the name
            doesn't already (a thread with no subject falls back to the contact's
            name server-side, and repeating it twice is noise). */}
        {conv.subject && conv.subject !== conv.contact.displayName ? (
          <Text numberOfLines={1} className="text-2xs font-semibold leading-snug text-fg">
            {conv.subject}
          </Text>
        ) : null}
        {/* SLA first, because it's the only part of this line that expires. The
            line truncates from the right, so what gets cut when the name is long
            is the name — which you can also see two lines up — rather than the
            countdown, which is nowhere else on this screen.

            Typing used to take this line over. It lives at the foot of the
            thread now (see TypingBubble), which is where every messaging app has
            put it for a decade and where the person reading is already looking;
            the header goes back to saying the one thing only it can say. */}
        <Text numberOfLines={1} className="text-2xs leading-snug text-faint">
          {slaText ? (
            <Text style={{ color: slaOver ? c.danger : c.amber }} className="font-semibold">
              {slaText}
              {" · "}
            </Text>
          ) : null}
          {statusText}
          {conv.assigneeName ? `Assigned to ${conv.assigneeName}` : "Unassigned"}
        </Text>
      </View>
      <Touchable feel="chip" onPress={onDetails} accessibilityRole="button" accessibilityLabel="Conversation details" hitSlop={12} className="px-1.5">
        <DetailsIcon size={20} color={c.textMuted} />
      </Touchable>
      <Touchable feel="chip" onPress={onMore} accessibilityRole="button" accessibilityLabel="More actions" hitSlop={12} className="px-1.5">
        <MoreIcon size={20} color={c.textMuted} />
      </Touchable>
    </View>
  );
}

/**
 * Scroll-up history. The thread loads its tail; earlier messages come on
 * request rather than pulling a year of email onto a phone unasked.
 *
 * It used to have to tell the thread where the reader was standing before
 * fetching, so the arriving history could be subtracted back out of the scroll
 * offset. The list pins its own position now
 * (`maintainVisibleContentPosition`), so this only has to ask for the messages.
 */
function LoadOlder({
  conv,
  onLoad,
}: {
  conv: ConversationWithMessages;
  /** Fired on press — the thread reads it as "I am up here reading history". */
  onLoad: () => void;
}) {
  const { c } = useTheme();
  const { loadOlder, loading } = useLoadOlderMessages(conv.id);
  if (!conv.hasMoreMessages) return null;
  return (
    <Touchable feel="chip"
      disabled={loading}
      onPress={() => {
        onLoad();
        void loadOlder();
      }}
      accessibilityRole="button"
      accessibilityState={{ busy: loading }}
      className="items-center py-2"
    >
      <Text style={{ color: c.brand }} className="text-sm font-medium">
        {loading ? "Loading…" : "Load earlier messages"}
      </Text>
    </Touchable>
  );
}

/**
 * One message.
 *
 * Memoised, and every prop is either a primitive or an object whose identity
 * only changes when the thing it describes changes: a message, the one message
 * it quotes, and handlers that take the message as an argument rather than
 * capturing it. That is the whole reason the signature looks like this instead
 * of taking `conv` and a set of closures — see the block above the render loop.
 */
const Bubble = memo(function Bubble({
  message,
  channel,
  contactName,
  quoted,
  onJumpTo,
  highlighted,
  meId,
  continues,
  endsRun,
  showSubject,
  firstOfDay,
  lastOfDay,
  onRetry,
  onLongPress,
  onReply,
  onRemoveReaction,
  onOpenReadLog,
  sentFrom,
}: {
  message: Message;
  channel: ChannelType;
  contactName: string;
  /** The message this one quotes, already resolved by the parent. */
  quoted?: Message;
  /** Scroll the thread to a message — what tapping the quote does. */
  onJumpTo?: (messageId: string) => void;
  /** Briefly flashed because a jump just landed here. */
  highlighted?: boolean;
  meId?: string;
  continues: boolean;
  /** Last of a run — i.e. not followed by the same speaker. Carries the tail. */
  endsRun: boolean;
  /** Email only: whether this message's subject is news (the thread's first, or
   *  a rename) rather than the same line as the message above it. */
  showSubject?: boolean;
  /** Directly under a date divider, and directly above one. Between them these
   *  put the divider's air on the side it belongs to; see `gapTop` below. */
  firstOfDay?: boolean;
  lastOfDay?: boolean;
  onRetry: (m: Message) => void;
  onLongPress: (m: Message) => void;
  onReply: (m: Message) => void;
  onRemoveReaction: (m: Message) => void;
  onOpenReadLog: (m: Message) => void;
  /** Which of our numbers/addresses this went from — set ONLY when it isn't the
   *  thread's usual one. Resolved by the parent, which holds the inbox list. */
  sentFrom?: string;
}) {
  const { c } = useTheme();
  const mine = message.direction === "out";

  /**
   * The air around a bubble, including the air a date divider needs.
   *
   * A divider says "everything from here is a new day", so it belongs to what
   * follows it — it should sit close under nothing and close *over* the first
   * message of its day. It was the other way round: 12pt above, 22pt below,
   * which read as the date trailing the conversation it had just ended rather
   * than heading the one it was starting.
   *
   * The correction is here rather than on the divider's own padding because the
   * divider is sticky: padding travels with it, so putting 20pt on top of the
   * pill would leave a 20pt hole under the header for as long as that day is on
   * screen. A margin on the message before it scrolls away like everything else.
   *
   * Then it overcorrected. With the pill's own `pt-1.5 pb-1` the sums came to
   * 21pt above and 3.5pt below, and 3.5pt is not "close", it is touching — the
   * first message of a day sat against the underside of the date. These two
   * numbers make it 25 above and 9.5 below: still the same statement about
   * which day the pill belongs to, without the first message crowding it.
   */
  const gapTop = firstOfDay ? 6 : continues ? 2 : 10;
  const gapBottom = lastOfDay ? 20 : 0;
  /** Height of the bubble alone — not the row, which also carries the gap above
   *  and any reaction chip below. The swipe-to-reply arrow lines up with this. */
  const [bubbleH, setBubbleH] = useState(0);

  if (message.internal) {
    const byMe = message.authorUserId === meId;
    return (
      <Animated.View
        testID={`msg-${message.id}`}
        entering={enter.row}
        className={byMe ? "items-end" : "items-start"}
        style={{ marginTop: gapTop, marginBottom: gapBottom }}
      >
        <View style={{ backgroundColor: c.amberTint, borderColor: c.amber, maxWidth: "86%" }} className="rounded-16 border px-3.5 py-2.5">
          {!continues ? (
            <Text style={{ color: c.amber }} className="pb-1 text-2xs font-semibold uppercase tracking-wide">
              Internal note · {message.authorName ?? "Teammate"}
            </Text>
          ) : null}
          <NoteBody body={message.body} color={c.amber} />
          <Attachments items={message.attachments ?? []} mine />
          <Text className="pt-1 text-right text-2xs text-faint">{clockTime(message.createdAt)}</Text>
        </View>
      </Animated.View>
    );
  }

  // Swipe-to-reply only where a reply means something: WhatsApp threads a
  // quoted reply, email does not, and an internal note has no customer to
  // quote out to.
  const canSwipe =
    !message.internal && (channel === "whatsapp" || channel === "whatsapp_group");

  // Only an outbound email has tracked recipients.
  const read = mine && !message.internal ? readSummary(message) : null;

  const on = message.channel ?? channel;
  const isEmail = on === "email";
  /**
   * Who is talking, split the way the web splits it.
   *
   * Inbound gets a name above the run — in a group that's essential, and in a
   * 1:1 it's what makes an imported or forwarded message attributable. Outbound
   * gets its author in the stamp row instead (`sentBy` below): a shared inbox
   * has several agents replying into one thread, and without a name every reply
   * reads as "the business" — you can't tell your own from a colleague's, which
   * is the first thing you need to know before answering a customer.
   *
   * Two different placements because they're two different questions. Inbound is
   * "who is this?", which you need before reading. Outbound is "who handled
   * this?", which is metadata and belongs next to the time.
   */
  const senderName = !mine ? (message.authorName ?? (channel === "whatsapp_group" ? contactName : null)) : null;
  const sentBy = mine && !message.internal ? (message.authorName ?? null) : null;
  /**
   * Email is drawn as paper, not as speech.
   *
   * The web makes the same split: an email bubble drops the outbound green tint
   * and becomes a lifted card in both directions, because an email you sent and
   * an email you received are the same kind of object — a document with a
   * subject and recipients — and tinting one of them green makes a mixed thread
   * lie about which of the two you're reading.
   *
   * `elevated` rather than the web's literal `#fff`: the web is showing the
   * sender's own HTML, which is authored for a white page, so it pins the card
   * white even in dark mode. This app re-renders the email in its own type
   * through {@link EmailBody}, so the card follows the theme — pinning it white
   * would leave dark text on a dark ground everywhere except the card.
   */
  const fill = isEmail ? c.elevated : mine ? c.brandTint : c.surface;
  /**
   * A tail marks speech, so only conversation gets one — and only where a turn
   * *ends*, which is what makes a run of five messages read as one person
   * talking rather than five separate cards. Last of the run, bottom outer
   * corner: the same rule and the same corner as the web, because the two
   * clients showing one thread differently is worse than either choice.
   *
   * Email is deliberately excluded. An email isn't an utterance, it's a
   * document: it has a subject, recipients and a signature, and drawing it as a
   * speech bubble makes a mixed thread lie about which of the two you're
   * looking at. It gets width instead, since that's what its content needs.
   */
  const tailed = endsRun && !isEmail;

  return (
    <SwipeToReply
      onReply={() => onReply(message)}
      mine={mine}
      enabled={canSwipe}
      anchorCenter={bubbleH ? gapTop + bubbleH / 2 : 0}
    >
    <Animated.View
      testID={`msg-${message.id}`}
      entering={enter.row}
      className={mine ? "items-end" : "items-start"}
      style={{
        marginTop: gapTop,
        marginBottom: gapBottom,
        // The flash after a jump, on the row rather than the bubble. The bubble
        // can't take it: its fill is shared with the tail, which is a separate
        // filled shape, and tinting one without the other splits what is
        // supposed to read as a single object. A border is out for the same
        // reason — see the note below. A band behind the whole row also says
        // "here" more clearly at arm's length, and costs no layout: no padding
        // changes, so nothing moves when it clears.
        backgroundColor: highlighted ? c.brandTint : undefined,
        borderRadius: highlighted ? 12 : 0,
      }}
    >
      <Pressable
        onLayout={(e) => setBubbleH(e.nativeEvent.layout.height)}
        onLongPress={() => onLongPress(message)}
        delayLongPress={280}
        accessibilityRole="button"
        accessibilityLabel={`Message: ${message.body || "attachment"}. Long press for actions.`}
        style={{
          backgroundColor: fill,
          // An email gets width rather than a lift. It carried a card shadow for
          // a while, on the theory that light mode's surfaces are too close to
          // separate an email from a message without one — but the thing it is
          // being separated *from* is a tinted WhatsApp bubble, and against that
          // a plain white card is already unmistakable. The shadow only made the
          // thread look like two apps stacked.
          maxWidth: isEmail ? "94%" : "86%",
          // The tailed corner squares off. A tail growing out of a 16pt curve
          // leaves a visible sliver of background between the two shapes; at 2pt
          // they read as one shape.
          ...(tailed
            ? mine
              ? { borderBottomRightRadius: tailCorner }
              : { borderBottomLeftRadius: tailCorner }
            : null),
        }}
        // No border. The tail is a filled shape in this same colour, and a
        // border is the one thing that makes it impossible for the two to read
        // as one object — see the note at the top of Tail.tsx. The thread's
        // ground carries the separation instead.
        className="rounded-16 px-3.5 py-2.5"
      >
        {tailed ? <Tail mine={mine} fill={fill} /> : null}

        {/* Who is talking, above the first bubble of each run.
            
            Outbound needs this as much as inbound: a shared inbox has several
            agents replying into the same thread, and without a name every reply
            reads as "the business" — you can't tell your own message from a
            colleague's, which is exactly what you need to know before you answer
            a customer. The customer's own name is redundant in a 1:1 (the header
            already says who they are), so it's shown only in a group, where
            several people speak from that side. */}
        {!continues && senderName ? (
          <Text style={{ color: c.group }} className="pb-0.5 text-2xs font-semibold">
            {senderName}
          </Text>
        ) : null}

        {/* WhatsApp's "Forwarded" tell, above the content it qualifies: these
            aren't the sender's own words. Kept at the weight of the timestamp so
            it reads as chrome rather than as part of the message. */}
        {message.forwarded ? (
          <View className="flex-row items-center gap-1 pb-1">
            <ForwardIcon size={12} color={c.textFaint} />
            <Text style={{ color: c.textFaint }} className="text-2xs italic">
              Forwarded
            </Text>
          </View>
        ) : null}
        {/* Nest said this, not a person: the website chat's reply while nobody
            was online. */}
        {message.auto ? (
          <View className="flex-row items-center gap-1 pb-1">
            <Text style={{ color: c.textFaint }} className="text-2xs italic">
              Automatic reply · nobody was online
            </Text>
          </View>
        ) : null}

        {/* Tap to go to what's being quoted. It has always looked like a link
            and done nothing, which is the one behaviour a quote in a chat app
            has everywhere else. */}
        {quoted ? (
          <Touchable
            feel="chip"
            onPress={() => onJumpTo?.(quoted.id)}
            disabled={!onJumpTo}
            accessibilityRole="button"
            accessibilityLabel={`Reply to ${quoted.direction === "out" ? "your message" : contactName}: ${
              quoted.body || "attachment"
            }. Tap to go to it.`}
            style={{ borderLeftColor: mine ? c.brandStrong : c.borderStrong, backgroundColor: c.surface2 }}
            className="mb-1.5 rounded-8 border-l-2 px-2.5 py-1.5"
          >
            <Text numberOfLines={1} className="text-2xs font-medium text-muted">
              {quoted.direction === "out" ? "You" : contactName}
            </Text>
            <Text numberOfLines={2} className="text-sm text-muted">
              {quoted.body || "Attachment"}
            </Text>
          </Touchable>
        ) : null}

        {/* Email carries structure worth keeping — headings, lists, links, a
            subject, and usually the whole thread quoted underneath. Rendering
            it as one run of plain text throws all of that away and produces a
            wall nobody reads. */}
        {isEmail ? (
          <EmailBody message={message} showSubject={showSubject} />
        ) : message.body ? (
          <Text className="text-lg leading-snug text-fg">
            <LinkedText text={message.body} />
          </Text>
        ) : null}
        <Attachments items={message.attachments ?? []} mine={mine} />

        <View className="flex-row items-center justify-end gap-1.5 pt-1">
          {/* A sent email says how many recipients opened it, and opens the
              per-person log. Email has no real delivery receipt, so this is the
              only honest answer to "did they see it". */}
          {read ? (
            <Touchable feel="chip"
              onPress={() => onOpenReadLog(message)}
              accessibilityRole="button"
              accessibilityLabel={`Read receipts: ${read.seen} of ${read.total} opened`}
              hitSlop={6}
              className="flex-row items-center gap-1"
            >
              <EyeIcon size={13} color={read.seen ? c.email : c.textFaint} />
              <Text
                style={{ color: read.seen ? c.email : c.textFaint }}
                className="text-2xs font-medium"
              >
                {read.seen}/{read.total}
              </Text>
            </Touchable>
          ) : null}
          {/* "Sent by Nathan A ·" — the same place and the same wording the web
              uses, so a thread read on a phone attributes replies identically to
              one read at a desk. Capped so a long name can't push the time and
              ticks off the end of a narrow bubble. */}
          {sentBy ? (
            <Text numberOfLines={1} className="max-w-[140px] text-2xs text-faint">
              Sent by {sentBy} ·
            </Text>
          ) : null}
          {/* Only when this went from somewhere other than the thread's usual
              number — the rare case, and the one nothing else on screen would
              show. On every bubble it would be noise. */}
          {sentFrom ? (
            <Text numberOfLines={1} className="max-w-[140px] text-2xs text-faint">
              from {sentFrom} ·
            </Text>
          ) : null}
          <Text className="text-2xs text-faint">{clockTime(message.createdAt)}</Text>
          {/* One status marker, never two. Where an email has tracked
              recipients the open count above is strictly the better answer —
              it's measured rather than inferred — and a second double-tick
              beside it would be the same claim told two ways. */}
          {mine && !read ? <Ticks status={message.status} /> : null}
        </View>
      </Pressable>

      <Reactions
        reactions={message.reactions ?? []}
        mine={mine}
        contactName={contactName}
        onRemove={() => onRemoveReaction(message)}
      />

      {mine && message.status === "failed" ? (
        <Touchable feel="chip" onPress={() => onRetry(message)} accessibilityRole="button" className="px-1 pt-1">
          <Text style={{ color: c.brand }} className="text-2xs font-medium">
            Retry{message.failureReason ? ` · ${message.failureReason}` : ""}
          </Text>
        </Touchable>
      ) : null}
    </Animated.View>
    </SwipeToReply>
  );
});
