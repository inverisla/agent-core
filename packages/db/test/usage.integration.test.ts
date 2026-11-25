// Task 13: usage per tenant and month, from the tables that record it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTenantDatabase,
  createTenantWithAdmin,
  monthRange,
  schema,
  SETUP_ACTOR,
  tenantUsage,
  type TenantDatabase,
} from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";

let testDb: TestDatabase;
let db: TenantDatabase;
const t = { a: "", b: "" };

const IN_MONTH = new Date("2026-10-15T12:00:00Z");
const LAST_DAY = new Date("2026-10-31T23:59:59Z");
const NEXT_MONTH = new Date("2026-11-01T00:00:00Z");

/** A document, a job with this status, and its model calls, all at `at`. */
async function work(
  tenantId: string,
  at: Date,
  status: (typeof schema.jobStatus.enumValues)[number],
  calls: { input: number; output: number; cost: string | null; failed?: boolean }[],
) {
  await db.withTenant(tenantId, async (tx) => {
    const [user] = await tx.select().from(schema.users);
    const [doc] = await tx
      .insert(schema.documents)
      .values({
        tenantId,
        filename: "x.pdf",
        contentType: "application/pdf",
        sizeBytes: 1,
        blobPath: `p-${Math.random()}`,
        sha256: "s",
        uploadedBy: user?.userId ?? "",
        createdAt: at,
      })
      .returning();
    const [job] = await tx
      .insert(schema.jobs)
      .values({
        tenantId,
        documentId: doc?.documentId ?? "",
        agentName: "a",
        agentVersion: "v",
        status,
        createdAt: at,
      })
      .returning();
    for (const c of calls) {
      await tx.insert(schema.modelCalls).values({
        tenantId,
        jobId: job?.jobId ?? "",
        step: "fields",
        provider: "azure-openai",
        model: "m",
        outcome: c.failed ? "failed" : "succeeded",
        inputTokens: c.input,
        outputTokens: c.output,
        costUsd: c.cost,
        durationMs: 1,
        createdAt: at,
      });
    }
  });
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  db = createTenantDatabase(testDb.appUrl, { contextKey: testDb.contextKey, maxConnections: 2 });
  for (const key of ["a", "b"] as const) {
    t[key] = await createTenantWithAdmin(
      db,
      { name: key, slug: `usage-${key}`, adminEmail: `admin@${key}.example` },
      SETUP_ACTOR,
    );
  }
  await work(t.a, IN_MONTH, "approved", [
    { input: 1000, output: 200, cost: "0.0123" },
    { input: 0, output: 0, cost: null, failed: true },
  ]);
  await work(t.a, LAST_DAY, "failed", [{ input: 500, output: 0, cost: "0.00005" }]);
  await work(t.a, IN_MONTH, "awaiting_review", []);
  await work(t.a, IN_MONTH, "running", []);
  await work(t.a, IN_MONTH, "succeeded", []);
  // Outside the month, and another tenant's: not counted.
  await work(t.a, NEXT_MONTH, "approved", [{ input: 9999, output: 9999, cost: "9" }]);
  await work(t.b, IN_MONTH, "approved", [{ input: 7777, output: 7777, cost: "7" }]);
});

afterAll(async () => {
  await db?.close();
  await testDb?.drop();
});

describe("usage per tenant", () => {
  it("counts a calendar month (UTC) of the tenant's own work", async () => {
    const october = monthRange("2026-10");
    if (!october) throw new Error("no range");
    expect(await tenantUsage(db, t.a, october)).toEqual({
      documents: 5,
      jobs: 5,
      jobsApproved: 2,
      jobsAwaitingReview: 1,
      jobsFailed: 1,
      jobsInProgress: 1,
      modelCalls: 3,
      modelCallsFailed: 1,
      inputTokens: 1500,
      outputTokens: 200,
      costUsd: "0.0124",
    });
  });

  it("is all zeros for a month with nothing in it", async () => {
    const range = monthRange("2025-01");
    if (!range) throw new Error("no range");
    expect(await tenantUsage(db, t.a, range)).toMatchObject({
      documents: 0,
      jobs: 0,
      modelCalls: 0,
      inputTokens: 0,
      costUsd: "0.0000",
    });
  });

  it("reads months strictly", () => {
    expect(monthRange("2026-12")).toEqual({
      from: new Date("2026-12-01T00:00:00Z"),
      to: new Date("2027-01-01T00:00:00Z"),
    });
    for (const bad of ["2026-13", "2026-1", "26-01", "2026-01-01", "", "2026-00"]) {
      expect(monthRange(bad), bad).toBeNull();
    }
  });
});
