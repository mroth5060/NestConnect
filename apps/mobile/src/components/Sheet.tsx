import { useEffect, useMemo, useState } from "react";
import { Keyboard, Modal, Platform, Pressable, View, useWindowDimensions } from "react-native";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { fadeTo, spring, springTo, timing } from "../motion";
import { useTheme, useThemeVars } from "../theme";
import { useInsets } from "../insets";
import { useModalSlot } from "../modal-slot";
import { useStableCallback } from "../stable-callback";

/** How far down you have to drag before letting go dismisses rather than snaps
 *  back, and the flick speed that dismisses regardless of distance. A flick
 *  works from the first few pixels — that's what makes the sheet feel like it
 *  has weight rather than a threshold to clear. */
const DISMISS_DISTANCE = 90;
const DISMISS_VELOCITY = 700;

/**
 * The animated bottom sheet every sheet in the app is built on.
 *
 * React Native's own `animationType="slide"` was doing this before, and the
 * problem with it isn't that it looks bad — it's that it's a linear slide of a
 * fixed duration with a scrim that appears instantly. Nothing physical moves
 * like that, and next to a spring it reads as a slide *show*. This runs the
 * panel on a spring and cross-fades the scrim with it, so the sheet arrives the
 * way a sheet should: fast at first, then settling.
 *
 * The reason it's a shared component rather than a prop on each sheet is the
 * exit. A `Modal` unmounts the instant `visible` goes false, which kills any
 * exit animation before it starts — so the unmount has to be held back until
 * the animation has finished. That's fiddly, easy to get subtly wrong, and
 * there are six sheets in this app; doing it once is the only version of this
 * that stays correct.
 *
 * It also drags. A sheet that rises from the bottom edge and can then only be
 * dismissed by aiming at the scrim above it is saying two contradictory things:
 * it arrived like something physical, and it behaves like a dialog. Everything
 * else on a phone that comes up from the bottom goes back down when you push it
 * there — and on a tall sheet, reaching the scrim means moving your thumb past
 * the whole sheet to close it.
 *
 * ── One rule for anything you put inside ──────────────────────────────────
 *
 * **A `ScrollView` in here must set `flexShrink: 1`** (or carry its own
 * `maxHeight`). The panel is capped at 85% of the screen, but Yoga defaults
 * `flexShrink` to 0, so a scroller with taller content keeps its full content
 * height, overflows the cap, and gets clipped. Clipped is not scrolled: the
 * ScrollView's frame equals its content, so as far as it knows there is nothing
 * to scroll to, and every drag inside it does nothing.
 *
 * That's what "the customer details pop-up scrolls sometimes" was — a short
 * contact fits inside the cap and looks fine, a long one silently can't move.
 * `flexShrink: 1` lets the scroller give back the height it can't have, which
 * leaves content taller than frame, which is the condition for scrolling.
 * `check:layout` enforces it.
 */
export function Sheet({
  visible,
  onClose,
  children,
  /** Screen-reader label for the scrim, which is also the dismiss target. */
  closeLabel = "Close",
  /** Off for sheets whose contents already carry their own horizontal padding —
   *  a full-bleed list of rows with dividers, typically, where padding on the
   *  panel would inset the dividers as well. */
  padded = true,
}: {
  visible: boolean;
  onClose: () => void;
  children: React.ReactNode;
  closeLabel?: string;
  padded?: boolean;
}) {
  const { c } = useTheme();
  const themeVars = useThemeVars();
  const insets = useInsets();
  const { height } = useWindowDimensions();

  // Kept mounted through the exit, then torn down. Without this the Modal
  // disappears on the same frame `visible` flips and there is nothing left on
  // screen to animate out.
  //
  // Held by the slot rather than by local state, because that exit window is
  // also when a sheet that opened another sheet has two modals mounted at once
  // — and on iOS UIKit refuses the second one. `presenting` is this sheet's
  // turn to be on screen, which on iOS may start a beat after `visible` does.
  // See `modal-slot.ts`.
  const { mounted, presenting } = useModalSlot(visible, timing.base.duration + 40);
  const open = useSharedValue(0);
  // Live finger offset, in points, on top of the open/closed transform.
  const drag = useSharedValue(0);

  /**
   * How much of the screen the keyboard is covering, so a sheet with a text
   * input in it can get out of the way.
   *
   * React Native's own `Keyboard` events rather than the keyboard-controller's
   * hooks, because a `Modal` renders outside the tree its provider publishes
   * into — the same reason the palette and the gesture root are re-established
   * below. If Android ever reports nothing here the sheet simply doesn't move,
   * which is what it did before this existed.
   */
  const [keyboard, setKeyboard] = useState(0);
  useEffect(() => {
    if (!mounted) return;
    const show = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow",
      (e) => setKeyboard(e.endCoordinates?.height ?? 0),
    );
    const hide = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide",
      () => setKeyboard(0),
    );
    return () => {
      show.remove();
      hide.remove();
      setKeyboard(0);
    };
  }, [mounted]);

  useEffect(() => {
    if (presenting) {
      drag.value = 0;
      open.value = springTo(1, spring.settle);
      return;
    }
    open.value = fadeTo(0, timing.base);
  }, [presenting, open, drag]);

  // Built once: a gesture rebuilt on a re-render is reconfigured natively,
  // even mid-drag, and the parent re-rendering under a held finger (the inbox's
  // 30-second clock) crashed the app. See `useStableCallback`.
  const close = useStableCallback(onClose);
  const pan = useMemo(() => Gesture.Pan()
    // Let a list inside the sheet win. Requiring 12pt downward before this
    // activates, and failing outright on upward movement, means a sheet with a
    // scrollable body still scrolls: the native scroll gesture claims the touch
    // first, and the drag is left to the handle and the padding around it.
    .activeOffsetY(12)
    .failOffsetY(-8)
    // Downward only: an upward drag on a sheet that can't expand should do
    // nothing rather than lift it off the bottom edge and leave a gap under it.
    .onUpdate((e) => {
      drag.value = Math.max(0, e.translationY);
    })
    .onEnd((e) => {
      if (e.translationY > DISMISS_DISTANCE || e.velocityY > DISMISS_VELOCITY) {
        runOnJS(close)();
        return;
      }
      drag.value = springTo(0, spring.settle);
    }), [drag, close]);

  // The scrim thins as the sheet is pulled down, so the background comes back
  // as you go and the drag reads as reversing the entrance rather than sliding
  // a panel around underneath a fixed dim.
  /**
   * The dim behind the panel. Its geometry is here rather than in a `className`
   * beside it, and that is load-bearing: on this stack an animated style in
   * `style` takes the element's whole styling with it — the class-derived rules
   * and any second style object are both dropped, and only the animated object
   * arrives. This scrim shipped as `className="absolute inset-0"` plus an
   * animated opacity, which means it had neither the position nor the colour.
   * `scripts/check-layout-rules.mjs` guards against it now; the measurement
   * behind it is in `__tests__/interop-probe.test.tsx`.
   */
  const scrim = useAnimatedStyle(() => ({
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    backgroundColor: c.scrim,
    opacity: open.value * Math.max(0, 1 - drag.value / 400),
  }));
  const panel = useAnimatedStyle(() => ({
    // Three translations rather than one sum: the first is a percentage of the
    // sheet's own height, so a tall sheet and a short one travel for the same
    // length of time rather than the tall one appearing to fall further; the
    // second is the finger, in points; the third lifts the whole panel clear of
    // the keyboard. The units differ so they can't be added, but transforms
    // compose.
    transform: [
      { translateY: `${(1 - open.value) * 100}%` },
      { translateY: drag.value },
      { translateY: -keyboard },
    ],
  }));

  return (
    <Modal
      visible={mounted}
      transparent
      animationType="none"
      accessibilityViewIsModal
      onRequestClose={onClose}
      statusBarTranslucent
    >
      {/* Two things have to be re-established inside a Modal, and both are for
          the same underlying reason: a Modal renders into its own view
          hierarchy, not into the app's tree.

          The palette, because the variables published at the root don't reach
          here and every colour utility inside would resolve against nothing.

          And the gesture root, because handlers only receive touches under a
          `GestureHandlerRootView` — the one at the app root is in the tree this
          Modal isn't part of. Without it the pan below is mounted, styled and
          completely inert, which is exactly how every sheet in the app ended up
          undraggable while swipe-to-reply, which isn't in a Modal, worked
          fine. */}
      <GestureHandlerRootView style={{ flex: 1 }}>
      <View style={themeVars} className="flex-1 justify-end">
        {/* No className, deliberately — see `scrim` above. */}
        <Animated.View style={scrim}>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={closeLabel}
            className="flex-1"
          />
        </Animated.View>

          <Animated.View style={panel}>
            {/* A plain View, and that is the fix for a sheet whose contents
                would not scroll.

                This was a `Pressable` with an empty `onPress` — a sink meant to
                stop taps inside the sheet from reaching the scrim. On Android a
                JS touch responder that claims on touch-down stops the native
                scroll view beneath it from ever seeing the gesture, so the
                details sheet could be dragged at and simply did not move.

                The sink was never needed. The scrim is a *sibling* rendered
                before this panel, not an ancestor of it, so it is behind in the
                z-order and a tap that lands on the panel cannot reach it. It
                was defending against something that could not happen, at the
                cost of the one interaction the sheet exists for. */}
            <View
              // A real number, not "85%": a percentage resolves against the
              // parent, and the parent here is content-sized, so the cap simply
              // wouldn't apply — a long sheet would grow past the top of the
              // screen instead of scrolling inside itself.
              // Capped against what's left of the screen rather than all of it:
              // the panel is lifted clear of the keyboard below, and an
              // 85%-of-the-whole-screen sheet lifted that far would put its own
              // top off the top. The system inset is only padded for when the
              // keyboard isn't covering it anyway.
              style={{
                backgroundColor: c.elevated,
                paddingBottom: keyboard ? 12 : insets.bottom + 12,
                maxHeight: (height - keyboard) * 0.85,
              }}
              className={`rounded-t-24 ${padded ? "px-4" : ""}`}
            >
              {/* The handle is the drag target, and only the handle.
                  The pan used to cover the whole panel, held off a list inside
                  it by `activeOffsetY(12)` / `failOffsetY(-8)`. That splits the
                  wrong way: dragging *up* failed the pan and scrolled, dragging
                  *down* activated it and dragged the sheet — so a list scrolled
                  one way and not the other, which is what "sometimes it works"
                  actually was. A dedicated grabber has no such ambiguity, and
                  it's what a phone does with a sheet that contains a list. */}
              <GestureDetector gesture={pan}>
                <View className="items-center pb-3 pt-3" accessible={false}>
                  <View style={{ backgroundColor: c.borderStrong }} className="h-1 w-9 rounded-full" />
                </View>
              </GestureDetector>
              {children}
            </View>
          </Animated.View>
      </View>
      </GestureHandlerRootView>
    </Modal>
  );
}
