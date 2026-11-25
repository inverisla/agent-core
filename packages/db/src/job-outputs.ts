// Job outputs (task 9): what the worker needs to run a job's agent, and where it puts
// what the agent produced. Everything inside the tenant's context, like the rest.
import { and, eq, sql } from "drizzle-orm";
import { documents, jobAttempts, jobOutputs, jobs } from "./schema.ts";
import type { TenantDatabase } from "./tenant-context.ts";

export interface JobDocument {
  documentId: string;
  contentType: string;
}

/** The document a job is for, or null if the job is not in this tenant. */
export async function jobDocument(
  db: TenantDatabase,
  tenantId: string,
  jobId: string,
): Promise<JobDocument | null> {
  const [row] = await db.withTenant(tenantId, (tx) =>
    tx
      .select({ documentId: documents.documentId, contentType: documents.contentType })
      .from(jobs)
      .innerJoin(
        documents,
        and(eq(documents.tenantId, jobs.tenantId), eq(documents.documentId, jobs.documentId)),
      )
      .where(and(eq(jobs.tenantId, tenantId), eq(jobs.jobId, jobId))),
  );
  return row ?? null;
}

export interface JobOutput {
  fields: Record<string, unknown> | null;
  hasReport: boolean;
}

export interface ReviewableOutput extends JobOutput {
  /** The fields as reviewers have left them (the draft until someone saves). */
  reviewedFields: Record<string, unknown> | null;
  /** Moves on with each save: a save must name the revision it started from. */
  revision: number;
  /** The run that produced the draft. */
  run: number;
}

/** The job is running this run, and `attempt` is the run's newest, still open. */
function liveAttempt(jobId: string, run: number, attempt: number) {
  return and(
    eq(jobs.jobId, jobId),
    eq(jobs.status, "running"),
    eq(jobs.run, run),
    sql`exists (select 1 from ${jobAttempts} a where a.job_id = ${jobs.jobId}
      and a.run = ${run} and a.attempt = ${attempt} and a.outcome = 'running')`,
    sql`not exists (select 1 from ${jobAttempts} a where a.job_id = ${jobs.jobId}
      and a.run = ${run} and a.attempt > ${attempt})`,
  );
}

/**
 * Whether an attempt is still the job's live one, so its files may be written (the
 * worker asks before writing the report and text; saveJobOutput checks again).
 */
export async function attemptIsLive(
  db: TenantDatabase,
  tenantId: string,
  jobId: string,
  run: number,
  attempt: number,
): Promise<boolean> {
  const [live] = await db.withTenant(tenantId, (tx) =>
    tx
      .select({ jobId: jobs.jobId })
      .from(jobs)
      .where(liveAttempt(jobId, run, attempt)),
  );
  return live !== undefined;
}

/**
 * Stores what a run produced, replacing what an earlier attempt or run stored. The new
 * draft is also what reviewers start from, and the revision moves on, so a save begun on
 * the old draft is refused.
 *
 * Given an attempt (the worker always gives one), it stores only if that attempt is
 * still the job's live one (review Q5): the job is running this run, and the attempt is
 * the run's newest and not yet closed. An attempt that outlived its timeout, after a later
 * one began or the draft went to review, stores nothing. Returns whether it stored.
 */
export async function saveJobOutput(
  db: TenantDatabase,
  tenantId: string,
  jobId: string,
  output: JobOutput & { run?: number; attempt?: number },
): Promise<boolean> {
  const run = output.run ?? 1;
  return db.withTenant(tenantId, async (tx) => {
    if (output.attempt !== undefined) {
      // Locks the job's row, so the check and the save are one step.
      const [live] = await tx
        .select({ jobId: jobs.jobId })
        .from(jobs)
        .where(liveAttempt(jobId, run, output.attempt))
        .for("update");
      if (!live) return false;
    }
    await tx
      .insert(jobOutputs)
      .values({
        tenantId,
        jobId,
        fields: output.fields,
        reviewedFields: output.fields,
        hasReport: output.hasReport,
        run,
      })
      .onConflictDoUpdate({
        target: [jobOutputs.tenantId, jobOutputs.jobId],
        set: {
          fields: output.fields,
          reviewedFields: output.fields,
          hasReport: output.hasReport,
          run,
          revision: sql`${jobOutputs.revision} + 1`,
          updatedAt: sql`now()`,
        },
      });
    return true;
  });
}

export async function getJobOutput(
  db: TenantDatabase,
  tenantId: string,
  jobId: string,
): Promise<ReviewableOutput | null> {
  const [row] = await db.withTenant(tenantId, (tx) =>
    tx
      .select({
        fields: jobOutputs.fields,
        reviewedFields: jobOutputs.reviewedFields,
        revision: jobOutputs.revision,
        run: jobOutputs.run,
        hasReport: jobOutputs.hasReport,
      })
      .from(jobOutputs)
      .where(and(eq(jobOutputs.tenantId, tenantId), eq(jobOutputs.jobId, jobId))),
  );
  return row
    ? {
        fields: row.fields as Record<string, unknown> | null,
        reviewedFields: row.reviewedFields as Record<string, unknown> | null,
        revision: row.revision,
        run: row.run,
        hasReport: row.hasReport,
      }
    : null;
}

/** The job's report no longer matches its fields: stop offering it. */
export async function withdrawReport(
  db: TenantDatabase,
  tenantId: string,
  jobId: string,
): Promise<void> {
  await db.withTenant(tenantId, (tx) =>
    tx
      .update(jobOutputs)
      .set({ hasReport: false, updatedAt: sql`now()` })
      .where(and(eq(jobOutputs.tenantId, tenantId), eq(jobOutputs.jobId, jobId))),
  );
}
