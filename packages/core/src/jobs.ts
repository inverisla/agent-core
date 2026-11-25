// The contract between the web app, which starts jobs, and the worker, which runs them.
// Workflow inputs carry IDs only: no document content ever passes through Temporal.

export const DEFAULT_TASK_QUEUE = "documents";
export const PROCESS_DOCUMENT_WORKFLOW = "processDocument";

export interface RetryPolicy {
  initialIntervalMs: number;
  backoffCoefficient: number;
  maximumAttempts: number;
}

/** 3 attempts, waiting 5 s then 20 s. */
export const DEFAULT_RETRY: RetryPolicy = {
  initialIntervalMs: 5000,
  backoffCoefficient: 4,
  maximumAttempts: 3,
};

/**
 * Tenant and job IDs only: the worker reads everything else (the document, the agent
 * and version) from the job's record, inside the tenant's context, so a forged input
 * cannot point a job at another document.
 */
export interface ProcessDocumentInput {
  tenantId: string;
  jobId: string;
  retry: RetryPolicy;
  /**
   * Tests only: fail the first N attempts. Ignored unless the worker runs with
   * ALLOW_TEST_FAULTS=true, which it refuses outside local development.
   */
  testFailAttempts?: number;
}

export function workflowIdForJob(jobId: string): string {
  return `job-${jobId}`;
}

export function jobTaskQueue(env: NodeJS.ProcessEnv): string {
  return env["JOB_TASK_QUEUE"] || DEFAULT_TASK_QUEUE;
}

export interface TemporalConnectionSettings {
  address: string;
  namespace: string;
  /** Temporal Cloud: an API key, sent over TLS. Unset for the local dev server. */
  apiKey?: string;
}

export function temporalSettings(env: NodeJS.ProcessEnv): TemporalConnectionSettings {
  const apiKey = env["TEMPORAL_API_KEY"];
  return {
    address: env["TEMPORAL_ADDRESS"] || "localhost:7233",
    namespace: env["TEMPORAL_NAMESPACE"] || "default",
    ...(apiKey ? { apiKey } : {}),
  };
}

/**
 * Connection options for the Temporal client and worker. With an API key (Temporal
 * Cloud) the connection uses TLS and names the namespace, as Temporal Cloud requires.
 */
export function temporalConnectionOptions(settings: TemporalConnectionSettings) {
  return settings.apiKey
    ? {
        address: settings.address,
        tls: true as const,
        apiKey: settings.apiKey,
        metadata: { "temporal-namespace": settings.namespace },
      }
    : { address: settings.address };
}

/** The workflow update the review screen sends with a reviewer's decision (task 11). */
export const DECIDE_UPDATE = "decide";

/**
 * A decision: the review event that records it, and the run whose draft it is about.
 * IDs only; the decision itself, and any reason, are read from the event in the database.
 */
export interface ReviewDecision {
  eventId: string;
  run: number;
}
