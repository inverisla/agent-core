// Task 8: model calls are recorded per job and per tenant, and a tenant sees only its own.
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addTenantUser,
  createJob,
  createTenantDatabase,
  modelUsageForJob,
  modelUsageForTenant,
  recordModelCall,
  schema,
  type ModelCallRecord,
  type TenantDatabase,
  SETUP_ACTOR,
} from "../src/index.ts";
import { createTestDatabase, type TestDatabase, createTestTenant } from "../src/testing.ts";

let testDb: TestDatabase;
let db: TenantDatabase;
const t = { a: { id: "", job1: "", job2: "" }, b: { id: "", job1: "", job2: "" } };

async function tenantWithJobs(slug: string) {
  const id = await createTestTenant(db, { name: slug, slug });
  const user = await addTenantUser(
    db,
    id,
    { email: `u@${slug}.example`, role: "tenant_user" },
    SETUP_ACTOR,
  );
  const documentId = await db.withTenant(id, async (tx) => {
    const [row] = await tx
      .insert(schema.documents)
      .values({
        tenantId: id,
        filename: "x.pdf",
        contentType: "application/pdf",
        sizeBytes: 1,
        blobPath: "p",
        sha256: "s",
        uploadedBy: user,
      })
      .returning({ id: schema.documents.documentId });
    return row?.id ?? "";
  });
  const job = () =>
    createJob(db, id, { documentId, agentName: "contract-summary", agentVersion: "v" });
  return { id, job1: await job(), job2: await job() };
}

const call = (jobId: string, over: Partial<ModelCallRecord> = {}): ModelCallRecord => ({
  jobId,
  step: "fields",
  provider: "azure-openai",
  model: "test-model",
  outcome: "succeeded",
  inputTokens: 100,
  outputTokens: 20,
  costUsd: 0.00036,
  durationMs: 812.4,
  ...over,
});

beforeAll(async () => {
  testDb = await createTestDatabase();
  db = createTenantDatabase(testDb.appUrl, { contextKey: testDb.contextKey, maxConnections: 2 });
  t.a = await tenantWithJobs("tenant-a");
  t.b = await tenantWithJobs("tenant-b");
  await recordModelCall(db, t.a.id, call(t.a.job1));
  await recordModelCall(
    db,
    t.a.id,
    call(t.a.job1, { inputTokens: 50, outputTokens: 5, costUsd: null }),
  );
  await recordModelCall(
    db,
    t.a.id,
    call(t.a.job2, {
      outcome: "failed",
      errorCode: "model-rate-limited",
      inputTokens: 0,
      outputTokens: 0,
      costUsd: null,
    }),
  );
  await recordModelCall(db, t.b.id, call(t.b.job1, { inputTokens: 9999, costUsd: 1 }));
});

afterAll(async () => {
  await db?.close();
  await testDb?.drop();
});

describe("model call records", () => {
  it("totals a job's calls, and says how many had no price", async () => {
    expect(await modelUsageForJob(db, t.a.id, t.a.job1)).toEqual({
      calls: 2,
      inputTokens: 150,
      outputTokens: 25,
      costUsd: 0.00036,
      unpricedCalls: 1,
    });
  });

  it("totals a tenant's calls, failed ones included", async () => {
    expect(await modelUsageForTenant(db, t.a.id)).toMatchObject({
      calls: 3,
      inputTokens: 150,
      outputTokens: 25,
      // The failed call has no cost too, but it is not "unpriced".
      unpricedCalls: 1,
    });
    expect(await modelUsageForTenant(db, t.a.id, new Date(Date.now() + 60_000))).toMatchObject({
      calls: 0,
    });
  });

  it("shows a tenant only its own calls", async () => {
    const seenByA = await db.withTenant(t.a.id, (tx) => tx.select().from(schema.modelCalls));
    expect(seenByA).toHaveLength(3);
    expect(seenByA.every((r) => r.tenantId === t.a.id)).toBe(true);
    // B's job, asked for in A's context: nothing.
    expect(await modelUsageForJob(db, t.a.id, t.b.job1)).toMatchObject({ calls: 0 });
  });

  it("will not record a call against another tenant's job", async () => {
    await expect(recordModelCall(db, t.a.id, call(t.b.job1))).rejects.toThrow();
  });

  it("keeps the records as written: the app cannot change or delete them", async () => {
    // Drizzle wraps Postgres's error; the refusal is in its cause.
    const refusal = (work: Promise<unknown>) =>
      work.then(
        () => "allowed",
        (e: unknown) => String((e as { cause?: { message?: string } }).cause?.message ?? e),
      );
    expect(
      await refusal(
        db.withTenant(t.a.id, (tx) => tx.update(schema.modelCalls).set({ inputTokens: 0 })),
      ),
    ).toMatch(/permission denied/);
    expect(await refusal(db.withTenant(t.a.id, (tx) => tx.delete(schema.modelCalls)))).toMatch(
      /permission denied/,
    );
  });

  it("stores the failure's reason code and the duration in whole milliseconds", async () => {
    const [row] = await db.withTenant(t.a.id, (tx) =>
      tx.select().from(schema.modelCalls).where(eq(schema.modelCalls.jobId, t.a.job2)),
    );
    expect(row).toMatchObject({
      outcome: "failed",
      errorCode: "model-rate-limited",
      durationMs: 812,
    });
  });
});
