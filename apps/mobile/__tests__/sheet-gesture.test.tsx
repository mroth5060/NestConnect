/**
 * A sheet held and dragged keeps its gesture across its parent's re-renders.
 *
 * "Hold a finger on a sheet and swipe up and down for 30 seconds and the app
 * crashes": the inbox re-renders on a 30-second clock, and the sheet built a
 * new `Gesture.Pan()` on every render, so gesture-handler reconfigured the
 * native handler under the finger. Nothing about that shows in a tree except
 * the gesture's identity, so that is what's pinned: the same object through
 * re-renders that hand the sheet a new `onClose` each time, as the inbox does —
 * and that `onClose` still being the one called.
 */
import { act, render } from "@testing-library/react-native";
import { Text } from "react-native";
import { __resetModalSlot } from "../src/modal-slot";
import { useStableCallback } from "../src/stable-callback";

jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  initialWindowMetrics: { insets: { top: 0, bottom: 0, left: 0, right: 0 } },
  SafeAreaProvider: ({ children }: { children: unknown }) => children,
}));

const seen: unknown[] = [];
jest.mock("react-native-gesture-handler", () => {
  const actual = jest.requireActual("react-native-gesture-handler");
  return {
    ...actual,
    GestureDetector: ({ gesture, children }: { gesture: unknown; children: React.ReactNode }) => {
      seen.push(gesture);
      return children;
    },
    // The real one installs the native module, which a test has none of.
    GestureHandlerRootView: ({ children }: { children: React.ReactNode }) => children,
  };
});

// Imported after the mock is in place.
import { Sheet } from "../src/components/Sheet";

beforeEach(() => {
  seen.length = 0;
  __resetModalSlot();
});

it("keeps one drag gesture while its parent re-renders", () => {
  const view = render(
    <Sheet visible onClose={() => undefined}>
      <Text>tick 0</Text>
    </Sheet>,
  );
  for (let tick = 1; tick <= 3; tick++) {
    act(() => {
      view.rerender(
        <Sheet visible onClose={() => undefined}>
          <Text>{`tick ${tick}`}</Text>
        </Sheet>,
      );
    });
  }
  expect(seen.length).toBeGreaterThan(1);
  expect(new Set(seen).size).toBe(1);
});

it("a stable callback calls the latest function it was given", () => {
  const calls: string[] = [];
  let stable: (() => void) | undefined;
  const first: Array<() => void> = [];
  function Probe({ label }: { label: string }) {
    stable = useStableCallback(() => calls.push(label));
    first.push(stable);
    return null;
  }
  const view = render(<Probe label="a" />);
  act(() => view.rerender(<Probe label="b" />));
  stable!();
  expect(new Set(first).size).toBe(1);
  expect(calls).toEqual(["b"]);
});
