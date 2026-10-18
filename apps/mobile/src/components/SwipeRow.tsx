import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useMemo, useRef } from "react";
import { View } from "react-native";
import { haptics } from "../haptics";
import { useTheme } from "../theme";
import { timing } from "../motion";
import { useStableCallback } from "../stable-callback";

/**
 * `FULL` is where the action's icon reaches full size; `COMMIT` is where letting
 * go actually fires it.
 *
 * COMMIT sits short of FULL for the reason `SwipeToReply` sets out at length:
 * people release as they *reach* the end of a pull rather than after holding it
 * there, so a threshold at full size fires on the frame they are already easing
 * back from, and the swipe reads as having failed.
 */
const FULL = 92;
const COMMIT = 72;

/**
 * Swipe actions on a list row.
 *
 * A shared inbox is triaged, and triage was three taps per conversation: open
 * it, act, come back. The gesture library was already here and already doing
 * this correctly one screen over, on message bubbles — the inbox just never got
 * it.
 *
 * One action each way, because two per side on a 52pt row is a lottery:
 * swipe left to close, swipe right to toggle read. The panel behind the row
 * grows with the pull and its colour says which action is armed, so you know
 * what will happen before you let go rather than after.
 *
 * Runs on the UI thread; only the commit crosses back to JS.
 */
export function SwipeRow({
  left,
  right,
  children,
}: {
  /** Revealed by pulling the row rightward. */
  left?: { icon: React.ReactNode; color: string; onCommit: () => void };
  /** Revealed by pulling the row leftward. */
  right?: { icon: React.ReactNode; color: string; onCommit: () => void };
  /**
   * The row itself. It is a function because the row has to be able to tell a
   * tap from the end of a swipe: the pressable underneath this is a plain
   * `Pressable`, and when the pan finishes it still sees a press and fires it —
   * so swiping a conversation closed *also* opened it. `swiped()` is true for a
   * moment after a real drag, and the row's `onPress` checks it.
   */
  children: (swiped: () => boolean) => React.ReactNode;
}) {
  const { c } = useTheme();
  const x = useSharedValue(0);
  /** When the last real drag ended. */
  const draggedAt = useRef(0);
  const swiped = () => Date.now() - draggedAt.current < 500;

  const fire = useStableCallback((side: "left" | "right") => {
    haptics.tap();
    (side === "left" ? left : right)?.onCommit();
  });
  const markDragged = useStableCallback(() => {
    draggedAt.current = Date.now();
  });
  // Whether each side exists, not the side objects themselves: those are new
  // on every render, and the gesture is built once (see `useStableCallback`).
  const hasLeft = !!left;
  const hasRight = !!right;

  const pan = useMemo(() => Gesture.Pan()
    // Only a decisively horizontal drag is ours; anything vertical belongs to
    // the list, which is what people are doing 95% of the time.
    .activeOffsetX([-14, 14])
    .failOffsetY([-12, 12])
    // Activation is the moment this stopped being a tap. Recorded here rather
    // than at the end so a drag that travels and returns to zero still
    // suppresses the press it would otherwise land as.
    .onStart(() => {
      runOnJS(markDragged)();
    })
    .onUpdate((e) => {
      const raw = e.translationX;
      if (raw > 0 && !hasLeft) return void (x.value = 0);
      if (raw < 0 && !hasRight) return void (x.value = 0);
      // Damped past the commit point, so the row can't be dragged across the
      // screen and back.
      const mag = Math.abs(raw);
      const eased = mag <= FULL ? mag : FULL + (mag - FULL) * 0.18;
      x.value = Math.sign(raw) * eased;
    })
    .onEnd(() => {
      runOnJS(markDragged)();
      if (x.value >= COMMIT && hasLeft) runOnJS(fire)("left");
      else if (x.value <= -COMMIT && hasRight) runOnJS(fire)("right");
      x.value = withTiming(0, timing.base);
    }), [x, hasLeft, hasRight, fire, markDragged]);

  const row = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));

  /** Each panel shows only while the row is pulled its way, and its icon grows
   *  to full size exactly at the point the pull would commit. */
  const leftPanel = useAnimatedStyle(() => ({
    opacity: interpolate(x.value, [0, 16], [0, 1], "clamp"),
    transform: [{ scale: interpolate(x.value, [0, FULL], [0.6, 1], "clamp") }],
  }));
  const rightPanel = useAnimatedStyle(() => ({
    opacity: interpolate(x.value, [-16, 0], [1, 0], "clamp"),
    transform: [{ scale: interpolate(x.value, [-FULL, 0], [1, 0.6], "clamp") }],
  }));

  /**
   * The colour behind the row: whichever side is being pulled.
   *
   * The positioning lives *inside* the animated style rather than in a
   * `className` or a second style object, and that is not a stylistic choice.
   * On this stack, the moment a `useAnimatedStyle` value enters the `style` of
   * a `cssInterop`-registered `Animated.View`, everything else on that element
   * is dropped — its classes and any other inline style with it. This panel
   * shipped with `absolute inset-0` in its className and spent two builds
   * sitting *in* the layout instead of behind the row: an invisible 44pt column
   * of two icons above every conversation, which is what "the spacing is messed
   * up" was. `__tests__/interop-probe.test.tsx` is the proof.
   *
   * One style object, nothing to merge, nothing to lose.
   *
   * The two colours are read out here rather than inside the worklet: `left` and
   * `right` carry an `onCommit` callback each, and a worklet should close over
   * two strings rather than over two objects holding JS functions.
   */
  const leftColor = left?.color ?? c.surface2;
  const rightColor = right?.color ?? c.surface2;
  const behind = useAnimatedStyle(() => ({
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    // `px-6` was 21, not 24: NativeWind's rem on native is 14.
    paddingHorizontal: 21,
    backgroundColor: x.value > 0 ? leftColor : rightColor,
    opacity: interpolate(Math.abs(x.value), [0, 30], [0, 1], "clamp"),
  }));

  return (
    <GestureDetector gesture={pan}>
      <View>
        {/* No className on this element, deliberately — see `behind` above. */}
        <Animated.View pointerEvents="none" style={behind}>
          <Animated.View style={leftPanel}>{left?.icon}</Animated.View>
          <Animated.View style={rightPanel}>{right?.icon}</Animated.View>
        </Animated.View>

        <Animated.View style={row}>{children(swiped)}</Animated.View>
      </View>
    </GestureDetector>
  );
}
