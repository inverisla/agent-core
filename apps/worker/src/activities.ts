// Activities run in the worker process and may use the database; workflows may not.
// Each attempt is recorded before and after the work, so the job's status shows every
// retry. Failures leave the activity as a fixed message and a reason code only: raw
// errors can quote SQL parameters or document content, and Temporal keeps failures in
// its history (and the worker logs them).
import {
  BlockError,
  cleanFields,
  documentKind,
  reportFromFields,
  runAgent,
} from "@agent-core/blocks";
import type { ProcessDocumentInput } from "@agent-core/core";
import type { LoadedAgent } from "@agent-core/core/agents";
import { ModelError, type ModelGateway } from "@agent-core/core/models";
import {
  documentBlobName,
  reportBlobName,
  tenantContainer,
  textBlobName,
} from "@agent-core/core/storage";
import {
  approveJob,
  beginReview,
  finishAttempt,
  finishJob,
  getDecision,
  getJob,
  getJobOutput,
  jobDocument,
  attemptIsLive,
  saveJobOutput,
  sendBackNote,
  withdrawReport,
  startAttempt,
  startRun,
  type TenantDatabase,
} from "@agent-core/db";
import type { BlobServiceClient, ContainerClient } from "@azure/storage-blob";
import { copyAuditLog } from "./audit-copy.ts";
import { sweepJobs } from "./job-sweep.ts";
import type { Client } from "@temporalio/client";
import {
  testAgentVersion,
  type AgentTestInput,
  type AgentTestProgress,
  type TestGatewayFactory,
} from "./agent-tests.ts";
import { ApplicationFailure, Context } from "@temporalio/activity";
import { logEvent } from "@agent-core/core/telemetry";

export interface ActivityDeps {
  db: TenantDatabase;
  /** The agents this worker has loaded, by name. */
  agents: Map<string, LoadedAgent>;
  /** The model gateway (null if no model is configured). */
  models: ModelGateway | null;
  /** The same model, for agent test runs (task 16), whose calls are no tenant's. */
  testGateway?: TestGatewayFactory;
  /** Tenant documents in, reports out (one container per tenant). */
  blobs: BlobServiceClient;
  /** The audit log's write-once copy (task 14); null where none is set up. */
  auditCopy: ContainerClient | null;
  /** AUDIT_COPY_EPOCH (docs/operations.md); 1 unless the database was restored. */
  auditCopyEpoch?: number;
  allowTestFaults: boolean;
  /** Temporal, for the job sweep (review Q1, Q7); and the job queue it starts jobs on. */
  temporal?: { client: Client; taskQueue: string };
}

export const TEST_FAULT = "test-fault";
/** How often runJob reports in (the workflow allows a minute). */
export const RUN_JOB_HEARTBEAT_MS = 15_000;

/**
 * Calls `beat` every `everyMs` until the returned stop function is called. Started at the
 * beginning of an attempt and stopped in its `finally`, so it stops however it ends.
 */
export function startHeartbeat(beat: () => void, everyMs = RUN_JOB_HEARTBEAT_MS): () => void {
  const timer = setInterval(beat, everyMs);
  return () => clearInterval(timer);
}
/** The job's recorded agent version is not the one this worker has: it cannot run it. */
export const AGENT_VERSION_CHANGED = "agent-version-changed";
/** An attempt that outlived its timeout, after a later one took over: its result is dropped. */
export const ATTEMPT_SUPERSEDED = "attempt-superseded";
/** Failures that retrying cannot fix: the document, the agent or the setup is the problem. */
const FINAL = new Set<string>([
  AGENT_VERSION_CHANGED,
  "document-not-found",
  "no-text",
  "unreadable-document",
  "document-too-long",
  "document-too-large",
  "document-type-not-accepted",
  "no-model",
  "schema-mismatch",
  "template-error",
  "model-refused",
  "model-demo-unknown",
]);
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Whether the placeholder agent should fail this attempt on purpose (tests only). */
export function shouldForceFailure(
  allowTestFaults: boolean,
  testFailAttempts: number | undefined,
  attempt: number,
) {
  return allowTestFaults && (testFailAttempts ?? 0) >= attempt;
}

/** A failure that carries a reason code and nothing from the original error. */
function sanitised(code: string): ApplicationFailure {
  const message = `job attempt failed: ${code}`;
  return FINAL.has(code)
    ? ApplicationFailure.nonRetryable(message, code)
    : ApplicationFailure.retryable(message, code);
}

/** Runs `work`, turning any failure into a fixed code (Temporal keeps failures). */
async function guarded<T>(code: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    console.error(`${code}: ${error instanceof Error ? error.name : "unknown error"}`);
    throw sanitised(code);
  }
}

export function createActivities({
  db,
  agents,
  models,
  blobs,
  auditCopy,
  auditCopyEpoch = 1,
  allowTestFaults,
  testGateway = () => null,
  temporal,
}: ActivityDeps) {
  return {
    /** One attempt at one run of the job's agent. Throws to make Temporal retry. */
    async runJob(input: ProcessDocumentInput, run = 1, sentBackBy?: string): Promise<void> {
      const context = Context.current();
      const { attempt } = context.info;
      let code = "error";
      // Reports in while it works, so a worker that dies mid-job is noticed within the
      // workflow's heartbeat timeout, not only at the end of the attempt's 10 minutes.
      const stopHeartbeat = startHeartbeat(() => context.heartbeat());
      try {
        await startAttempt(db, input.tenantId, input.jobId, attempt, run);
        // Run only the agent version the job recorded, so the record is what ran.
        const job = await getJob(db, input.tenantId, input.jobId);
        if (!job) throw new Error("job not found");
        const loaded = agents.get(job.agentName)?.version;
        if (loaded !== job.agentVersion) {
          code = AGENT_VERSION_CHANGED;
          // Expected after a deploy that changes an agent: say which, and what to do.
          console.warn(
            `job ${input.jobId} refused: ${code} (agent ${job.agentName}, recorded ${job.agentVersion}, loaded ${loaded ?? "none"}); upload the document again`,
          );
          throw new Error(code);
        }
        if (run === 1 && shouldForceFailure(allowTestFaults, input.testFailAttempts, attempt)) {
          code = TEST_FAULT;
          throw new Error(TEST_FAULT);
        }
        const agent = agents.get(job.agentName);
        const document = await jobDocument(db, input.tenantId, input.jobId);
        if (!agent || !document) {
          code = "document-not-found";
          throw new Error(code);
        }
        const kind = documentKind(document.contentType);
        if (!kind) {
          code = "document-type-not-accepted";
          throw new Error(code);
        }
        // Names only from server-side IDs, through the storage module (CLAUDE.md).
        const container = await tenantContainer(blobs, input.tenantId);
        const bytes = await container
          .getBlockBlobClient(documentBlobName(document.documentId))
          .downloadToBuffer()
          .catch((error: unknown) => {
            // A missing file stays missing; other storage failures are retried.
            if ((error as { statusCode?: number }).statusCode === 404) code = "document-not-found";
            throw error;
          });
        const result = await runAgent({
          agent,
          document: { bytes, kind },
          gateway: models,
          tenantId: input.tenantId,
          jobId: input.jobId,
          // After a send-back, the reviewer's reason (task 11), from the decision acted on.
          reviewerNote: await sendBackNote(db, input.tenantId, input.jobId, sentBackBy),
        });
        // A later attempt has taken over (this one outlived its timeout): it writes the
        // files, not this one (review Q5). Checked again when the fields are saved.
        if (!(await attemptIsLive(db, input.tenantId, input.jobId, run, attempt))) {
          code = ATTEMPT_SUPERSEDED;
          throw new Error(ATTEMPT_SUPERSEDED);
        }
        // The text the agent read, for the review screen to show beside the fields.
        if (result.text !== null) {
          await container
            .getBlockBlobClient(textBlobName(input.jobId))
            .uploadData(Buffer.from(result.text.replaceAll("\0", ""), "utf8"), {
              blobHTTPHeaders: { blobContentType: "text/plain; charset=utf-8" },
            });
        }
        if (result.report) {
          await container
            .getBlockBlobClient(reportBlobName(input.jobId))
            .uploadData(result.report, {
              blobHTTPHeaders: { blobContentType: DOCX, blobContentDisposition: "attachment" },
            });
        }
        const saved = await saveJobOutput(db, input.tenantId, input.jobId, {
          // Postgres cannot store NUL in jsonb text, and a model could give one.
          // No character Postgres or a Word report cannot hold (NUL, a page's form feed).
          fields: result.fields && cleanFields(result.fields),
          hasReport: result.report !== null,
          run,
          attempt,
        });
        // A later attempt has taken over (this one outlived its timeout): its result
        // stands, not this one's (review Q5).
        if (!saved) {
          code = ATTEMPT_SUPERSEDED;
          throw new Error(ATTEMPT_SUPERSEDED);
        }
        await finishAttempt(db, input.tenantId, input.jobId, attempt, "succeeded", null, run);
      } catch (error) {
        // Blocks and the gateway fail with a fixed code; keep it. Anything else (storage,
        // the database) is "error" and is retried.
        if (error instanceof BlockError || error instanceof ModelError) code = error.code;
        if (code === "error")
          console.error(
            `job ${input.jobId} attempt ${attempt} failed: ${error instanceof Error ? error.name : "unknown error"}`,
          );
        else if (
          code !== TEST_FAULT &&
          code !== AGENT_VERSION_CHANGED &&
          code !== ATTEMPT_SUPERSEDED
        )
          console.warn(`job ${input.jobId} attempt ${attempt} failed: ${code}`);
        await finishAttempt(db, input.tenantId, input.jobId, attempt, "failed", code, run).catch(
          () => {},
        );
        throw sanitised(code);
      } finally {
        stopHeartbeat();
      }
    },

    /** A run finished: the job waits for a reviewer (task 11). */
    async awaitReview(input: ProcessDocumentInput, run: number): Promise<void> {
      await guarded("review-failed", () => beginReview(db, input.tenantId, input.jobId, run));
    },

    /** A reviewer sent the draft back: the next run starts. */
    async startNextRun(input: ProcessDocumentInput, run: number): Promise<void> {
      await guarded("review-failed", () => startRun(db, input.tenantId, input.jobId, run));
    },

    /**
     * What a reviewer decided, from the event the review screen recorded. Only an event
     * for this job and this run counts: anything else is refused, never acted on.
     */
    async readDecision(
      input: ProcessDocumentInput,
      eventId: string,
      run: number,
    ): Promise<"approve" | "send_back"> {
      const event = await guarded("review-failed", () => getDecision(db, input.tenantId, eventId));
      if (
        !event ||
        event.jobId !== input.jobId ||
        event.run !== run ||
        (event.kind !== "approve" && event.kind !== "send_back")
      ) {
        throw ApplicationFailure.nonRetryable("not a decision on this draft", "bad-decision");
      }
      return event.kind;
    },

    /**
     * Approval: the report is written again from the reviewed fields, so the download
     * matches what was approved, and the job is done.
     */
    async approve(input: ProcessDocumentInput, eventId: string): Promise<void> {
      let code = "approve-failed";
      try {
        const job = await getJob(db, input.tenantId, input.jobId);
        const output = await getJobOutput(db, input.tenantId, input.jobId);
        const event = await getDecision(db, input.tenantId, eventId);
        if (!job || !output) throw new Error("job not found");
        // Act on exactly the draft the reviewer approved. (A decision locks the draft, so
        // this holds; it is checked again rather than assumed.)
        if (
          event?.jobId !== input.jobId ||
          event.kind !== "approve" ||
          event.revision !== output.revision
        ) {
          code = "bad-decision";
          throw new Error(code);
        }
        const agent = agents.get(job.agentName);
        const edited = JSON.stringify(output.reviewedFields) !== JSON.stringify(output.fields);
        if (output.hasReport && output.reviewedFields && edited) {
          if (agent?.version !== job.agentVersion) {
            // The agent changed since this job ran, so its template cannot be used again:
            // the job is approved, but the draft's report is withdrawn rather than offered
            // with values that differ from what was approved.
            console.warn(`job ${input.jobId} approved without a report: ${AGENT_VERSION_CHANGED}`);
            await withdrawReport(db, input.tenantId, input.jobId);
            await approveJob(db, input.tenantId, input.jobId);
            return;
          }
          const report = reportFromFields(agent, output.reviewedFields);
          if (report) {
            const container = await tenantContainer(blobs, input.tenantId);
            await container.getBlockBlobClient(reportBlobName(input.jobId)).uploadData(report, {
              blobHTTPHeaders: { blobContentType: DOCX, blobContentDisposition: "attachment" },
            });
          }
        }
        await approveJob(db, input.tenantId, input.jobId);
      } catch (error) {
        if (error instanceof BlockError) code = error.code;
        console.error(
          `job ${input.jobId} approval failed: ${code} (${error instanceof Error ? error.name : "unknown error"})`,
        );
        // A fault in the report or the decision will not mend by retrying: the job fails
        // with its code. Anything else (storage, the database) is retried until it works.
        if (error instanceof BlockError || code === "bad-decision") {
          throw ApplicationFailure.nonRetryable(`approval failed: ${code}`, code);
        }
        throw ApplicationFailure.retryable(`approval failed: ${code}`, code);
      }
    },

    /** Copies new audit events to write-once storage (task 14). */
    async copyAuditLog(): Promise<void> {
      if (!auditCopy) return;
      // Per-tenant failures are logged (audit.copy-failed) inside; only a failure to list
      // the tenants reaches here, and the next scheduled run tries again.
      try {
        await copyAuditLog(db, auditCopy, {
          epoch: auditCopyEpoch,
          onProgress: () => Context.current().heartbeat(),
        });
      } catch (error) {
        logEvent(
          "audit.copy-failed",
          { error: error instanceof Error ? error.name : "unknown" },
          "error",
        );
        // A fixed message only: Temporal keeps failures in its history.
        throw ApplicationFailure.nonRetryable("audit copy failed", "audit-copy-failed");
      }
    },

    /** Starts stuck jobs and sends undelivered decisions again (review Q1, Q7). */
    async sweepJobs(): Promise<void> {
      if (!temporal) return;
      // Per-job failures are logged (job.stuck, job.decision-undelivered) inside; only a
      // failure to list the tenants reaches here, and the next scheduled run tries again.
      try {
        const context = Context.current();
        await sweepJobs({
          db,
          client: temporal.client,
          taskQueue: temporal.taskQueue,
          onProgress: () => context.heartbeat(),
          signal: context.cancellationSignal,
        });
      } catch (error) {
        logEvent("job.stuck", { reason: error instanceof Error ? error.name : "unknown" }, "error");
        throw ApplicationFailure.nonRetryable("job sweep failed", "job-sweep-failed");
      }
    },

    /** Runs an agent version's test set and records the result (task 16). */
    async testAgentVersion(input: AgentTestInput): Promise<"recorded" | "already-recorded"> {
      const context = Context.current();
      // What an earlier attempt finished, so this one carries on from there.
      const resumeFrom = context.info.heartbeatDetails as AgentTestProgress | undefined;
      return testAgentVersion(
        { db, agents, testGateway, heartbeat: (p) => context.heartbeat(p), resumeFrom },
        input,
      );
    },

    /** The job's final status, once the work has succeeded or the retries have run out. */
    async finishJob(
      input: ProcessDocumentInput,
      outcome: "succeeded" | "failed",
      reason?: "approve-failed" | "cancelled",
    ): Promise<void> {
      let changed: boolean;
      try {
        changed = await finishJob(db, input.tenantId, input.jobId, outcome);
      } catch (error) {
        console.error(
          `finishing job failed: ${error instanceof Error ? error.name : "unknown error"}`,
        );
        throw sanitised("finish-failed");
      }
      // Once per job: a retried activity finds the job already finished. A failed job is
      // what the "job failed" alert watches for (infra/azure/monitoring.bicep).
      if (changed) {
        const job = await getJob(db, input.tenantId, input.jobId).catch(() => null);
        const last = job?.attempts.at(-1);
        logEvent(
          outcome === "failed" ? "job.failed" : "job.succeeded",
          {
            tenantId: input.tenantId,
            jobId: input.jobId,
            agent: job?.agentName ?? null,
            agentVersion: job?.agentVersion ?? null,
            attempts: job?.attempts.length ?? null,
            // Why it failed: given by the workflow when the last attempt itself succeeded
            // (an approval that could not be carried out, a cancellation).
            reason:
              outcome === "failed"
                ? (reason ?? (last?.outcome === "failed" ? last.errorCode : null) ?? "unknown")
                : null,
          },
          outcome === "failed" ? "error" : "info",
        );
      }
    },
  };
}

export type Activities = ReturnType<typeof createActivities>;
