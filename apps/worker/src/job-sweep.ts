// The job sweep (review Q1, Q7): every 5 minutes, for every tenant, it starts the jobs
// whose workflow never started (Temporal did not answer the upload in time), and sends
// again the review decisions that never reached their workflow. Both are safe to repeat:
// a job's workflow runs once only, and the same decision sent twice is one decision.
// A job whose workflow has ended (terminated, say) can never go on: it is ended as
// failed, once, so it does not alert for ever. What still fails is logged as an event
// with an alert (infra/azure/modules/monitoring.bicep).
import {
  DECIDE_UPDATE,
  DEFAULT_RETRY,
  PROCESS_DOCUMENT_WORKFLOW,
  workflowIdForJob,
  type ProcessDocumentInput,
} from "@agent-core/core";
import { logEvent } from "@agent-core/core/telemetry";
import {
  finishJob,
  setJobStatus,
  stuckUploads,
  undeliveredDecisions,
  type TenantDatabase,
} from "@agent-core/db";
import {
  WorkflowExecutionAlreadyStartedError,
  WorkflowIdReusePolicy,
  WorkflowNotFoundError,
  type Client,
} from "@temporalio/client";

/** How long a job may wait for its workflow, or a decision for its workflow, first. */
export const STUCK_AFTER_MS = 2 * 60 * 1000;
/** How long one call to Temporal may take here. */
const CALL_DEADLINE_MS = 10_000;
/** The reason a job is ended with when its workflow has ended without it. */
export const WORKFLOW_ENDED = "workflow-ended";

export interface SweepResult {
  started: number;
  delivered: number;
  ended: number;
  stuck: number;
}

const errorName = (error: unknown) => (error instanceof Error ? error.name : "unknown");

export async function sweepJobs(deps: {
  db: TenantDatabase;
  client: Client;
  taskQueue: string;
  now?: number;
  /** Called after each job and tenant, so the activity can report in. */
  onProgress?: () => void;
  /** Set when the activity is cancelled (timed out): the sweep stops there. */
  signal?: AbortSignal;
}): Promise<SweepResult> {
  const { db, client } = deps;
  const before = new Date((deps.now ?? Date.now()) - STUCK_AFTER_MS);
  const result: SweepResult = { started: 0, delivered: 0, ended: 0, stuck: 0 };
  const call = <T>(fn: () => Promise<T>) => client.withDeadline(Date.now() + CALL_DEADLINE_MS, fn);
  const progress = () => {
    deps.onProgress?.();
    if (deps.signal?.aborted) throw new Error("job sweep cancelled");
  };

  /** Whether the job's workflow has ended (or never existed): it will never act. */
  const workflowEnded = async (jobId: string): Promise<boolean> => {
    try {
      const described = await call(() =>
        client.workflow.getHandle(workflowIdForJob(jobId)).describe(),
      );
      return described.status.name !== "RUNNING";
    } catch (error) {
      if (error instanceof WorkflowNotFoundError) return true;
      throw error;
    }
  };

  /** Ends a job whose workflow has ended without it, once; the job-failed alert fires. */
  const endJob = async (tenantId: string, jobId: string) => {
    if (await finishJob(db, tenantId, jobId, "failed")) {
      result.ended++;
      logEvent("job.failed", { tenantId, jobId, reason: WORKFLOW_ENDED }, "error");
    }
  };

  for (const { tenantId } of await db.listTenants()) {
    // One tenant's failure does not stop the others.
    try {
      for (const jobId of await stuckUploads(db, tenantId, before)) {
        try {
          const input: ProcessDocumentInput = { tenantId, jobId, retry: DEFAULT_RETRY };
          let alreadyStarted = false;
          await call(() =>
            client.workflow.start(PROCESS_DOCUMENT_WORKFLOW, {
              taskQueue: deps.taskQueue,
              workflowId: workflowIdForJob(jobId),
              workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
              args: [input],
            }),
          ).catch((error: unknown) => {
            if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
            alreadyStarted = true;
          });
          // Started before, and only the status was not recorded: fine while it runs; if
          // it has ended, the job can never run (its workflow runs once only).
          if (alreadyStarted && (await workflowEnded(jobId))) {
            await endJob(tenantId, jobId);
          } else {
            await setJobStatus(db, tenantId, jobId, "queued", ["uploaded"]);
            // A restart only when this sweep started the workflow. One already running
            // (only its status was not recorded) is just put right, and not counted.
            if (!alreadyStarted) {
              result.started++;
              logEvent("job.restarted", { tenantId, jobId });
            }
          }
        } catch (error) {
          result.stuck++;
          logEvent("job.stuck", { tenantId, jobId, reason: errorName(error) }, "error");
        }
        progress();
      }
      for (const d of await undeliveredDecisions(db, tenantId, before)) {
        try {
          await call(() =>
            client.workflow.getHandle(workflowIdForJob(d.jobId)).executeUpdate(DECIDE_UPDATE, {
              args: [{ eventId: d.eventId, run: d.run }],
              updateId: d.eventId,
            }),
          );
          result.delivered++;
        } catch (error) {
          try {
            if (await workflowEnded(d.jobId)) {
              await endJob(tenantId, d.jobId);
            } else {
              result.stuck++;
              logEvent(
                "job.decision-undelivered",
                { tenantId, jobId: d.jobId, reason: errorName(error) },
                "error",
              );
            }
          } catch (describeError) {
            result.stuck++;
            logEvent(
              "job.decision-undelivered",
              { tenantId, jobId: d.jobId, reason: errorName(describeError) },
              "error",
            );
          }
        }
        progress();
      }
    } catch (error) {
      if (deps.signal?.aborted) throw error;
      result.stuck++;
      logEvent("job.stuck", { tenantId, reason: errorName(error) }, "error");
    }
    progress();
  }
  return result;
}
