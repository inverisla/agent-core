// Model calls (task 8): one row per call, with tokens and estimated cost, recorded inside
// the tenant's context like everything else. Totals per job and per tenant are what the
// usage export (task 13) builds on.
import { and, eq, gte, sql } from "drizzle-orm";
import { modelCalls } from "./schema.ts";
import type { TenantDatabase } from "./tenant-context.ts";

export interface ModelCallRecord {
  jobId: string;
  step: string;
  provider: string;
  model: string;
  outcome: "succeeded" | "failed";
  errorCode?: string | null;
  inputTokens: number;
  outputTokens: number;
  /** Estimated cost in US dollars, or null if the model has no price. */
  costUsd: number | null;
  durationMs: number;
}

export async function recordModelCall(
  db: TenantDatabase,
  tenantId: string,
  call: ModelCallRecord,
): Promise<void> {
  await db.withTenant(tenantId, (tx) =>
    tx.insert(modelCalls).values({
      tenantId,
      jobId: call.jobId,
      step: call.step,
      provider: call.provider,
      model: call.model,
      outcome: call.outcome,
      errorCode: call.errorCode ?? null,
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      costUsd: call.costUsd === null ? null : call.costUsd.toFixed(8),
      durationMs: Math.round(call.durationMs),
    }),
  );
}

export interface ModelUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** The sum of the calls that have a price; see unpricedCalls. */
  costUsd: number;
  /** Successful calls whose model had no price, so their cost is not in costUsd. */
  unpricedCalls: number;
}

async function usage(
  db: TenantDatabase,
  tenantId: string,
  where: ReturnType<typeof and>,
): Promise<ModelUsage> {
  const [row] = await db.withTenant(tenantId, (tx) =>
    tx
      .select({
        calls: sql<number>`count(*)::int`,
        inputTokens: sql<number>`coalesce(sum(${modelCalls.inputTokens}), 0)::bigint`,
        outputTokens: sql<number>`coalesce(sum(${modelCalls.outputTokens}), 0)::bigint`,
        costUsd: sql<string>`coalesce(sum(${modelCalls.costUsd}), 0)`,
        unpricedCalls: sql<number>`count(*) filter (where ${modelCalls.costUsd} is null and ${modelCalls.outcome} = 'succeeded')::int`,
      })
      .from(modelCalls)
      .where(where),
  );
  return {
    calls: Number(row?.calls ?? 0),
    inputTokens: Number(row?.inputTokens ?? 0),
    outputTokens: Number(row?.outputTokens ?? 0),
    costUsd: Number(row?.costUsd ?? 0),
    unpricedCalls: Number(row?.unpricedCalls ?? 0),
  };
}

/** Totals for one job. */
export function modelUsageForJob(
  db: TenantDatabase,
  tenantId: string,
  jobId: string,
): Promise<ModelUsage> {
  return usage(db, tenantId, and(eq(modelCalls.tenantId, tenantId), eq(modelCalls.jobId, jobId)));
}

/** Totals for a tenant, optionally only since a given time. */
export function modelUsageForTenant(
  db: TenantDatabase,
  tenantId: string,
  since?: Date,
): Promise<ModelUsage> {
  return usage(
    db,
    tenantId,
    and(eq(modelCalls.tenantId, tenantId), since ? gte(modelCalls.createdAt, since) : undefined),
  );
}
