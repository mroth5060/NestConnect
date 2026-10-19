import { io, type Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents } from "@ding/schemas";
import { clientConfig } from "./config";

// Socket.IO types listen-events first, emit-events second.
export type DingSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: DingSocket | null = null;

export function getSocket(): DingSocket {
  if (socket) return socket;
  const { baseUrl, auth } = clientConfig();
  const opts = {
    path: "/socket.io",
    transports: ["websocket", "polling"],
    // Browser: withCredentials sends the httpOnly session cookie on the
    // handshake (required cross-origin in dev too). Native: the same JWT rides
    // in the handshake `auth` payload, because a phone's socket doesn't share a
    // cookie jar with its HTTP client. `auth` may be a function, which
    // socket.io calls on every (re)connect — so a refreshed token is picked up
    // without tearing the socket down.
    ...(auth.kind === "cookie"
      ? { withCredentials: true }
      : { auth: (cb: (data: object) => void) => cb({ token: auth.getToken() ?? "" }) }),
  };
  socket = baseUrl ? io(baseUrl, opts) : io(opts);
  return socket;
}

/**
 * Run `cb` each time the connection comes back after dropping — not on the
 * first connect. Whatever the server sent while it was down never arrived,
 * and a list that only moves on those events would stay as it was: on a phone
 * that is every return from the background, which is when the badge (its own
 * request) said 7 above a list still showing none of them. Returns the
 * unsubscribe.
 */
export function onReconnect(cb: () => void): () => void {
  const s = getSocket();
  let connectedBefore = s.connected;
  const onConnect = () => {
    if (connectedBefore) cb();
    connectedBefore = true;
  };
  s.on("connect", onConnect);
  return () => {
    s.off("connect", onConnect);
  };
}

/** Drop the connection and forget it — on sign-out, so the next sign-in
 *  handshakes with the new session rather than reusing the old one. */
export function resetSocket(): void {
  socket?.close();
  socket = null;
}
