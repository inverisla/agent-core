// Checks a database restored from backup against the one it was restored from (task 14),
// for the restore drill (.github/workflows/restore-drill.yml).
//
// - The same migrations have run.
// - The app role works on it: its role checks pass and a tenant's context can be set,
//   which needs the restored context key. So the restore is usable, not just present.
// - Every tenant that existed by the cut-off is there, with the same number of users,
//   documents, jobs, review events and audit events created before the cut-off.
//
// The cut-off is two transaction lengths before the restore point: no app transaction
// lasts longer than MAX_TRANSACTION_MS, and rows are stamped when their transaction
// starts, so anything stamped before the cut-off had committed by the restore point.
import { and, lt, sql, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { auditEvents, documents, jobs, reviewEvents, tenants, users } from "./schema.ts";
import { createTenantDatabase, MAX_TRANSACTION_MS, type TenantDatabase } from "./tenant-context.ts";

export interface RestoreCheck {
  ok: boolean;
  /** One line per check, for the drill's summary. */
  lines: string[];
}

const COUNTED: { name: string; table: PgTable; stamp: PgColumn }[] = [
  { name: "users", table: users, stamp: users.createdAt },
  { name: "documents", table: documents, stamp: documents.createdAt },
  { name: "jobs", table: jobs, stamp: jobs.createdAt },
  { name: "review events", table: reviewEvents, stamp: reviewEvents.createdAt },
  { name: "audit events", table: auditEvents, stamp: auditEvents.occurredAt },
];

async function migrationCount(adminUrl: string): Promise<number> {
  const client = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    const [row] = await client<
      { n: number }[]
    >`select count(*)::int as n from drizzle.__drizzle_migrations`;
    return row?.n ?? 0;
  } finally {
    await client.end({ timeout: 5 });
  }
}

async function counts(
  db: TenantDatabase,
  tenantId: string,
  cutoff: Date,
): Promise<Record<string, number>> {
  return db.withTenant(tenantId, async (tx) => {
    const out: Record<string, number> = {};
    for (const { name, table, stamp } of COUNTED) {
      const [row] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(table)
        .where(lt(stamp, cutoff) as SQL);
      out[name] = row?.n ?? 0;
    }
    return out;
  });
}

async function tenantsBefore(
  db: TenantDatabase,
  cutoff: Date,
): Promise<{ tenantId: string; slug: string }[]> {
  const found: { tenantId: string; slug: string }[] = [];
  for (const t of await db.listTenants()) {
    const [row] = await db.withTenant(t.tenantId, (tx) =>
      tx
        .select({ id: tenants.tenantId })
        .from(tenants)
        .where(and(lt(tenants.createdAt, cutoff))),
    );
    if (row) found.push(t);
  }
  return found;
}

export async function checkRestore(input: {
  source: { appUrl: string; adminUrl: string };
  restored: { appUrl: string; adminUrl: string };
  contextKey: Buffer;
  /** When the restore was taken from. */
  restorePoint: Date;
}): Promise<RestoreCheck> {
  const cutoff = new Date(input.restorePoint.getTime() - 2 * MAX_TRANSACTION_MS);
  const lines: string[] = [];
  let ok = true;
  const fail = (line: string) => {
    ok = false;
    lines.push(`FAIL ${line}`);
  };

  const [sourceMigrations, restoredMigrations] = await Promise.all([
    migrationCount(input.source.adminUrl),
    migrationCount(input.restored.adminUrl),
  ]);
  if (sourceMigrations === restoredMigrations) lines.push(`ok   migrations: ${restoredMigrations}`);
  else fail(`migrations: ${restoredMigrations} restored, ${sourceMigrations} in the source`);

  const source = createTenantDatabase(input.source.appUrl, {
    contextKey: input.contextKey,
    maxConnections: 1,
  });
  const restored = createTenantDatabase(input.restored.appUrl, {
    contextKey: input.contextKey,
    maxConnections: 1,
  });
  try {
    const expected = await tenantsBefore(source, cutoff);
    lines.push(
      `ok   app role signs in to the restored database; ${expected.length} tenants to compare`,
    );
    const totals: Record<string, number> = {};
    for (const t of expected) {
      const id = await restored.tenantIdForSlug(t.slug);
      if (id !== t.tenantId) {
        fail(`tenant ${t.slug} is missing from the restore`);
        continue;
      }
      const [want, got] = await Promise.all([
        counts(source, t.tenantId, cutoff),
        counts(restored, t.tenantId, cutoff),
      ]);
      for (const { name } of COUNTED) {
        totals[name] = (totals[name] ?? 0) + (got[name] ?? 0);
        if (want[name] !== got[name])
          fail(`tenant ${t.slug}: ${got[name]} ${name} restored, ${want[name]} in the source`);
      }
    }
    lines.push(
      `ok   rows before ${cutoff.toISOString()} checked: ${COUNTED.map(({ name }) => `${totals[name] ?? 0} ${name}`).join(", ")}`,
    );
  } catch (error) {
    fail(
      `could not read as the app role: ${error instanceof Error ? error.message.split("\n")[0] : "unknown error"}`,
    );
  } finally {
    await source.close();
    await restored.close();
  }
  return { ok, lines };
}
