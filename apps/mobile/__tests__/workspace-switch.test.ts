/**
 * Switching workspace takes the last one's number off the app icon.
 *
 * "The badge shows even though the workspace I'm in has nothing": the icon kept
 * the old workspace's count, and its notifications stayed in the tray (which an
 * Android launcher counts), until the new workspace's number arrived — if it
 * did. Pinned: a successful switch clears both, and a refused one leaves them,
 * since the person is still where they were.
 */
const mockCalls: string[] = [];

jest.mock("expo-notifications", () => ({
  // push.ts sets this up when it loads.
  setNotificationHandler: () => {},
  dismissAllNotificationsAsync: async () => {
    mockCalls.push("dismiss");
  },
  setBadgeCountAsync: async (n: number) => {
    mockCalls.push(`badge:${n}`);
  },
}));
jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));
jest.mock("../src/session", () => ({
  saveSession: async () => {
    mockCalls.push("save");
  },
}));

const mockSwitch = jest.fn();
jest.mock("@ding/client", () => ({
  api: { switchWorkspace: (...a: unknown[]) => mockSwitch(...a) },
  resetSocket: () => mockCalls.push("socket"),
  seedIdentity: () => mockCalls.push("identity"),
  useChatStatus: () => ({ data: undefined }),
  useSession: () => ({ data: undefined }),
}));

import { switchWorkspace } from "../src/workspaces";

const qc = { resetQueries: async () => void mockCalls.push("reset") } as never;

beforeEach(() => {
  mockCalls.length = 0;
  mockSwitch.mockReset();
});

it("clears the old workspace's badge and notifications once the switch is made", async () => {
  mockSwitch.mockResolvedValue({ token: "t2", user: { id: "u2" } });
  await switchWorkspace(qc, "org-2");
  expect(mockCalls).toContain("dismiss");
  expect(mockCalls).toContain("badge:0");
  // After the new session is stored, before the caches refill with the new
  // workspace's numbers.
  expect(mockCalls.indexOf("save")).toBeLessThan(mockCalls.indexOf("dismiss"));
  expect(mockCalls.indexOf("badge:0")).toBeLessThan(mockCalls.indexOf("reset"));
});

it("leaves them alone when the switch is refused", async () => {
  mockSwitch.mockRejectedValue(new Error("Workspace not found"));
  await expect(switchWorkspace(qc, "org-x")).rejects.toThrow("Workspace not found");
  expect(mockCalls).not.toContain("dismiss");
  expect(mockCalls).not.toContain("badge:0");
});
