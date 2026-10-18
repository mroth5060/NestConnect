import { useEffect, useMemo, useState } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import type { ConversationWithMessages, Message } from "@ding/schemas";
import { replyAllRecipients } from "@ding/client";
import { EyeIcon, ForwardIcon, ReplyAllIcon, ReplyIcon, TeamChatIcon } from "../icons";
import { fadeTo, spring, springTo, stagger, timing } from "../motion";
import { elevation, useTheme, useThemeVars } from "../theme";
import { readSummary } from "./ReadLog";
import { useInsets } from "../insets";
import { useModalSlot } from "../modal-slot";
import { useStableCallback } from "../stable-callback";
import { Touchable } from "./Touchable";

/**
 * A heavier dim than the shared sheet scrim.
 *
 * A bottom sheet only has to push back what's directly behind it. This overlay
 * covers the whole screen and floats a copy of the held message, so at the
 * sheet's 30% the real bubble stays fully legible right next to its own preview
 * and the two read as a duplicate rather than as a lifted item over a
 * backgrounded thread. Same idea as an iOS context menu.
 */
const HOLD_SCRIM = { light: "rgba(24,24,22,.55)", dark: "rgba(0,0,0,.72)" } as const;

/** The same six the web offers, in the same order — a reaction should mean the
 *  same thing to an agent whichever screen they're on. */
const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

/**
 * Gap between one emoji arriving and the next.
 *
 * Six of them at 26ms is 130ms end to end — long enough that the row reads left
 * to right instead of blinking on as a block, short enough that the last one has
 * landed before a thumb could reach it. It is the same number the web overlay
 * uses (`animationDelay: ${i * 26}ms`), which is the point: this is the one
 * screen the two platforms are supposed to feel identical on.
 */
const REACTION_STEP = 26;

/** One line describing a message with no text of its own, so the preview under
 *  the reaction row still says what you're acting on. */
function summarise(m: Message): string {
  const body = m.body?.trim();
  if (body) return body;
  const a = m.attachments?.[0];
  if (a) {
    switch (a.kind) {
      case "image": return "Photo";
      case "video": return "Video";
      case "voice": return "Voice message";
      case "audio": return "Audio";
      case "sticker": return "Sticker";
      default: return a.filename || "Document";
    }
  }
  if (m.messageType === "location") return "Location";
  if (m.messageType === "contact") return "Contact";
  return "Message";
}

/**
 * What you can do to one message — laid out the way WhatsApp lays it out.
 *
 * The reactions come down from the top and the actions come up from the bottom,
 * with the held message sitting between them. That split isn't decoration: the
 * two are different kinds of choice. Reacting is one tap on a thing you can see
 * at a glance, so it belongs where your eye already is; the actions are a list
 * you read, so they belong under your thumb. Stacking both into one bottom sheet
 * — which is what this was — buries the six emoji above a list and makes the
 * quick thing the slow one.
 *
 * Both halves ride one shared progress value so they arrive together rather than
 * as two animations that happen to overlap, and the whole thing is held mounted
 * through the exit so it can animate out (a Modal unmounts the frame `visible`
 * flips, which would kill it).
 */
export function MessageActions({
  message,
  conv,
  onReact,
  onReply,
  onReplyAll,
  onForward,
  onReceipts,
  onDiscuss,
  onClose,
  selfAddresses,
}: {
  message: Message | null;
  conv: ConversationWithMessages;
  onReact: (emoji: string) => void;
  onReply: () => void;
  /** Reply, copying everyone else who was on this email. Only offered when
   *  there *is* somebody else — see `hasOtherRecipients`. */
  onReplyAll: (cc: string[]) => void;
  onForward: () => void;
  onReceipts: () => void;
  /** Take this message to a Team Chat to discuss (only while Team Chat is on). */
  onDiscuss?: () => void;
  onClose: () => void;
  /** Our own addresses, so reply-all never copies the inbox back into itself. */
  selfAddresses?: (string | null | undefined)[];
}) {
  const insets = useInsets();
  const { c, scheme } = useTheme();
  const themeVars = useThemeVars();

  // The message is held for the length of the exit so the sheet has something to
  // render on the way out; `message` itself goes null as soon as it's dismissed.
  //
  // How long that is, and when the Modal may go up in the first place, is the
  // slot's to decide. Every row in here closes this sheet and opens another in
  // the same breath — Forward especially — which leaves two modals mounted
  // through this exit, and iOS presents only the first of those. See
  // `modal-slot.ts`.
  const [shown, setShown] = useState<Message | null>(message);
  const { mounted, presenting } = useModalSlot(!!message, timing.base.duration + 40);
  const open = useSharedValue(0);

  useEffect(() => {
    if (message) setShown(message);
  }, [message]);

  useEffect(() => {
    open.value = presenting ? springTo(1, spring.settle) : fadeTo(0, timing.base);
  }, [presenting, open]);

  // Let go of the message only once the sheet is off screen, so the rows don't
  // blank out mid-fade.
  useEffect(() => {
    if (!mounted) setShown(null);
  }, [mounted]);

  /**
   * Both of these carry their own geometry rather than leaving it to a
   * `className` alongside. An animated style in `style` displaces everything
   * else on the element — the class-derived rules and any sibling style object
   * — so a scrim written as `className="absolute inset-0"` plus an animated
   * opacity had neither its position nor its colour. See
   * `scripts/check-layout-rules.mjs`, which now refuses that shape.
   */
  const scrim = useAnimatedStyle(() => ({
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    backgroundColor: HOLD_SCRIM[scheme],
    opacity: open.value,
  }));
  // The top half drops in a short distance — it's already near where you were
  // looking, so it needs to appear, not travel.
  const top = useAnimatedStyle(() => ({
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    paddingTop: insets.top + 56 + 12,
    // `px-4` was 14, not 16: NativeWind's rem on native is 14.
    paddingHorizontal: 14,
    opacity: open.value,
    transform: [{ translateY: (1 - open.value) * -22 }],
  }));
  // Same drag-to-dismiss as every other sheet. This one owns its own Modal
  // rather than going through `Sheet` — it has a top half as well as a bottom
  // one — so it needs its own copy of the gesture and, critically, its own
  // gesture root: handlers get no touches inside a Modal without one.
  const drag = useSharedValue(0);
  // Built once, like the Sheet's: see `useStableCallback`.
  const close = useStableCallback(onClose);
  const pan = useMemo(() => Gesture.Pan()
    .onUpdate((e) => {
      drag.value = Math.max(0, e.translationY);
    })
    .onEnd((e) => {
      if (e.translationY > 90 || e.velocityY > 700) {
        runOnJS(close)();
        return;
      }
      drag.value = springTo(0, spring.settle);
    }), [drag, close]);

  const bottom = useAnimatedStyle(() => ({
    transform: [{ translateY: `${(1 - open.value) * 100}%` }, { translateY: drag.value }],
  }));

  if (!shown || !mounted) return null;

  const isWhatsApp = conv.channel === "whatsapp" || conv.channel === "whatsapp_group";
  // Quoting threads on WhatsApp and nowhere else — an email "quote" is just
  // pasted text, which the composer already does.
  const canQuote = isWhatsApp && !shown.internal;
  const isEmail = (shown.channel ?? conv.channel) === "email";
  /**
   * Forwarding sends this content somewhere else, so an internal note is never
   * forwardable — the server refuses it too.
   *
   * Email used to be excluded here with the note that "that forward is an
   * addressed one, and it lives on the web". It doesn't any more: an addressed
   * forward is a sheet with a recipients field, which a phone can show as
   * readily as a laptop, and being able to pass a customer's email to a
   * colleague only from a desk is the sort of gap that sends people back to
   * Gmail.
   */
  const canForward = (isWhatsApp || isEmail) && !shown.internal;
  // Reply-all only when it differs from reply. Two rows that do the same thing
  // is a menu with a decoy in it.
  const replyAllCc = isEmail && !shown.internal
    ? replyAllRecipients(shown, { exclude: selfAddresses })
    : [];
  // Read receipts: only a sent email has tracked recipients to report on.
  const receipts = shown.direction === "out" && !shown.internal ? readSummary(shown) : null;
  // "by: user" is our side of the conversation — an agent's reaction, as opposed
  // to the customer's. That's as fine-grained as the model gets: WhatsApp allows
  // one reaction per participant, so the business has exactly one.
  const ours = shown.reactions?.filter((r) => r.by === "user").map((r) => r.emoji) ?? [];

  return (
    <Modal
      visible
      transparent
      animationType="none"
      accessibilityViewIsModal
      onRequestClose={onClose}
      statusBarTranslucent
    >
      {/* A Modal renders outside the root that publishes the palette, so the
          scheme's variables are re-applied here.

          `justify-end` — not `mt-auto` on the sheet — is what pins the bottom
          half down, and the only in-flow child is that sheet. This is byte for
          byte the root `Sheet` uses, which is deliberate: `mt-auto` here put the
          sheet at the *top* on an Android device while laying out correctly in a
          browser. Tailwind does emit the rule, NativeWind does translate it, and
          Yoga does implement auto margins — so the cause is somewhere further
          down and isn't reproducible off-device. Rather than keep a construction
          that's only known to work on one of our two targets, this uses the one
          every other sheet in the app already proves on both. */}
      <GestureHandlerRootView style={{ flex: 1 }}>
      <View style={themeVars} className="flex-1 justify-end">
        {/* No className on either of these two — see `scrim` and `top`. */}
        <Animated.View style={scrim}>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" className="flex-1" />
        </Animated.View>

        {/* ---- top: react, and what you're reacting to ---- */}
        {/* Below the thread header, not on top of it — the header stays visible
            behind the dim, and a reaction pill overlapping the back button reads
            as a mistake. 56 is the header's height.
            Pinned rather than in flow because the root is now bottom-aligned for
            the sheet; anything left in flow would ride up with it. */}
        <Animated.View style={top} pointerEvents="box-none">
          {/* Keyed on the message so the emoji replay their entrance every time
              the overlay opens. Without it, holding a second message while the
              first is still animating out reuses the mounted buttons and the
              row simply appears. */}
          <View
            key={shown.id}
            style={[{ backgroundColor: c.elevated, borderColor: c.border }, elevation.float]}
            className="flex-row items-center justify-between gap-0.5 self-center rounded-full border px-2 py-1.5"
          >
            {QUICK_REACTIONS.map((e, i) => (
              <ReactionButton
                key={e}
                emoji={e}
                index={i}
                // A reaction already left is a toggle — sending the same emoji
                // again clears it, which is what the server does.
                on={ours.includes(e)}
                onPress={() => {
                  onReact(e);
                  onClose();
                }}
              />
            ))}
          </View>

          {!isWhatsApp ? (
            <Text className="mt-2 self-center text-2xs text-faint">
              Only your team sees this reaction — email has none to deliver.
            </Text>
          ) : null}
        </Animated.View>

        {/* ---- bottom: the list you read ---- */}
        <Animated.View style={bottom}>
          {/* A View, not a tap sink. This carried the same empty-`onPress`
              `Pressable` the shared Sheet did, and for the same imagined
              reason — stopping a tap from reaching the scrim, which is a
              sibling behind this and cannot be reached through it. There it
              cost the details sheet its scrolling, because a JS responder that
              claims on touch-down blocks the native scroll view under it on
              Android. Nothing here scrolls today, so it cost nothing here — but
              leaving the shape in place is leaving the trap set for whoever
              adds a list to this sheet. */}
          <View
            style={[
              { backgroundColor: c.elevated, paddingBottom: insets.bottom + 12 },
              // Casts upward: it's flush with the bottom of the screen, so its
              // top edge is the only one that can show any depth against the
              // dimmed thread behind it.
              elevation.lift,
            ]}
            className="rounded-t-24 px-4 pt-3"
          >
            {/* The handle is the drag target, as on the shared Sheet. */}
            <GestureDetector gesture={pan}>
              <View className="items-center pb-2.5" accessible={false}>
                <View style={{ backgroundColor: c.borderStrong }} className="h-1 w-9 rounded-full" />
              </View>
            </GestureDetector>

            {/* What the actions below apply to. It belongs here rather than
                floating over the thread: the real bubble is still on screen
                behind the dim, and a second copy of it out in the middle
                overlaps the original and reads as a duplicate. As the sheet's
                header it's a label, which is what it actually is. */}
            <Text numberOfLines={2} className="pb-1 text-sm text-muted">
              {summarise(shown)}
            </Text>

            {canQuote || isEmail ? (
              <Row
                icon={<ReplyIcon size={19} color={c.textMuted} />}
                label="Reply"
                onPress={() => { onReply(); onClose(); }}
              />
            ) : null}
            {replyAllCc.length ? (
              <Row
                icon={<ReplyAllIcon size={19} color={c.textMuted} />}
                label="Reply all"
                trailing={`+${replyAllCc.length}`}
                onPress={() => { onReplyAll(replyAllCc); onClose(); }}
              />
            ) : null}
            {canForward ? (
              <Row icon={<ForwardIcon size={19} color={c.textMuted} />} label="Forward" onPress={() => { onForward(); onClose(); }} />
            ) : null}
            {receipts ? (
              <Row
                icon={<EyeIcon size={19} color={c.textMuted} />}
                label="Read receipts"
                trailing={`${receipts.seen} of ${receipts.total}`}
                onPress={() => { onReceipts(); onClose(); }}
              />
            ) : null}
            {onDiscuss ? (
              <Row icon={<TeamChatIcon size={19} color={c.textMuted} />} label="Discuss…" onPress={() => { onClose(); setTimeout(onDiscuss, 250); }} />
            ) : null}
          </View>
        </Animated.View>
      </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

/**
 * One emoji in the reaction pill.
 *
 * A component rather than a loop body because each one owns two animations, and
 * hooks can't live in a `.map`. Both are the small details that separate this
 * from a row of buttons that merely appeared:
 *
 *  - **The entrance.** It pops out of nothing — scale 0 to a little past 1 and
 *    back — a fraction of a second after the one to its left. The delay is what
 *    makes the row read as a row; the overshoot is what makes each one read as
 *    landing rather than fading up.
 *  - **The press.** Scale, not opacity. A 44pt target with a 24pt glyph in it
 *    has no visible edge to dim, so `active:opacity-60` mostly greys the emoji
 *    — which looks like it's disabled, not pressed. Shrinking it slightly is
 *    the same feedback WhatsApp gives and reads instantly at that size.
 *
 * The two multiply into one transform, so a press mid-entrance is composed with
 * it rather than fighting it.
 */
function ReactionButton({
  emoji,
  index,
  on,
  onPress,
}: {
  emoji: string;
  /** Position in the row; sets how long this one waits before arriving. */
  index: number;
  /** Already this agent's reaction — tapping clears it. */
  on: boolean;
  onPress: () => void;
}) {
  const { c } = useTheme();
  const enter = useSharedValue(0);
  const opacity = useSharedValue(0);
  const press = useSharedValue(1);

  useEffect(() => {
    // `stagger` caps the delay for long lists; six never reaches the cap, and
    // passing it explicitly keeps that true if the set ever grows.
    const wait = stagger(index, REACTION_STEP, QUICK_REACTIONS.length);
    enter.value = withDelay(wait, withSpring(1, spring.pop));
    // Opacity is a fade, so it gets a curve, and a short one: the emoji should
    // be visible for most of its own pop rather than arriving already there.
    opacity.value = withDelay(wait, withTiming(1, timing.quick));
  }, [index, enter, opacity]);

  const style = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [
      { scale: enter.value * press.value },
      // Starts 6pt low and rides up with the spring, so the pop has a direction.
      { translateY: (1 - enter.value) * 6 },
    ],
  }));

  return (
    <Animated.View style={style}>
      <Pressable
        onPress={onPress}
        onPressIn={() => {
          press.value = springTo(0.92, spring.quick);
        }}
        onPressOut={() => {
          press.value = springTo(1, spring.quick);
        }}
        accessibilityRole="button"
        accessibilityLabel={on ? `Remove ${emoji} reaction` : `React with ${emoji}`}
        accessibilityState={{ selected: on }}
        style={on ? { backgroundColor: c.brandTint } : undefined}
        className="h-11 w-11 items-center justify-center rounded-full"
      >
        <Text className="text-2xl">{emoji}</Text>
      </Pressable>
    </Animated.View>
  );
}

/** One action in the bottom list. A hairline above each keeps the rows apart
 *  without a divider under the last one. */
function Row({
  icon,
  label,
  trailing,
  onPress,
}: {
  icon: React.ReactNode;
  label: string;
  trailing?: string;
  onPress: () => void;
}) {
  const { c } = useTheme();
  return (
    <Touchable feel="row"
      onPress={onPress}
      accessibilityRole="button"
      style={{ borderTopColor: c.border }}
      className="flex-row items-center gap-3 border-t py-3.5"
    >
      {icon}
      {/* The label grows rather than the trailing text carrying `ml-auto` —
          same reason as the sheet above: auto margins have burned us on device
          once and nothing here needs them. */}
      <Text className="flex-1 text-lg font-medium text-fg">{label}</Text>
      {trailing ? <Text className="text-md text-muted">{trailing}</Text> : null}
    </Touchable>
  );
}
