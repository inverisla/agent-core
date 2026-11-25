// The operator console's jobs across tenants (task 16), for support: status, attempts and
// reason codes only. Never a file name, a field or any text from a document. The tenant
// list comes from the slug directory and each tenant's jobs are read inside its own
// context, as every tenant read is. Only for a signed-in operator: callers check first.
import { getJob, recentJobs, type JobAttempt, type JobListing } from "@agent-core/db";
import { db } from "../server/db.ts";
import { eachTenant } from "./each-tenant.ts";

/** At most this many jobs in the list, over every tenant. */
export const JOB_LIST_LIMIT = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TenantJob extends JobListing {
  tenantId: string;
  tenantName: string;
}

/**
 * The most recently changed jobs over every tenant, newest first, and how many tenants
 * could not be read.
 */
export async function listJobsAcrossTenants(options: {
  failedOnly: boolean;
}): Promise<{ jobs: TenantJob[]; unreadable: number }> {
  const { results, unreadable } = await eachTenant(async (t) =>
    (await recentJobs(db(), t.tenantId, { ...options, limit: JOB_LIST_LIMIT })).map((j) => ({
      ...j,
      tenantId: t.tenantId,
      tenantName: t.name,
    })),
  );
  const jobs = results
    .flat()
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    .slice(0, JOB_LIST_LIMIT);
  return { jobs, unreadable };
}

export interface FoundJob {
  tenantId: string;
  tenantName: string;
  jobId: string;
  agentName: string;
  agentVersion: string;
  status: JobListing["status"];
  run: number;
  createdAt: Date;
  updatedAt: Date;
  attempts: JobAttempt[];
}

/**
 * A job by its ID, whichever tenant it belongs to, or null (also for a malformed ID), and
 * how many tenants could not be read.
 */
export async function findJob(
  jobId: string,
): Promise<{ job: FoundJob | null; unreadable: number }> {
  if (!UUID.test(jobId)) return { job: null, unreadable: 0 };
  const { results, unreadable } = await eachTenant(async (t) => {
    const job = await getJob(db(), t.tenantId, jobId.toLowerCase());
    if (!job) return null;
    // Not the document's ID: support needs the job's state, not a way to its content.
    return {
      tenantId: t.tenantId,
      tenantName: t.name,
      jobId: job.jobId,
      agentName: job.agentName,
      agentVersion: job.agentVersion,
      status: job.status,
      run: job.run,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      attempts: job.attempts,
    };
  });
  return { job: results.find((j) => j !== null) ?? null, unreadable };
}
