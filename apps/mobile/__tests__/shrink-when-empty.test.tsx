/**
 * The message box goes back to one line once sent.
 *
 * "After sending, the composer stays the height of the message I just sent":
 * a multiline TextInput on iOS doesn't shrink when its value is cleared from
 * code. The box remembers its one-line height and is held to it while empty.
 */
import { act, renderHook } from "@testing-library/react-native";
import type { LayoutChangeEvent } from "react-native";
import { useShrinkWhenEmpty } from "../src/shrink-when-empty";

const laidOut = (height: number) => ({ nativeEvent: { layout: { x: 0, y: 0, width: 300, height } } }) as LayoutChangeEvent;

it("holds an emptied box to the one-line height it was measured at", () => {
  const { result, rerender } = renderHook(({ value }: { value: string }) => useShrinkWhenEmpty(value), { initialProps: { value: "" } });
  act(() => result.current.onLayout(laidOut(40)));
  // Typing grows it: nothing is imposed while there is text.
  rerender({ value: "A long message\nover\nfour lines" });
  expect(result.current.height).toBeNull();
  act(() => result.current.onLayout(laidOut(120)));
  // Sent: the box is cleared, and goes back to one line, not the 120 it was.
  rerender({ value: "" });
  expect(result.current.height).toEqual({ height: 40 });
});

it("imposes nothing before it has been measured", () => {
  const { result } = renderHook(() => useShrinkWhenEmpty(""));
  expect(result.current.height).toBeNull();
});

it("learns the one-line height from a single line of text too", () => {
  const { result, rerender } = renderHook(({ value }: { value: string }) => useShrinkWhenEmpty(value), { initialProps: { value: "a draft\nthat was long" } });
  act(() => result.current.onLayout(laidOut(90)));
  rerender({ value: "short" });
  act(() => result.current.onLayout(laidOut(40)));
  rerender({ value: "" });
  expect(result.current.height).toEqual({ height: 40 });
});
