// Review (task 11): the job waits for a person after each run of its agent. Reviewers
// edit the fields, then approve or send the draft back with a reason, which starts
// another run. Every edit and decision is a row in review_events, which the app can add
// to but never change. Always inside the job's tenant context.
import { and, eq, sql } from "drizzle-orm";
import { jobOutputs, jobs, reviewEvents, users } from "./schema.ts";
import type { TenantDatabase, TenantTx } from "./tenant-context.ts";

export type ReviewEventKind = "edit" | "approve" | "send_back";

export interface FieldEdit {
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

export interface ReviewEvent {
  eventId: string;
  run: number;
  kind: ReviewEventKind;
  userId: string;
  /** The user's name, if they are still a user of the tenant. */
  userName: string | null;
  field: string | null;
  oldValue: unknown;
  newValue: unknown;
  note: string | null;
  createdAt: Date;
}

/** The longest send-back reason, in characters. */
export const MAX_NOTE_CHARS = 2000;

/** The run has finished: the job waits for review. Only from running, in that run. */
export async function beginReview(
  db: TenantDatabase,
  tenantId: string,
  jobId: string,
  run: number,
): Promise<boolean> {
  return db.withTenant(tenantId, async (tx) => {
    const updated = await tx
      .update(jobs)
      .set({ status: "awaiting_review", updatedAt: sql`now()` })
      .where(
        and(
          eq(jobs.jobId, jobId),
          eq(jobs.run, run),
          sql`${jobs.status} in ('running', 'awaiting_review')`,
        ),
      )
      .returning({ jobId: jobs.jobId });
    return updated.length > 0;
  });
}

/** A send-back starts the next run: the job is queued again. Safe to repeat. */
export async function startRun(
  db: TenantDatabase,
  tenantId: string,
  jobId: string,
  run: number,
): Promise<boolean> {
  return db.withTenant(tenantId, async (tx) => {
    const updated = await tx
      .update(jobs)
      .set({ run, status: "queued", updatedAt: sql`now()` })
      .where(
        and(
          eq(jobs.jobId, jobId),
          sql`(${jobs.run} = ${run - 1} and ${jobs.status} = 'awaiting_review')
              or (${jobs.run} = ${run} and ${jobs.status} = 'queued')`,
        ),
      )
      .returning({ jobId: jobs.jobId });
    return updated.length > 0;
  });
}

/** The draft is approved: the job is done. Safe to repeat. */
export async function approveJob(
  db: TenantDatabase,
  tenantId: string,
  jobId: string,
): Promise<boolean> {
  return db.withTenant(tenantId, async (tx) => {
    const updated = await tx
      .update(jobs)
      .set({ status: "approved", updatedAt: sql`now()` })
      .where(and(eq(jobs.jobId, jobId), sql`${jobs.status} in ('awaiting_review', 'approved')`))
      .returning({ jobId: jobs.jobId });
    return updated.length > 0;
  });
}

/** Why a save or decision was refused: a decision on this draft already exists ("decided"). */
export type ReviewRefusal = "not-awaiting-review" | "stale" | "decided";

/** Whether the job's current run already has a decision (inside a locked transaction). */
async function decided(tx: TenantTx, jobId: string, run: number): Promise<boolean> {
  const [row] = await tx
    .select({ eventId: reviewEvents.eventId })
    .from(reviewEvents)
    .where(
      and(
        eq(reviewEvents.jobId, jobId),
        eq(reviewEvents.run, run),
        sql`${reviewEvents.kind} in ('approve', 'send_back')`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Saves a reviewer's edits: the new fields, and one edit event per changed field, in one
 * transaction. Refused if the job is not waiting for review, or if someone saved (or a
 * new run replaced the draft) since `revision`.
 */
export async function saveReview(
  db: TenantDatabase,
  tenantId: string,
  jobId: string,
  input: {
    userId: string;
    revision: number;
    fields: Record<string, unknown>;
    edits: FieldEdit[];
  },
): Promise<{ ok: true; revision: number } | { ok: false; reason: ReviewRefusal }> {
  return db.withTenant(tenantId, async (tx) => {
    const [job] = await tx
      .select({ status: jobs.status, run: jobs.run })
      .from(jobs)
      .where(eq(jobs.jobId, jobId))
      .for("update");
    if (job?.status !== "awaiting_review") return { ok: false, reason: "not-awaiting-review" };
    // Once a decision is recorded, the draft it was made on is final.
    if (await decided(tx, jobId, job.run)) return { ok: false, reason: "decided" };
    const [updated] = await tx
      .update(jobOutputs)
      .set({
        reviewedFields: input.fields,
        revision: sql`${jobOutputs.revision} + 1`,
        updatedAt: sql`now()`,
      })
      .where(and(eq(jobOutputs.jobId, jobId), eq(jobOutputs.revision, input.revision)))
      .returning({ revision: jobOutputs.revision });
    if (!updated) return { ok: false, reason: "stale" };
    if (input.edits.length > 0) {
      await tx.insert(reviewEvents).values(
        input.edits.map((e) => ({
          tenantId,
          jobId,
          run: job.run,
          userId: input.userId,
          kind: "edit" as const,
          field: e.field,
          oldValue: e.oldValue ?? null,
          newValue: e.newValue ?? null,
        })),
      );
    }
    return { ok: true, revision: updated.revision };
  });
}

/**
 * Records a decision on the current draft, which the workflow then acts on (the web app
 * sends it the event's ID). Refused if the job is not waiting for review, or the draft
 * changed since `revision`.
 */
export async function recordDecision(
  db: TenantDatabase,
  tenantId: string,
  jobId: string,
  input: { userId: string; revision: number; kind: "approve" | "send_back"; note?: string },
): Promise<{ ok: true; eventId: string; run: number } | { ok: false; reason: ReviewRefusal }> {
  if (input.kind === "send_back" && !input.note?.trim())
    throw new Error("A send-back needs a reason.");
  return db.withTenant(tenantId, async (tx) => {
    const [job] = await tx
      .select({ status: jobs.status, run: jobs.run, revision: jobOutputs.revision })
      .from(jobs)
      .innerJoin(
        jobOutputs,
        and(eq(jobOutputs.tenantId, jobs.tenantId), eq(jobOutputs.jobId, jobs.jobId)),
      )
      .where(eq(jobs.jobId, jobId))
      .for("update", { of: jobs });
    if (job?.status !== "awaiting_review") return { ok: false, reason: "not-awaiting-review" };
    // One decision per draft: a second (a double click, another reviewer) is refused.
    if (await decided(tx, jobId, job.run)) return { ok: false, reason: "decided" };
    if (job.revision !== input.revision) return { ok: false, reason: "stale" };
    const [event] = await tx
      .insert(reviewEvents)
      .values({
        tenantId,
        jobId,
        run: job.run,
        userId: input.userId,
        kind: input.kind,
        note:
          input.kind === "send_back" ? (input.note ?? "").trim().slice(0, MAX_NOTE_CHARS) : null,
        revision: input.revision,
      })
      .returning({ eventId: reviewEvents.eventId });
    if (!event) throw new Error("The decision was not recorded.");
    return { ok: true, eventId: event.eventId, run: job.run };
  });
}

/** A recorded decision, for the worker to act on. */
export async function getDecision(
  db: TenantDatabase,
  tenantId: string,
  eventId: string,
): Promise<{
  jobId: string;
  run: number;
  kind: ReviewEventKind;
  revision: number | null;
  note: string | null;
} | null> {
  const [row] = await db.withTenant(tenantId, (tx) =>
    tx
      .select({
        jobId: reviewEvents.jobId,
        run: reviewEvents.run,
        kind: reviewEvents.kind,
        revision: reviewEvents.revision,
        note: reviewEvents.note,
      })
      .from(reviewEvents)
      .where(eq(reviewEvents.eventId, eventId)),
  );
  return row ?? null;
}

/**
 * The reason a draft was sent back, from the send-back event the workflow acted on, for
 * the next run's model. Null unless that event is a send-back on this job.
 */
export async function sendBackNote(
  db: TenantDatabase,
  tenantId: string,
  jobId: string,
  eventId: string | null | undefined,
): Promise<string | null> {
  if (!eventId) return null;
  const event = await getDecision(db, tenantId, eventId);
  return event?.jobId === jobId && event.kind === "send_back" ? event.note : null;
}

/** A job's review history, oldest first, with each reviewer's name. */
export async function reviewHistory(
  db: TenantDatabase,
  tenantId: string,
  jobId: string,
): Promise<ReviewEvent[]> {
  const rows = await db.withTenant(tenantId, (tx) =>
    tx
      .select({
        eventId: reviewEvents.eventId,
        run: reviewEvents.run,
        kind: reviewEvents.kind,
        userId: reviewEvents.userId,
        userName: users.displayName,
        field: reviewEvents.field,
        oldValue: reviewEvents.oldValue,
        newValue: reviewEvents.newValue,
        note: reviewEvents.note,
        createdAt: reviewEvents.createdAt,
      })
      .from(reviewEvents)
      .leftJoin(
        users,
        and(eq(users.tenantId, reviewEvents.tenantId), eq(users.userId, reviewEvents.userId)),
      )
      .where(eq(reviewEvents.jobId, jobId))
      .orderBy(reviewEvents.createdAt, reviewEvents.eventId),
  );
  return rows;
}
