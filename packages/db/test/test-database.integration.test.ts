// The test-database helper: dropping a test database must not fail just because a
// connection to it is still closing (as after a test where Postgres ends a connection
// for a timeout). The owner role may not end the app role's connections itself.
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { createTestDatabase, serverAdminUrl } from "../src/testing.ts";

describe("dropping a test database", () => {
  it("waits for a connection that is still closing, rather than failing", async () => {
    const testDb = await createTestDatabase();
    // An app-role connection that stays open a moment after the drop starts.
    const app = postgres(testDb.appUrl, { max: 1, onnotice: () => {} });
    await app`select 1`;
    const closing = new Promise<void>((resolve) =>
      setTimeout(() => void app.end().then(resolve, () => resolve()), 500),
    );
    await testDb.drop();
    await closing;
    const owner = postgres(serverAdminUrl(), { max: 1, onnotice: () => {} });
    const name = new URL(testDb.adminUrl).pathname.slice(1);
    const [left] = await owner`select count(*)::int as n from pg_database where datname = ${name}`;
    await owner.end();
    expect(left?.n).toBe(0);
  });
});
