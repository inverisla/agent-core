import { parseContextKey, setContextKey } from "./context-key.ts";

const adminUrl = process.env["DATABASE_ADMIN_URL"];
if (!adminUrl) {
  console.error("DATABASE_ADMIN_URL is not set. Copy .env.example to .env.local.");
  process.exit(1);
}

await setContextKey(adminUrl, parseContextKey(process.env["TENANT_CONTEXT_KEY"]));
console.log("db: tenant context key set");
