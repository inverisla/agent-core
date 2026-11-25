// Each agent version's own test run (task 16). At start-up the worker records every
// agent version it loaded, then starts one workflow per version that has a test set and
// no results yet with the deployment's model. The workflow's activity runs the test set
// (3 runs per case) and records the result in the operator schema, for the operator
// console. Never with the demo model, whose answers are recorded ones: every version
// would score 100%. Model calls here are not any tenant's, so they are counted on the run
// itself, not in model_calls.
import type { LoadedAgent } from "@agent-core/core/agents";
import type { ModelCallRecorder, ModelGateway } from "@agent-core/core/models";
import { logEvent } from "@agent-core/core/telemetry";
import {
  hasAgentTestRun,
  recordAgentTestRun,
  recordAgentVersion,
  type TenantDatabase,
} from "@agent-core/db";
import {
  agentSnapshot,
  loadSamples,
  overallAccuracy,
  runTestSet,
  testSetFor,
  type TestCase,
  type TestRun,
} from "@agent-core/testing";
import { WorkflowExecutionAlreadyStartedError, type Client } from "@temporalio/client";
import { ApplicationFailure } from "@temporalio/activity";
import type { ModelCallRecord as CallRecord } from "@agent-core/core/models";

export const AGENT_TEST_WORKFLOW = "testAgentWorkflow";
export const AGENT_TEST_REPEATS = 3;

/**
 * Test runs have a task queue of their own, served by a worker that runs one at a time,
 * so they never take a slot from tenants' jobs (start-worker.ts).
 */
export function agentTestQueue(jobQueue: string): string {
  return `${jobQueue}-agent-tests`;
}

export interface AgentTestInput {
  agentName: string;
  version: string;
}

/** A model gateway whose calls go to `recorder`, or null if no model is configured. */
export type TestGatewayFactory = (recorder: ModelCallRecorder) => ModelGateway | null;

/** Whether this model's answers say anything about an agent version. */
export function testableModel(gateway: ModelGateway | null): gateway is ModelGateway {
  return gateway !== null && gateway.provider !== "demo";
}

/** One workflow per agent version and model, never two at once. */
export function agentTestWorkflowId(
  input: AgentTestInput,
  gateway: ModelGateway,
  taskQueue: string,
): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  // The queue too: a run left open on another queue (an earlier test run's, which no
  // worker serves any more) must not block this one. A deployment's queue never changes.
  return `agent-test-${safe(taskQueue)}-${safe(input.agentName)}-${safe(input.version)}-${safe(gateway.provider)}-${safe(gateway.model)}`;
}

/**
 * Records every loaded agent version, and starts a test run for each one that has a
 * test set and no results with this model yet. Returns what it started.
 */
export async function startAgentTests(input: {
  db: TenantDatabase;
  client: Client;
  taskQueue: string;
  agents: Map<string, LoadedAgent>;
  gateway: ModelGateway | null;
}): Promise<string[]> {
  const started: string[] = [];
  for (const agent of input.agents.values()) {
    const ids = { agentName: agent.definition.name, version: agent.version };
    await recordAgentVersion(input.db, { ...ids, snapshot: agentSnapshot(agent) });
    if (!testableModel(input.gateway) || testSetFor(agent) === null) continue;
    const model = { provider: input.gateway.provider, model: input.gateway.model };
    if (await hasAgentTestRun(input.db, { ...ids, ...model })) continue;
    try {
      await input.client.workflow.start(AGENT_TEST_WORKFLOW, {
        taskQueue: agentTestQueue(input.taskQueue),
        workflowId: agentTestWorkflowId(ids, input.gateway, input.taskQueue),
        // The database, not Temporal's history, says whether a version has been tested
        // (a restored or new database may have lost a run Temporal remembers). So only a
        // run still going blocks another; the activity checks the database again first.
        workflowIdReusePolicy: "ALLOW_DUPLICATE",
        args: [ids],
      });
      started.push(`${ids.agentName} ${ids.version}`);
    } catch (error) {
      // Another worker has just started it.
      if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
    }
  }
  return started;
}

/**
 * A run's failure that says nothing about the agent: the model unreachable, slow or out
 * of quota. Such a case is run again later rather than recorded as wrong.
 */
const TRANSIENT = /\bmodel-(rate-limited|timeout|error)\b/;

/** What a test run has finished so far, kept in its heartbeat so a retry resumes there. */
export interface AgentTestProgress {
  startedAt: string;
  cases: TestRun["cases"];
  calls: number;
  tokens: number;
  costUsd: number | null;
}

/** The activity: runs the version's test set and records the result. */
export async function testAgentVersion(
  deps: {
    db: TenantDatabase;
    agents: Map<string, LoadedAgent>;
    testGateway: TestGatewayFactory;
    /** Reports progress to Temporal, and gives back what an earlier attempt reported. */
    heartbeat: (progress: AgentTestProgress) => void;
    resumeFrom?: AgentTestProgress | undefined;
  },
  input: AgentTestInput,
): Promise<"recorded" | "already-recorded"> {
  const fail = (code: string, retry: boolean) => {
    logEvent(
      "agent.test-failed",
      { agent: input.agentName, agentVersion: input.version, reason: code, retry },
      "error",
    );
    // A fixed message and code only: Temporal keeps failures in its history.
    const message = `agent test run failed: ${code}`;
    return retry
      ? ApplicationFailure.retryable(message, code)
      : ApplicationFailure.nonRetryable(message, code);
  };
  // During a deploy, a worker of the old revision may take the activity: another worker
  // has this version, so try again (on one of them, probably) rather than give up.
  const agent = deps.agents.get(input.agentName);
  if (!agent || agent.version !== input.version) throw fail("agent-version-elsewhere", true);
  const dir = testSetFor(agent);
  if (!dir) throw fail("no-test-set", false);
  try {
    const calls: CallRecord[] = [];
    const gateway = deps.testGateway(async (_context, record) => {
      calls.push(record);
    });
    if (!testableModel(gateway)) throw fail("no-model", false);
    const model = { provider: gateway.provider, model: gateway.model };
    if (await hasAgentTestRun(deps.db, { ...input, ...model })) return "already-recorded";

    const testCases: TestCase[] = loadSamples(dir).map((c) => ({
      id: c.id,
      format: c.format,
      check: c.check,
      file: c.file,
    }));
    const previous = deps.resumeFrom;
    const progress: AgentTestProgress = {
      startedAt: previous?.startedAt ?? new Date().toISOString(),
      cases: (previous?.cases ?? []).filter((c) => testCases.some((t) => t.id === c.id)),
      calls: previous?.calls ?? 0,
      tokens: previous?.tokens ?? 0,
      costUsd: previous ? previous.costUsd : 0,
    };
    let transient = 0;
    for (const testCase of testCases) {
      if (progress.cases.some((c) => c.id === testCase.id)) continue;
      const run = await runTestSet({
        agent,
        cases: [testCase],
        dir,
        gateway,
        calls,
        repeats: AGENT_TEST_REPEATS,
        onCase: () => deps.heartbeat(progress),
      });
      progress.calls += run.usage.calls;
      progress.tokens += run.usage.tokens;
      progress.costUsd =
        progress.costUsd === null || run.usage.costUsd === null
          ? null
          : progress.costUsd + run.usage.costUsd;
      const done = run.cases[0];
      // A case the model could not answer is run again by the next attempt.
      if (!done || done.runs.some((r) => r.error && TRANSIENT.test(r.error))) transient += 1;
      else progress.cases.push(done);
      deps.heartbeat(progress);
    }
    if (transient > 0) throw fail("model-unavailable", true);

    const result: TestRun = {
      agent: input.agentName,
      version: input.version,
      repeats: AGENT_TEST_REPEATS,
      cases: testCases.flatMap((t) => progress.cases.filter((c) => c.id === t.id)),
      usage: { calls: progress.calls, tokens: progress.tokens, costUsd: progress.costUsd },
    };
    await recordAgentTestRun(deps.db, {
      ...input,
      ...model,
      repeats: result.repeats,
      cases: result.cases.length,
      accuracy: overallAccuracy(result),
      result,
      calls: progress.calls,
      tokens: progress.tokens,
      costUsd: progress.costUsd,
      startedAt: new Date(progress.startedAt),
    });
    logEvent("agent.tested", {
      agent: input.agentName,
      agentVersion: input.version,
      cases: result.cases.length,
      calls: progress.calls,
    });
    return "recorded";
  } catch (error) {
    if (error instanceof ApplicationFailure) throw error;
    console.error(
      `agent test run failed: ${error instanceof Error ? error.name : "unknown error"}`,
    );
    throw fail("test-run-failed", true);
  }
}
