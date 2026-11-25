import { createTenantDatabase, parseContextKey, type TenantDatabase } from "@agent-core/db";

const globalForDb = globalThis as unknown as { agentCoreDb?: TenantDatabase };

/** The app's one tenant-scoped database pool (reused across hot reloads in dev). */
export function db(): TenantDatabase {
  globalForDb.agentCoreDb ??= createTenantDatabase(requireEnv("DATABASE_URL"), {
    contextKey: parseContextKey(process.env["TENANT_CONTEXT_KEY"]),
  });
  return globalForDb.agentCoreDb;
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Copy .env.example to .env.local.`);
  return value;
}
