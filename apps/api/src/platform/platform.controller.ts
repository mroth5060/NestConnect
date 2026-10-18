import {
  BadRequestException,
  Body,
  ConflictException,
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
  addPlatformPersonInputSchema,
  createWorkspaceInputSchema,
  deleteWorkspaceNowInputSchema,
  renameWorkspaceInputSchema,
  setPlatformPersonRoleInputSchema,
  setWorkspaceStatusInputSchema,
  WORKSPACE_DELETE_GRACE_DAYS,
  type AddPlatformPersonInput,
  type CreateWorkspaceInput,
  type CreatedWorkspace,
  type DeleteWorkspaceNowInput,
  type PlatformPerson,
  type PlatformPersonInvite,
  type PlatformWorkspace,
  type RenameWorkspaceInput,
  type SetPlatformPersonRoleInput,
  type SetWorkspaceStatusInput,
} from "@ding/schemas";
import { CurrentUserId } from "../auth/current-user.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { env } from "../config/env";
import { Store } from "../data/store";
import { Mailer } from "../mail/mailer.service";
import { isPlatformOwner } from "../tenancy/platform-owner";
import { runInTenant } from "../tenancy/tenant-scope";
import { isPlatformOrg } from "../tenancy/platform";
import { WorkspaceLifecycleService } from "./workspace-lifecycle.service";

/**
 * The platform's owners, above any one workspace: every workspace there is,
 * and new ones. Opening one is a workspace switch (POST /auth/switch), which
 * adds an owner to a workspace they aren't in yet as an admin.
 */
@Controller("platform")
export class PlatformController {
  constructor(
    private readonly store: Store,
    private readonly mailer: Mailer,
    private readonly lifecycle: WorkspaceLifecycleService,
  ) {}

  @Get("workspaces")
  async list(@CurrentUserId() userId: string): Promise<PlatformWorkspace[]> {
    await this.requireOwner(userId);
    const mine = new Set((await this.store.listMemberships(userId)).map((m) => m.user.orgId));
    return (await this.store.listWorkspaces()).map((w) => ({ ...w, joined: mine.has(w.id), platform: isPlatformOrg(w.id) }));
  }

  /**
   * A new workspace and the person who'll run it: its first admin, on a first
   * team ("General") so routing and Team Chat have somewhere to start. Someone
   * new is invited to set a password; someone who already signs in is told
   * they've been added, and finds it among their workspaces.
   */
  @Post("workspaces")
  async create(
    @CurrentUserId() userId: string,
    @Body(new ZodValidationPipe(createWorkspaceInputSchema)) body: CreateWorkspaceInput,
  ): Promise<CreatedWorkspace> {
    await this.requireOwner(userId);
    const ws = await this.store.createWorkspace(body.name);
    const admin = await runInTenant(ws.id, async () => {
      const team = await this.store.createTeam({ orgId: ws.id, name: "General" });
      const { user, inviteToken, joinedExisting } = await this.store.createUser({
        orgId: ws.id,
        name: body.adminName,
        email: body.adminEmail,
        role: "admin",
        teamIds: [team.id],
      });
      if (joinedExisting) {
        const { sent } = await this.mailer.sendAddedToWorkspace(user.email, user.name, ws.name, env.appUrl).catch(() => ({ sent: false }));
        return { name: user.name, email: user.email, invited: false, emailed: sent };
      }
      if (!inviteToken) return { name: user.name, email: user.email, invited: false, emailed: false };
      const url = `${env.appUrl}/?invite=${inviteToken}`;
      const { sent } = await this.mailer.sendInvite(user.email, user.name, url, ws.name).catch(() => ({ sent: false }));
      return { name: user.name, email: user.email, invited: true, emailed: sent, inviteUrl: url };
    });
    const summary = (await this.store.listWorkspaces()).find((w) => w.id === ws.id)!;
    const mine = (await this.store.listMemberships(userId)).some((m) => m.user.orgId === ws.id);
    return { workspace: { ...summary, joined: mine, platform: false }, admin };
  }

  /* ---- managing one workspace, from outside it ---- */

  @Patch("workspaces/:id")
  async rename(
    @CurrentUserId() userId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(renameWorkspaceInputSchema)) body: RenameWorkspaceInput,
  ): Promise<PlatformWorkspace> {
    await this.requireOwner(userId);
    await this.workspace(id);
    await this.store.renameWorkspace(id, body.name);
    return this.summary(userId, id);
  }

  /**
   * Suspend, archive, delete (wiped in 30 days), or make active again. Anything
   * but active ends every session in it at once and freezes it: nobody signs
   * in, its channels take nothing in and send nothing out.
   */
  @Post("workspaces/:id/status")
  async setStatus(
    @CurrentUserId() userId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(setWorkspaceStatusInputSchema)) body: SetWorkspaceStatusInput,
  ): Promise<PlatformWorkspace> {
    await this.requireOwner(userId);
    await this.workspace(id);
    if (body.status !== "active") await this.assertMayClose(userId, id);
    const purgeAt = body.status === "deleting" ? new Date(Date.now() + WORKSPACE_DELETE_GRACE_DAYS * 86_400_000) : null;
    await this.store.setWorkspaceStatus(id, body.status, purgeAt);
    if (body.status !== "active") await this.store.revokeWorkspaceSessions(id);
    return this.summary(userId, id);
  }

  /** Wipe it now, for good — its name typed out to confirm. */
  @Post("workspaces/:id/delete-now")
  async deleteNow(
    @CurrentUserId() userId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(deleteWorkspaceNowInputSchema)) body: DeleteWorkspaceNowInput,
  ): Promise<{ ok: true; files: number }> {
    await this.requireOwner(userId);
    const ws = await this.workspace(id);
    await this.assertMayClose(userId, id);
    if (body.confirmName.trim() !== ws.name.trim()) {
      throw new BadRequestException("Type the workspace's name exactly to delete it.");
    }
    // Frozen first, so nothing lands in it while it's being wiped.
    await this.store.setWorkspaceStatus(id, "deleting", new Date());
    const { files } = await this.lifecycle.purge(id);
    return { ok: true, files };
  }

  @Get("workspaces/:id/people")
  async people(@CurrentUserId() userId: string, @Param("id") id: string): Promise<PlatformPerson[]> {
    await this.requireOwner(userId);
    await this.workspace(id);
    return this.store.listWorkspacePeople(id);
  }

  @Post("workspaces/:id/people")
  async addPerson(
    @CurrentUserId() userId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(addPlatformPersonInputSchema)) body: AddPlatformPersonInput,
  ): Promise<PlatformPersonInvite> {
    await this.requireOwner(userId);
    const ws = await this.workspace(id);
    return this.manage(id, async () => {
      if (await this.store.emailInWorkspace(body.email)) {
        throw new ConflictException("Someone in this workspace already has that email address.");
      }
      const { user, inviteToken, joinedExisting } = await this.store.createUser({ orgId: id, name: body.name, email: body.email, role: body.role, teamIds: [] });
      if (joinedExisting) {
        await this.mailer.sendAddedToWorkspace(user.email, user.name, ws.name, env.appUrl).catch(() => undefined);
        return { person: { user, pending: false }, addedExisting: true };
      }
      if (!inviteToken) return { person: { user, pending: false } };
      return { person: { user, pending: true }, invite: await this.sendInvite(user.email, user.name, inviteToken, ws.name) };
    });
  }

  @Patch("workspaces/:id/people/:personId")
  async setRole(
    @CurrentUserId() userId: string,
    @Param("id") id: string,
    @Param("personId") personId: string,
    @Body(new ZodValidationPipe(setPlatformPersonRoleInputSchema)) body: SetPlatformPersonRoleInput,
  ): Promise<PlatformPerson> {
    await this.requireOwner(userId);
    const person = await this.person(id, personId);
    if (person.user.role === "admin" && body.role !== "admin") await this.assertAnotherAdmin(id, personId);
    const user = await this.manage(id, () => this.store.updateUser(personId, { role: body.role }));
    if (!user) throw new NotFoundException("Person not found");
    return { user, pending: person.pending };
  }

  @Delete("workspaces/:id/people/:personId")
  async removePerson(@CurrentUserId() userId: string, @Param("id") id: string, @Param("personId") personId: string): Promise<{ ok: true }> {
    await this.requireOwner(userId);
    const person = await this.person(id, personId);
    if (person.user.role === "admin") await this.assertAnotherAdmin(id, personId);
    await this.manage(id, () => this.store.deleteUser(personId));
    return { ok: true };
  }

  /** A fresh invite for someone who hasn't set their password yet. */
  @Post("workspaces/:id/people/:personId/invite")
  async resendInvite(@CurrentUserId() userId: string, @Param("id") id: string, @Param("personId") personId: string): Promise<PlatformPersonInvite> {
    await this.requireOwner(userId);
    const ws = await this.workspace(id);
    const person = await this.person(id, personId);
    const token = await this.manage(id, () => this.store.reissueInvite(personId));
    if (!token) throw new BadRequestException("They've already set a password — they can sign in, or reset it from the sign-in page.");
    return { person, invite: await this.sendInvite(person.user.email, person.user.name, token, ws.name) };
  }

  private async sendInvite(email: string, name: string, token: string, workspace: string): Promise<{ url: string; emailed: boolean }> {
    const url = `${env.appUrl}/?invite=${token}`;
    const { sent } = await this.mailer.sendInvite(email, name, url, workspace).catch(() => ({ sent: false }));
    return { url, emailed: sent };
  }

  /** Act inside a workspace as its manager from outside — even a frozen one. */
  private manage<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
    return runInTenant(orgId, fn, { manage: true });
  }

  private async workspace(id: string) {
    const ws = (await this.store.listWorkspaces()).find((w) => w.id === id);
    if (!ws) throw new NotFoundException("Workspace not found");
    return ws;
  }

  private async summary(userId: string, id: string): Promise<PlatformWorkspace> {
    const ws = await this.workspace(id);
    const joined = (await this.store.listMemberships(userId)).some((m) => m.user.orgId === id);
    return { ...ws, joined, platform: isPlatformOrg(id) };
  }

  private async person(orgId: string, personId: string): Promise<PlatformPerson> {
    const person = (await this.store.listWorkspacePeople(orgId)).find((p) => p.user.id === personId);
    if (!person) throw new NotFoundException("Person not found");
    return person;
  }

  /** A workspace always keeps someone who can run it. */
  private async assertAnotherAdmin(orgId: string, personId: string): Promise<void> {
    const admins = (await this.store.listWorkspacePeople(orgId)).filter((p) => p.user.role === "admin" && p.user.id !== personId);
    if (!admins.length) throw new BadRequestException("A workspace needs at least one admin — make someone else an admin first.");
  }

  /** The platform's own workspace is never closed, nor the one you're in. */
  private async assertMayClose(userId: string, orgId: string): Promise<void> {
    if (isPlatformOrg(orgId)) throw new BadRequestException("The platform's own workspace can't be suspended, archived or deleted.");
    const here = (await this.store.getUserForAuth(userId))?.orgId;
    if (here === orgId) throw new BadRequestException("You're in this workspace — switch to another one first.");
  }

  private async requireOwner(userId: string): Promise<void> {
    if (!(await isPlatformOwner(this.store, userId))) throw new ForbiddenException("Only the platform's owners manage workspaces");
  }
}
