// Shared plumbing for the setup commands: plain error messages (never a stack trace or a
// raw database error), and the usage line for unknown or malformed options.
import { parseArgs, type ParseArgsConfig } from "node:util";
import { parseContextKey } from "./context-key.ts";
import { createTenantDatabase, type TenantDatabase } from "./tenant-context.ts";

export class UsageError extends Error {}

export function parseCliArgs<T extends NonNullable<ParseArgsConfig["options"]>>(options: T) {
  try {
    return parseArgs({
      args: process.argv.slice(2).filter((a) => a !== "--"),
      options,
      strict: true,
    }).values;
  } catch {
    throw new UsageError();
  }
}

/** Runs a command against the app database, as the app role, with tenant context. */
export async function runCli(usage: string, main: (db: () => TenantDatabase) => Promise<void>) {
  let db: TenantDatabase | undefined;
  const open = () => {
    if (db) return db;
    const url = process.env["DATABASE_URL"];
    if (!url) throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local.");
    db = createTenantDatabase(url, {
      contextKey: parseContextKey(process.env["TENANT_CONTEXT_KEY"]),
    });
    return db;
  };
  try {
    await main(open);
  } catch (error) {
    console.error(
      error instanceof UsageError ? usage : error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
  } finally {
    await db?.close();
  }
}
