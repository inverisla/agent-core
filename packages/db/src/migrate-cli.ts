import { runMigrations } from "./migrate.ts";

const adminUrl = process.env["DATABASE_ADMIN_URL"];
if (!adminUrl) {
  console.error("DATABASE_ADMIN_URL is not set. Copy .env.example to .env.local.");
  process.exit(1);
}

await runMigrations(adminUrl);
console.log("db: migrations applied");
