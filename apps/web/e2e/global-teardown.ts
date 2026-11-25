import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { BlobServiceClient } from "@azure/storage-blob";
import { temporalConnectionOptions, temporalSettings } from "@agent-core/core";
import { Client, Connection } from "@temporalio/client";
import postgres from "postgres";
import { AZURITE, readState } from "./state.ts";

export default async function globalTeardown() {
  const state = readState();
  await (globalThis as { agentCoreFakeModel?: { close(): Promise<void> } }).agentCoreFakeModel
    ?.close()
    .catch(() => {});
  await stopServer(state.serverPid);
  // The run's worker made schedules for its own queue (apps/worker/src/audit-schedule.ts),
  // which nothing serves after this: removed, with any run they started, before the
  // worker stops, so none is left waiting for ever.
  try {
    const settings = temporalSettings(process.env);
    const connection = await Connection.connect(temporalConnectionOptions(settings));
    const client = new Client({ connection, namespace: settings.namespace });
    for (const base of ["audit-copy", "job-sweep"]) {
      const handle = client.schedule.getHandle(`${base}-${state.taskQueue}`);
      const described = await handle.describe().catch(() => null);
      await handle.delete().catch(() => {});
      for (const run of described?.info.recentActions ?? []) {
        await client.workflow
          .getHandle(run.action.workflow.workflowId)
          .terminate("e2e run finished")
          .catch(() => {});
      }
    }
    await connection.close();
  } catch {
    // Temporal already gone: nothing to tidy.
  }
  await stopServer(state.workerPid);
  const adminUrl = new URL(state.adminUrl);
  const name = adminUrl.pathname.slice(1);
  adminUrl.pathname = "/agentcore";
  const server = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
  await server.unsafe(`drop database if exists ${name} with (force)`);
  await server.end();
  rmSync(state.outboxDir, { recursive: true, force: true });
  rmSync(`${state.outboxDir}.drafts`, { recursive: true, force: true });
  rmSync(state.agentsDir, { recursive: true, force: true });
  // The test tenants' document containers in Azurite.
  const connectionString = AZURITE;
  const blobs = BlobServiceClient.fromConnectionString(connectionString);
  for (const t of [state.a, state.b, state.g]) {
    await blobs
      .getContainerClient(`tenant-${t.tenantId}`)
      .deleteIfExists()
      .catch(() => {});
  }
}

/** Stops the app server and waits for it, so its database connections are closed. */
async function stopServer(pid: number) {
  if (!pid) return;
  if (process.platform === "win32") {
    // Windows has no process groups: /T stops the server's child processes too.
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      process.kill(-pid, 0);
      await new Promise((r) => setTimeout(r, 100));
    }
  } catch {
    // gone
  }
}
