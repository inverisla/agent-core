// Workflow code runs in Temporal's deterministic sandbox: no I/O here, only activities.
import { DECIDE_UPDATE, type ProcessDocumentInput, type ReviewDecision } from "@agent-core/core";
import {
  ActivityFailure,
  CancellationScope,
  condition,
  defineUpdate,
  isCancellation,
  patched,
  proxyActivities,
  setHandler,
} from "@temporalio/workflow";
import type { Activities } from "./activities.ts";
import type { AgentTestInput } from "./agent-tests.ts";

/** A reviewer's decision (task 11), sent by the review screen: IDs only. */
export const decideUpdate = defineUpdate<null, [ReviewDecision]>(DECIDE_UPDATE);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs the job's agent, then waits for a reviewer. Approval writes the report from the
 * reviewed fields and ends the job; a send-back starts another run, which is reviewed in
 * turn. A run that fails after its retries ends the job as failed.
 */
export async function processDocument(
  input: ProcessDocumentInput,
): Promise<"approved" | "succeeded" | "failed"> {
  const { runJob } = proxyActivities<Activities>({
    startToCloseTimeout: "10 minutes",
    // An attempt reports in every 15 s (activities.ts), so a worker that dies mid-job is
    // noticed in a minute. Workflows started before this change keep their old options,
    // so their histories replay unchanged.
    ...(patched("run-job-heartbeat") ? { heartbeatTimeout: "1 minute" } : {}),
    retry: {
      initialInterval: input.retry.initialIntervalMs,
      backoffCoefficient: input.retry.backoffCoefficient,
      maximumAttempts: input.retry.maximumAttempts,
    },
  });
  // Recording a status or a decision must not give up on a brief database outage.
  const { finishJob, awaitReview, startNextRun, readDecision, approve } =
    proxyActivities<Activities>({
      startToCloseTimeout: "1 minute",
      retry: {
        initialInterval: "1 second",
        backoffCoefficient: 2,
        maximumInterval: "1 minute",
        nonRetryableErrorTypes: ["bad-decision"],
      },
    });

  // The run whose draft is waiting for review, and the decision once one arrives. The
  // validator refuses a decision unless the workflow is waiting for one on that run, so
  // the review screen learns at once if it is out of date.
  let waitingOn: number | null = null;
  let decision: ReviewDecision | null = null;
  setHandler(
    decideUpdate,
    (d) => {
      decision = d;
      return null;
    },
    {
      validator: (d) => {
        if (!d || typeof d.eventId !== "string" || !UUID.test(d.eventId)) {
          throw new Error("not a decision");
        }
        if (waitingOn === null || d.run !== waitingOn || decision !== null) {
          throw new Error("not waiting for a decision on this draft");
        }
      },
    },
  );

  // Even if the workflow is cancelled, a failed job still gets its final status. (A
  // workflow that is terminated outright runs no more code, so its job stays as it was.)
  // The reason goes into the "job failed" event when the last attempt itself succeeded.
  const fail = (reason?: "approve-failed" | "cancelled") =>
    CancellationScope.nonCancellable(() => finishJob(input, "failed", reason));

  // Workflows started before review existed (task 11) replay their old path: after the
  // run, the job simply succeeds. New ones take the review loop.
  if (!patched("task-11-review")) {
    try {
      await runJob(input);
    } catch (error) {
      await fail();
      if (!(error instanceof ActivityFailure)) throw error;
      return "failed";
    }
    await CancellationScope.nonCancellable(() => finishJob(input, "succeeded"));
    return "succeeded";
  }

  try {
    let sentBackBy: string | undefined;
    for (let run = 1; ; run++) {
      if (run > 1) await startNextRun(input, run);
      try {
        await runJob(input, run, sentBackBy);
      } catch (error) {
        await fail();
        if (!(error instanceof ActivityFailure)) throw error;
        return "failed";
      }
      await awaitReview(input, run);
      // Wait until a decision on this run's draft holds up; one that does not (an event
      // for another job, say) is dropped and the draft waits again.
      let kind: "approve" | "send_back" | null = null;
      let eventId = "";
      while (kind === null) {
        decision = null;
        waitingOn = run;
        await condition(() => decision !== null);
        waitingOn = null;
        eventId = (decision as unknown as ReviewDecision).eventId;
        kind = await readDecision(input, eventId, run).catch(() => null);
      }
      if (kind === "approve") {
        try {
          await approve(input, eventId);
        } catch (error) {
          // An approval that cannot be carried out (a report that cannot be written).
          await fail("approve-failed");
          if (!(error instanceof ActivityFailure)) throw error;
          return "failed";
        }
        return "approved";
      }
      sentBackBy = eventId;
    }
  } catch (error) {
    // Cancelled while running or waiting for review: the job still gets a final status.
    if (isCancellation(error)) await fail("cancelled");
    throw error;
  }
}

/**
 * Copies new audit events to write-once storage (task 14). Started every 5 minutes by
 * the audit-copy schedule (audit-schedule.ts), never two at once; a failed run is simply
 * done again by the next.
 */
export async function copyAuditLogWorkflow(): Promise<void> {
  const { copyAuditLog } = proxyActivities<Activities>({
    // Reports in after each tenant: a run that stops doing so is ended, and the next
    // scheduled one carries on from where the copy really ends.
    startToCloseTimeout: "30 minutes",
    heartbeatTimeout: "2 minutes",
    retry: { maximumAttempts: 1 },
  });
  await copyAuditLog();
}

/**
 * The job sweep (review Q1, Q7), run every 5 minutes by its schedule (job-sweep.ts):
 * starts jobs whose workflow never started, and sends undelivered decisions again.
 */
export async function sweepJobsWorkflow(): Promise<void> {
  const { sweepJobs } = proxyActivities<Activities>({
    startToCloseTimeout: "10 minutes",
    heartbeatTimeout: "2 minutes",
    retry: { maximumAttempts: 1 },
  });
  await sweepJobs();
}

/**
 * An agent version's own test run (task 16), started by the worker at start-up for each
 * new version (agent-tests.ts), on the agent-test queue. A run takes a few minutes; it
 * reports in after every case, and a retry carries on from the cases already done. If
 * it still fails after its retries, the next worker start tries again.
 */
export async function testAgentWorkflow(input: AgentTestInput): Promise<string> {
  const { testAgentVersion } = proxyActivities<Activities>({
    startToCloseTimeout: "60 minutes",
    // A case can wait several minutes for a rate limit (RETRY_WAITS_MS in @agent-core/testing).
    heartbeatTimeout: "10 minutes",
    retry: { initialInterval: "5 minutes", backoffCoefficient: 2, maximumAttempts: 3 },
  });
  return testAgentVersion(input);
}
