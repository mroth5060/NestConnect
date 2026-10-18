import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type { OpsActor, OpsResource, OpsRevision, OpsStatus, OpsStep } from "@ding/schemas";
import { PrismaService } from "../data/prisma.service";
import { tenantScoped, type TenantPrisma } from "../data/tenant-prisma";
import { currentOrgId } from "../tenancy/tenant-scope";
import { OpsStore, type OpsAckRecord, type OpsCollectionRecord, type OpsSopFields, type OpsSopRecord } from "./ops.store";

const withTeams = { teams: { select: { teamId: true } } } as const;
type SopRow = Prisma.OpsSopGetPayload<{ include: typeof withTeams }>;

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const date = (s: string | null | undefined): Date | null => (s ? new Date(s) : null);
const json = (v: unknown) => v as Prisma.InputJsonValue;

function toSop(r: SopRow): OpsSopRecord {
  return {
    id: r.id,
    collectionId: r.collectionId,
    title: r.title,
    icon: r.icon,
    color: r.color,
    summary: r.summary,
    warnings: r.warnings,
    steps: (r.steps as unknown as OpsStep[]) ?? [],
    body: r.body,
    resources: (r.resources as unknown as OpsResource[]) ?? [],
    teamIds: r.teams.map((t) => t.teamId).sort(),
    allTeams: r.allTeams,
    status: r.status as OpsStatus,
    version: r.version,
    mustRead: r.mustRead,
    reviewEveryMonths: r.reviewEveryMonths,
    reviewDueAt: iso(r.reviewDueAt),
    reviewNotifiedAt: iso(r.reviewNotifiedAt),
    lastReviewedAt: iso(r.lastReviewedAt),
    owner: r.ownerName ? { id: r.ownerUserId, name: r.ownerName } : null,
    publishedAt: iso(r.publishedAt),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    updatedBy: r.updatedByName ? { id: r.updatedById, name: r.updatedByName } : null,
  };
}

/** The columns a patch sets. Teams are a relation, handled on their own. */
function columns(p: Partial<OpsSopFields>): Prisma.OpsSopUncheckedUpdateInput {
  const out: Prisma.OpsSopUncheckedUpdateInput = {};
  const plain = ["collectionId", "title", "icon", "color", "summary", "warnings", "body", "allTeams", "status", "version", "mustRead", "reviewEveryMonths"] as const;
  for (const k of plain) if (p[k] !== undefined) (out as Record<string, unknown>)[k] = p[k];
  if (p.steps !== undefined) out.steps = json(p.steps);
  if (p.resources !== undefined) out.resources = json(p.resources);
  for (const k of ["reviewDueAt", "reviewNotifiedAt", "lastReviewedAt", "publishedAt"] as const) {
    if (p[k] !== undefined) out[k] = date(p[k]);
  }
  if (p.owner !== undefined) {
    out.ownerUserId = p.owner?.id ?? null;
    out.ownerName = p.owner?.name ?? null;
  }
  return out;
}

/** Postgres, through the tenant-scoped client: every query is the bound workspace's,
 *  and a team, collection or person from another workspace is refused on write. */
@Injectable()
export class PrismaOpsStore extends OpsStore {
  private readonly prisma: TenantPrisma;

  constructor(private readonly root: PrismaService) {
    super();
    this.prisma = tenantScoped(root);
  }

  async listCollections(): Promise<OpsCollectionRecord[]> {
    const rows = await this.prisma.opsCollection.findMany({ orderBy: [{ order: "asc" }, { name: "asc" }] });
    return rows.map(({ id, name, icon, color, order }) => ({ id, name, icon, color, order }));
  }
  async getCollection(id: string): Promise<OpsCollectionRecord | undefined> {
    const r = await this.prisma.opsCollection.findUnique({ where: { id } });
    return r ? { id: r.id, name: r.name, icon: r.icon, color: r.color, order: r.order } : undefined;
  }
  async collectionByName(name: string): Promise<OpsCollectionRecord | undefined> {
    const r = await this.prisma.opsCollection.findFirst({ where: { name: { equals: name, mode: "insensitive" } } });
    return r ? { id: r.id, name: r.name, icon: r.icon, color: r.color, order: r.order } : undefined;
  }
  async createCollection(f: Omit<OpsCollectionRecord, "id" | "order">): Promise<OpsCollectionRecord> {
    const last = await this.prisma.opsCollection.aggregate({ _max: { order: true } });
    const r = await this.prisma.opsCollection.create({
      data: { orgId: currentOrgId(), name: f.name, icon: f.icon, color: f.color, order: (last._max.order ?? -1) + 1 },
    });
    return { id: r.id, name: r.name, icon: r.icon, color: r.color, order: r.order };
  }
  async updateCollection(id: string, patch: Partial<Omit<OpsCollectionRecord, "id">>): Promise<OpsCollectionRecord | undefined> {
    const found = await this.prisma.opsCollection.findUnique({ where: { id }, select: { id: true } });
    if (!found) return undefined;
    const data = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const r = await this.prisma.opsCollection.update({ where: { id }, data });
    return { id: r.id, name: r.name, icon: r.icon, color: r.color, order: r.order };
  }
  async removeCollection(id: string): Promise<boolean> {
    const found = await this.prisma.opsCollection.findUnique({ where: { id }, select: { id: true } });
    if (!found) return false;
    // The foreign key sets its SOPs' collection to none.
    await this.prisma.opsCollection.delete({ where: { id } });
    return true;
  }

  async listSops(): Promise<OpsSopRecord[]> {
    const rows = await this.prisma.opsSop.findMany({ include: withTeams, orderBy: { title: "asc" } });
    return rows.map(toSop);
  }
  async getSop(id: string): Promise<OpsSopRecord | undefined> {
    const r = await this.prisma.opsSop.findUnique({ where: { id }, include: withTeams });
    return r ? toSop(r) : undefined;
  }
  async createSop(f: OpsSopFields, by: OpsActor): Promise<OpsSopRecord> {
    const r = await this.prisma.opsSop.create({
      data: {
        ...(columns(f) as Prisma.OpsSopUncheckedCreateInput),
        orgId: currentOrgId(),
        title: f.title,
        createdById: by.id,
        createdByName: by.name,
        updatedById: by.id,
        updatedByName: by.name,
        teams: { create: [...new Set(f.teamIds)].map((teamId) => ({ teamId })) },
      },
      include: withTeams,
    });
    return toSop(r);
  }
  async updateSop(id: string, patch: Partial<OpsSopFields>, by?: OpsActor): Promise<OpsSopRecord | undefined> {
    const found = await this.prisma.opsSop.findUnique({ where: { id }, select: { id: true, updatedAt: true } });
    if (!found) return undefined;
    if (patch.teamIds) {
      // Replaced wholesale: the editor sends the full set.
      await this.prisma.opsSopTeam.deleteMany({ where: { opsSopId: id } });
      for (const teamId of [...new Set(patch.teamIds)]) await this.prisma.opsSopTeam.create({ data: { opsSopId: id, teamId } });
    }
    const r = await this.prisma.opsSop.update({
      where: { id },
      data: {
        ...columns(patch),
        // Nobody's edit (a reminder sent) doesn't move "last updated".
        ...(by ? { updatedById: by.id, updatedByName: by.name } : { updatedAt: found.updatedAt }),
      },
      include: withTeams,
    });
    return toSop(r);
  }
  async removeSop(id: string): Promise<boolean> {
    const found = await this.prisma.opsSop.findUnique({ where: { id }, select: { id: true } });
    if (!found) return false;
    await this.prisma.opsSop.delete({ where: { id } });
    return true;
  }

  async addRevision(opsSopId: string, rev: OpsRevision): Promise<void> {
    await this.prisma.opsSopRevision.create({
      data: {
        opsSopId,
        version: rev.version,
        title: rev.title,
        summary: rev.summary,
        warnings: rev.warnings,
        steps: json(rev.steps),
        body: rev.body,
        note: rev.note,
        publishedAt: new Date(rev.publishedAt),
        publishedById: rev.publishedBy?.id ?? null,
        publishedByName: rev.publishedBy?.name ?? null,
      },
    });
  }
  async listRevisions(opsSopId: string): Promise<OpsRevision[]> {
    const rows = await this.prisma.opsSopRevision.findMany({ where: { opsSopId }, orderBy: { version: "desc" } });
    return rows.map((r) => ({
      version: r.version,
      title: r.title,
      summary: r.summary,
      warnings: r.warnings,
      steps: (r.steps as unknown as OpsStep[]) ?? [],
      body: r.body,
      note: r.note,
      publishedAt: r.publishedAt.toISOString(),
      publishedBy: r.publishedByName ? { id: r.publishedById, name: r.publishedByName } : null,
    }));
  }

  async setAck(opsSopId: string, userId: string, version: number): Promise<OpsAckRecord> {
    const at = new Date();
    await this.prisma.opsAck.upsert({
      where: { opsSopId_userId: { opsSopId, userId } },
      create: { opsSopId, userId, version, at },
      update: { version, at },
    });
    return { opsSopId, userId, version, at: at.toISOString() };
  }
  async acksForSop(opsSopId: string): Promise<OpsAckRecord[]> {
    const rows = await this.prisma.opsAck.findMany({ where: { opsSopId } });
    return rows.map((a) => ({ opsSopId: a.opsSopId, userId: a.userId, version: a.version, at: a.at.toISOString() }));
  }
  async acksForUser(userId: string): Promise<OpsAckRecord[]> {
    const rows = await this.prisma.opsAck.findMany({ where: { userId } });
    return rows.map((a) => ({ opsSopId: a.opsSopId, userId: a.userId, version: a.version, at: a.at.toISOString() }));
  }

  async getChecklist(opsSopId: string, userId: string): Promise<number[]> {
    const r = await this.prisma.opsChecklist.findUnique({ where: { opsSopId_userId: { opsSopId, userId } } });
    return r ? ((r.done as unknown as number[]) ?? []) : [];
  }
  async setChecklist(opsSopId: string, userId: string, done: number[]): Promise<number[]> {
    const clean = [...new Set(done)].sort((a, b) => a - b);
    await this.prisma.opsChecklist.upsert({
      where: { opsSopId_userId: { opsSopId, userId } },
      create: { opsSopId, userId, done: json(clean) },
      update: { done: json(clean) },
    });
    return clean;
  }

  async reviewsDueAcrossWorkspaces(now: Date): Promise<Array<{ id: string; orgId: string }>> {
    // Unscoped on purpose: one sweep covers every workspace.
    return this.root.opsSop.findMany({
      where: { status: "published", reviewNotifiedAt: null, reviewDueAt: { lte: now }, org: { status: "active" } },
      select: { id: true, orgId: true },
    });
  }
}
