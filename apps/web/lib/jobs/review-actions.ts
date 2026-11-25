"use server";
// The review screen's actions (task 11): save edits, approve, send back. Each checks the
// tenant user, the job's state and the draft's revision in the database, records an
// event, and for a decision tells the job's workflow (IDs only) to act on it.
import { agentRegistry, checkFields, fieldsSchema } from "@agent-core/core/agents";
import { DECIDE_UPDATE, workflowIdForJob } from "@agent-core/core";
import {
  getJob,
  getJobOutput,
  MAX_NOTE_CHARS,
  recordDecision,
  reviewHistory,
  saveReview,
} from "@agent-core/db";
import { redirect } from "next/navigation";
import { checkTenant } from "../auth/guards.ts";
import { db } from "../server/db.ts";
import { cleanFields } from "@agent-core/blocks";
import { fieldEdits } from "./review-edits.ts";
import { temporalClient } from "./start.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The edited fields, as JSON: far more than any summary needs. */
const MAX_FIELDS_BYTES = 256 * 1024;
/** How long a decision waits for the workflow to accept it. */
const DELIVER_DEADLINE_MS = 10_000;

type Outcome =
  | "saved"
  | "approved"
  | "sent-back"
  | "stale"
  | "invalid"
  | "not-awaiting-review"
  | "note"
  | "agent-changed"
  | "decided"
  | "not-delivered";

const back = (slug: string, jobId: string, outcome: Outcome): never =>
  redirect(`/t/${encodeURIComponent(slug)}/jobs/${jobId}?review=${outcome}`);

/** The signed-in tenant user and the job, or a redirect. Any user of the tenant may review. */
async function reviewContext(slug: string, jobId: string) {
  const access = await checkTenant(slug);
  if (!access.ok) redirect(`/t/${encodeURIComponent(slug)}/sign-in`);
  if (!UUID.test(jobId)) redirect(`/t/${encodeURIComponent(slug)}/documents`);
  const { tenantId, userId } = access.value;
  const job = await getJob(db(), tenantId, jobId);
  const output = job ? await getJobOutput(db(), tenantId, jobId) : null;
  if (!job || !output) redirect(`/t/${encodeURIComponent(slug)}/documents`);
  if (job.status !== "awaiting_review") back(slug, jobId, "not-awaiting-review");
  return { tenantId, userId, job, output };
}

/**
 * Saves the form's fields if they changed, after checking them against the agent's
 * schema. Returns the draft's revision afterwards.
 */
async function saveEdits(
  slug: string,
  jobId: string,
  ctx: Awaited<ReturnType<typeof reviewContext>>,
  formData: FormData,
): Promise<number> {
  const revision = Number(formData.get("revision"));
  if (!Number.isInteger(revision)) back(slug, jobId, "invalid");
  const raw = formData.get("fields");
  if (typeof raw !== "string") return revision;
  if (Buffer.byteLength(raw) > MAX_FIELDS_BYTES) back(slug, jobId, "invalid");
  let fields: unknown;
  try {
    fields = JSON.parse(raw);
  } catch {
    back(slug, jobId, "invalid");
  }
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) back(slug, jobId, "invalid");
  // No character Postgres or a Word report cannot hold (NUL, a form feed); nobody means
  // to type one.
  fields = cleanFields(fields);
  const edits = fieldEdits(ctx.output.reviewedFields ?? {}, fields as Record<string, unknown>);
  if (edits.length === 0) return revision;
  // Only the agent version the job ran can say what its fields must look like.
  const agent = (await agentRegistry(process.env)).get(ctx.job.agentName);
  const schema = agent?.version === ctx.job.agentVersion ? fieldsSchema(agent) : null;
  if (!schema) back(slug, jobId, "agent-changed");
  if (checkFields(schema as Record<string, unknown>, fields).length > 0)
    back(slug, jobId, "invalid");
  const saved = await saveReview(db(), ctx.tenantId, jobId, {
    userId: ctx.userId,
    revision,
    fields: fields as Record<string, unknown>,
    edits,
  });
  if (!saved.ok) back(slug, jobId, saved.reason);
  return (saved as { revision: number }).revision;
}

/** Tells the job's workflow about a recorded decision: its event ID and run only. */
async function deliver(jobId: string, eventId: string, run: number): Promise<boolean> {
  try {
    const client = await temporalClient();
    await client.withDeadline(Date.now() + DELIVER_DEADLINE_MS, () =>
      client.workflow.getHandle(workflowIdForJob(jobId)).executeUpdate(DECIDE_UPDATE, {
        args: [{ eventId, run }],
        // The same decision sent twice is one decision.
        updateId: eventId,
      }),
    );
    return true;
  } catch (error) {
    console.error(
      `review decision not delivered for job ${jobId}: ${error instanceof Error ? error.name : "unknown"}`,
    );
    return false;
  }
}

export async function saveReviewAction(slug: string, jobId: string, formData: FormData) {
  const ctx = await reviewContext(slug, jobId);
  await saveEdits(slug, jobId, ctx, formData);
  back(slug, jobId, "saved");
}

/** Saves any edits on the form, then approves the draft as it now stands. */
export async function approveAction(slug: string, jobId: string, formData: FormData) {
  const ctx = await reviewContext(slug, jobId);
  const revision = await saveEdits(slug, jobId, ctx, formData);
  const decision = await recordDecision(db(), ctx.tenantId, jobId, {
    userId: ctx.userId,
    revision,
    kind: "approve",
  });
  if (!decision.ok) back(slug, jobId, decision.reason);
  const { eventId, run } = decision as { eventId: string; run: number };
  back(slug, jobId, (await deliver(jobId, eventId, run)) ? "approved" : "not-delivered");
}

/** Sends the draft back with the reviewer's reason, which starts another run. */
export async function sendBackAction(slug: string, jobId: string, formData: FormData) {
  const ctx = await reviewContext(slug, jobId);
  const note = String(formData.get("note") ?? "")
    .replaceAll("\0", "")
    .trim();
  if (!note || note.length > MAX_NOTE_CHARS) back(slug, jobId, "note");
  const revision = Number(formData.get("revision"));
  if (!Number.isInteger(revision)) back(slug, jobId, "invalid");
  const decision = await recordDecision(db(), ctx.tenantId, jobId, {
    userId: ctx.userId,
    revision,
    kind: "send_back",
    note,
  });
  if (!decision.ok) back(slug, jobId, decision.reason);
  const { eventId, run } = decision as { eventId: string; run: number };
  back(slug, jobId, (await deliver(jobId, eventId, run)) ? "sent-back" : "not-delivered");
}

/** Sends the latest recorded decision again, if the workflow has not acted on it. */
export async function resendDecisionAction(slug: string, jobId: string) {
  const ctx = await reviewContext(slug, jobId);
  const pending = (await reviewHistory(db(), ctx.tenantId, jobId))
    .filter((e) => e.run === ctx.job.run)
    .findLast((e) => e.kind === "approve" || e.kind === "send_back");
  if (!pending) back(slug, jobId, "not-awaiting-review");
  const event = pending as { eventId: string; kind: string };
  const delivered = await deliver(jobId, event.eventId, ctx.job.run);
  back(
    slug,
    jobId,
    !delivered ? "not-delivered" : event.kind === "approve" ? "approved" : "sent-back",
  );
}
