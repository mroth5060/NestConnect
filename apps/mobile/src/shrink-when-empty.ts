import { useCallback, useRef } from "react";
import type { LayoutChangeEvent } from "react-native";

/**
 * A multiline message box that goes back to one line once it's emptied.
 *
 * "After sending, the composer stays the height of the message I just sent."
 * A multiline TextInput grows as the text wraps, and on iOS it doesn't shrink
 * again when its value is cleared from code — which is exactly what sending
 * does. Typing or deleting by hand is fine; the reset is what it misses.
 *
 * So the box's one-line height is remembered — the smallest it has been laid
 * out at, which is its height empty or with one line in it — and given back to
 * it as a fixed height while it is empty. The moment there is text again the
 * box sizes itself as before, starting from that same one line, so nothing
 * jumps. Measuring rather than computing it, because what padding a
 * multiline input counts in its own height differs between the platforms.
 */
export function useShrinkWhenEmpty(value: string): {
  onLayout: (e: LayoutChangeEvent) => void;
  height: { height: number } | null;
} {
  const smallest = useRef<number | null>(null);
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const h = e.nativeEvent.layout.height;
    if (h > 0 && (smallest.current === null || h < smallest.current)) smallest.current = h;
  }, []);
  return { onLayout, height: value === "" && smallest.current !== null ? { height: smallest.current } : null };
}
