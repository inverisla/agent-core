import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

export const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

/** One migrate at a time: two deploys at once would otherwise both apply the same file. */
const MIGRATE_LOCK = 7_310_001;

/** The database's applied migrations do not match the repository's: nothing was applied. */
export class MigrationMismatchError extends Error {
  override name = "MigrationMismatchError";
}

interface Applied {
  hash: string;
  createdAt: number;
}

interface Local {
  tag: string;
  hash: string;
  createdAt: number;
}

/**
 * What is wrong between the applied migrations and the repository's, or null if they
 * agree (review Q4). Drizzle applies only migrations newer than the newest applied one,
 * and checks no hashes, so without this:
 * - a migration merged from upstream with an older timestamp than one already applied
 *   would be skipped for good, silently;
 * - a migration changed after it was applied would never run again, silently.
 */
export function migrationMismatch(applied: Applied[], local: Local[]): string | null {
  const byTime = new Map(local.map((m) => [m.createdAt, m]));
  for (const a of applied) {
    const m = byTime.get(a.createdAt);
    if (!m) {
      return (
        `the database has a migration (timestamp ${a.createdAt}) that is not in ` +
        "packages/db/migrations: this code is older than the database, or a migration was removed"
      );
    }
    if (m.hash !== a.hash) {
      return (
        `${m.tag} has changed since it was applied. Restore it as it was, and make the ` +
        "change in a new migration (`pnpm db:generate`, or `drizzle-kit generate --custom`)"
      );
    }
  }
  const newest = Math.max(0, ...applied.map((a) => a.createdAt));
  const appliedTimes = new Set(applied.map((a) => a.createdAt));
  const skipped = local.find((m) => m.createdAt <= newest && !appliedTimes.has(m.createdAt));
  if (skipped) {
    return (
      `${skipped.tag} is older than migrations already applied, so it would be skipped. ` +
      "If it came from upstream, give its entry in packages/db/migrations/meta/_journal.json " +
      `a "when" later than ${newest} (the file itself is unchanged, so it still matches upstream)`
    );
  }
  return null;
}

/** The repository's migrations, with their tags, as Drizzle reads them. */
function localMigrations(): Local[] {
  const files = readMigrationFiles({ migrationsFolder });
  // readMigrationFiles keeps the journal's order; the tags come from the same journal.
  const journal = (
    JSON.parse(readFileSync(`${migrationsFolder}/meta/_journal.json`, "utf8")) as {
      entries: { tag: string; when: number }[];
    }
  ).entries;
  return files.map((f, i) => ({
    tag: journal[i]?.tag ?? String(f.folderMillis),
    hash: f.hash,
    createdAt: f.folderMillis,
  }));
}

/**
 * Applies all migrations. Run as the owner (admin) role, never as the app role. Holds a
 * lock while it runs, and refuses, applying nothing, if the database's applied
 * migrations do not match the repository's (MigrationMismatchError says how).
 */
export async function runMigrations(adminUrl: string): Promise<void> {
  const client = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    // One connection (max: 1), so the lock and the migrations share a session.
    await client`select pg_advisory_lock(${MIGRATE_LOCK})`;
    try {
      const [table] = await client`select to_regclass('drizzle.__drizzle_migrations') as t`;
      const applied: Applied[] = table?.["t"]
        ? (
            await client`select hash, created_at from drizzle.__drizzle_migrations order by created_at`
          ).map((r) => ({ hash: String(r["hash"]), createdAt: Number(r["created_at"]) }))
        : [];
      const problem = migrationMismatch(applied, localMigrations());
      if (problem) {
        throw new MigrationMismatchError(
          `Migrations not applied: ${problem}. On a local database you can instead start ` +
            "again with `docker compose down -v`.",
        );
      }
      await migrate(drizzle(client), { migrationsFolder });
    } finally {
      await client`select pg_advisory_unlock(${MIGRATE_LOCK})`.catch(() => {});
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}
