// The worker's schedules, each every 5 minutes and never two runs at once: the audit
// copy (task 14) and the job sweep (review Q1, Q7). Created by the worker at start-up if
// missing; left alone if they exist.
import {
  ScheduleAlreadyRunning,
  ScheduleNotFoundError,
  ScheduleOverlapPolicy,
  type Client,
} from "@temporalio/client";
import { DEFAULT_TASK_QUEUE } from "@agent-core/core";

export const AUDIT_COPY_SCHEDULE_ID = "audit-copy";
export const AUDIT_COPY_WORKFLOW = "copyAuditLogWorkflow";
export const JOB_SWEEP_SCHEDULE_ID = "job-sweep";
export const JOB_SWEEP_WORKFLOW = "sweepJobsWorkflow";

/**
 * A schedule's ID for a task queue: the plain ID on the deployment's own queue, so an
 * existing schedule keeps its name; another queue (the e2e tests' own) gets IDs of its
 * own, so it never takes over the schedules a local `pnpm dev` worker uses.
 */
export function scheduleIdFor(base: string, taskQueue: string): string {
  return taskQueue === DEFAULT_TASK_QUEUE ? base : `${base}-${taskQueue}`;
}

export function ensureAuditCopySchedule(
  client: Client,
  taskQueue: string,
  scheduleId = scheduleIdFor(AUDIT_COPY_SCHEDULE_ID, taskQueue),
): Promise<ScheduleOutcome> {
  return ensureSchedule(client, taskQueue, scheduleId, AUDIT_COPY_WORKFLOW);
}

export function ensureJobSweepSchedule(
  client: Client,
  taskQueue: string,
  scheduleId = scheduleIdFor(JOB_SWEEP_SCHEDULE_ID, taskQueue),
): Promise<ScheduleOutcome> {
  return ensureSchedule(client, taskQueue, scheduleId, JOB_SWEEP_WORKFLOW);
}

export type ScheduleOutcome = "created" | "exists" | "moved";

async function ensureSchedule(
  client: Client,
  taskQueue: string,
  scheduleId: string,
  workflowType: string,
): Promise<ScheduleOutcome> {
  const handle = client.schedule.getHandle(scheduleId);
  try {
    const described = await handle.describe();
    const action = described.action;
    if (
      action.type === "startWorkflow" &&
      action.workflowType === workflowType &&
      action.taskQueue === taskQueue
    ) {
      return "exists";
    }
    // This ID's schedule is on another queue, or runs another workflow: one made by an
    // older version of this code (before IDs depended on the queue, an e2e run's worker
    // could take the plain IDs). Its runs would wait for ever on a queue nobody serves,
    // and with overlap SKIP every later run would be skipped. So point it at this queue
    // first, so a run it starts from now on goes there, then end the runs it already
    // started (review of C2–D3). Both lists, as either can be missing a run; ending one
    // that has already finished does nothing.
    await handle.update((previous) => ({
      ...previous,
      action: {
        type: "startWorkflow",
        workflowType,
        workflowId: `${scheduleId}-run`,
        taskQueue,
        args: [],
      },
    }));
    const ids = [
      ...described.info.runningActions.map((r) => r.workflow.workflowId),
      ...described.info.recentActions.map((r) => r.action.workflow.workflowId),
    ];
    for (const id of new Set(ids)) {
      await client.workflow
        .getHandle(id)
        .terminate("schedule moved to another task queue")
        .catch(() => {});
    }
    return "moved";
  } catch (error) {
    if (!(error instanceof ScheduleNotFoundError)) throw error;
  }
  try {
    await client.schedule.create({
      scheduleId,
      spec: { intervals: [{ every: "5 minutes" }] },
      action: {
        type: "startWorkflow",
        workflowType,
        workflowId: `${scheduleId}-run`,
        taskQueue,
        args: [],
      },
      // A run still going when the next is due: skip it, rather than run two at once.
      policies: { overlap: ScheduleOverlapPolicy.SKIP, catchupWindow: "1 minute" },
    });
    return "created";
  } catch (error) {
    // Another worker created it at the same moment.
    if (error instanceof ScheduleAlreadyRunning) return "exists";
    throw error;
  }
}
