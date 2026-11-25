// Task 14: every app connection gives up on a stuck query or an abandoned transaction.
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTenantDatabase,
  createTenantWithAdmin,
  SETUP_ACTOR,
  type TenantDatabase,
} from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";

let testDb: TestDatabase;
let db: TenantDatabase;
let quick: TenantDatabase;
let tenantId = "";

beforeAll(async () => {
  testDb = await createTestDatabase();
  db = createTenantDatabase(testDb.appUrl, { contextKey: testDb.contextKey, maxConnections: 1 });
  quick = createTenantDatabase(testDb.appUrl, {
    contextKey: testDb.contextKey,
    maxConnections: 1,
    statementTimeoutMs: 200,
    idleInTransactionTimeoutMs: 300,
    transactionTimeoutMs: 600,
  });
  tenantId = await createTenantWithAdmin(
    db,
    { name: "Timeouts", slug: "timeouts", adminEmail: "a@timeouts.example" },
    SETUP_ACTOR,
  );
});

afterAll(async () => {
  await quick?.close();
  await db?.close();
  await testDb?.drop();
});

describe("database timeouts", () => {
  it("are on by default: 15 s per statement, 30 s idle, 60 s per transaction", async () => {
    const [row] = await db.withTenant(tenantId, (tx) =>
      tx.execute<{ s: string; i: string; t: string }>(
        sql`select current_setting('statement_timeout') as s, current_setting('idle_in_transaction_session_timeout') as i, current_setting('transaction_timeout') as t`,
      ),
    );
    expect(row).toEqual({ s: "15s", i: "30s", t: "1min" });
  });

  it("stop a statement that runs too long", async () => {
    await expect(
      quick.withTenant(tenantId, (tx) => tx.execute(sql`select pg_sleep(2)`)),
    ).rejects.toThrow();
    // The connection is fine afterwards.
    const [row] = await quick.withTenant(tenantId, (tx) =>
      tx.execute<{ one: number }>(sql`select 1 as one`),
    );
    expect(row?.one).toBe(1);
  });

  it("end a transaction left idle", async () => {
    await expect(
      quick.withTenant(tenantId, async (tx) => {
        await new Promise((r) => setTimeout(r, 800));
        await tx.execute(sql`select 1`);
      }),
    ).rejects.toThrow();
    const [row] = await quick.withTenant(tenantId, (tx) =>
      tx.execute<{ one: number }>(sql`select 1 as one`),
    );
    expect(row?.one).toBe(1);
  });

  it("end a transaction that runs too long, even one made of short statements", async () => {
    await expect(
      quick.withTenant(tenantId, async (tx) => {
        for (let i = 0; i < 10; i++) await tx.execute(sql`select pg_sleep(0.1)`);
      }),
    ).rejects.toThrow();
    const [row] = await quick.withTenant(tenantId, (tx) =>
      tx.execute<{ one: number }>(sql`select 1 as one`),
    );
    expect(row?.one).toBe(1);
  });
});
