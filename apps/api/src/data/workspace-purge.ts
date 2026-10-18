import type { PrismaClient } from "@prisma/client";

/**
 * Wipe one workspace and everything in it, for good.
 *
 * What belongs to a workspace is read from the database itself rather than
 * listed here, so a table added next month is wiped with the rest without
 * anyone remembering to add it:
 *
 *  - a table with an `orgId` column: its rows with this workspace's id;
 *  - any other table: rows that hang off rows being wiped, through a foreign
 *    key that owns them (CASCADE, RESTRICT or NO ACTION). A SET NULL key is a
 *    mere reference, not ownership — Postgres clears it, and the row stays.
 *
 * Children go before their parents, all in one transaction: if anything is
 * left holding on, the workspace row can't go either, and nothing is wiped.
 * Logins (which belong to no workspace) go too when this was the last
 * workspace their person was in.
 */
export async function purgeWorkspaceData(db: PrismaClient, orgId: string): Promise<{ files: string[]; rows: Record<string, number> }> {
  const plan = await planPurge(db);
  return db.$transaction(
    async (tx) => {
      const files = plan.has("Attachment")
        ? (await tx.$queryRawUnsafe<{ key: string }[]>(`SELECT "r2Key" AS key FROM "Attachment" WHERE ${plan.get("Attachment")}`, orgId)).map((r) => r.key)
        : [];
      const logins = (await tx.$queryRawUnsafe<{ id: string }[]>(`SELECT DISTINCT "loginId" AS id FROM "User" WHERE "orgId" = $1 AND "loginId" IS NOT NULL`, orgId)).map((r) => r.id);
      const rows: Record<string, number> = {};
      for (const [table, where] of LOOSE) {
        rows[table] = await tx.$executeRawUnsafe(`DELETE FROM ${q(table)} WHERE ${where}`, orgId);
      }
      for (const [table, where] of plan) {
        rows[table] = await tx.$executeRawUnsafe(`DELETE FROM ${q(table)} WHERE ${where}`, orgId);
      }
      if (!rows.Organization) throw new Error(`No workspace ${orgId}`);
      if (logins.length) {
        await tx.$executeRawUnsafe(
          `DELETE FROM "Login" l WHERE l.id = ANY($1::text[]) AND NOT EXISTS (SELECT 1 FROM "User" u WHERE u."loginId" = l.id)`,
          logins,
        );
      }
      await tx.$executeRawUnsafe(`UPDATE "Login" SET "lastOrgId" = NULL WHERE "lastOrgId" = $1`, orgId);
      return { files, rows };
    },
    { maxWait: 10_000, timeout: 10 * 60_000 },
  );
}

/** Tables tied to a workspace by ids alone, with no key the database knows
 *  about to follow. Wiped first, while what they point at is still there. */
const LOOSE: [string, string][] = [
  ["RoutingRule", `"inboxId" IN (SELECT "id" FROM "Inbox" WHERE "orgId" = $1) OR "teamId" IN (SELECT "id" FROM "Team" WHERE "orgId" = $1)`],
];

/** Tables that belong to no workspace, so wiping one never touches them. */
export const PLATFORM_TABLES = new Set(["Login", "_prisma_migrations"]);

/** Tables a workspace's wipe would miss: neither its own, nor platform-wide,
 *  nor listed as loose. Should always be empty (check:workspace-purge-pg). */
export async function tablesMissedByPurge(db: Pick<PrismaClient, "$queryRawUnsafe">): Promise<string[]> {
  const plan = await planPurge(db);
  const loose = new Set(LOOSE.map(([t]) => t));
  const all = await db.$queryRawUnsafe<{ t: string }[]>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = current_schema()`);
  return all.map((r) => r.t).filter((t) => !plan.has(t) && !PLATFORM_TABLES.has(t) && !loose.has(t));
}

interface ForeignKey {
  child: string;
  col: string;
  parent: string;
  pcol: string;
  /** confdeltype: a no action, r restrict, c cascade, n set null, d set default */
  del: string;
  ncols: number;
}

/** Each table to wipe, in the order to wipe it, with its WHERE ($1 = orgId). */
export async function planPurge(db: Pick<PrismaClient, "$queryRawUnsafe">): Promise<Map<string, string>> {
  const fks = await db.$queryRawUnsafe<ForeignKey[]>(`
    SELECT cl.relname AS child, a.attname AS col, pl.relname AS parent, pa.attname AS pcol,
           c.confdeltype AS del, array_length(c.conkey, 1) AS ncols
    FROM pg_constraint c
    JOIN pg_class cl ON cl.oid = c.conrelid
    JOIN pg_class pl ON pl.oid = c.confrelid
    JOIN pg_namespace n ON n.oid = cl.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = c.confkey[1]
    WHERE c.contype = 'f' AND n.nspname = current_schema()`);
  const orgCols = await db.$queryRawUnsafe<{ table: string; nullable: string }[]>(`
    SELECT table_name AS table, is_nullable AS nullable FROM information_schema.columns
    WHERE table_schema = current_schema() AND column_name = 'orgId'`);
  const multi = fks.find((f) => Number(f.ncols) > 1);
  if (multi) throw new Error(`Wiping a workspace can't follow the multi-column key ${multi.child} → ${multi.parent}`);

  const orgColumn = new Map(orgCols.map((c) => [c.table, c.nullable === "YES"]));
  const owning = fks.filter((f) => f.del !== "n" && f.del !== "d" && f.child !== f.parent);

  // Which rows of a table are this workspace's, as SQL. `path` stops a cycle.
  const memo = new Map<string, string | null>();
  const owned = (table: string, path: Set<string>): string | null => {
    if (memo.has(table)) return memo.get(table)!;
    if (PLATFORM_TABLES.has(table)) return null;
    if (table === "Organization") return `"id" = $1`;
    const nullableOrg = orgColumn.get(table);
    if (nullableOrg === false) {
      memo.set(table, `"orgId" = $1`);
      return memo.get(table)!;
    }
    const via: string[] = [];
    for (const f of owning) {
      if (f.child !== table || path.has(f.parent)) continue;
      const parent = owned(f.parent, new Set([...path, table]));
      if (parent) via.push(`${q(f.col)} IN (SELECT ${q(f.pcol)} FROM ${q(f.parent)} WHERE ${parent})`);
    }
    const derived = via.length ? `(${via.join(" OR ")})` : null;
    const where =
      nullableOrg === true ? (derived ? `("orgId" = $1 OR ("orgId" IS NULL AND ${derived}))` : `"orgId" = $1`) : derived;
    memo.set(table, where);
    return where;
  };

  const tables = [...new Set(fks.flatMap((f) => [f.child, f.parent]).concat([...orgColumn.keys()], ["Organization"]))];
  const scope = new Map<string, string>();
  for (const t of tables) {
    const where = owned(t, new Set());
    if (where) scope.set(t, where);
  }

  // Children before parents (over the owning keys among tables in scope).
  const ordered: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (t: string) => {
    if (state.get(t) === "done") return;
    if (state.get(t) === "visiting") throw new Error(`Wiping a workspace found a cycle of owning keys through ${t}`);
    state.set(t, "visiting");
    for (const f of owning) if (f.parent === t && scope.has(f.child)) visit(f.child);
    state.set(t, "done");
    ordered.push(t);
  };
  for (const t of scope.keys()) visit(t);
  return new Map(ordered.map((t) => [t, scope.get(t)!]));
}

function q(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}
