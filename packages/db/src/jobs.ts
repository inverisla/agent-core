// Jobs and their attempts, always inside the job's tenant context.
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { jobAttempts, jobs, reviewEvents } from "./schema.ts";
import type { TenantDatabase } from "./tenant-context.ts";

export type JobStatus =
  "uploaded" | "queued" | "running" | "succeeded" | "failed" | "awaiting_review" | "approved";
export type AttemptOutcome = "running" | "succeeded" | "failed";

export interface JobAttempt {
  /** Which run of the agent (each send-back starts another). */
  run: number;
  attempt: number;
  outcome: AttemptOutcome;
  errorCode: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

export interface JobDetail {
  jobId: string;
  documentId: string;
  agentName: string;
  agentVersion: string;
  status: JobStatus;
  /** The current run. */
  run: number;
  createdAt: Date;
  updatedAt: Date;
  attempts: JobAttempt[];
}

/** A new job for a document, recording the agent and version it will run. */
export async function createJob(
  db: TenantDatabase,
  tenantId: string,
  input: { documentId: string; agentName: string; agentVersion: string },
): Promise<string> {
  return db.withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .insert(jobs)
      .values({ tenantId, ...input, status: "uploaded" })
      .returning({ jobId: jobs.jobId });
    if (!row) throw new Error("The job was not created.");
    return row.jobId;
  });
}

/**
 * A job's final status. Attempts still shown as running are closed as failed with
 * "abandoned", so a finished job never shows an attempt as still running.
 */
export async function finishJob(
  db: TenantDatabase,
  tenantId: string,
  jobId: string,
  status: "succeeded" | "failed",
): Promise<boolean> {
  return db.withTenant(tenantId, async (tx) => {
    await tx
      .update(jobAttempts)
      .set({ outcome: "failed", errorCode: "abandoned", finishedAt: sql`now()` })
      .where(and(eq(jobAttempts.jobId, jobId), eq(jobAttempts.outcome, "running")));
    const updated = await tx
      .update(jobs)
      .set({ status, updatedAt: sql`now()` })
      .where(
        and(
          eq(jobs.jobId, jobId),
          // A job waiting for review can still fail (its workflow cancelled, or an approval
          // that cannot be carried out); it cannot succeed from there.
          status === "failed"
            ? sql`${jobs.status} in ('uploaded', 'queued', 'running', 'awaiting_review')`
            : sql`${jobs.status} in ('uploaded', 'queued', 'running')`,
        ),
      )
      .returning({ jobId: jobs.jobId });
    return updated.length > 0;
  });
}

/** Moves a job to a status; with `from`, only if it is currently in one of those. */
export async function setJobStatus(
  db: TenantDatabase,
  tenantId: string,
  jobId: string,
  status: JobStatus,
  from?: JobStatus[],
): Promise<boolean> {
  return db.withTenant(tenantId, async (tx) => {
    const updated = await tx
      .update(jobs)
      .set({ status, updatedAt: sql`now()` })
      .where(
        and(
          eq(jobs.jobId, jobId),
          from
            ? sql`${jobs.status} in (${sql.join(
                from.map((s) => sql`${s}`),
                sql`, `,
              )})`
            : undefined,
        ),
      )
      .returning({ jobId: jobs.jobId });
    return updated.length > 0;
  });
}

/** Records the start of an attempt and marks the job running. Safe to repeat. */
export async function startAttempt(
  db: TenantDatabase,
  tenantId: string,
  jobId: string,
  attempt: number,
  run = 1,
) {
  await db.withTenant(tenantId, async (tx) => {
    // Earlier attempts still shown as running were cut short (a crash, a timeout, or a
    // failure while recording their result): close them as failed, "timed-out".
    await tx
      .update(jobAttempts)
      .set({ outcome: "failed", errorCode: "timed-out", finishedAt: sql`now()` })
      .where(
        and(
          eq(jobAttempts.jobId, jobId),
          sql`(${jobAttempts.run}, ${jobAttempts.attempt}) < (${run}, ${attempt})`,
          eq(jobAttempts.outcome, "running"),
        ),
      );
    await tx.insert(jobAttempts).values({ tenantId, jobId, run, attempt }).onConflictDoNothing();
    await tx
      .update(jobs)
      .set({ status: "running", updatedAt: sql`now()` })
      .where(and(eq(jobs.jobId, jobId), sql`${jobs.status} in ('uploaded', 'queued', 'running')`));
  });
}

export async function finishAttempt(
  db: TenantDatabase,
  tenantId: string,
  jobId: string,
  attempt: number,
  outcome: "succeeded" | "failed",
  errorCode: string | null = null,
  run = 1,
) {
  // Only an attempt still running: a late attempt cannot rewrite one already closed.
  await db.withTenant(tenantId, (tx) =>
    tx
      .update(jobAttempts)
      .set({ outcome, errorCode, finishedAt: sql`now()` })
      .where(
        and(
          eq(jobAttempts.jobId, jobId),
          eq(jobAttempts.run, run),
          eq(jobAttempts.attempt, attempt),
          eq(jobAttempts.outcome, "running"),
        ),
      ),
  );
}

export async function getJob(
  db: TenantDatabase,
  tenantId: string,
  jobId: string,
): Promise<JobDetail | null> {
  return db.withTenant(tenantId, async (tx) => {
    const [job] = await tx.select().from(jobs).where(eq(jobs.jobId, jobId));
    if (!job) return null;
    const attempts = await tx
      .select({
        run: jobAttempts.run,
        attempt: jobAttempts.attempt,
        outcome: jobAttempts.outcome,
        errorCode: jobAttempts.errorCode,
        startedAt: jobAttempts.startedAt,
        finishedAt: jobAttempts.finishedAt,
      })
      .from(jobAttempts)
      .where(eq(jobAttempts.jobId, jobId))
      .orderBy(jobAttempts.run, jobAttempts.attempt);
    return {
      jobId: job.jobId,
      documentId: job.documentId,
      agentName: job.agentName,
      agentVersion: job.agentVersion,
      status: job.status,
      run: job.run,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      attempts,
    };
  });
}

export interface LatestJob {
  jobId: string;
  status: JobStatus;
  attempts: number;
  /** The reason code of its last attempt, if that failed. */
  errorCode: string | null;
}

/** The newest job for each of the tenant's documents, with its number of attempts. */
export async function latestJobsByDocument(
  db: TenantDatabase,
  tenantId: string,
  documentIds: string[],
): Promise<Map<string, LatestJob>> {
  if (documentIds.length === 0) return new Map();
  const rows = await db.withTenant(tenantId, (tx) =>
    // A join rather than a correlated subquery: in a select field of a query with no join,
    // Drizzle writes a column inside sql`` without its table name, so inside a subquery on
    // job_attempts "job_id" meant job_attempts.job_id and the count covered the tenant.
    tx
      .select({
        documentId: jobs.documentId,
        jobId: jobs.jobId,
        status: jobs.status,
        attempts: sql<number>`count(${jobAttempts.attempt})::int`,
        errorCode: sql<
          string | null
        >`(array_agg(${jobAttempts.errorCode} order by ${jobAttempts.attempt} desc))[1]`,
      })
      .from(jobs)
      // The job's current run only (review Q3): after a send-back, the attempts and the
      // reason are the new run's, not an earlier run's.
      .leftJoin(
        jobAttempts,
        and(
          eq(jobAttempts.tenantId, jobs.tenantId),
          eq(jobAttempts.jobId, jobs.jobId),
          eq(jobAttempts.run, jobs.run),
        ),
      )
      .where(inArray(jobs.documentId, documentIds))
      .groupBy(jobs.tenantId, jobs.jobId)
      .orderBy(desc(jobs.createdAt)),
  );
  const latest = new Map<string, LatestJob>();
  for (const r of rows) {
    if (!latest.has(r.documentId))
      latest.set(r.documentId, {
        jobId: r.jobId,
        status: r.status,
        attempts: r.attempts,
        errorCode: r.errorCode,
      });
  }
  return latest;
}

/** A job as the operator console's job list shows it: status and codes, no content. */
export interface JobListing {
  jobId: string;
  agentName: string;
  agentVersion: string;
  status: JobStatus;
  run: number;
  attempts: number;
  /** The reason code of its last attempt, if that failed. */
  errorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The tenant's most recently changed jobs, newest first; only failed ones if asked. */
export async function recentJobs(
  db: TenantDatabase,
  tenantId: string,
  options: { failedOnly?: boolean; limit: number },
): Promise<JobListing[]> {
  return db.withTenant(tenantId, async (tx) => {
    // The newest jobs first (jobs_tenant_id_updated_at_idx), then only their attempts.
    const latest = await tx
      .select({
        jobId: jobs.jobId,
        agentName: jobs.agentName,
        agentVersion: jobs.agentVersion,
        status: jobs.status,
        run: jobs.run,
        createdAt: jobs.createdAt,
        updatedAt: jobs.updatedAt,
      })
      .from(jobs)
      .where(options.failedOnly ? eq(jobs.status, "failed") : undefined)
      .orderBy(desc(jobs.updatedAt))
      .limit(options.limit);
    if (latest.length === 0) return [];
    const attempts = await tx
      .select({
        jobId: jobAttempts.jobId,
        run: jobAttempts.run,
        attempt: jobAttempts.attempt,
        errorCode: jobAttempts.errorCode,
      })
      .from(jobAttempts)
      .where(
        inArray(
          jobAttempts.jobId,
          latest.map((j) => j.jobId),
        ),
      )
      .orderBy(jobAttempts.run, jobAttempts.attempt);
    return latest.map((j) => {
      const mine = attempts.filter((a) => a.jobId === j.jobId);
      return { ...j, attempts: mine.length, errorCode: mine.at(-1)?.errorCode ?? null };
    });
  });
}

/** How many of the tenant's jobs each agent version ran since `since`. */
export async function jobCountsByAgentVersion(
  db: TenantDatabase,
  tenantId: string,
  since: Date,
): Promise<{ agentName: string; agentVersion: string; jobs: number }[]> {
  return db.withTenant(tenantId, (tx) =>
    tx
      .select({
        agentName: jobs.agentName,
        agentVersion: jobs.agentVersion,
        jobs: sql<number>`count(*)::int`,
      })
      .from(jobs)
      .where(gte(jobs.createdAt, since))
      .groupBy(jobs.agentName, jobs.agentVersion),
  );
}

/**
 * Jobs still "uploaded" that were created before `before`: their workflow never started
 * (Temporal did not answer the upload in time). The job sweep starts them (review Q1).
 */
export async function stuckUploads(
  db: TenantDatabase,
  tenantId: string,
  before: Date,
  limit = 100,
): Promise<string[]> {
  const rows = await db.withTenant(tenantId, (tx) =>
    tx
      .select({ jobId: jobs.jobId })
      .from(jobs)
      .where(and(eq(jobs.status, "uploaded"), lt(jobs.createdAt, before)))
      .orderBy(jobs.createdAt)
      .limit(limit),
  );
  return rows.map((r) => r.jobId);
}

/**
 * Review decisions recorded before `before` that the job's workflow has not acted on:
 * the job still waits for review in that run. The job sweep sends them again (review Q7).
 */
export async function undeliveredDecisions(
  db: TenantDatabase,
  tenantId: string,
  before: Date,
  limit = 100,
): Promise<{ jobId: string; eventId: string; run: number }[]> {
  return db.withTenant(tenantId, (tx) =>
    tx
      .select({ jobId: jobs.jobId, eventId: reviewEvents.eventId, run: jobs.run })
      .from(jobs)
      .innerJoin(
        reviewEvents,
        and(
          eq(reviewEvents.tenantId, jobs.tenantId),
          eq(reviewEvents.jobId, jobs.jobId),
          eq(reviewEvents.run, jobs.run),
        ),
      )
      .where(
        and(
          eq(jobs.status, "awaiting_review"),
          sql`${reviewEvents.kind} in ('approve', 'send_back')`,
          lt(reviewEvents.createdAt, before),
        ),
      )
      .orderBy(reviewEvents.createdAt)
      .limit(limit),
  );
}
