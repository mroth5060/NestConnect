import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  MessageBody,
  ConnectedSocket,
} from "@nestjs/websockets";
import { Logger } from "@nestjs/common";
import { Server, Socket } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { Redis } from "ioredis";
import jwt from "jsonwebtoken";
import {
  ChatClientEvent,
  ChatServerEvent,
  ClientEvent,
  ServerEvent,
  type ChatCue,
  type ChatServerEvents,
  type ClientToServerEvents,
  type Conversation,
  type Message,
  type Notification,
  type ServerToClientEvents,
} from "@ding/schemas";
import { env } from "../config/env";
import { Store } from "../data/store";
import { TenantContext } from "../tenancy/tenant-context";
import { runInTenant } from "../tenancy/tenant-scope";
import { isWorkspaceFrozen } from "../tenancy/workspace-status";
import { SandboxPolicy } from "../tenancy/sandbox";

type DingServer = Server<ClientToServerEvents, ServerToClientEvents>;
type DingSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

const orgRoom = (orgId: string) => `org:${orgId}`;
const convRoom = (id: string) => `conversation:${id}`;
const chatRoom = (id: string) => `chat:${id}`;
const userRoom = (id: string) => `user:${id}`;

/**
 * What the gateway asks Team Chat, which lives in its own module: who is in a
 * chat (null when this person may not open it), and to be told when someone
 * comes and goes. Registered by ChatService at start-up, so the gateway needs
 * no knowledge of how chats are stored.
 */
export interface ChatHooks {
  members(orgId: string, userId: string, roomId: string): Promise<string[] | null>;
  presence(orgId: string, userId: string, online: boolean): void;
}

/** Pull one cookie value out of a raw `Cookie:` header. */
function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

@WebSocketGateway({
  cors: { origin: env.corsOrigin, credentials: true },
})
export class RealtimeGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(RealtimeGateway.name);

  constructor(
    private readonly store: Store,
    private readonly tenant: TenantContext,
    private readonly sandbox: SandboxPolicy,
  ) {}

  @WebSocketServer()
  server!: DingServer;

  private chat: ChatHooks | null = null;

  /** Team Chat plugs in here; see {@link ChatHooks}. */
  registerChat(hooks: ChatHooks): void {
    this.chat = hooks;
  }

  /** Told whenever a workspace's conversations change — a message, a read, an
   *  assignment. The app-icon badge listens, so it follows what's unread. */
  private changeListeners: Array<(orgId: string) => void> = [];
  onWorkspaceChange(fn: (orgId: string) => void): void {
    this.changeListeners.push(fn);
  }
  private changed(orgId: string): void {
    for (const fn of this.changeListeners) {
      try {
        fn(orgId);
      } catch {
        // A listener's failure is its own; the broadcast has already gone.
      }
    }
  }

  afterInit(server: DingServer) {
    if (!env.usingRedis) return;
    try {
      const pub = new Redis(env.redisUrl);
      const sub = pub.duplicate();
      server.adapter(createAdapter(pub, sub));
      this.logger.log("Socket.IO Redis adapter enabled");
    } catch (err) {
      this.logger.warn(`Redis adapter unavailable, running single-node: ${String(err)}`);
    }
  }

  /**
   * Each socket's authentication, so a message handler can wait for it.
   *
   * socket.io delivers a client's first messages as soon as the handshake is
   * accepted — before `handleConnection`, which has to look the user up, has
   * finished. A client that joins a thread the moment it (re)connects would
   * otherwise be asking as nobody, and be refused.
   */
  private readonly authenticated = new WeakMap<DingSocket, Promise<void>>();

  async handleConnection(client: DingSocket): Promise<void> {
    const done = this.authenticate(client);
    this.authenticated.set(client, done);
    await done;
  }

  private async authenticate(client: DingSocket): Promise<void> {
    // Authenticate the handshake with the same session token the REST API uses:
    // an unauthenticated socket would otherwise stream every conversation to
    // anyone who can reach the endpoint. Identity (and the org room) come from
    // the verified token, never from the client.
    //
    // Browsers carry it in the httpOnly cookie. Native clients pass it in the
    // socket.io handshake `auth` payload, because a phone's socket doesn't share
    // a cookie jar with its HTTP client.
    const handshakeAuth = client.handshake.auth as { token?: unknown } | undefined;
    const bearer = typeof handshakeAuth?.token === "string" ? handshakeAuth.token : undefined;
    const token = readCookie(client.handshake.headers.cookie, env.auth.cookieName) ?? bearer;
    let claims: { sub?: string; jti?: string; twofa?: string } | undefined;
    if (token) {
      try {
        claims = jwt.verify(token, env.auth.jwtSecret) as typeof claims;
      } catch {
        claims = undefined;
      }
    }
    // A half-authenticated "2FA pending" token is never a session.
    const userId = claims?.twofa ? undefined : claims?.sub;
    // Honour remote sign-out here too. It matters more on a socket than on a
    // request: a socket is opened once and then lives for hours, so without this
    // a revoked device would keep receiving the org's traffic until it reconnects.
    // The user the token names, in whichever workspace they are — then the
    // session check runs inside that workspace, like the HTTP guard's.
    const found = userId ? await this.store.getUserForAuth(userId) : undefined;
    // Nobody is signed in to a suspended or closed workspace.
    const principal = found && !isWorkspaceFrozen(found.orgId) ? found : undefined;
    const revoked =
      principal && claims?.jti
        ? await runInTenant(principal.orgId, () => this.store.getSession(claims!.jti!)).then((s) => !s || !!s.revokedAt)
        : false;
    const user = principal && !revoked ? principal : undefined;
    if (!user) {
      this.logger.debug(`socket rejected (no valid session): ${client.id}`);
      client.disconnect();
      return;
    }
    // Held at the mandatory two-factor gate. The HTTP guard refuses those
    // sessions every route but enrolment; this is the one way into the org's
    // traffic that doesn't go through it, and it streams the lot.
    if (!user.twoFactorEnabled && (await this.sandbox.twoFactorRequired(user.orgId))) {
      this.logger.debug(`socket rejected (two-factor not set up): ${client.id}`);
      client.disconnect();
      return;
    }
    client.data.userId = user.id;
    client.data.orgId = user.orgId;
    client.join(orgRoom(user.orgId));
    client.join(userRoom(user.id));
    this.logger.debug(`socket connected: ${client.id} (user ${user.id})`);
    this.chat?.presence(user.orgId, user.id, true);
  }

  async handleDisconnect(client: DingSocket) {
    this.logger.debug(`socket disconnected: ${client.id}`);
    const { userId, orgId } = client.data as { userId?: string; orgId?: string };
    if (!userId || !orgId || !this.chat) return;
    // Offline only once their last tab or phone has gone.
    if (!(await this.isOnline(userId))) this.chat.presence(orgId, userId, false);
  }

  /**
   * Is this person looking at this conversation right now?
   *
   * Push asks before it sends: a banner for the thread that's already open and
   * updating in front of you is the single most obvious sign an app wasn't
   * thought through. Joining the conversation room is exactly "has it open", and
   * it's true for the web app as well — if they're reading it on a desktop, the
   * phone doesn't need to buzz either.
   *
   * Best-effort: a failure here must never stop a notification being sent, so it
   * answers "no" and the push goes out.
   */
  async isViewing(userId: string, conversationId: string): Promise<boolean> {
    try {
      const sockets = await this.server.in(convRoom(conversationId)).fetchSockets();
      return sockets.some((s) => (s.data as { userId?: string }).userId === userId);
    } catch (err) {
      this.logger.debug(`isViewing check failed: ${String(err)}`);
      return false;
    }
  }

  /**
   * Relay a typing indicator into a conversation from outside a socket — a
   * NestChat visitor types in an iframe, not on the agents' socket.
   *
   * `preview` carries what they have written so far. It goes to the conversation
   * room, which is the agents with this thread actually open — not the org room,
   * so an unsent draft isn't broadcast to everyone signed in.
   */
  emitTyping(conversationId: string, who: string, typing: boolean, preview?: string): void {
    this.server
      .to(convRoom(conversationId))
      .emit(ServerEvent.Typing, { conversationId, who, typing, preview });
  }

  /**
   * Open a thread's room — only a thread in the socket's own workspace.
   *
   * Room names are conversation ids, and a room is joined by naming it, so
   * without this check anyone signed in to any workspace could name another
   * workspace's conversation and receive its typing previews, which carry the
   * draft being written.
   */
  @SubscribeMessage(ClientEvent.JoinConversation)
  async onJoin(@ConnectedSocket() client: DingSocket, @MessageBody() body: { conversationId: string }) {
    await this.authenticated.get(client);
    const orgId = client.data.orgId;
    const id = typeof body?.conversationId === "string" ? body.conversationId : "";
    if (!orgId || !id) return;
    const conv = await runInTenant(orgId, () => this.store.getConversation(id)).catch(() => undefined);
    if (conv?.orgId === orgId) client.join(convRoom(id));
  }

  @SubscribeMessage(ClientEvent.LeaveConversation)
  onLeave(@ConnectedSocket() client: DingSocket, @MessageBody() body: { conversationId: string }) {
    client.leave(convRoom(body.conversationId));
  }

  @SubscribeMessage(ClientEvent.Typing)
  onTyping(
    @ConnectedSocket() client: DingSocket,
    @MessageBody() body: { conversationId: string; typing: boolean; who?: string },
  ) {
    // Relay to the other agents on this thread (client.to excludes the sender) —
    // only from a socket that was let into the room, which onJoin confines to
    // its own workspace's threads.
    if (!client.rooms.has(convRoom(body.conversationId))) return;
    client.to(convRoom(body.conversationId)).emit(ServerEvent.Typing, {
      conversationId: body.conversationId,
      who: body.who?.trim() || "Someone",
      typing: body.typing,
    });
  }

  /* ---- Team Chat ---- */

  /** Opening a chat: only one this person is allowed into. */
  @SubscribeMessage(ChatClientEvent.Join)
  async onChatJoin(@ConnectedSocket() client: DingSocket, @MessageBody() body: { roomId: string }) {
    await this.authenticated.get(client);
    const { userId, orgId } = client.data as { userId?: string; orgId?: string };
    const id = typeof body?.roomId === "string" ? body.roomId : "";
    if (!userId || !orgId || !id || !this.chat) return;
    const members = await this.chat.members(orgId, userId, id).catch(() => null);
    if (members) client.join(chatRoom(id));
  }

  @SubscribeMessage(ChatClientEvent.Leave)
  onChatLeave(@ConnectedSocket() client: DingSocket, @MessageBody() body: { roomId: string }) {
    if (typeof body?.roomId === "string") client.leave(chatRoom(body.roomId));
  }

  /** "typing…" to the others in the chat, wherever they are in the app. */
  @SubscribeMessage(ChatClientEvent.Typing)
  async onChatTyping(@ConnectedSocket() client: DingSocket, @MessageBody() body: { roomId: string; typing: boolean }) {
    const { userId, orgId } = client.data as { userId?: string; orgId?: string };
    const id = typeof body?.roomId === "string" ? body.roomId : "";
    if (!userId || !orgId || !id || !this.chat || !client.rooms.has(chatRoom(id))) return;
    const members = await this.chat.members(orgId, userId, id).catch(() => null);
    // Only a member types; an admin reading along can't.
    if (!members?.includes(userId)) return;
    const user = await runInTenant(orgId, () => this.store.getUser(userId)).catch(() => undefined);
    this.emitToUsers(
      members.filter((m) => m !== userId),
      ChatServerEvent.Typing,
      { roomId: id, userId, name: user?.name ?? "Someone", typing: !!body.typing },
    );
  }

  /**
   * Send a Team Chat event to these people, on every device they have open —
   * and, given a chat, to anyone with it open (an admin reading along). One
   * emit across all the rooms, so a socket in several gets it once.
   */
  emitToUsers<E extends keyof ChatServerEvents>(
    userIds: string[],
    event: E,
    payload: Parameters<ChatServerEvents[E]>[0],
    roomId?: string,
  ): void {
    const rooms = [...new Set(userIds)].map(userRoom);
    if (roomId) rooms.push(chatRoom(roomId));
    if (!rooms.length) return;
    (this.server.to(rooms) as unknown as { emit(e: string, p: unknown): void }).emit(event, payload);
  }

  /** Presence goes to the whole workspace: anyone might have this person's chat open. */
  emitChatPresence(orgId: string, userId: string, online: boolean, lastSeenAt: string | null): void {
    this.server.to(orgRoom(orgId)).emit(ChatServerEvent.Presence, { userId, online, lastSeenAt });
  }

  emitChatCue(userIds: string[], cue: ChatCue): void {
    this.emitToUsers(userIds, ChatServerEvent.Cue, cue);
  }

  /** Has this person got this chat open, on any device? Push asks, as for conversations. */
  async isViewingChat(userId: string, roomId: string): Promise<boolean> {
    try {
      const sockets = await this.server.in(chatRoom(roomId)).fetchSockets();
      return sockets.some((s) => (s.data as { userId?: string }).userId === userId);
    } catch {
      return false;
    }
  }

  /** Connected anywhere right now. */
  async isOnline(userId: string): Promise<boolean> {
    try {
      return (await this.server.in(userRoom(userId)).fetchSockets()).length > 0;
    } catch {
      return false;
    }
  }

  /** Which of these people are connected — one round trip for a whole chat list. */
  async onlineAmong(userIds: string[]): Promise<Set<string>> {
    const out = new Set<string>();
    if (!userIds.length || !this.server) return out;
    try {
      const sockets = await this.server.in([...new Set(userIds)].map(userRoom)).fetchSockets();
      for (const s of sockets) {
        const id = (s.data as { userId?: string }).userId;
        if (id) out.add(id);
      }
    } catch {
      // Unknown is shown as offline; nothing depends on it.
    }
    return out;
  }

  /* ---- server-side emit helpers, called by services ----
   * Events go to the owning org's room, so nothing ever crosses a tenant
   * boundary. Conversation-carrying emits derive the org from the conversation;
   * message emits take it from the caller or, by default, from the workspace the
   * current request or job is bound to. There is no fallback org: an emit with
   * no workspace bound throws rather than broadcasting to a guess. */

  emitMessageCreated(conversationId: string, message: Message, orgId: string = this.tenant.orgId) {
    this.server.to(orgRoom(orgId)).emit(ServerEvent.MessageCreated, { conversationId, message });
    this.changed(orgId);
  }

  /**
   * Tell specific people that a message is theirs to hear about.
   *
   * Per user, not per org — which is the whole difference between this and
   * `emitMessageCreated`. That one is a broadcast, because every open client
   * needs its lists and threads to stay current whoever the message belongs to.
   * This one carries the alert, and an alert that goes to everybody is the
   * thing that makes people turn alerts off.
   *
   * The rooms are already joined at connect, so this costs one emit per
   * recipient and nothing when the policy picked nobody.
   */
  emitMessageCue(userIds: string[], conversationId: string, kind: "message" | "team_message") {
    for (const userId of new Set(userIds)) {
      this.server.to(`user:${userId}`).emit(ServerEvent.MessageCue, { conversationId, kind });
    }
  }

  emitMessageUpdated(conversationId: string, message: Message, orgId: string = this.tenant.orgId) {
    this.server.to(orgRoom(orgId)).emit(ServerEvent.MessageUpdated, { conversationId, message });
  }

  emitConversationAssigned(conversation: Conversation, by?: string, reason?: string) {
    this.server.to(orgRoom(conversation.orgId)).emit(ServerEvent.ConversationAssigned, { conversation, by, reason });
    this.changed(conversation.orgId);
  }

  emitConversationUpdated(conversation: Conversation) {
    this.server.to(orgRoom(conversation.orgId)).emit(ServerEvent.ConversationUpdated, { conversation });
    this.changed(conversation.orgId);
  }

  /** A bell notification for one user — delivered only to their own room. */
  emitNotification(userId: string, notification: Notification) {
    this.server.to(`user:${userId}`).emit(ServerEvent.Notification, { notification });
  }
}
