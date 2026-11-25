// Review T14: the rules that need a lock hold when two people act at the same moment. A
// tenant keeps at least one admin when two admins demote or remove each other at once,
// and a draft gets exactly one decision when two reviewers decide it at once. Each test
// runs the two changes in parallel, on separate connections, several times.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  addTenantUser,
  createJob,
  createTenantDatabase,
  recordDecision,
  removeTenantUser,
  saveJobOutput,
  schema,
  setTenantUserRole,
  type AuditActor,
  type TenantDatabase,
  SETUP_ACTOR,
} from "../src/index.ts";
import { createTestDatabase, createTestTenant, type TestDatabase } from "../src/testing.ts";

let testDb: TestDatabase;
let db: TenantDatabase;
let n = 0;

beforeAll(async () => {
  testDb = await createTestDatabase();
  // Enough connections that the two changes really run side by side.
  db = createTenantDatabase(testDb.appUrl, { contextKey: testDb.contextKey, maxConnections: 6 });
});

afterAll(async () => {
  await db?.close();
  await testDb?.drop();
});

const actor = (userId: string): AuditActor => ({ kind: "user", userId, label: userId });

/** A tenant with two admins. */
async function twoAdmins() {
  const tenantId = await createTestTenant(db, { name: "Two admins", slug: `two-admins-${++n}` });
  const add = (email: string) =>
    addTenantUser(db, tenantId, { email, role: "tenant_admin" }, SETUP_ACTOR);
  const first = await add(`first-${n}@example.com`);
  const second = await add(`second-${n}@example.com`);
  return { tenantId, first, second };
}

async function adminsOf(tenantId: string): Promise<number> {
  const rows = await db.withTenant(tenantId, (tx) =>
    tx.select().from(schema.users).where(eq(schema.users.role, "tenant_admin")),
  );
  return rows.filter((u) => u.removedAt === null).length;
}

describe("the last admin, with two admins acting at once (review T14)", () => {
  it("lets only one of two admins demoting each other succeed", async () => {
    for (let round = 0; round < 5; round++) {
      const { tenantId, first, second } = await twoAdmins();
      const results = await Promise.all([
        setTenantUserRole(db, tenantId, { userId: second, role: "tenant_user" }, actor(first)),
        setTenantUserRole(db, tenantId, { userId: first, role: "tenant_user" }, actor(second)),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.find((r) => !r.ok)).toEqual({ ok: false, reason: "last-admin" });
      expect(await adminsOf(tenantId)).toBe(1);
    }
  });

  it("lets only one of two admins removing each other succeed", async () => {
    for (let round = 0; round < 5; round++) {
      const { tenantId, first, second } = await twoAdmins();
      const results = await Promise.all([
        removeTenantUser(db, tenantId, { userId: second }, actor(first)),
        removeTenantUser(db, tenantId, { userId: first }, actor(second)),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.find((r) => !r.ok)).toEqual({ ok: false, reason: "last-admin" });
      expect(await adminsOf(tenantId)).toBe(1);
    }
  });
});

describe("a draft, with two reviewers deciding at once (review T14)", () => {
  it("records exactly one decision, and tells the other reviewer it was decided", async () => {
    const tenantId = await createTestTenant(db, { name: "Reviews", slug: "concurrent-reviews" });
    const user = (email: string) =>
      addTenantUser(db, tenantId, { email, role: "tenant_user" }, SETUP_ACTOR);
    const [one, two] = [await user("one@example.com"), await user("two@example.com")];
    const documentId = await db.withTenant(tenantId, async (tx) => {
      const [row] = await tx
        .insert(schema.documents)
        .values({
          tenantId,
          filename: "x.pdf",
          contentType: "application/pdf",
          sizeBytes: 1,
          blobPath: "p",
          sha256: "s",
          uploadedBy: one,
        })
        .returning({ id: schema.documents.documentId });
      return row?.id ?? "";
    });
    for (let round = 0; round < 5; round++) {
      const jobId = await createJob(db, tenantId, {
        documentId,
        agentName: "skeleton",
        agentVersion: "skeleton-1",
      });
      await saveJobOutput(db, tenantId, jobId, { fields: { term: "x" }, hasReport: false });
      await db.withTenant(tenantId, (tx) =>
        tx
          .update(schema.jobs)
          .set({ status: "awaiting_review" })
          .where(eq(schema.jobs.jobId, jobId)),
      );
      const [output] = await db.withTenant(tenantId, (tx) =>
        tx.select().from(schema.jobOutputs).where(eq(schema.jobOutputs.jobId, jobId)),
      );
      const revision = output?.revision ?? -1;
      const results = await Promise.all([
        recordDecision(db, tenantId, jobId, { userId: one, revision, kind: "approve" }),
        recordDecision(db, tenantId, jobId, {
          userId: two,
          revision,
          kind: "send_back",
          note: "needs the notice period",
        }),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.find((r) => !r.ok)).toEqual({ ok: false, reason: "decided" });
      const decisions = await db.withTenant(tenantId, (tx) =>
        tx.select().from(schema.reviewEvents).where(eq(schema.reviewEvents.jobId, jobId)),
      );
      expect(decisions.filter((e) => e.kind === "approve" || e.kind === "send_back")).toHaveLength(
        1,
      );
    }
  });
});
