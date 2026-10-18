import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import {
  bulkContactsInputSchema,
  createContactInputSchema,
  importContactsInputSchema,
  mergeContactsInputSchema,
  reachInputSchema,
  updateContactInputSchema,
  type BulkContactsResult,
  type CreateContactInput,
  type ImportContactsInput,
  type ImportContactsResult,
  type MergeContactsInput,
  type ReachInput,
  type UpdateContactInput,
} from "@ding/schemas";
import { Store } from "../data/store";
import { ConversationLog, agent } from "../conversations/conversation-log";
import { RealtimeGateway } from "../realtime/realtime.gateway";
import { AccountsService } from "../accounts/accounts.service";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUserId } from "../auth/current-user.decorator";
import type { z } from "zod";

/** The customer directory (CRM): list, view, add, tag and pin-route contacts. */
@Controller("contacts")
export class ContactsController {
  constructor(
    private readonly store: Store,
    private readonly realtime: RealtimeGateway,
    private readonly accounts: AccountsService,
  ) {}

  @Get()
  list() {
    return this.store.listContacts();
  }

  /** Possible-duplicate clusters — contacts that share a normalised phone or
   *  email. Declared before `:id` so the literal path isn't read as an id. */
  @Get("duplicates")
  duplicates() {
    return this.store.findDuplicateContacts();
  }

  @Get(":id")
  async detail(@Param("id") id: string) {
    const contact = await this.store.getContactWithConversations(id);
    if (!contact) throw new NotFoundException("Customer not found");
    return contact;
  }

  @Post()
  async create(
    @CurrentUserId() userId: string,
    @Body(new ZodValidationPipe(createContactInputSchema)) body: CreateContactInput,
  ) {
    const me = await this.store.getUser(userId);
    if (!me) throw new NotFoundException("Current user not found");
    // Get-or-create: `existed` is true when the phone/email already matched a
    // contact, so the UI can open that one instead of adding a duplicate.
    const { contact, created } = await this.store.createContact({ orgId: me.orgId, ...body });
    return { contact, existed: !created };
  }

  /**
   * Bulk import from an uploaded file.
   *
   * Each row goes through the same get-or-create as the Add-customer form, so
   * importing a list twice does not double the directory — the second run
   * matches on normalised phone/email and updates instead. That is what makes
   * this safe to re-run after fixing a column mapping, which people do.
   *
   * The bulk tags reach matched customers too, not just new ones. Tagging an
   * import is nearly always about marking a *cohort* — "these came from the
   * trade show" — and a cohort that silently excluded everyone already on file
   * would be wrong in exactly the cases that matter.
   *
   * A bad row fails alone. One malformed phone number in a thousand-row file
   * should not cost the other 999, so the loop collects failures and reports
   * them by position rather than aborting.
   */
  @Post("import")
  async import(
    @CurrentUserId() userId: string,
    @Body(new ZodValidationPipe(importContactsInputSchema)) body: ImportContactsInput,
  ): Promise<ImportContactsResult> {
    const me = await this.store.getUser(userId);
    if (!me) throw new NotFoundException("Current user not found");
    if (me.role !== "admin" && me.role !== "manager") {
      throw new ForbiddenException("Only admins and managers can import customers");
    }

    const bulk = body.tags.map((t) => t.trim()).filter(Boolean);
    const result: ImportContactsResult = { created: 0, matched: 0, failed: [] };

    for (const [index, row] of body.contacts.entries()) {
      try {
        // A "Company" column puts the customer in that organisation (made if
        // it's new) rather than in the retired free-text field.
        const { company, ...input } = row;
        const tags = [...new Set([...(input.tags ?? []), ...bulk])];
        const { contact, created } = await this.store.createContact({
          orgId: me.orgId,
          ...input,
          ...(tags.length ? { tags } : {}),
        });
        if (company?.trim()) {
          await this.accounts.linkByName(userId, contact.id, company).catch(() => undefined);
        }
        if (created) {
          result.created++;
          continue;
        }
        result.matched++;
        // Get-or-create returns the existing record untouched, so the tags have
        // to be put on separately. Union, never replace: an import must not
        // strip labels someone applied by hand.
        const merged = [...new Set([...(contact.tags ?? []), ...tags])];
        if (merged.length !== (contact.tags ?? []).length) {
          await this.store.updateContact(contact.id, { tags: merged });
        }
      } catch (err) {
        result.failed.push({
          index,
          name: row.displayName,
          error: err instanceof Error && err.message ? err.message : "Could not be imported",
        });
      }
    }
    return result;
  }

  /** Merge duplicate customers into one surviving record (winnerId). The losers'
   *  identities, conversations and blank fields fold into the winner, then the
   *  losers are deleted. */
  @Post("merge")
  async merge(@Body(new ZodValidationPipe(mergeContactsInputSchema)) body: MergeContactsInput) {
    if (body.loserIds.includes(body.winnerId)) {
      throw new BadRequestException("A customer can't be merged into itself.");
    }
    const contact = await this.store.mergeContacts(body);
    return { contact };
  }

  /**
   * One action on many customers: tag (add and take off, never replacing what
   * else they have), block or unblock, or delete. Deleting many at once is for
   * admins and managers, as importing is; the rest is anyone's, as it is one
   * customer at a time.
   */
  @Post("bulk")
  async bulk(
    @CurrentUserId() userId: string,
    @Body(new ZodValidationPipe(bulkContactsInputSchema)) body: z.output<typeof bulkContactsInputSchema>,
  ): Promise<BulkContactsResult> {
    if (body.action === "delete") {
      const me = await this.store.getUser(userId);
      if (me?.role !== "admin" && me?.role !== "manager") {
        throw new ForbiddenException("Only admins and managers can delete customers in bulk");
      }
    }
    if (body.action === "tag" && !body.add.length && !body.remove.length) {
      throw new BadRequestException("Pick a tag to add or take off");
    }
    const result: BulkContactsResult = { done: 0, missing: 0 };
    for (const id of [...new Set(body.ids)]) {
      const contact = await this.store.getContact(id);
      if (!contact) {
        result.missing++;
        continue;
      }
      if (body.action === "delete") {
        await this.store.deleteContact(id);
      } else if (body.action === "block") {
        if (!!contact.blocked === body.blocked) continue;
        await this.store.updateContact(id, { blocked: body.blocked });
      } else {
        // Tags match whatever their case, as the filter does.
        const off = new Set(body.remove.map((t) => t.toLowerCase()));
        const kept = (contact.tags ?? []).filter((t) => !off.has(t.toLowerCase()));
        const tags = [...kept];
        for (const t of body.add) if (!tags.some((x) => x.toLowerCase() === t.toLowerCase())) tags.push(t);
        const same = tags.length === (contact.tags ?? []).length && tags.every((t, i) => t === contact.tags?.[i]);
        if (same) continue;
        await this.store.updateContact(id, { tags });
      }
      result.done++;
    }
    return result;
  }

  @Patch(":id")
  async update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateContactInputSchema)) body: UpdateContactInput,
  ) {
    const contact = await this.store.updateContact(id, body);
    if (!contact) throw new NotFoundException("Customer not found");
    return contact;
  }

  /** Permanently delete a customer and everything attached to them. */
  @Delete(":id")
  async remove(@Param("id") id: string): Promise<{ ok: boolean }> {
    await this.store.deleteContact(id);
    return { ok: true };
  }

  /** Reach this customer on a channel: open your own conversation with them
   *  there, or start a new one that's yours. `alsoOpenWith` says who has the
   *  other open one you've started beside (a colleague, or "the queue"). Lets
   *  an agent move a customer who's reachable on several channels between them. */
  @Post(":id/reach")
  async reach(
    @CurrentUserId() userId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(reachInputSchema)) body: ReachInput,
  ): Promise<{ conversationId: string; created: boolean; alsoOpenWith?: string }> {
    const me = await this.store.getUser(userId);
    if (!me) throw new NotFoundException("Current user not found");
    const contact = await this.store.getContactWithConversations(id);
    if (!contact) throw new NotFoundException("Customer not found");

    if (body.channel === "whatsapp" && !contact.phone) {
      throw new BadRequestException("This customer has no WhatsApp number on file.");
    }
    if (body.channel === "sms" && !contact.phone) {
      throw new BadRequestException("This customer has no phone number on file.");
    }
    if (body.channel === "email" && !contact.email) {
      throw new BadRequestException("This customer has no email address on file.");
    }

    const inboxes = await this.store.listInboxes();
    // Honour an explicit inbox (the composer's "send from" choice when several of
    // the same channel are connected); otherwise fall back to the first.
    const inbox = body.inboxId
      ? inboxes.find((i) => i.id === body.inboxId && i.type === body.channel)
      : inboxes.find((i) => i.type === body.channel);
    if (!inbox) {
      throw new BadRequestException(`No ${body.channel} inbox is connected yet.`);
    }

    // Front and Intercom's rule: starting a conversation starts a new one,
    // and it's yours. The only exception is a thread already yours — opening
    // that is what you meant. A colleague's open thread, or one waiting in the
    // queue, is left exactly as it is: a new conversation beside it, owned by
    // whoever started it. The customer's answer goes to the most recently
    // active open thread (see `findOrCreateOpenConversation`), which is the new
    // one, so it comes to them.
    const target = { orgId: me.orgId, inboxId: inbox.id, contact, channel: body.channel, assigneeUserId: me.id };
    let { conversation, created } = await this.store.findOrCreateOpenConversation(target);
    let alsoOpenWith: string | undefined;
    if (!created && conversation.assigneeUserId !== me.id) {
      const other = conversation.assigneeUserId ? await this.store.getUser(conversation.assigneeUserId) : undefined;
      alsoOpenWith = other ? other.name : "the queue";
      ({ conversation, created } = await this.store.findOrCreateOpenConversation({ ...target, forceNew: true }));
    }
    if (created) {
      this.realtime.emitConversationUpdated(conversation);
      const log = new ConversationLog(this.store);
      await log.record(conversation.id, "created", agent(me.id), { channel: body.channel });
      await log.record(conversation.id, "assigned", agent(me.id), { toUserId: me.id });
    }
    return { conversationId: conversation.id, created, ...(alsoOpenWith ? { alsoOpenWith } : {}) };
  }
}
