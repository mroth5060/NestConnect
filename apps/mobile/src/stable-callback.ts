import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * A function whose identity never changes but which always calls the latest
 * `fn` — for handing a parent's callback to something that must not be rebuilt
 * when the parent re-renders.
 *
 * What that is, here, is a gesture. `Gesture.Pan()` written straight into a
 * component's body is a new gesture on every render, and gesture-handler
 * reconfigures the native handler to match — including while a finger is on it.
 * The inbox re-renders on a 30-second clock, so a sheet held and dragged for
 * half a minute had its handler swapped out mid-drag, and the app crashed. A
 * gesture built once in `useMemo` can't be swapped; this is what lets it still
 * call an `onClose` that the parent recreates every render.
 */
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  useLayoutEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args: A) => ref.current(...args), []);
}
