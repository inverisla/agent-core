import { agentRegistry, fieldsSchema } from "@agent-core/core/agents";
import { blobServiceFromEnv, tenantContainerName, textBlobName } from "@agent-core/core/storage";
import {
  getJob,
  getJobOutput,
  reviewHistory,
  type JobDetail,
  type ReviewableOutput,
  type ReviewEvent,
} from "@agent-core/db";
import { db } from "../server/db.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A job of the tenant's, or null (also for anything that is not a job ID). */
export async function tenantJob(tenantId: string, jobId: string): Promise<JobDetail | null> {
  return UUID.test(jobId) ? getJob(db(), tenantId, jobId) : null;
}

/** What a job of the tenant's produced, or null (none yet, or not a job ID). */
export async function tenantJobOutput(
  tenantId: string,
  jobId: string,
): Promise<ReviewableOutput | null> {
  return UUID.test(jobId) ? getJobOutput(db(), tenantId, jobId) : null;
}

/** A job's review history (task 11). */
export async function tenantReviewHistory(tenantId: string, jobId: string): Promise<ReviewEvent[]> {
  return UUID.test(jobId) ? reviewHistory(db(), tenantId, jobId) : [];
}

/**
 * The fields schema of the agent version the job ran, or null if this deployment does
 * not have that version (then its fields cannot be edited, only approved or sent back).
 */
export async function jobFieldsSchema(
  agentName: string,
  agentVersion: string,
): Promise<Record<string, unknown> | null> {
  try {
    const agent = (await agentRegistry(process.env)).get(agentName);
    return agent?.version === agentVersion ? fieldsSchema(agent) : null;
  } catch {
    return null;
  }
}

/**
 * The order an agent's schema lists its fields in (Postgres stores JSON objects in its
 * own key order), or none if this deployment does not have that agent version.
 */
export async function fieldOrder(agentName: string, agentVersion: string): Promise<string[]> {
  const schema = (await jobFieldsSchema(agentName, agentVersion)) as { properties?: object } | null;
  return Object.keys(schema?.properties ?? {});
}

/** The longest source text the review screen shows, in characters. */
const MAX_TEXT_CHARS = 400_000;

/**
 * The text the agent read from the job's document (saved by the worker), from the
 * tenant's own container; null if there is none.
 */
export async function jobText(tenantId: string, jobId: string): Promise<string | null> {
  if (!UUID.test(jobId)) return null;
  try {
    const bytes = await blobServiceFromEnv()
      .getContainerClient(tenantContainerName(tenantId))
      .getBlockBlobClient(textBlobName(jobId))
      .downloadToBuffer();
    return bytes.toString("utf8").slice(0, MAX_TEXT_CHARS);
  } catch {
    return null;
  }
}
