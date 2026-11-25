// The operator console's view of agents (task 16): what this deployment has loaded, which
// tenants use each, each recorded version's files and test runs, and two runs compared.
// Agent files and test results are the operator's own records (the operator schema);
// tenant reads (which agents a tenant uses, job counts) happen inside each tenant's own
// context. Only for a signed-in operator: callers check first.
import { agentForUploads, agentRegistry, type LoadedAgent } from "@agent-core/core/agents";
import {
  getAgentTestRun,
  getAgentVersion,
  getTenantAgents,
  jobCountsByAgentVersion,
  listAgentTestRuns,
  listAgentVersions,
  type AgentSnapshot,
  type AgentTestRunRecord,
  type AgentTestRunSummary,
} from "@agent-core/db";
import { compareRuns, type Comparison } from "@agent-core/testing/compare";
import type { TestRun } from "@agent-core/testing/run";
import { agentSnapshot } from "@agent-core/testing/snapshot";
import { db } from "../server/db.ts";
import { eachTenant, type TenantRef } from "./each-tenant.ts";

const AGENT_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VERSION = /^[0-9a-f]{12}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Each tenant's name and the agents it may use (none assigned: the deployment's default). */
async function tenantAgents(): Promise<{
  tenants: (TenantRef & { agents: string[] })[];
  unreadable: number;
}> {
  const { results, unreadable } = await eachTenant(async (t) => ({
    ...t,
    agents: await getTenantAgents(db(), t.tenantId),
  }));
  return { tenants: results, unreadable };
}

function usersOf(
  name: string,
  defaultAgent: string | null,
  tenants: (TenantRef & { agents: string[] })[],
): TenantRef[] {
  return tenants
    .filter((t) => (t.agents.length > 0 ? t.agents.includes(name) : name === defaultAgent))
    .map(({ tenantId, name: tenantName }) => ({ tenantId, name: tenantName }));
}

function defaultAgentName(registry: Map<string, LoadedAgent>): string | null {
  try {
    return agentForUploads(registry, process.env).definition.name;
  } catch {
    return null;
  }
}

export interface AgentOverview {
  name: string;
  title: string;
  version: string;
  accepts: string[];
  steps: { id: string; block: string }[];
  isDefault: boolean;
  tenants: TenantRef[];
  /** The latest test run of the loaded version, if any. */
  latestRun: AgentTestRunSummary | null;
}

export async function listAgentOverviews(): Promise<{
  agents: AgentOverview[];
  unreadable: number;
}> {
  const registry = await agentRegistry(process.env);
  const defaultAgent = defaultAgentName(registry);
  const { tenants, unreadable } = await tenantAgents();
  const agents = await Promise.all(
    [...registry.values()].map(async (agent) => {
      const name = agent.definition.name;
      const run = (await listAgentTestRuns(db(), name)).find((r) => r.version === agent.version);
      return {
        name,
        title: agent.definition.title,
        version: agent.version,
        accepts: agent.definition.accepts,
        steps: agent.definition.steps.map((s) => ({ id: s.id, block: s.block })),
        isDefault: name === defaultAgent,
        tenants: usersOf(name, defaultAgent, tenants),
        latestRun: run ?? null,
      };
    }),
  );
  return { agents, unreadable };
}

export interface VersionRow {
  version: string;
  recordedAt: Date | null;
  loaded: boolean;
  /** Jobs that ran this version in the last 30 days, over every tenant. */
  jobs: number;
}

export interface AgentDetail {
  name: string;
  title: string;
  /** The version loaded by this deployment, or null if it no longer has the agent. */
  loadedVersion: string | null;
  isDefault: boolean;
  tenants: TenantRef[];
  /** The version being shown, and its files. */
  shown: { version: string; snapshot: AgentSnapshot } | null;
  versions: VersionRow[];
  runs: AgentTestRunSummary[];
  /** Tenants that could not be read just now (their use and job counts are missing). */
  unreadable: number;
}

/** One agent, showing `version` (default: the loaded one), or null if there is no such agent. */
export async function agentDetail(name: string, version?: string): Promise<AgentDetail | null> {
  if (!AGENT_NAME.test(name)) return null;
  const registry = await agentRegistry(process.env);
  const loaded = registry.get(name) ?? null;
  const recorded = await listAgentVersions(db(), name);
  if (!loaded && recorded.length === 0) return null;
  const defaultAgent = defaultAgentName(registry);
  // Which agents each tenant uses, and its jobs per version in the last 30 days, in one
  // pass over the tenants, each read in its own context.
  const since = new Date(Date.now() - 30 * DAY_MS);
  const { results: tenants, unreadable } = await eachTenant(async (t) => ({
    ...t,
    agents: await getTenantAgents(db(), t.tenantId),
    counts: await jobCountsByAgentVersion(db(), t.tenantId, since),
  }));
  const jobs = new Map<string, number>();
  for (const t of tenants) {
    for (const c of t.counts) {
      if (c.agentName === name) jobs.set(c.agentVersion, (jobs.get(c.agentVersion) ?? 0) + c.jobs);
    }
  }
  const versions: VersionRow[] = recorded.map((v) => ({
    version: v.version,
    recordedAt: v.recordedAt,
    loaded: v.version === loaded?.version,
    jobs: jobs.get(v.version) ?? 0,
  }));
  if (loaded && !versions.some((v) => v.loaded)) {
    versions.unshift({
      version: loaded.version,
      recordedAt: null,
      loaded: true,
      jobs: jobs.get(loaded.version) ?? 0,
    });
  }

  const wanted =
    version && VERSION.test(version) ? version : (loaded?.version ?? versions[0]?.version);
  let shown: AgentDetail["shown"] = null;
  if (wanted && wanted === loaded?.version) {
    shown = { version: wanted, snapshot: agentSnapshot(loaded) };
  } else if (wanted) {
    const record = await getAgentVersion(db(), name, wanted);
    if (record) shown = { version: wanted, snapshot: record.snapshot };
  }

  const runs = await listAgentTestRuns(db(), name);
  return {
    name,
    title: loaded?.definition.title ?? name,
    loadedVersion: loaded?.version ?? null,
    isDefault: name === defaultAgent,
    tenants: usersOf(name, defaultAgent, tenants),
    shown,
    versions,
    runs,
    unreadable,
  };
}

/** Two of an agent's test runs compared, or null unless both are runs of that agent. */
export async function compareTestRuns(
  name: string,
  baseRunId: string,
  currentRunId: string,
): Promise<{
  base: AgentTestRunRecord;
  current: AgentTestRunRecord;
  comparison: Comparison;
} | null> {
  const [base, current] = await Promise.all([
    getAgentTestRun(db(), baseRunId),
    getAgentTestRun(db(), currentRunId),
  ]);
  if (!base || !current || base.agentName !== name || current.agentName !== name) return null;
  const comparison = compareRuns(base.result as TestRun, current.result as TestRun, {
    sameVersion: base.version === current.version,
  });
  return { base, current, comparison };
}
