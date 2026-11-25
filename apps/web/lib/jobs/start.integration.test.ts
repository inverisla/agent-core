// Review T11: an upload whose job cannot reach Temporal still succeeds, with the job left
// "uploaded" for the job sweep (apps/worker/src/job-sweep.ts); one whose job cannot even
// be created fails, rather than reporting success with no job.
import { randomUUID } from "node:crypto";
import { agentForUploads, agentRegistry } from "@agent-core/core/agents";
import {
  addTenantUser,
  createTenantDatabase,
  getJob,
  schema,
  type TenantDatabase,
  SETUP_ACTOR,
} from "@agent-core/db";
import { createTestDatabase, type TestDatabase, createTestTenant } from "@agent-core/db/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startDocumentJob } from "./start.ts";

let testDb: TestDatabase;
let db: TenantDatabase;
let tenantId = "";
let documentId = "";

beforeAll(async () => {
  testDb = await createTestDatabase();
  db = createTenantDatabase(testDb.appUrl, { contextKey: testDb.contextKey, maxConnections: 2 });
  tenantId = await createTestTenant(db, { name: "Start", slug: "start-test" });
  const user = await addTenantUser(
    db,
    tenantId,
    { email: "u@start.example", role: "tenant_user" },
    SETUP_ACTOR,
  );
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

describe("startDocumentJob (review Q1, T11)", () => {
  it("leaves the job uploaded, for the sweep, when Temporal cannot be reached", async () => {
    const agent = agentForUploads(await agentRegistry(process.env), process.env);
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await startDocumentJob(db, tenantId, documentId, agent, () =>
      Promise.reject(new Error("unreachable")),
    );
    quiet.mockRestore();
    expect(result.queued).toBe(false);
    expect(result.jobId).toBeTruthy();
    expect((await getJob(db, tenantId, result.jobId ?? ""))?.status).toBe("uploaded");
  });

  it("fails when the job cannot be created, rather than succeeding with no job", async () => {
    const agent = agentForUploads(await agentRegistry(process.env), process.env);
    await expect(
      startDocumentJob(db, tenantId, randomUUID(), agent, () =>
        Promise.reject(new Error("never asked")),
      ),
    ).rejects.toThrow();
  });
});
