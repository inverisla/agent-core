import { apiError, checkTenant } from "../../../../../../lib/auth/guards.ts";
import { tenantJob } from "../../../../../../lib/jobs/view.ts";

export const dynamic = "force-dynamic";

/** A job's status, agent version and every attempt. */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ slug: string; jobId: string }> },
): Promise<Response> {
  const { slug, jobId } = await ctx.params;
  const access = await checkTenant(slug);
  if (!access.ok) return apiError(access.status);
  const job = await tenantJob(access.value.tenantId, jobId);
  if (!job) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ job });
}
