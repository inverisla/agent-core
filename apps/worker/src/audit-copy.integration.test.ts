// Task 14: the audit log's copy in write-once storage gets every event exactly once.
import { randomUUID } from "node:crypto";
import {
  addTenantUser,
  createTenantDatabase,
  createTenantWithAdmin,
  recordAudit,
  SETUP_ACTOR,
  type TenantDatabase,
} from "@agent-core/db";
import { createTestDatabase, type TestDatabase } from "@agent-core/db/testing";
import { auditCopyBlobName, auditCopyPrefix } from "@agent-core/core/storage";
import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyAuditLog, copyTenantAuditLog, lastCopiedSeq } from "./audit-copy.ts";

const AZURITE =
  "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;";

let testDb: TestDatabase;
let db: TenantDatabase;
let container: ContainerClient;
const t = { a: "", b: "" };
/** These tests' events are seconds old: copy them without waiting for them to settle. */
const now = { settleMs: 0 };

async function copied(tenantId: string, epoch = 1): Promise<{ seq: number; action: string }[]> {
  const rows: { seq: number; action: string }[] = [];
  const names: string[] = [];
  for await (const b of container.listBlobsFlat({ prefix: auditCopyPrefix(tenantId, epoch) })) {
    names.push(b.name);
  }
  for (const name of names.sort()) {
    const text = (await container.getAppendBlobClient(name).downloadToBuffer()).toString("utf8");
    for (const l of text.split("\n").filter(Boolean)) {
      rows.push(JSON.parse(l) as { seq: number; action: string });
    }
  }
  return rows;
}

const addUsers = async (tenantId: string, n: number) => {
  for (let i = 0; i < n; i++) {
    await addTenantUser(
      db,
      tenantId,
      { email: `${randomUUID().slice(0, 8)}@copy.example`, role: "tenant_user" },
      SETUP_ACTOR,
    );
  }
};

beforeAll(async () => {
  testDb = await createTestDatabase();
  db = createTenantDatabase(testDb.appUrl, { contextKey: testDb.contextKey, maxConnections: 4 });
  container = BlobServiceClient.fromConnectionString(AZURITE).getContainerClient(
    `audit-test-${randomUUID().slice(0, 8)}`,
  );
  await container.create();
  for (const key of ["a", "b"] as const) {
    t[key] = await createTenantWithAdmin(
      db,
      { name: key, slug: `copy-${key}`, adminEmail: `admin@${key}.example` },
      SETUP_ACTOR,
    );
  }
  await addUsers(t.a, 5);
});

afterAll(async () => {
  await container?.deleteIfExists();
  await db?.close();
  await testDb?.drop();
});

describe("the audit log's write-once copy", () => {
  it("copies every tenant's events once, in order, in pages", async () => {
    const result = await copyAuditLog(db, container, { ...now, pageSize: 2 });
    expect(result).toEqual({ tenants: 2, copied: 7 + 2, failed: 0 });
    const a = await copied(t.a);
    expect(a.map((r) => r.action)).toEqual([
      "tenant.created",
      "user.added",
      "user.added",
      "user.added",
      "user.added",
      "user.added",
      "user.added",
    ]);
    const seqs = a.map((r) => r.seq);
    expect([...seqs].sort((x, y) => x - y)).toEqual(seqs);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect((await copied(t.b)).map((r) => r.action)).toEqual(["tenant.created", "user.added"]);
  });

  it("copies nothing twice, and only what is new", async () => {
    expect(await copyAuditLog(db, container, now)).toMatchObject({ copied: 0, failed: 0 });
    await addUsers(t.a, 2);
    expect(await copyAuditLog(db, container, now)).toMatchObject({ copied: 2 });
    const seqs = (await copied(t.a)).map((r) => r.seq);
    expect(seqs).toHaveLength(9);
    expect(new Set(seqs).size).toBe(9);
  });

  it("waits for events to settle by default", async () => {
    await addUsers(t.a, 1);
    // Just written, so not copied yet (it may still have a slower neighbour).
    expect(await copyTenantAuditLog(db, container, t.a)).toBe(0);
    expect(await copyTenantAuditLog(db, container, t.a, now)).toBe(1);
  });

  // A row's seq is taken when it is inserted, not when it commits. As in production
  // (transactions at most 60 s, settling 120 s), the transaction here is shorter than the
  // settling time.
  it("does not skip an event that commits after a later one", async () => {
    const before = await lastCopiedSeq(container, t.a);
    const settle = { settleMs: 3_000 };
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    // Takes the lower seq, and commits only after the next event has been written.
    const slow = db.withTenant(t.a, async (tx) => {
      await recordAudit(tx, t.a, SETUP_ACTOR, "agents.changed", { agents: [] });
      await held;
    });
    await new Promise((r) => setTimeout(r, 200));
    await addUsers(t.a, 1);
    // The fast event has committed, the slow one has not: neither has settled, so
    // nothing is copied (copying the fast one now would skip the slow one for good).
    expect(await copyTenantAuditLog(db, container, t.a, settle)).toBe(0);
    await new Promise((r) => setTimeout(r, 800));
    release();
    await slow;
    await new Promise((r) => setTimeout(r, 3_100));
    expect(await copyTenantAuditLog(db, container, t.a, settle)).toBe(2);
    const rows = (await copied(t.a)).filter((r) => r.seq > before);
    expect(rows.map((r) => r.action)).toEqual(["agents.changed", "user.added"]);
  }, 15_000);

  it("files events by the day they are copied, and finds its place across days", async () => {
    await addUsers(t.b, 1);
    const tomorrow = () => new Date(Date.now() + 24 * 60 * 60 * 1000);
    expect(await copyTenantAuditLog(db, container, t.b, { ...now, now: tomorrow })).toBe(1);
    const name = auditCopyBlobName(t.b, tomorrow().toISOString().slice(0, 10));
    expect(await container.getAppendBlobClient(name).exists()).toBe(true);
    expect(await copyTenantAuditLog(db, container, t.b, { ...now, now: tomorrow })).toBe(0);
    expect((await copied(t.b)).map((r) => r.seq)).toHaveLength(3);
  });

  it("carries on after a crash that left an empty blob", async () => {
    const before = await lastCopiedSeq(container, t.a);
    // A later day's blob was created, then the copy stopped before writing to it.
    const later = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const empty = container.getAppendBlobClient(auditCopyBlobName(t.a, later));
    await empty.create();
    expect(await lastCopiedSeq(container, t.a)).toBe(before);
    await addUsers(t.a, 1);
    // The next copy writes to that blob (the newest), from its start.
    expect(await copyTenantAuditLog(db, container, t.a, now)).toBe(1);
    const text = (await empty.downloadToBuffer()).toString("utf8");
    expect(text.trimEnd().split("\n")).toHaveLength(1);
    expect(await lastCopiedSeq(container, t.a)).toBeGreaterThan(before);
  });

  it("never copies an event twice when two copies run at once, and neither reports a failure", async () => {
    await addUsers(t.a, 3);
    const runs = await Promise.all([
      copyAuditLog(db, container, now),
      copyAuditLog(db, container, now),
    ]);
    expect(runs.map((r) => r.failed)).toEqual([0, 0]);
    const seqs = (await copied(t.a)).map((r) => r.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    await copyAuditLog(db, container, now);
    const after = await copied(t.a);
    expect(await lastCopiedSeq(container, t.a)).toBe(Math.max(...after.map((r) => r.seq)));
    expect(new Set(after.map((r) => r.seq)).size).toBe(after.length);
  });

  it("stops and reports it if the database no longer has the copy's last event", async () => {
    // As if the database were restored to before that event: remove it (as the owner,
    // with the guard off; this is what only a restore or a determined owner can do).
    const end = (await copied(t.b)).at(-1);
    const owner = postgres(testDb.adminUrl, { max: 1, onnotice: () => {} });
    await owner.begin(async (sql) => {
      await sql`alter table audit_events disable trigger audit_events_append_only`;
      await sql`alter table audit_events no force row level security`;
      await sql`delete from audit_events where seq = ${end?.seq ?? 0}`;
      await sql`alter table audit_events force row level security`;
      await sql`alter table audit_events enable trigger audit_events_append_only`;
    });
    await owner.end();
    await addUsers(t.b, 1);
    const result = await copyAuditLog(db, container, now);
    expect(result.failed).toBe(1);
    expect((await copied(t.b)).at(-1)?.seq).toBe(end?.seq);
    // A fresh epoch starts the copy again from the database as it now is.
    expect(await copyTenantAuditLog(db, container, t.b, { ...now, epoch: 2 })).toBeGreaterThan(0);
    expect((await copied(t.b, 2)).length).toBeGreaterThan(0);
  });
});
