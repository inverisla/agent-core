// Runs the job worker until stopped.
import "./telemetry.ts";
import { logEvent } from "@agent-core/core/telemetry";
import { readConfig } from "./config.ts";
import { Client } from "@temporalio/client";
import { ensureAuditCopySchedule, ensureJobSweepSchedule } from "./audit-schedule.ts";
import { startAgentTests, testableModel } from "./agent-tests.ts";
import { modelGatewayFromEnv } from "@agent-core/core/models";
import { createJobWorker, databaseFromEnv } from "./start-worker.ts";

const config = readConfig(process.env);
const db = databaseFromEnv(process.env);
const { worker, testWorker, connection, auditCopy, agents } = await createJobWorker(config, db);
const client = new Client({ connection, namespace: config.temporalNamespace });
if (auditCopy) {
  // The schedule that copies the audit log to write-once storage every 5 minutes.
  console.log(
    `worker: audit copy schedule ${await ensureAuditCopySchedule(client, config.taskQueue)}`,
  );
}
// The job sweep every 5 minutes: starts stuck jobs, sends undelivered decisions again.
console.log(`worker: job sweep schedule ${await ensureJobSweepSchedule(client, config.taskQueue)}`);
// Each new agent version's own test run, for the operator console (task 16). A failure
// here must not stop the worker running jobs.
const testGateway = modelGatewayFromEnv(process.env, async () => {});
try {
  const started = await startAgentTests({
    db,
    client,
    taskQueue: config.taskQueue,
    agents,
    gateway: testGateway,
  });
  console.log(
    `worker: agent test runs ${
      !testableModel(testGateway)
        ? "off (they need a real model)"
        : started.length > 0
          ? `started for ${started.join(", ")}`
          : "up to date"
    }`,
  );
} catch (error) {
  console.error(
    `worker: agent test runs not started: ${error instanceof Error ? error.name : "unknown error"}`,
  );
}
const model = config.model;
const modelLabel = !model
  ? "no model configured, so jobs whose agent needs one fail with no-model"
  : model.provider === "demo"
    ? "the demo model (recorded answers for the sample contracts only)"
    : `model ${model.provider} ${model.provider === "bedrock" ? model.modelId : model.model}`;
console.log(
  `worker: ready (Temporal ${config.temporalAddress}, namespace ${config.temporalNamespace}, queue ${config.taskQueue}; agents ${[...agents.values()].map((a) => `${a.definition.name} ${a.version}`).join(", ")}; ${modelLabel})`,
);
logEvent("worker.started", { queue: config.taskQueue });
// Every 5 minutes while running: the "worker stopped" alert fires when these stop.
const heartbeat = setInterval(
  () => logEvent("worker.heartbeat", { queue: config.taskQueue }),
  5 * 60 * 1000,
);
heartbeat.unref();
// Both stop together: if either stops or fails, the other is shut down too. Only a
// running worker can be shut down: on SIGTERM both are already stopping, and asking again
// threw, which skipped closing the database and failed the exit (review Q6).
const stop = (w: typeof worker) => {
  if (w.getState() !== "RUNNING") return;
  try {
    w.shutdown();
  } catch {
    // Stopped in the meantime.
  }
};
try {
  await Promise.all([
    worker.run().finally(() => stop(testWorker)),
    testWorker.run().finally(() => stop(worker)),
  ]);
} finally {
  clearInterval(heartbeat);
  await connection.close();
  await db.close();
}
