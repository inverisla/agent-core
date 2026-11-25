import { apiError, checkOperator } from "../../../../../../lib/auth/guards.ts";
import { auditCsv } from "../../../../../../lib/audit/describe.ts";
import { csvStreamResponse } from "../../../../../../lib/export/csv.ts";
import { tenantDetail } from "../../../../../../lib/operator/tenants.ts";
import { db } from "../../../../../../lib/server/db.ts";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ tenantId: string }> };

/** A tenant's whole audit log as CSV. Operators only. */
export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
  const access = await checkOperator();
  if (!access.ok) return apiError(access.status);
  const { tenantId } = await ctx.params;
  const tenant = await tenantDetail(tenantId);
  if (!tenant) return Response.json({ error: "not found" }, { status: 404 });
  return csvStreamResponse(
    `activity-${tenant.slug}.csv`,
    auditCsv(db(), tenant.tenantId, "operator"),
  );
}
