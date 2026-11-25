// Job status bookkeeping when attempts are cut short or finish late.
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addTenantUser,
  attemptIsLive,
  createJob,
  createTenantDatabase,
  finishAttempt,
  finishJob,
  getJob,
  getJobOutput,
  latestJobsByDocument,
  saveJobOutput,
  schema,
  startAttempt,
  type TenantDatabase,
  SETUP_ACTOR,
} from "../src/index.ts";
import { createTestDatabase, type TestDatabase, createTestTenant } from "../src/testing.ts";

let testDb: TestDatabase;
let db: TenantDatabase;
let tenantId = "";
let documentId = "";
let userId = "";

const newJob = () =>
  createJob(db, tenantId, { documentId, agentName: "skeleton", agentVersion: "skeleton-1" });
const outcomes = async (jobId: string) =>
  (await getJob(db, tenantId, jobId))?.attempts.map((a) => [a.attempt, a.outcome, a.errorCode]);

beforeAll(async () => {
  testDb = await createTestDatabase();
  db = createTenantDatabase(testDb.appUrl, { contextKey: testDb.contextKey, maxConnections: 2 });
  tenantId = await createTestTenant(db, { name: "Jobs", slug: "jobs-test" });
  const user = await addTenantUser(
    db,
    tenantId,
    { email: "u@jobs.example", role: "tenant_user" },
    SETUP_ACTOR,
  );
  userId = user;
  documentId = await db.withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .insert(schema.documents)
      .values({
        tenantId,
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
});

afterAll(async () => {
  await db?.close();
  await testDb?.drop();
});

describe("job attempts", () => {
  it("closes an earlier attempt left running when the next one starts", async () => {
    const jobId = await newJob();
    await startAttempt(db, tenantId, jobId, 1); // crashed: never finished
    await startAttempt(db, tenantId, jobId, 2);
    await finishAttempt(db, tenantId, jobId, 2, "succeeded");
    expect(await outcomes(jobId)).toEqual([
      [1, "failed", "timed-out"],
      [2, "succeeded", null],
    ]);
  });

  it("does not let a late attempt rewrite one already closed", async () => {
    const jobId = await newJob();
    await startAttempt(db, tenantId, jobId, 1);
    await startAttempt(db, tenantId, jobId, 2); // closes attempt 1 as timed out
    await finishAttempt(db, tenantId, jobId, 1, "succeeded"); // attempt 1 reports in late
    expect((await outcomes(jobId))?.[0]).toEqual([1, "failed", "timed-out"]);
  });

  it("closes any attempt still running when the job finishes", async () => {
    const jobId = await newJob();
    await startAttempt(db, tenantId, jobId, 1);
    expect(await finishJob(db, tenantId, jobId, "failed")).toBe(true);
    const job = await getJob(db, tenantId, jobId);
    expect(job?.status).toBe("failed");
    expect(job?.attempts.map((a) => [a.outcome, a.errorCode])).toEqual([["failed", "abandoned"]]);
    expect(job?.attempts.every((a) => a.finishedAt)).toBe(true);
  });

  it("never moves a finished job back", async () => {
    const jobId = await newJob();
    await finishJob(db, tenantId, jobId, "succeeded");
    expect(await finishJob(db, tenantId, jobId, "failed")).toBe(false);
    await startAttempt(db, tenantId, jobId, 1);
    expect((await getJob(db, tenantId, jobId))?.status).toBe("succeeded");
  });
});

describe("latest job per document", () => {
  const newDocument = (filename: string) =>
    db.withTenant(tenantId, async (tx) => {
      const [row] = await tx
        .insert(schema.documents)
        .values({
          tenantId,
          filename,
          contentType: "application/pdf",
          sizeBytes: 1,
          blobPath: `p-${filename}`,
          sha256: `s-${filename}`,
          uploadedBy: userId,
        })
        .returning({ id: schema.documents.documentId });
      return row?.id ?? "";
    });
  const jobWith = async (document: string, attempts: number) => {
    const jobId = await createJob(db, tenantId, {
      documentId: document,
      agentName: "skeleton",
      agentVersion: "skeleton-1",
    });
    for (let attempt = 1; attempt <= attempts; attempt++) {
      await startAttempt(db, tenantId, jobId, attempt);
    }
    return jobId;
  };

  // Each document's count must be its own job's alone. A correlated subquery once counted
  // every attempt in the tenant, which here (with earlier tests' attempts too) is more than 4.
  it("counts only each job's own attempts", async () => {
    const [one = "", three = "", none = ""] = await Promise.all(
      ["one.pdf", "three.pdf", "none.pdf"].map((name) => newDocument(name)),
    );
    const jobs = {
      one: await jobWith(one, 1),
      three: await jobWith(three, 3),
      none: await jobWith(none, 0),
    };
    const latest = await latestJobsByDocument(db, tenantId, [one, three, none]);
    expect(latest.get(one)).toMatchObject({ jobId: jobs.one, attempts: 1 });
    expect(latest.get(three)).toMatchObject({ jobId: jobs.three, attempts: 3 });
    expect(latest.get(none)).toMatchObject({ jobId: jobs.none, attempts: 0 });
  });

  it("after a send-back, counts and explains the new run only (review Q3, T6)", async () => {
    const doc = await newDocument("sent-back.pdf");
    const jobId = await jobWith(doc, 3);
    for (const n of [1, 2, 3])
      await finishAttempt(db, tenantId, jobId, n, "failed", "model-timeout");
    // A reviewer sends the draft back: the job's second run begins.
    await db.withTenant(tenantId, (tx) =>
      tx.update(schema.jobs).set({ run: 2 }).where(eq(schema.jobs.jobId, jobId)),
    );
    await startAttempt(db, tenantId, jobId, 1, 2);
    // Still running: no reason yet, and not the first run's.
    expect((await latestJobsByDocument(db, tenantId, [doc])).get(doc)).toMatchObject({
      attempts: 1,
      errorCode: null,
    });
    await finishAttempt(db, tenantId, jobId, 1, "failed", "no-text", 2);
    expect((await latestJobsByDocument(db, tenantId, [doc])).get(doc)).toMatchObject({
      attempts: 1,
      errorCode: "no-text",
    });
  });

  it("gives the reason code of the last attempt", async () => {
    const doc = await newDocument("failed.pdf");
    const jobId = await jobWith(doc, 2);
    await finishAttempt(db, tenantId, jobId, 1, "failed", "model-timeout");
    await finishAttempt(db, tenantId, jobId, 2, "failed", "no-text");
    expect((await latestJobsByDocument(db, tenantId, [doc])).get(doc)).toMatchObject({
      attempts: 2,
      errorCode: "no-text",
    });
    const ok = await newDocument("ok.pdf");
    expect((await latestJobsByDocument(db, tenantId, [ok])).get(ok)).toBeUndefined();
    const fine = await jobWith(ok, 1);
    await finishAttempt(db, tenantId, fine, 1, "succeeded");
    expect((await latestJobsByDocument(db, tenantId, [ok])).get(ok)?.errorCode).toBeNull();
  });
});

describe("saveJobOutput from a late attempt (review Q5, T13)", () => {
  const fields = (n: number) => ({ term: `term ${n}` });

  it("stores the live attempt's fields, and nothing from one a later attempt replaced", async () => {
    const jobId = await newJob();
    await startAttempt(db, tenantId, jobId, 1);
    // Attempt 1 outlives its timeout; attempt 2 begins and closes it as timed out.
    await startAttempt(db, tenantId, jobId, 2);
    expect(await attemptIsLive(db, tenantId, jobId, 1, 1)).toBe(false);
    expect(await attemptIsLive(db, tenantId, jobId, 1, 2)).toBe(true);
    const save = (attempt: number) =>
      saveJobOutput(db, tenantId, jobId, {
        fields: fields(attempt),
        hasReport: false,
        run: 1,
        attempt,
      });
    expect(await save(2)).toBe(true);
    expect(await save(1)).toBe(false);
    expect((await getJobOutput(db, tenantId, jobId))?.fields).toEqual(fields(2));
  });

  it("stores nothing once the draft has gone to review", async () => {
    const jobId = await newJob();
    await startAttempt(db, tenantId, jobId, 1);
    expect(
      await saveJobOutput(db, tenantId, jobId, {
        fields: fields(1),
        hasReport: false,
        run: 1,
        attempt: 1,
      }),
    ).toBe(true);
    await db.withTenant(tenantId, (tx) =>
      tx.update(schema.jobs).set({ status: "awaiting_review" }).where(eq(schema.jobs.jobId, jobId)),
    );
    expect(
      await saveJobOutput(db, tenantId, jobId, {
        fields: fields(9),
        hasReport: false,
        run: 1,
        attempt: 1,
      }),
    ).toBe(false);
    expect((await getJobOutput(db, tenantId, jobId))?.fields).toEqual(fields(1));
  });
});
