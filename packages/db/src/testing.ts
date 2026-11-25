// For tests only: a fresh, migrated database with its own tenant context key, created
// as the owner role and dropped afterwards.
import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { setContextKey } from "./context-key.ts";
import { runMigrations } from "./migrate.ts";
import * as schema from "./schema.ts";
import type { TenantDatabase } from "./tenant-context.ts";
import { slugProblem } from "./tenant-slug.ts";

export interface TestDatabase {
  appUrl: string;
  adminUrl: string;
  contextKey: Buffer;
  drop(): Promise<void>;
}

const DEFAULT_ADMIN_URL = "postgres://agentcore_owner:agentcore_owner@localhost:5433/agentcore";
const DEFAULT_APP_URL = "postgres://agentcore_app:agentcore_app@localhost:5433/agentcore";

/**
 * Tries at dropping a test database, 200 ms apart: up to 5 s for its connections to
 * close, well inside Vitest's 10 s hook timeout, so a real leak shows Postgres's error.
 */
const DROP_ATTEMPTS = 25;

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

/** The owner's connection to the server's own database (where test databases are made). */
export function serverAdminUrl(): string {
  return process.env["DATABASE_ADMIN_URL"] ?? DEFAULT_ADMIN_URL;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const serverUrl = serverAdminUrl();
  const name = `agentcore_test_${randomUUID().replaceAll("-", "")}`;
  const server = postgres(serverUrl, { max: 1, onnotice: () => {} });
  try {
    await server.unsafe(`create database ${name}`);
  } catch (error) {
    throw new Error(
      "Could not create a test database. Is the local stack running (`docker compose up`)?",
      { cause: error },
    );
  } finally {
    await server.end();
  }
  const adminUrl = withDatabase(serverUrl, name);
  const appUrl = withDatabase(process.env["DATABASE_URL"] ?? DEFAULT_APP_URL, name);
  const contextKey = randomBytes(32);
  await runMigrations(adminUrl);
  await setContextKey(adminUrl, contextKey);
  return {
    appUrl,
    adminUrl,
    contextKey,
    async drop() {
      const s = postgres(serverUrl, { max: 1, onnotice: () => {} });
      try {
        // WITH (FORCE) ends the database's other connections, but the owner role may not
        // end the app role's. A connection a test has just closed, or that Postgres has
        // just ended for a timeout, can still be closing: wait for it rather than fail.
        for (let attempt = 1; ; attempt++) {
          try {
            await s.unsafe(`drop database if exists ${name} with (force)`);
            return;
          } catch (error) {
            const code = (error as { code?: string }).code;
            // 42501: permission denied to terminate; 55006: still in use.
            if ((code !== "42501" && code !== "55006") || attempt >= DROP_ATTEMPTS) throw error;
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
        }
      } finally {
        await s.end();
      }
    },
  };
}

/**
 * Tests only (review Q10): a tenant with no admin and no audit row, which the app never
 * makes. The app's own way is createTenantWithAdmin, with an actor.
 */
export async function createTestTenant(
  db: TenantDatabase,
  { name, slug }: { name: string; slug: string },
): Promise<string> {
  const problem = slugProblem(slug);
  if (problem !== null) throw new Error(`Invalid tenant slug: ${problem}`);
  const tenantId = randomUUID();
  await db.withTenant(tenantId, (tx) => tx.insert(schema.tenants).values({ tenantId, name, slug }));
  return tenantId;
}
