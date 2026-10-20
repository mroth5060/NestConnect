import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useMemo, useState } from "react";
import { View, useWindowDimensions } from "react-native";
import { haptics } from "../haptics";
import { ReplyIcon } from "../icons";
import { useTheme } from "../theme";
import { useStableCallback } from "../stable-callback";

/**
 * `FULL` is where the arrow reaches full size; `COMMIT` is where letting go
 * actually starts a reply.
 *
 * COMMIT sits at ~80% of FULL, not at it. Two reasons, and both are about the
 * gesture being forgiving where it can afford to be:
 *
 *  - People release as they *reach* the end of a pull, not after holding it
 *    there, so a threshold at full size fires on the frame they're already
 *    easing back from. It reads as "the swipe didn't take", which is the worst
 *    outcome — you have to do it again, harder.
 *  - The pan doesn't claim the gesture until the finger has travelled
 *    `activeOffsetX`, and on some platforms translation is then reported from
 *    that point rather than from touch-down. Budgeting for the difference costs
 *    nothing; not budgeting for it makes an ordinary swipe a coin flip.
 *
 * 45pt is still well past the activation slop, so a scroll that drifts
 * sideways never trips it.
 */
const FULL = 56;
const COMMIT = 45;

/** Diameter of the arrow disc. */
const ARROW = 28;

/**
 * How close to the screen's edge a swipe can start and still be the phone's.
 *
 * iOS goes back with a swipe in from the left edge, and Android with one in
 * from either. A message row runs the full width of the screen, so a swipe
 * from the edge over somebody's message was taken as a reply and the chat
 * never closed. WhatsApp leaves the edge to the phone: a reply is a swipe on
 * the message, not one that begins at the rim. So does this.
 */
const EDGE = 30;

/**
 * Swipe a bubble to reply to it, the way WhatsApp does.
 *
 * Inbound swipes right and outbound swipes left — mirrored, because the gesture
 * pulls the message toward the middle of the screen from wherever it sits. A
 * reply arrow fades in and grows behind it, reaching full size at the commit
 * point, so the feedback tells you when you've pulled far enough before you let
 * go rather than after.
 *
 * The pan is claimed only once the finger has moved further horizontally than
 * vertically (`activeOffsetX` / `failOffsetY`), so a diagonal flick still
 * scrolls the thread instead of half-starting a reply.
 *
 * Runs on the UI thread through Reanimated: a gesture driven by React state
 * stutters on a long thread, which is exactly where people use it.
 */
export function SwipeToReply({
  onReply,
  mine,
  enabled = true,
  anchorCenter,
  children,
}: {
  onReply: () => void;
  /** Outbound messages swipe the other way. */
  mine: boolean;
  /** Off for internal notes and email, where there's nothing to reply *to*. */
  enabled?: boolean;
  /**
   * Where the middle of the *bubble* sits, measured from the top of this row.
   *
   * The row is taller than the bubble: it carries the gap above, and below the
   * bubble it may carry a reaction chip and a retry line. Centring the arrow on
   * the row therefore centres it on none of those things — with a reaction chip
   * it sat low, without one it sat high, and either way it lined up with the
   * message above or below rather than the one being swiped.
   *
   * The caller is the only place that knows which of its children is the bubble,
   * so it measures that and says. Falls back to the row's own centre when it
   * hasn't been measured yet (one frame, while the arrow is still invisible).
   */
  anchorCenter?: number;
  children: React.ReactNode;
}) {
  const { c } = useTheme();
  const { width: screen } = useWindowDimensions();
  const x = useSharedValue(0);
  // Measured height of the row, so the arrow can be centred on it explicitly.
  const [h, setH] = useState(0);
  const dir = mine ? -1 : 1;

  const commit = useStableCallback(() => {
    // Order matters: the reply is the point, the buzz is decoration. `haptics`
    // can never throw, but keeping the real work first means it stays true even
    // if that changes.
    onReply();
    haptics.tap();
  });

  // Built once per side and on/off: see `useStableCallback`.
  const pan = useMemo(() => Gesture.Pan()
    // Only a decisively horizontal drag is ours; anything vertical belongs to
    // the scroll view.
    .activeOffsetX(mine ? [-12, 99999] : [-99999, 12])
    .failOffsetY([-14, 14])
    // Begun at either edge: that's the back gesture, not a reply.
    .onTouchesDown((e, state) => {
      const at = e.allTouches[0]?.absoluteX;
      if (at !== undefined && (at < EDGE || at > screen - EDGE)) state.fail();
    })
    .enabled(enabled)
    .onUpdate((e) => {
      // Only in the one direction, and damped past the commit point so it can't
      // be dragged across the screen.
      const raw = dir * e.translationX;
      x.value = raw <= 0 ? 0 : raw <= FULL ? raw : FULL + (raw - FULL) * 0.2;
    })
    .onEnd(() => {
      if (x.value >= COMMIT) runOnJS(commit)();
      x.value = withTiming(0, { duration: 200 });
    }), [x, mine, dir, enabled, commit, screen]);

  const bubble = useAnimatedStyle(() => ({
    transform: [{ translateX: dir * x.value }],
  }));

  /**
   * The arrow behind the bubble, on the side it is pulled away from, level with
   * the middle of it.
   *
   * Everything is in this one object — position, offset, size — because on this
   * stack an animated style displaces the rest of the element's styling. A
   * `style={[hint, { position: "absolute", top: … }]}` array arrives at the view
   * as `hint` alone: no `position`, so the arrow falls back into the flow at the
   * top of the row, which is what "the arrow flies higher than the bubble" was.
   * `__tests__/interop-probe.test.tsx` measures it against an unregistered
   * component to show the interop is what drops it.
   *
   * `anchorCenter` is the caller's measurement of its own bubble; `h` is only
   * the fallback for the first frame, while the arrow is fully transparent
   * anyway. Two earlier versions centred on the wrong box — first by stretching
   * `top: 0; bottom: 0` over the row, then by measuring the row's own height —
   * and both put the arrow beside a neighbouring message.
   */
  const hint = useAnimatedStyle(() => ({
    position: "absolute",
    top: Math.max(0, (anchorCenter && anchorCenter > 0 ? anchorCenter : h / 2) - ARROW / 2),
    ...(mine ? { right: 8 } : { left: 8 }),
    height: ARROW,
    justifyContent: "center",
    opacity: interpolate(x.value, [0, FULL], [0, 1], "clamp"),
    transform: [{ scale: interpolate(x.value, [0, FULL], [0.55, 1], "clamp") }],
  }));

  if (!enabled) return <>{children}</>;

  return (
    <GestureDetector gesture={pan}>
      <View onLayout={(e) => setH(e.nativeEvent.layout.height)}>
        {/* `hint` and nothing else — see where it is defined. */}
        <Animated.View pointerEvents="none" style={hint}>
          <View
            style={{ backgroundColor: c.surface2, height: ARROW, width: ARROW }}
            className="items-center justify-center rounded-full"
          >
            <ReplyIcon size={15} color={c.textMuted} />
          </View>
        </Animated.View>

        <Animated.View style={bubble}>{children}</Animated.View>
      </View>
    </GestureDetector>
  );
}
