/**
 * Lists catch up when the live connection comes back.
 *
 * "The Chat tab says 7 but the chats aren't in the list until I switch tabs":
 * a phone pauses the app's connection in the background, and every message
 * sent meanwhile was an event nobody received. The badge is its own request
 * and refreshed; the list only moved on those events and stayed as it was.
 * Now a reconnect refreshes it — and only a reconnect: the first connect is
 * the page loading, which fetches everything anyway.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const listeners = new Map<string, Set<() => void>>();
const fake = {
  connected: false,
  on(event: string, cb: () => void) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event)!.add(cb);
  },
  off(event: string, cb: () => void) {
    listeners.get(event)?.delete(cb);
  },
  close() {},
};
const connect = () => {
  fake.connected = true;
  for (const cb of listeners.get("connect") ?? []) cb();
};

vi.mock("socket.io-client", () => ({ io: () => fake }));

import { onReconnect, resetSocket } from "../../../../packages/client/src/socket";

afterEach(() => {
  resetSocket();
  listeners.clear();
  fake.connected = false;
});

describe("onReconnect", () => {
  it("leaves the first connect alone and runs on each one after", () => {
    const cb = vi.fn();
    onReconnect(cb);
    connect();
    expect(cb).not.toHaveBeenCalled();
    fake.connected = false;
    connect();
    connect();
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("counts a connection already up when it's asked as the first", () => {
    fake.connected = true;
    const cb = vi.fn();
    onReconnect(cb);
    connect();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("stops when unsubscribed", () => {
    const cb = vi.fn();
    const off = onReconnect(cb);
    connect();
    off();
    connect();
    expect(cb).not.toHaveBeenCalled();
  });
});
