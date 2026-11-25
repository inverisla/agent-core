import { temporalConnectionOptions } from "@agent-core/core";
import { agentRegistry } from "@agent-core/core/agents";
import {
  AUDIT_COPY_CONTAINER,
  auditBlobServiceFromEnv,
  blobServiceFromEnv,
} from "@agent-core/core/storage";
import { createTenantDatabase, parseContextKey, type TenantDatabase } from "@agent-core/db";
import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import { Client } from "@temporalio/client";
import { createActivities } from "./activities.ts";
import { modelGatewayFromEnv } from "@agent-core/core/models";
import { workerModelGateway } from "./models.ts";
import { agentTestQueue, type TestGatewayFactory } from "./agent-tests.ts";
import type { WorkerConfig } from "./config.ts";

/** Jobs one worker runs at the same time. */
export const JOBS_AT_ONCE = 4;

/**
 * A worker for the job queue. Workflows are bundled from workflows.ts. It loads the
 * agents first and will not start if any of them is not valid.
 */
export async function createJobWorker(
  config: WorkerConfig,
  db: TenantDatabase,
  env: NodeJS.ProcessEnv = process.env,
  /** Tests only: the model for agent test runs (task 16). */
  testGateway: TestGatewayFactory = (recorder) => modelGatewayFromEnv(env, recorder),
) {
  const agents = await agentRegistry(env);
  const connection = await NativeConnection.connect(
    temporalConnectionOptions({
      address: config.temporalAddress,
      namespace: config.temporalNamespace,
      ...(config.temporalApiKey ? { apiKey: config.temporalApiKey } : {}),
    }),
  );
  // The audit log's write-once copy, where storage for it is set up.
  const auditCopy = auditBlobServiceFromEnv(env)?.getContainerClient(AUDIT_COPY_CONTAINER) ?? null;
  // Created by the Bicep in Azure (with its retention policy); locally, on first use.
  if (auditCopy && !env["AUDIT_STORAGE_ACCOUNT_URL"]) await auditCopy.createIfNotExists();
  const activities = createActivities({
    db,
    agents,
    models: workerModelGateway(db, env),
    blobs: blobServiceFromEnv(env),
    auditCopy,
    auditCopyEpoch: auditCopyEpoch(env),
    allowTestFaults: config.allowTestFaults,
    testGateway,
    temporal: {
      client: new Client({ connection, namespace: config.temporalNamespace }),
      taskQueue: config.taskQueue,
    },
  });
  const worker = await Worker.create({
    connection,
    namespace: config.temporalNamespace,
    taskQueue: config.taskQueue,
    // fileURLToPath, not .pathname: correct on Windows and in paths with spaces.
    workflowsPath: fileURLToPath(new URL("./workflows.ts", import.meta.url)),
    // Few jobs at once: each reads a whole document into memory. Text extraction runs at
    // most two at a time in this process, each within 192 MB
    // (packages/blocks/src/extract-text.ts).
    maxConcurrentActivityTaskExecutions: JOBS_AT_ONCE,
    activities,
  });
  // Agent test runs (task 16) on a queue of their own, one at a time, so a long run never
  // takes a slot from tenants' jobs.
  const testWorker = await Worker.create({
    connection,
    namespace: config.temporalNamespace,
    taskQueue: agentTestQueue(config.taskQueue),
    workflowsPath: fileURLToPath(new URL("./workflows.ts", import.meta.url)),
    maxConcurrentActivityTaskExecutions: 1,
    activities,
  });
  return { worker, testWorker, connection, auditCopy, agents };
}

/** AUDIT_COPY_EPOCH: a whole number from 1; 1 if unset. */
export function auditCopyEpoch(env: NodeJS.ProcessEnv): number {
  const raw = env["AUDIT_COPY_EPOCH"];
  if (!raw) return 1;
  const epoch = Number(raw);
  if (!Number.isInteger(epoch) || epoch < 1 || epoch > 9999) {
    throw new Error("AUDIT_COPY_EPOCH must be a whole number from 1 to 9999.");
  }
  return epoch;
}

export function databaseFromEnv(env: NodeJS.ProcessEnv): TenantDatabase {
  const url = env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local.");
  return createTenantDatabase(url, { contextKey: parseContextKey(env["TENANT_CONTEXT_KEY"]) });
}
