// Tenant-scoped database access. App code queries only through withTenant().
export { createTenantDatabase, MAX_TRANSACTION_MS } from "./tenant-context.ts";
export type { TenantDatabase, TenantDatabaseOptions, TenantTx } from "./tenant-context.ts";
export { parseContextKey } from "./context-key.ts";
export { RESERVED_SLUGS, slugFromName, slugProblem } from "./tenant-slug.ts";
export * as schema from "./schema.ts";
export {
  getTenantSso,
  linkTenantSso,
  normaliseSsoLink,
  setAllowEmailLinks,
  type SsoLink,
  type TenantSsoSettings,
} from "./tenant-sso.ts";
export {
  activeUser,
  addTenantUser,
  createTenantWithAdmin,
  endUserSessions,
  listTenantUsers,
  normaliseEmail,
  removeTenantUser,
  setTenantUserRole,
  type TenantUser,
  type TenantUserRole,
  type UserChangeRefusal,
} from "./tenant-users.ts";
export { getTenantAgents, setTenantAgents } from "./tenant-agents.ts";
export {
  createJob,
  finishAttempt,
  finishJob,
  getJob,
  jobCountsByAgentVersion,
  stuckUploads,
  undeliveredDecisions,
  latestJobsByDocument,
  recentJobs,
  setJobStatus,
  startAttempt,
  type AttemptOutcome,
  type JobAttempt,
  type JobDetail,
  type JobListing,
  type JobStatus,
  type LatestJob,
} from "./jobs.ts";
export {
  modelUsageForJob,
  modelUsageForTenant,
  recordModelCall,
  type ModelCallRecord,
  type ModelUsage,
} from "./model-calls.ts";
export {
  getJobOutput,
  jobDocument,
  attemptIsLive,
  saveJobOutput,
  withdrawReport,
  type JobDocument,
  type JobOutput,
  type ReviewableOutput,
} from "./job-outputs.ts";
export {
  approveJob,
  beginReview,
  getDecision,
  MAX_NOTE_CHARS,
  recordDecision,
  reviewHistory,
  saveReview,
  sendBackNote,
  startRun,
  type FieldEdit,
  type ReviewEvent,
  type ReviewEventKind,
  type ReviewRefusal,
} from "./review.ts";
export {
  auditEventsAfter,
  auditEventSeq,
  listAuditEvents,
  countRefusedSignIn,
  listRefusedSignIns,
  recordAudit,
  recordRefusedSignIn,
  SETUP_ACTOR,
  type AuditAction,
  type AuditActor,
  type AuditDetail,
  type AuditEvent,
  type RefusedSignIns,
  type SignInMethod,
} from "./audit.ts";
export { monthRange, tenantUsage, type TenantUsage } from "./usage.ts";
export { checkRestore, type RestoreCheck } from "./restore-check.ts";
export {
  getAgentTestRun,
  getAgentVersion,
  hasAgentTestRun,
  listAgentTestRuns,
  listAgentVersions,
  recordAgentTestRun,
  recordAgentVersion,
  type AgentSnapshot,
  type AgentTestRunRecord,
  type AgentTestRunSummary,
  type AgentVersionRecord,
} from "./operator-data.ts";
