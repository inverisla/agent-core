import { blobServiceFromEnv, reportBlobName, tenantContainerName } from "@agent-core/core/storage";
import { apiError, checkTenant } from "../../../../../../../lib/auth/guards.ts";
import { tenantJob, tenantJobOutput } from "../../../../../../../lib/jobs/view.ts";

export const dynamic = "force-dynamic";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** The job's Word report, once approved (or from before review), from the tenant's container. */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ slug: string; jobId: string }> },
): Promise<Response> {
  const { slug, jobId } = await ctx.params;
  const access = await checkTenant(slug);
  if (!access.ok) return apiError(access.status);
  // The job must be the tenant's and have a report; the blob name comes from its ID only.
  const output = await tenantJobOutput(access.value.tenantId, jobId);
  const job = await tenantJob(access.value.tenantId, jobId);
  if ((job?.status !== "approved" && job?.status !== "succeeded") || !output?.hasReport)
    return Response.json({ error: "not found" }, { status: 404 });
  // Reading only: the container exists once the tenant has uploaded anything.
  const blob = blobServiceFromEnv()
    .getContainerClient(tenantContainerName(access.value.tenantId))
    .getBlockBlobClient(reportBlobName(jobId));
  let bytes: Buffer;
  try {
    bytes = await blob.downloadToBuffer();
  } catch (error) {
    // Gone is a 404; anything else (storage down, sign-in) is a fault, not "not found".
    if ((error as { statusCode?: number }).statusCode === 404) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    console.error(`report download failed: ${error instanceof Error ? error.name : "unknown"}`);
    return Response.json({ error: "unavailable" }, { status: 503 });
  }
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": DOCX,
      "content-disposition": `attachment; filename="report-${jobId}.docx"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
