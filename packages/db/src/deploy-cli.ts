// Prepares the database on each deploy (the migrate job in Azure runs this):
//  1. creates the database if it does not exist, so the migrating role owns it;
//  2. applies migrations as that owner;
//  3. gives the app role (agentcore_app) its login and password;
//  4. stores the tenant context key.
// Every step is safe to repeat. Settings: DATABASE_ADMIN_URL, APP_DB_PASSWORD,
// TENANT_CONTEXT_KEY.
import postgres from "postgres";
import { parseContextKey, setContextKey } from "./context-key.ts";
import { runMigrations } from "./migrate.ts";
import { scramSha256Verifier } from "./scram.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
}

async function main() {
  const adminUrl = required("DATABASE_ADMIN_URL");
  const appPassword = required("APP_DB_PASSWORD");
  const contextKey = parseContextKey(process.env["TENANT_CONTEXT_KEY"]);
  const database = new URL(adminUrl).pathname.slice(1);
  if (!/^[a-z_][a-z0-9_]*$/.test(database)) throw new Error("Unexpected database name.");

  const maintenanceUrl = new URL(adminUrl);
  maintenanceUrl.pathname = "/postgres";
  const server = postgres(maintenanceUrl.toString(), { max: 1, onnotice: () => {} });
  try {
    const [exists] = await server`select 1 from pg_database where datname = ${database}`;
    if (!exists) {
      // The name was checked above; identifiers cannot be passed as parameters.
      await server.unsafe(`create database ${database}`);
      console.log(`deploy: created database ${database}`);
    }
  } finally {
    await server.end({ timeout: 5 });
  }

  await runMigrations(adminUrl);
  console.log("deploy: migrations applied");

  const db = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    // Only a SCRAM verifier is sent, never the password, so statement statistics and
    // logs cannot reveal it. Postgres quotes the verifier (%L).
    const [row] = await db<{ statement: string }[]>`
      select format('alter role agentcore_app login password %L', ${scramSha256Verifier(appPassword)}::text) as statement`;
    if (!row) throw new Error("Could not prepare the app role statement.");
    await db.unsafe(row.statement);
    console.log("deploy: app role login set");
  } finally {
    await db.end({ timeout: 5 });
  }

  await setContextKey(adminUrl, contextKey);
  console.log("deploy: tenant context key set");
}

try {
  await main();
} catch (error) {
  console.error(`deploy failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
