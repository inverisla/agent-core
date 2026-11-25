// Usage per tenant (task 13): documents, jobs, model calls, tokens and estimated cost in
// a time range, read inside the tenant's own context from the tables that record them.
import { and, gte, lt, sql } from "drizzle-orm";
import { documents, jobs, modelCalls } from "./schema.ts";
import type { TenantDatabase } from "./tenant-context.ts";

export interface TenantUsage {
  documents: number;
  jobs: number;
  /** Approved by a reviewer (or succeeded, for jobs from before review). */
  jobsApproved: number;
  jobsAwaitingReview: number;
  jobsFailed: number;
  /** Uploaded, queued or running. */
  jobsInProgress: number;
  modelCalls: number;
  modelCallsFailed: number;
  inputTokens: number;
  outputTokens: number;
  /** Estimated from the price list at the time of each call, in US dollars, as a decimal string. */
  costUsd: string;
}

/** A calendar month in UTC, from "YYYY-MM": [from, to). Null if not a real month. */
export function monthRange(month: string): { from: Date; to: Date } | null {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!m) return null;
  const year = Number(m[1]);
  const index = Number(m[2]) - 1;
  return { from: new Date(Date.UTC(year, index, 1)), to: new Date(Date.UTC(year, index + 1, 1)) };
}

/** Jobs and documents count by when they were created; model calls by when they were made. */
export async function tenantUsage(
  db: TenantDatabase,
  tenantId: string,
  range: { from: Date; to: Date },
): Promise<TenantUsage> {
  return db.withTenant(tenantId, async (tx) => {
    const [docs] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(documents)
      .where(and(gte(documents.createdAt, range.from), lt(documents.createdAt, range.to)));
    const [job] = await tx
      .select({
        total: sql<number>`count(*)::int`,
        approved: sql<number>`count(*) filter (where ${jobs.status} in ('approved', 'succeeded'))::int`,
        awaiting: sql<number>`count(*) filter (where ${jobs.status} = 'awaiting_review')::int`,
        failed: sql<number>`count(*) filter (where ${jobs.status} = 'failed')::int`,
        inProgress: sql<number>`count(*) filter (where ${jobs.status} in ('uploaded', 'queued', 'running'))::int`,
      })
      .from(jobs)
      .where(and(gte(jobs.createdAt, range.from), lt(jobs.createdAt, range.to)));
    const [calls] = await tx
      .select({
        total: sql<number>`count(*)::int`,
        failed: sql<number>`count(*) filter (where ${modelCalls.outcome} = 'failed')::int`,
        input: sql<string>`coalesce(sum(${modelCalls.inputTokens}), 0)::text`,
        output: sql<string>`coalesce(sum(${modelCalls.outputTokens}), 0)::text`,
        cost: sql<string>`coalesce(sum(${modelCalls.costUsd}), 0)::numeric(18, 4)::text`,
      })
      .from(modelCalls)
      .where(and(gte(modelCalls.createdAt, range.from), lt(modelCalls.createdAt, range.to)));
    return {
      documents: docs?.n ?? 0,
      jobs: job?.total ?? 0,
      jobsApproved: job?.approved ?? 0,
      jobsAwaitingReview: job?.awaiting ?? 0,
      jobsFailed: job?.failed ?? 0,
      jobsInProgress: job?.inProgress ?? 0,
      modelCalls: calls?.total ?? 0,
      modelCallsFailed: calls?.failed ?? 0,
      inputTokens: Number(calls?.input ?? 0),
      outputTokens: Number(calls?.output ?? 0),
      costUsd: calls?.cost ?? "0.0000",
    };
  });
}
