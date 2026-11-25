import { apiError, checkTenant } from "../../../../../lib/auth/guards.ts";
import { chooseUploadAgent, startDocumentJob } from "../../../../../lib/jobs/start.ts";
import {
  intakeDocument,
  maxUploadBytes,
  type IntakeRefusal,
} from "../../../../../lib/documents/intake.ts";
import { documentPage, maxUploadsPerDay, uploadsSince } from "../../../../../lib/documents/list.ts";
import { blobServiceFromEnv } from "@agent-core/core/storage";
import { logEvent } from "@agent-core/core/telemetry";
import {
  FORM_OVERHEAD_BYTES,
  readBodyWithin,
  withUploadSlot,
} from "../../../../../lib/documents/upload-body.ts";
import { db, requireEnv } from "../../../../../lib/server/db.ts";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> };

type UploadError =
  IntakeRefusal | "no-file" | "busy" | "failed" | "agent" | "no-agent" | "too-slow" | "daily-limit";

const MESSAGES: Record<UploadError, string> = {
  "no-file": "Choose a file to upload.",
  agent: "Choose one of the agents offered.",
  "no-agent": "No agent is set up for this tenant's uploads. Ask your operator.",
  busy: "Too many uploads are in progress. Try again in a moment.",
  "too-slow": "The upload took too long. Try again.",
  "daily-limit":
    "This portal has reached its uploads for today. Try again tomorrow, or ask your operator.",
  failed: "The upload failed. Try again.",
  empty: "That file is empty.",
  "too-large": "That file is too large.",
  "unsupported-type": "Only PDF and Word (.docx) files can be uploaded.",
  "protected-or-legacy":
    "Password-protected and old-format (.doc) Word files cannot be uploaded. Save it as an unprotected .docx and try again.",
};

/**
 * The tenant's documents, newest first, a page at a time: `older` is where the next page
 * starts (pass it as `?before=`), or null on the last page.
 */
export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const { slug } = await ctx.params;
  const access = await checkTenant(slug);
  if (!access.ok) return apiError(access.status);
  const before = new URL(req.url).searchParams.get("before");
  return Response.json(await documentPage(db(), access.value.tenantId, before));
}

/**
 * Upload one document (multipart form field "file"). Answers JSON to API callers, and
 * redirects back to the documents page for the portal's own form.
 */
export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const { slug } = await ctx.params;
  const fromForm = !(req.headers.get("accept") ?? "").includes("application/json");
  const reply = (
    status: number,
    body: { error?: UploadError; documentId?: string; jobId?: string },
  ) => {
    if (!fromForm) {
      return Response.json(
        body.error ? { error: body.error, message: MESSAGES[body.error] } : body,
        { status },
      );
    }
    const page = new URL(`/t/${slug}/documents`, requireEnv("AUTH_URL"));
    page.searchParams.set(body.error ? "error" : "uploaded", body.error ?? "1");
    return Response.redirect(page, 303);
  };

  // Uploads must come from this site. The session cookie is SameSite=Lax, which already
  // stops cross-site form posts; this checks the origin as well.
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(requireEnv("AUTH_URL")).origin) return apiError(403);

  const access = await checkTenant(slug);
  if (!access.ok) return apiError(access.status);

  const maxBytes = maxUploadBytes();
  const bodyLimit = maxBytes + FORM_OVERHEAD_BYTES;
  // Refuse obviously oversize requests before reading them.
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > bodyLimit) return reply(413, { error: "too-large" });
  // Each upload costs model calls: a tenant has a daily allowance (review S5).
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  if ((await uploadsSince(db(), access.value.tenantId, since)) >= maxUploadsPerDay()) {
    return reply(429, { error: "daily-limit" });
  }

  const outcome = await withUploadSlot(access.value.tenantId, async () => {
    const body = await readBodyWithin(req, bodyLimit);
    if (body === "too-large") return reply(413, { error: "too-large" });
    if (body === "too-slow") return reply(400, { error: "too-slow" });
    const form = await new Response(new Uint8Array(body), {
      headers: { "content-type": req.headers.get("content-type") ?? "" },
    })
      .formData()
      .catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) return reply(400, { error: "no-file" });
    if (file.size > maxBytes) return reply(413, { error: "too-large" });
    const requested = form?.get("agent");
    try {
      // The agent must be one this tenant may use (task 12b), checked before storing.
      const agent = await chooseUploadAgent(
        db(),
        access.value.tenantId,
        typeof requested === "string" && requested !== "" ? requested : null,
      );
      if (agent === "none") return reply(503, { error: "no-agent" });
      if (agent === "agent") return reply(400, { error: "agent" });
      const result = await intakeDocument({
        db: db(),
        blobs: blobServiceFromEnv(),
        tenantId: access.value.tenantId,
        userId: access.value.userId,
        filename: file.name,
        bytes: Buffer.from(await file.arrayBuffer()),
        maxBytes,
      });
      if (!result.ok)
        return reply(result.reason === "too-large" ? 413 : 415, { error: result.reason });
      const job = await startDocumentJob(
        db(),
        access.value.tenantId,
        result.document.documentId,
        agent,
      );
      return reply(201, {
        documentId: result.document.documentId,
        ...(job.jobId ? { jobId: job.jobId } : {}),
      });
    } catch (error) {
      // Storage or database failure: log it (the upload-failed alert watches for this),
      // answer without details.
      logEvent(
        "upload.failed",
        {
          tenantId: access.value.tenantId,
          error: error instanceof Error ? error.name : "unknown",
        },
        "error",
      );
      return reply(500, { error: "failed" });
    }
  });
  return outcome ?? reply(503, { error: "busy" });
}
