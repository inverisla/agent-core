// Usage per tenant for the operator console (task 13): one row per tenant for a month,
// each read inside that tenant's own context. Only for a signed-in operator: callers
// check first.
import { monthRange, schema, tenantUsage, type TenantUsage } from "@agent-core/db";
import { eq } from "drizzle-orm";
import { toCsv } from "../export/csv.ts";
import { db } from "../server/db.ts";

export interface TenantUsageRow extends TenantUsage {
  tenantId: string;
  slug: string;
  name: string;
}

/** This month (UTC), as "YYYY-MM". */
export function currentMonth(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

/** Every tenant's usage in `month` ("YYYY-MM"), by slug; null if the month is not valid. */
export async function usageForMonth(month: string): Promise<TenantUsageRow[] | null> {
  const range = monthRange(month);
  if (!range) return null;
  const rows: TenantUsageRow[] = [];
  // One tenant at a time: a few connections at most, however many tenants there are.
  for (const { tenantId, slug } of await db().listTenants()) {
    const [tenant] = await db().withTenant(tenantId, (tx) =>
      tx
        .select({ name: schema.tenants.name })
        .from(schema.tenants)
        .where(eq(schema.tenants.tenantId, tenantId)),
    );
    rows.push({
      tenantId,
      slug,
      name: tenant?.name ?? slug,
      ...(await tenantUsage(db(), tenantId, range)),
    });
  }
  return rows;
}

export const USAGE_COLUMNS: { key: keyof TenantUsage; label: string }[] = [
  { key: "documents", label: "Documents" },
  { key: "jobs", label: "Jobs" },
  { key: "jobsApproved", label: "Approved" },
  { key: "jobsAwaitingReview", label: "Awaiting review" },
  { key: "jobsFailed", label: "Failed" },
  { key: "jobsInProgress", label: "In progress" },
  { key: "modelCalls", label: "Model calls" },
  { key: "modelCallsFailed", label: "Failed model calls" },
  { key: "inputTokens", label: "Input tokens" },
  { key: "outputTokens", label: "Output tokens" },
  { key: "costUsd", label: "Estimated cost (USD)" },
];

export function usageCsv(month: string, rows: TenantUsageRow[]): string {
  return toCsv(
    ["Month", "Tenant", "Portal", "Tenant ID", ...USAGE_COLUMNS.map((c) => c.label)],
    rows.map((r) => [month, r.name, r.slug, r.tenantId, ...USAGE_COLUMNS.map((c) => r[c.key])]),
  );
}
