import { apiError, checkTenant } from "../../../../../../lib/auth/guards.ts";
import { auditCsv } from "../../../../../../lib/audit/describe.ts";
import { csvStreamResponse } from "../../../../../../lib/export/csv.ts";
import { db } from "../../../../../../lib/server/db.ts";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> };

/** The tenant's whole audit log as CSV. Tenant admins only. */
export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
  const { slug } = await ctx.params;
  const access = await checkTenant(slug, { admin: true });
  if (!access.ok) return apiError(access.status);

  // The slug is the tenant's own, checked by the guard: lowercase letters, digits, hyphens.
  return csvStreamResponse(
    `activity-${access.value.slug}.csv`,
    auditCsv(db(), access.value.tenantId, "tenant"),
  );
}
