import { Body, Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common";
import {
  assignConversationInputSchema,
  forwardMessageInputSchema,
  reactionInputSchema,
  sendMessageInputSchema,
  setConversationLabelsInputSchema,
  snoozeInputSchema,
  updatePriorityInputSchema,
  updateStatusInputSchema,
  type AssignConversationInput,
  type ForwardMessageInput,
  type ReactionInput,
  type SendMessageInput,
  type SetConversationLabelsInput,
  type SnoozeInput,
  type UpdatePriorityInput,
  type UpdateStatusInput,
} from "@ding/schemas";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUserId } from "../auth/current-user.decorator";
import { ConversationsService } from "./conversations.service";

@Controller("conversations")
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  /**
   * One page of a view.
   *
   * `fieldKey` narrows it to threads carrying that custom field — with
   * `fieldValue` to one value, without it to any. It is ANDed with the view, so
   * it can only ever show less than the view already would: "my inbox, orders
   * only" rather than a search that reaches outside it.
   */
  @Get()
  list(
    @CurrentUserId() userId: string,
    @Query("view") view?: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
    @Query("fieldKey") fieldKey?: string,
    @Query("fieldValue") fieldValue?: string,
    @Query("status") status?: string,
  ) {
    const key = fieldKey?.trim();
    return this.conversations.list(view ?? "inbound", userId, {
      cursor,
      limit: limit ? Number(limit) : undefined,
      // Anything else (or nothing) is both sides, as before the split.
      ...(status === "active" || status === "closed" ? { status } : {}),
      // An empty value is not a filter for the empty string — it is the
      // querystring's way of saying the box was left blank, which means "any".
      ...(key ? { field: { key, value: fieldValue?.trim() || undefined } } : {}),
    });
  }

  /**
   * Per-filter totals for the list's chips (declared before :id so it
   * matches). Counted over the whole view rather than left to the client,
   * which only ever has the pages it has scrolled through.
   */
  @Get("counts")
  counts(
    @CurrentUserId() userId: string,
    @Query("view") view?: string,
    @Query("fieldKey") fieldKey?: string,
    @Query("fieldValue") fieldValue?: string,
  ) {
    const key = fieldKey?.trim();
    return this.conversations.counts(view ?? "inbound", userId, {
      ...(key ? { field: { key, value: fieldValue?.trim() || undefined } } : {}),
    });
  }

  /** Search (declared before :id so it matches). Pass `view` to scope it to the
   *  inbox the search field is sitting in; omit it to search everything. */
  @Get("search")
  search(
    @CurrentUserId() userId: string,
    @Query("q") q?: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
    @Query("view") view?: string,
  ) {
    return this.conversations.search(q ?? "", {
      cursor,
      limit: limit ? Number(limit) : undefined,
      ...(view ? { view, userId } : {}),
    });
  }

  /** Older messages in a thread (scroll-up history), before a seq cursor. */
  @Get(":id/messages")
  messages(
    @Param("id") id: string,
    @Query("before") before?: string,
    @Query("limit") limit?: string,
  ) {
    return this.conversations.messages(id, { before, limit: limit ? Number(limit) : undefined });
  }

  @Get(":id")
  get(@Param("id") id: string, @CurrentUserId() userId: string) {
    return this.conversations.get(id, userId);
  }

  /** Take it out of my My Inbound when only its notes put it there. */
  @Post(":id/dismiss")
  @HttpCode(200)
  dismiss(@Param("id") id: string, @CurrentUserId() userId: string) {
    return this.conversations.dismissFollowUp(id, userId);
  }

  /** The conversation's log — routing, assignment, status and changes. */
  @Get(":id/events")
  events(@Param("id") id: string) {
    return this.conversations.events(id);
  }

  @Post(":id/messages")
  send(
    @CurrentUserId() userId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(sendMessageInputSchema)) body: SendMessageInput,
  ) {
    return this.conversations.sendMessage(id, body, userId);
  }

  @Post(":id/assign")
  assign(
    @CurrentUserId() userId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(assignConversationInputSchema)) body: AssignConversationInput,
  ) {
    return this.conversations.assign(id, body, userId);
  }

  @Post(":id/status")
  setStatus(
    @CurrentUserId() userId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateStatusInputSchema)) body: UpdateStatusInput,
  ) {
    return this.conversations.setStatus(id, body, userId);
  }

  @Post(":id/snooze")
  snooze(
    @CurrentUserId() userId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(snoozeInputSchema)) body: SnoozeInput,
  ) {
    return this.conversations.snooze(id, body.until, userId);
  }

  /**
   * Mark a conversation read — sends a WhatsApp read receipt, and clears the
   * unread badge if this reader is the one responsible for replying. Who that
   * is (assignee, or anyone when unassigned) is decided in the service.
   */
  @Post(":id/read")
  markRead(@Param("id") id: string, @CurrentUserId() userId: string) {
    return this.conversations.markRead(id, userId);
  }

  /** Manually mark a conversation unread — leaves a WhatsApp-style empty dot. */
  @Post(":id/unread")
  markUnread(@Param("id") id: string) {
    return this.conversations.markUnread(id);
  }

  /** Replace a conversation's labels with the given set of label ids. */
  @Post(":id/labels")
  setLabels(
    @CurrentUserId() userId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(setConversationLabelsInputSchema)) body: SetConversationLabelsInput,
  ) {
    return this.conversations.setLabels(id, body.labelIds, userId);
  }

  /** Agent started typing — show the customer a WhatsApp "typing…" indicator. */
  @Post(":id/typing")
  async typing(@Param("id") id: string): Promise<{ ok: boolean }> {
    await this.conversations.sendTyping(id);
    return { ok: true };
  }

  /** React to a message with an emoji (empty removes the agent's reaction). */
  @Post(":id/messages/:messageId/react")
  react(
    @CurrentUserId() userId: string,
    @Param("id") id: string,
    @Param("messageId") messageId: string,
    @Body(new ZodValidationPipe(reactionInputSchema)) body: ReactionInput,
  ) {
    return this.conversations.react(id, messageId, body.emoji, userId);
  }

  /** Pass this message on to other customers' WhatsApp chats. Reports one result
   *  per target — a closed 24-hour window fails that chat, not the whole send. */
  @Post(":id/messages/:messageId/forward")
  forward(
    @CurrentUserId() userId: string,
    @Param("id") id: string,
    @Param("messageId") messageId: string,
    @Body(new ZodValidationPipe(forwardMessageInputSchema)) body: ForwardMessageInput,
  ) {
    return this.conversations.forwardMessage(id, messageId, body.contactIds, userId);
  }

  /** Manually retry a failed outbound message (re-queues it for delivery). */
  @Post(":id/messages/:messageId/retry")
  retry(@CurrentUserId() userId: string, @Param("messageId") messageId: string) {
    return this.conversations.retryMessage(messageId, userId);
  }

  @Post(":id/priority")
  setPriority(
    @CurrentUserId() userId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updatePriorityInputSchema)) body: UpdatePriorityInput,
  ) {
    return this.conversations.setPriority(id, body, userId);
  }
}
