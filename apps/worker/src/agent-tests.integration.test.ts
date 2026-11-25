// Task 16: the worker records each agent version it loads, and runs each new version's
// test set once with the deployment's model, recording the result for the operator
// console. Never with the demo model.
import path from "node:path";
import { randomUUID } from "node:crypto";
import { agentRegistry, type LoadedAgent } from "@agent-core/core/agents";
import {
  ModelError,
  modelGatewayFromEnv,
  type ModelCallRecorder,
  type ModelGateway,
} from "@agent-core/core/models";
import {
  createTenantDatabase,
  getAgentTestRun,
  getAgentVersion,
  listAgentTestRuns,
  type TenantDatabase,
} from "@agent-core/db";
import { createTestDatabase, type TestDatabase } from "@agent-core/db/testing";
import { SAMPLES_DIR } from "@agent-core/testing";
import { Client } from "@temporalio/client";
import type { NativeConnection, Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentTestWorkflowId,
  startAgentTests,
  testAgentVersion,
  type AgentTestProgress,
} from "./agent-tests.ts";
import { ApplicationFailure } from "@temporalio/activity";
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
let agents: Map<string, LoadedAgent>;
const taskQueue = `agent-tests-${randomUUID().slice(0, 8)}`;
// A model name of its own, so this run's workflow IDs are new on a shared Temporal.
const modelName = `fake-${randomUUID().slice(0, 8)}`;
let modelCalls = 0;

/** A "real" model for the test: the demo model's recorded answers, under another name. */
function fakeModel(recorder: ModelCallRecorder): ModelGateway {
  const demo = modelGatewayFromEnv(
    {
      MODEL_PROVIDER: "demo",
      DATABASE_URL: "postgres://agentcore_app@localhost:5433/agentcore",
      DEMO_SAMPLES_DIR: SAMPLES_DIR,
    },
    recorder,
  );
  if (!demo) throw new Error("no demo model");
  return {
    provider: "azure-openai",
    model: modelName,
    complete: (...args) => {
      modelCalls += 1;
      return demo.complete(...args);
    },
  };
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  db = createTenantDatabase(testDb.appUrl, { contextKey: testDb.contextKey, maxConnections: 2 });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AZURE_STORAGE_CONNECTION_STRING: AZURITE,
    AGENTS_DIR: path.join(SAMPLES_DIR, "..", "agents"),
  };
  delete env["AZURE_STORAGE_ACCOUNT_URL"];
  delete env["AUDIT_STORAGE_ACCOUNT_URL"];
  agents = await agentRegistry(env);
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
    fakeModel,
  ));
  running = Promise.all([worker.run(), testWorker.run()]).then(() => {});
  client = new Client({ connection, namespace: "default" });
}, 120_000);

afterAll(async () => {
  worker?.shutdown();
  testWorker?.shutdown();
  await running?.catch(() => {});
  await connection?.close();
  await db?.close();
  await testDb?.drop();
}, 60_000);

describe("agent test runs", () => {
  it("with the demo model: records the version, runs nothing", async () => {
    const demo = modelGatewayFromEnv(
      {
        MODEL_PROVIDER: "demo",
        DATABASE_URL: "postgres://agentcore_app@localhost:5433/agentcore",
        DEMO_SAMPLES_DIR: SAMPLES_DIR,
      },
      async () => {},
    );
    expect(await startAgentTests({ db, client, taskQueue, agents, gateway: demo })).toEqual([]);
    const agent = agents.get("contract-summary");
    if (!agent) throw new Error("no demo agent");
    const version = await getAgentVersion(db, "contract-summary", agent.version);
    expect(version?.snapshot.files.map((f) => f.path)).toEqual(agent.files);
    expect(await listAgentTestRuns(db, "contract-summary")).toEqual([]);
  });

  it("with a real model: runs each new version's test set once and records it", async () => {
    const agent = agents.get("contract-summary");
    if (!agent) throw new Error("no demo agent");
    const gateway = fakeModel(async () => {});
    const started = await startAgentTests({ db, client, taskQueue, agents, gateway });
    expect(started).toEqual([`contract-summary ${agent.version}`]);
    const ids = { agentName: "contract-summary", version: agent.version };
    const result = await client.workflow
      .getHandle(agentTestWorkflowId(ids, gateway, taskQueue))
      .result();
    expect(result).toBe("recorded");

    const [run] = await listAgentTestRuns(db, "contract-summary");
    expect(run).toMatchObject({
      version: agent.version,
      provider: "azure-openai",
      model: modelName,
      repeats: 3,
      cases: 10,
      calls: 30,
    });
    const full = await getAgentTestRun(db, run?.runId ?? "");
    const cases = (full?.result as { cases: { runs: { error?: string }[] }[] }).cases;
    expect(cases.flatMap((c) => c.runs).every((r) => !r.error)).toBe(true);
    const calls = modelCalls;

    // Already recorded: a restarted worker starts nothing, and calls no model.
    expect(await startAgentTests({ db, client, taskQueue, agents, gateway })).toEqual([]);
    expect(modelCalls).toBe(calls);

    // A database without that run (restored from a backup, say) asks again: Temporal's
    // memory of the finished workflow does not stop it. This worker's own database has
    // the run, so its activity records nothing twice.
    const otherDb = await createTestDatabase();
    const other = createTenantDatabase(otherDb.appUrl, {
      contextKey: otherDb.contextKey,
      maxConnections: 1,
    });
    try {
      expect(await startAgentTests({ db: other, client, taskQueue, agents, gateway })).toEqual(
        started,
      );
      expect(
        await client.workflow.getHandle(agentTestWorkflowId(ids, gateway, taskQueue)).result(),
      ).toBe("already-recorded");
      expect(modelCalls).toBe(calls);
    } finally {
      await other.close();
      await otherDb.drop();
    }
  }, 120_000);
});

describe("an agent test run that cannot finish", () => {
  /** The fake model, failing for the cases whose title matches `down`. */
  function flakyModel(down: RegExp, name: string) {
    let calls = 0;
    const factory = (recorder: ModelCallRecorder): ModelGateway => {
      const model = fakeModel(recorder);
      return {
        ...model,
        model: name,
        complete: (...args) => {
          calls += 1;
          if (down.test(args[1].user)) return Promise.reject(new ModelError("model-error", 503));
          return model.complete(...args);
        },
      };
    };
    return { factory, calls: () => calls };
  }

  async function failure(work: Promise<unknown>): Promise<ApplicationFailure> {
    const error = await work.then(
      () => null,
      (e: unknown) => e,
    );
    if (!(error instanceof ApplicationFailure)) throw new Error("expected an ApplicationFailure");
    return error;
  }

  const ids = () => ({
    agentName: "contract-summary",
    version: agents.get("contract-summary")?.version ?? "",
  });

  it("records nothing while the model fails, and resumes from the cases it finished", async () => {
    const name = `flaky-${randomUUID().slice(0, 8)}`;
    // The first sample's title: every other case answers.
    const down = flakyModel(/Fernhill/, name);
    let progress: AgentTestProgress | undefined;
    const deps = (factory: typeof down.factory, resumeFrom?: AgentTestProgress) => ({
      db,
      agents,
      testGateway: factory,
      heartbeat: (p: AgentTestProgress) => {
        progress = structuredClone(p);
      },
      resumeFrom,
    });
    const first = await failure(testAgentVersion(deps(down.factory), ids()));
    // A fixed message and code only, and worth trying again.
    expect(first.message).toBe("agent test run failed: model-unavailable");
    expect(first.type).toBe("model-unavailable");
    expect(first.nonRetryable).toBe(false);
    expect(await listAgentTestRuns(db, "contract-summary")).toHaveLength(1); // the earlier test's
    expect(progress?.cases).toHaveLength(9);
    expect(progress?.cases.map((c) => c.id)).not.toContain("01-office-supplies");

    // The model is back: only the unfinished case runs again (3 runs), then it is recorded.
    const up = flakyModel(/^$/, name);
    expect(await testAgentVersion(deps(up.factory, progress), ids())).toBe("recorded");
    expect(up.calls()).toBe(3);
    const run = (await listAgentTestRuns(db, "contract-summary")).find((r) => r.model === name);
    expect(run).toMatchObject({ cases: 10, repeats: 3, calls: 30 });
    expect(run?.accuracy).toBe(1);
  });

  it("leaves a version this worker does not have to another worker", async () => {
    const f = await failure(
      testAgentVersion(
        { db, agents, testGateway: fakeModel, heartbeat: () => {} },
        { agentName: "contract-summary", version: "000000000000" },
      ),
    );
    expect(f.message).toBe("agent test run failed: agent-version-elsewhere");
    expect(f.nonRetryable).toBe(false);
  });

  it("never lets a setup error's own words reach Temporal", async () => {
    const f = await failure(
      testAgentVersion(
        {
          db,
          agents,
          testGateway: () => {
            throw new Error("BEDROCK_API_KEY=sk-secret-value is not valid");
          },
          heartbeat: () => {},
        },
        ids(),
      ),
    );
    expect(f.message).toBe("agent test run failed: test-run-failed");
    expect(JSON.stringify(f)).not.toContain("sk-secret");
  });
});
