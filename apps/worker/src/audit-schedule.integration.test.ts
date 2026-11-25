// Task 14: the worker's schedule runs the audit copy, and creating it twice is harmless.
import { randomUUID } from "node:crypto";
import {
  createTenantDatabase,
  createTenantWithAdmin,
  listAuditEvents,
  schema,
  SETUP_ACTOR,
  type TenantDatabase,
} from "@agent-core/db";
import { createTestDatabase, type TestDatabase } from "@agent-core/db/testing";
import { AUDIT_COPY_CONTAINER, auditCopyPrefix } from "@agent-core/core/storage";
import { BlobServiceClient } from "@azure/storage-blob";
import { Client, ScheduleOverlapPolicy } from "@temporalio/client";
import type { NativeConnection, Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureAuditCopySchedule } from "./audit-schedule.ts";
import { createJobWorker } from "./start-worker.ts";

const TEMPORAL = process.env["TEMPORAL_ADDRESS"] ?? "127.0.0.1:7233";
const AZURITE =
  "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;";

let testDb: TestDatabase;
let db: TenantDatabase;
let worker: Worker;
let testWorker: Worker;
let connection: NativeConnection;
let running: Promise<void>;
let client: Client;
let tenantId = "";
const scheduleId = `audit-copy-test-${randomUUID().slice(0, 8)}`;
const taskQueue = `audit-copy-test-${randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  testDb = await createTestDatabase();
  db = createTenantDatabase(testDb.appUrl, { contextKey: testDb.contextKey, maxConnections: 2 });
  tenantId = await createTenantWithAdmin(
    db,
    { name: "Scheduled", slug: "scheduled", adminEmail: "a@scheduled.example" },
    SETUP_ACTOR,
  );
  // Ten minutes old, so already settled (the copy waits two minutes for new events).
  await db.withTenant(tenantId, (tx) =>
    tx.insert(schema.auditEvents).values(
      [1, 2].map((n) => ({
        tenantId,
        actorKind: "setup" as const,
        action: "agents.changed",
        detail: { n },
        occurredAt: new Date(Date.now() - 10 * 60_000),
      })),
    ),
  );
  const env: NodeJS.ProcessEnv = { ...process.env, AZURE_STORAGE_CONNECTION_STRING: AZURITE };
  delete env["AZURE_STORAGE_ACCOUNT_URL"];
  delete env["AUDIT_STORAGE_ACCOUNT_URL"];
  ({ worker, testWorker, connection } = await createJobWorker(
    {
      temporalAddress: TEMPORAL,
      temporalNamespace: "default",
      taskQueue,
      allowTestFaults: false,
      model: null,
    },
    db,
    env,
  ));
  running = Promise.all([worker.run(), testWorker.run()]).then(() => {});
  // As main.ts does: a client on the worker's own connection.
  client = new Client({ connection, namespace: "default" });
}, 120_000);

afterAll(async () => {
  await client?.schedule
    .getHandle(scheduleId)
    .delete()
    .catch(() => {});
  worker?.shutdown();
  testWorker?.shutdown();
  await running?.catch(() => {});
  await connection?.close();
  await db?.close();
  await testDb?.drop();
}, 60_000);

describe("the audit copy schedule", () => {
  it("is created once, every 5 minutes, skipping a run while one is going", async () => {
    expect(await ensureAuditCopySchedule(client, taskQueue, scheduleId)).toBe("created");
    expect(await ensureAuditCopySchedule(client, taskQueue, scheduleId)).toBe("exists");
    const described = await client.schedule.getHandle(scheduleId).describe();
    expect(described.spec.intervals?.[0]?.every).toBe(5 * 60 * 1000);
    expect(described.policies.overlap).toBe(ScheduleOverlapPolicy.SKIP);
    expect(described.action).toMatchObject({ workflowType: "copyAuditLogWorkflow", taskQueue });
  });

  it("copies the audit log when it runs", async () => {
    await client.schedule.getHandle(scheduleId).trigger();
    const container =
      BlobServiceClient.fromConnectionString(AZURITE).getContainerClient(AUDIT_COPY_CONTAINER);
    const lines = async () => {
      let text = "";
      for await (const b of container.listBlobsFlat({ prefix: auditCopyPrefix(tenantId) })) {
        text += (await container.getAppendBlobClient(b.name).downloadToBuffer()).toString("utf8");
      }
      return text.split("\n").filter(Boolean).length;
    };
    // Every event up to the last settled one: the two back-dated ones, and the tenant's own
    // creation before them (numbered lower, so already committed; see auditEventsAfter).
    const all = (await listAuditEvents(db, tenantId)).length;
    await expect.poll(lines, { timeout: 30_000, interval: 500 }).toBe(all);
  }, 60_000);

  it("moves a schedule made for another queue, ending its stuck run (review of C2–D3)", async () => {
    const moved = `${scheduleId}-moved`;
    try {
      // Made by a worker on a queue nobody serves now (an e2e run's, or an old setting).
      expect(await ensureAuditCopySchedule(client, `${taskQueue}-gone`, moved)).toBe("created");
      await client.schedule.getHandle(moved).trigger();
      let stuck = "";
      await expect
        .poll(
          async () => {
            const runs = (await client.schedule.getHandle(moved).describe()).info.recentActions;
            stuck = runs[0]?.action.workflow.workflowId ?? "";
            return runs.length;
          },
          { timeout: 15_000 },
        )
        .toBe(1);
      // This worker's start: the schedule follows it, and the stuck run is ended.
      expect(await ensureAuditCopySchedule(client, taskQueue, moved)).toBe("moved");
      const described = await client.schedule.getHandle(moved).describe();
      expect(described.action).toMatchObject({ workflowType: "copyAuditLogWorkflow", taskQueue });
      expect((await client.workflow.getHandle(stuck).describe()).status.name).toBe("TERMINATED");
      expect(await ensureAuditCopySchedule(client, taskQueue, moved)).toBe("exists");
    } finally {
      await client.schedule
        .getHandle(moved)
        .delete()
        .catch(() => {});
    }
  }, 60_000);
});
