/**
 * A swipe from the screen's edge goes back; a swipe on a message replies.
 *
 * "Swiping out of the chat replies to whoever's message is under my thumb":
 * message rows run the full width, so the reply gesture took swipes that
 * began at the edge, which on iOS (and on Android, from either side) is the
 * phone going back. WhatsApp leaves the edge to the phone. Pinned here on the
 * gesture itself: a touch at either edge fails it at once, so the system's
 * back gesture has it; one on the message doesn't.
 */
import { render } from "@testing-library/react-native";
import { Text } from "react-native";

jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));

const seen: Array<{ handlers: { onTouchesDown?: (e: unknown, s: { fail: () => void }) => void } }> = [];
jest.mock("react-native-gesture-handler", () => {
  const actual = jest.requireActual("react-native-gesture-handler");
  return {
    ...actual,
    GestureDetector: ({ gesture, children }: { gesture: never; children: React.ReactNode }) => {
      seen.push(gesture);
      return children;
    },
    GestureHandlerRootView: ({ children }: { children: React.ReactNode }) => children,
  };
});
jest.mock("react-native/Libraries/Utilities/useWindowDimensions", () => ({
  __esModule: true,
  default: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }),
}));

import { SwipeToReply } from "../src/components/SwipeToReply";

const touchAt = (x: number) => {
  const fail = jest.fn();
  seen.at(-1)!.handlers.onTouchesDown!({ allTouches: [{ absoluteX: x, absoluteY: 400, x, y: 10, id: 1 }] }, { fail });
  return fail;
};

beforeEach(() => {
  seen.length = 0;
});

it.each([
  ["someone else's message", false],
  ["my own message", true],
])("on %s, a swipe from either edge is left to the phone", (_, mine) => {
  render(
    <SwipeToReply onReply={() => undefined} mine={mine}>
      <Text>Hola</Text>
    </SwipeToReply>,
  );
  expect(touchAt(8)).toHaveBeenCalled();
  expect(touchAt(385)).toHaveBeenCalled();
});

it("a swipe that starts on the message is still a reply", () => {
  render(
    <SwipeToReply onReply={() => undefined} mine={false}>
      <Text>Hola</Text>
    </SwipeToReply>,
  );
  expect(touchAt(80)).not.toHaveBeenCalled();
  expect(touchAt(300)).not.toHaveBeenCalled();
});
