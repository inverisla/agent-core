// Starting a job: record it, then hand it to Temporal. Workflow inputs carry IDs only.
import {
  agentForUploads,
  agentRegistry,
  describeAgentError,
  type LoadedAgent,
} from "@agent-core/core/agents";
import {
  DEFAULT_RETRY,
  jobTaskQueue,
  PROCESS_DOCUMENT_WORKFLOW,
  temporalConnectionOptions,
  temporalSettings,
  workflowIdForJob,
  type ProcessDocumentInput,
} from "@agent-core/core";
import { createJob, getTenantAgents, setJobStatus, type TenantDatabase } from "@agent-core/db";
import { Client, Connection, WorkflowIdReusePolicy } from "@temporalio/client";

/** An upload waits at most this long for Temporal; after that the job stays "uploaded". */
const START_DEADLINE_MS = 5000;

const globalForTemporal = globalThis as unknown as { agentCoreTemporal?: Promise<Client> };

export function temporalClient(): Promise<Client> {
  const settings = temporalSettings(process.env);
  globalForTemporal.agentCoreTemporal ??= Connection.connect({
    ...temporalConnectionOptions(settings),
    connectTimeout: START_DEADLINE_MS,
  }).then((connection) => new Client({ connection, namespace: settings.namespace }));
  // A failed connection is not cached, so the next upload tries again.
  globalForTemporal.agentCoreTemporal.catch(() => {
    delete globalForTemporal.agentCoreTemporal;
  });
  return globalForTemporal.agentCoreTemporal;
}

/**
 * The agents a tenant's uploads may use (task 12b): those an operator assigned to it that
 * this deployment has loaded. Only a tenant with none assigned gets the deployment's
 * default (AGENT_FOR_UPLOADS); if its assigned agents are gone, it gets none, rather than
 * one nobody chose for it.
 */
export async function uploadAgents(db: TenantDatabase, tenantId: string): Promise<LoadedAgent[]> {
  const registry = await agentRegistry(process.env);
  const names = await getTenantAgents(db, tenantId);
  if (names.length === 0) return [agentForUploads(registry, process.env)];
  return names.map((name) => registry.get(name)).filter((a): a is LoadedAgent => a !== undefined);
}

/**
 * The agent for an upload: the one asked for, if the tenant may use it, or the tenant's
 * only one when none is asked for. "none" if the tenant has no agent it can use; "agent"
 * if the request names one it may not use, or names none when there is a choice.
 */
export async function chooseUploadAgent(
  db: TenantDatabase,
  tenantId: string,
  requested: string | null,
): Promise<LoadedAgent | "none" | "agent"> {
  const allowed = await uploadAgents(db, tenantId);
  if (allowed.length === 0) return "none";
  if (requested) return allowed.find((a) => a.definition.name === requested) ?? "agent";
  return allowed.length === 1 && allowed[0] ? allowed[0] : "agent";
}

/**
 * Creates the job (status "uploaded") and starts its workflow; once Temporal has it,
 * the status becomes "queued". If the job cannot be created, this throws and the upload
 * fails. If Temporal does not take it (no answer within 5 s, say), the upload still
 * succeeds and the job stays "uploaded": the worker's job sweep starts it within a few
 * minutes (apps/worker/src/job-sweep.ts, review Q1). Every upload runs the agent named by AGENT_FOR_UPLOADS (see agents.ts), and
 * the job records that agent's name and version.
 */
export async function startDocumentJob(
  db: TenantDatabase,
  tenantId: string,
  documentId: string,
  chosen?: LoadedAgent,
  /** Tests only: a Temporal that cannot be reached. */
  connect: () => Promise<Client> = temporalClient,
): Promise<{ jobId: string | null; queued: boolean }> {
  const agent = chosen ?? agentForUploads(await agentRegistry(process.env), process.env);
  const jobId = await createJob(db, tenantId, {
    documentId,
    agentName: agent.definition.name,
    agentVersion: agent.version,
  });
  try {
    const input: ProcessDocumentInput = { tenantId, jobId, retry: DEFAULT_RETRY };
    const client = await connect();
    const id = jobId;
    await client.withDeadline(Date.now() + START_DEADLINE_MS, () =>
      client.workflow.start(PROCESS_DOCUMENT_WORKFLOW, {
        taskQueue: jobTaskQueue(process.env),
        workflowId: workflowIdForJob(id),
        // One run per job, ever: a finished workflow's ID cannot be run again.
        workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
        args: [input],
      }),
    );
    await setJobStatus(db, tenantId, jobId, "queued", ["uploaded"]);
    return { jobId, queued: true };
  } catch (error) {
    console.error("job not started yet (the job sweep will):", describeAgentError(error));
    return { jobId, queued: false };
  }
}
