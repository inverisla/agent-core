import { defineConfig } from "drizzle-kit";

// `drizzle-kit generate` writes table migrations from src/schema.ts into migrations/.
// Roles, row-level security and policies live in hand-written SQL migrations
// (created with `drizzle-kit generate --custom`), so they are reviewed as SQL.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
});
