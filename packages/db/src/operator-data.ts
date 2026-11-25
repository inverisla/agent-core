// The operator's own records (task 16): each agent version the deployment has run, and
// its test-set results. Outside every tenant (withOperatorData), and never tenant data.
// Rows are only ever added: the database refuses changes and deletions.
import { and, desc, eq, sql } from "drizzle-orm";
import { agentTestRuns, agentVersions } from "./schema.ts";
import type { TenantDatabase } from "./tenant-context.ts";

/** An agent version's files as the deployment loaded them. */
export interface AgentSnapshot {
  /** agent.json, as parsed. */
  definition: unknown;
  /** Every file the agent names: text files with their text, others with their size only. */
  files: { path: string; text: string | null; bytes: number }[];
}

export interface AgentVersionRecord {
  agentName: string;
  version: string;
  snapshot: AgentSnapshot;
  recordedAt: Date;
}

export interface AgentTestRunSummary {
  runId: string;
  agentName: string;
  version: string;
  provider: string;
  model: string;
  repeats: number;
  cases: number;
  /** Right answers out of every checked field, over all cases and runs (0 to 1). */
  accuracy: number | null;
  calls: number;
  tokens: number;
  costUsd: number | null;
  startedAt: Date;
  finishedAt: Date;
}

export interface AgentTestRunRecord extends AgentTestRunSummary {
  /** The whole run: every case's answers and field checks (TestRun in @agent-core/testing). */
  result: unknown;
}

/** Records a version the first time it is seen; later calls change nothing. */
export async function recordAgentVersion(
  db: TenantDatabase,
  input: { agentName: string; version: string; snapshot: AgentSnapshot },
): Promise<void> {
  await db.withOperatorData((tx) => tx.insert(agentVersions).values(input).onConflictDoNothing());
}

export async function recordAgentTestRun(
  db: TenantDatabase,
  input: Omit<AgentTestRunRecord, "runId" | "finishedAt">,
): Promise<string> {
  const [row] = await db.withOperatorData((tx) =>
    tx.insert(agentTestRuns).values(input).returning({ runId: agentTestRuns.runId }),
  );
  if (!row) throw new Error("The test run was not recorded.");
  return row.runId;
}

export async function getAgentVersion(
  db: TenantDatabase,
  agentName: string,
  version: string,
): Promise<AgentVersionRecord | null> {
  const [row] = await db.withOperatorData((tx) =>
    tx
      .select()
      .from(agentVersions)
      .where(and(eq(agentVersions.agentName, agentName), eq(agentVersions.version, version))),
  );
  return row ? { ...row, snapshot: row.snapshot as AgentSnapshot } : null;
}

/** An agent's recorded versions, newest first (without their files). */
export async function listAgentVersions(
  db: TenantDatabase,
  agentName: string,
): Promise<{ version: string; recordedAt: Date }[]> {
  return db.withOperatorData((tx) =>
    tx
      .select({ version: agentVersions.version, recordedAt: agentVersions.recordedAt })
      .from(agentVersions)
      .where(eq(agentVersions.agentName, agentName))
      .orderBy(desc(agentVersions.recordedAt)),
  );
}

const summaryColumns = {
  runId: agentTestRuns.runId,
  agentName: agentTestRuns.agentName,
  version: agentTestRuns.version,
  provider: agentTestRuns.provider,
  model: agentTestRuns.model,
  repeats: agentTestRuns.repeats,
  cases: agentTestRuns.cases,
  accuracy: agentTestRuns.accuracy,
  calls: agentTestRuns.calls,
  tokens: agentTestRuns.tokens,
  costUsd: agentTestRuns.costUsd,
  startedAt: agentTestRuns.startedAt,
  finishedAt: agentTestRuns.finishedAt,
};

/** An agent's test runs, newest first (without their results). */
export async function listAgentTestRuns(
  db: TenantDatabase,
  agentName: string,
): Promise<AgentTestRunSummary[]> {
  return db.withOperatorData((tx) =>
    tx
      .select(summaryColumns)
      .from(agentTestRuns)
      .where(eq(agentTestRuns.agentName, agentName))
      .orderBy(desc(agentTestRuns.finishedAt)),
  );
}

/** One test run with its result, or null (also for anything that is not a run ID). */
export async function getAgentTestRun(
  db: TenantDatabase,
  runId: string,
): Promise<AgentTestRunRecord | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) return null;
  const [row] = await db.withOperatorData((tx) =>
    tx
      .select({ ...summaryColumns, result: agentTestRuns.result })
      .from(agentTestRuns)
      .where(eq(agentTestRuns.runId, runId)),
  );
  return row ?? null;
}

/** Whether this version already has a test run with this model. */
export async function hasAgentTestRun(
  db: TenantDatabase,
  input: { agentName: string; version: string; provider: string; model: string },
): Promise<boolean> {
  const [row] = await db.withOperatorData((tx) =>
    tx
      .select({ n: sql<number>`1` })
      .from(agentTestRuns)
      .where(
        and(
          eq(agentTestRuns.agentName, input.agentName),
          eq(agentTestRuns.version, input.version),
          eq(agentTestRuns.provider, input.provider),
          eq(agentTestRuns.model, input.model),
        ),
      )
      .limit(1),
  );
  return row !== undefined;
}
