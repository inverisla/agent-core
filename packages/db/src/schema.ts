// Every table in the public schema has tenant_id, and row-level security
// (migrations/*_row_level_security.sql) limits every row to the tenant set for the current
// transaction. The one exception is the operator schema at the end: the operator's own
// records about agents, which never hold tenant data.
//
// Foreign keys between tenant-owned tables include tenant_id, so a row can never
// point at another tenant's row, even though foreign-key checks bypass RLS.
import {
  bigint,
  boolean,
  foreignKey,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgSchema,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const tenants = pgTable(
  "tenants",
  {
    tenantId: uuid("tenant_id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    // URL name for the tenant's portal (/t/{slug}); see tenant-slug.ts for the rules.
    slug: text("slug").notNull().unique(),
    createdAt: createdAt(),
  },
  (t) => [
    // Shape only; reserved words are checked in tenant-slug.ts.
    check(
      "tenants_slug_format",
      sql`${t.slug} ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$' and ${t.slug} !~ '--'`,
    ),
  ],
);

// Tenant members only. Operators (the client's own staff) are decided in task 3.
export const userRole = pgEnum("user_role", ["tenant_admin", "tenant_user"]);

export const users = pgTable(
  "users",
  {
    userId: uuid("user_id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.tenantId),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    role: userRole("role").notNull(),
    // Entra object ID (oid), recorded the first time the user signs in with Microsoft.
    entraObjectId: text("entra_object_id"),
    // Google's permanent user ID (sub), recorded the first time the user signs in with Google.
    googleSubject: text("google_subject"),
    createdAt: createdAt(),
    // Set when an admin removes the user (task 12b): they can no longer sign in, but their
    // name stays on what they uploaded and reviewed, and adding them again restores them.
    removedAt: timestamp("removed_at", { withTimezone: true }),
    // Sessions that began before this are refused: set when the user is removed or
    // restored, so a session from before removal never works for whoever has the address now.
    sessionsValidAfter: timestamp("sessions_valid_after", { withTimezone: true }),
  },
  (t) => [
    unique("users_tenant_id_entra_object_id_key").on(t.tenantId, t.entraObjectId),
    unique("users_tenant_id_google_subject_key").on(t.tenantId, t.googleSubject),
    unique("users_tenant_id_user_id_key").on(t.tenantId, t.userId),
    // Emails are unique per tenant regardless of case.
    uniqueIndex("users_tenant_id_email_key").on(t.tenantId, sql`lower(${t.email})`),
  ],
);

export const documents = pgTable(
  "documents",
  {
    documentId: uuid("document_id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.tenantId),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    blobPath: text("blob_path").notNull(),
    sha256: text("sha256").notNull(),
    uploadedBy: uuid("uploaded_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("documents_tenant_id_document_id_key").on(t.tenantId, t.documentId),
    foreignKey({
      name: "documents_uploaded_by_fkey",
      columns: [t.tenantId, t.uploadedBy],
      foreignColumns: [users.tenantId, users.userId],
    }),
    index("documents_tenant_id_uploaded_by_idx").on(t.tenantId, t.uploadedBy),
    // The daily upload allowance (review S5).
    index("documents_tenant_id_created_at_idx").on(t.tenantId, t.createdAt),
  ],
);

// awaiting_review: the agent has run and a person must approve its draft or send it back
// (task 11); approved: done. "succeeded" is for jobs from before review existed.
export const jobStatus = pgEnum("job_status", [
  "uploaded",
  "queued",
  "running",
  "succeeded",
  "failed",
  "awaiting_review",
  "approved",
]);

export const jobs = pgTable(
  "jobs",
  {
    jobId: uuid("job_id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.tenantId),
    documentId: uuid("document_id").notNull(),
    agentName: text("agent_name").notNull(),
    // Every job records the agent version it ran (content hash, from task 7).
    agentVersion: text("agent_version").notNull(),
    // Kept current by the job runner (task 5).
    status: jobStatus("status").notNull().default("uploaded"),
    // Each send-back starts another run of the agent (task 11); attempts count within a run.
    run: integer("run").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "jobs_document_fkey",
      columns: [t.tenantId, t.documentId],
      foreignColumns: [documents.tenantId, documents.documentId],
    }),
    unique("jobs_tenant_id_job_id_key").on(t.tenantId, t.jobId),
    index("jobs_tenant_id_status_idx").on(t.tenantId, t.status),
    // The operator console's job list and job counts (task 16).
    index("jobs_tenant_id_updated_at_idx").on(t.tenantId, t.updatedAt),
    index("jobs_tenant_id_created_at_idx").on(t.tenantId, t.createdAt),
  ],
);

// One row per attempt at running a job, so the status shows every retry.
export const attemptOutcome = pgEnum("attempt_outcome", ["running", "succeeded", "failed"]);

export const jobAttempts = pgTable(
  "job_attempts",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.tenantId),
    jobId: uuid("job_id").notNull(),
    run: integer("run").notNull().default(1),
    attempt: integer("attempt").notNull(),
    outcome: attemptOutcome("outcome").notNull().default("running"),
    // A short reason code, never document content or a raw error message.
    errorCode: text("error_code"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.jobId, t.run, t.attempt] }),
    foreignKey({
      name: "job_attempts_job_fkey",
      columns: [t.tenantId, t.jobId],
      foreignColumns: [jobs.tenantId, jobs.jobId],
    }),
    check("job_attempts_attempt_positive", sql`${t.attempt} > 0`),
  ],
);

// What a job produced (task 9): the fields its agent extracted, and whether it wrote a
// Word report (at reports/{job_id}.docx in the tenant's container). One row per job,
// replaced if an attempt runs again; the review screen (task 11) edits the fields.
export const jobOutputs = pgTable(
  "job_outputs",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.tenantId),
    jobId: uuid("job_id").notNull(),
    // The agent's draft, as the model gave it.
    fields: jsonb("fields"),
    // The fields as reviewers have edited them (the draft until someone saves), and a
    // counter that each save moves on, so two reviewers cannot overwrite each other.
    reviewedFields: jsonb("reviewed_fields"),
    revision: integer("revision").notNull().default(0),
    // The run that produced this draft.
    run: integer("run").notNull().default(1),
    hasReport: boolean("has_report").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.jobId] }),
    foreignKey({
      name: "job_outputs_job_fkey",
      columns: [t.tenantId, t.jobId],
      foreignColumns: [jobs.tenantId, jobs.jobId],
    }),
  ],
);

// One row per call to a model (task 8): who, for which job and agent step, which model,
// the tokens used and the estimated cost. Never the prompt, the document or the answer.
export const modelCallOutcome = pgEnum("model_call_outcome", ["succeeded", "failed"]);

export const modelCalls = pgTable(
  "model_calls",
  {
    callId: uuid("call_id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.tenantId),
    jobId: uuid("job_id").notNull(),
    // The agent step that made the call.
    step: text("step").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    outcome: modelCallOutcome("outcome").notNull(),
    // A short reason code (for example model-rate-limited), never a raw error message.
    errorCode: text("error_code"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    // Estimated from the price list at the time of the call; null if the model has no price.
    costUsd: numeric("cost_usd", { precision: 14, scale: 8 }),
    durationMs: integer("duration_ms").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "model_calls_job_fkey",
      columns: [t.tenantId, t.jobId],
      foreignColumns: [jobs.tenantId, jobs.jobId],
    }),
    index("model_calls_tenant_id_job_id_idx").on(t.tenantId, t.jobId),
    index("model_calls_tenant_id_created_at_idx").on(t.tenantId, t.createdAt),
    check(
      "model_calls_counts_not_negative",
      sql`${t.inputTokens} >= 0 and ${t.outputTokens} >= 0 and ${t.durationMs} >= 0`,
    ),
  ],
);

// A tenant's single sign-on: one Microsoft organisation (Entra tenant ID) or one Google
// Workspace domain. Sign-in goes to that provider only. allowEmailLinks lets a tenant
// admin turn email links off once SSO is linked.
export const ssoProvider = pgEnum("sso_provider", ["microsoft", "google"]);

export const tenantSso = pgTable(
  "tenant_sso",
  {
    tenantId: uuid("tenant_id")
      .primaryKey()
      .references(() => tenants.tenantId),
    provider: ssoProvider("provider").notNull(),
    entraTenantId: uuid("entra_tenant_id"),
    googleDomain: text("google_domain"),
    allowEmailLinks: boolean("allow_email_links").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "tenant_sso_one_provider",
      sql`(${t.provider} = 'microsoft' and ${t.entraTenantId} is not null and ${t.googleDomain} is null)
        or (${t.provider} = 'google' and ${t.googleDomain} is not null and ${t.entraTenantId} is null)`,
    ),
    check(
      "tenant_sso_google_domain_format",
      sql`${t.googleDomain} ~ '^([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,}$'`,
    ),
  ],
);

// Single-use email sign-in links. Only a SHA-256 hash of each token is stored.
export const verificationTokens = pgTable(
  "verification_tokens",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.tenantId),
    identifier: text("identifier").notNull(),
    tokenHash: text("token_hash").notNull(),
    expires: timestamp("expires", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.tokenHash] })],
);

// Each sign-in email sent (a link, or the use-your-work-account note), so the sending
// limits can count them (review S1). Only the normalised address and when: no token.
// Rows a day old are deleted when the next email is asked for.
export const emailLinkSends = pgTable(
  "email_link_sends",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.tenantId),
    identifier: text("identifier").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("email_link_sends_tenant_id_sent_at_idx").on(t.tenantId, t.sentAt)],
);

// Every review action (task 11): each edit with the field's old and new values, each
// approval, and each send-back with its reason. The app may add rows, never change or
// delete them.
export const reviewEventKind = pgEnum("review_event_kind", ["edit", "approve", "send_back"]);

export const reviewEvents = pgTable(
  "review_events",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.tenantId),
    eventId: uuid("event_id").notNull().defaultRandom(),
    jobId: uuid("job_id").notNull(),
    // The run whose draft was being reviewed.
    run: integer("run").notNull(),
    // Who did it. No foreign key: the record must outlive a user who is later removed.
    userId: uuid("user_id").notNull(),
    kind: reviewEventKind("kind").notNull(),
    // Edits: the field's name, and its value before and after.
    field: text("field"),
    oldValue: jsonb("old_value"),
    newValue: jsonb("new_value"),
    // Send-backs: the reviewer's reason, which the next run's model is given.
    note: text("note"),
    // Decisions: the draft's revision they were made on, so the worker acts on exactly
    // what the reviewer saw.
    revision: integer("revision"),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.eventId] }),
    foreignKey({
      name: "review_events_job_fkey",
      columns: [t.tenantId, t.jobId],
      foreignColumns: [jobs.tenantId, jobs.jobId],
    }),
    index("review_events_tenant_id_job_id_idx").on(t.tenantId, t.jobId, t.createdAt),
  ],
);

// The agents a tenant may use (task 12b), chosen by an operator. A tenant with none uses
// the deployment's default agent (AGENT_FOR_UPLOADS).
export const tenantAgents = pgTable(
  "tenant_agents",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.tenantId),
    agentName: text("agent_name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.agentName] })],
);

// The audit log (task 13): who changed what in a tenant, and who signed in. Append-only:
// the app role may only add and read rows, and a trigger refuses any change or deletion,
// even by the owner (migration 0020).
export const auditActorKind = pgEnum("audit_actor_kind", ["user", "operator", "setup", "system"]);

export const auditEvents = pgTable(
  "audit_events",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.tenantId),
    eventId: uuid("event_id").notNull().defaultRandom(),
    // The order events happened in, even within one transaction (which share a time).
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    actorKind: auditActorKind("actor_kind").notNull(),
    // A user's ID, or an operator's Entra object ID. No foreign key: the log must outlive
    // a removed user, and operators have no row here.
    actorId: text("actor_id"),
    // Their email or name when it happened, so the log stays readable later.
    actorLabel: text("actor_label"),
    // What happened, such as user.added (see AuditAction in audit.ts).
    action: text("action").notNull(),
    // Details: IDs, roles, settings. Never document content.
    detail: jsonb("detail").notNull().default({}),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.eventId] }),
    index("audit_events_tenant_id_occurred_at_idx").on(t.tenantId, t.occurredAt),
    // The write-once copy pages by seq (review S4).
    index("audit_events_tenant_id_seq_idx").on(t.tenantId, t.seq),
  ],
);

// Refused sign-ins to a tenant (task 13), counted per hour, method and reason code. A
// count, not one row per attempt: anyone can cause a refusal, so a flood can raise a
// count but never add rows. The address or token tried is never stored.
export const signInRefusals = pgTable(
  "sign_in_refusals",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.tenantId),
    // The start of the hour (UTC).
    hour: timestamp("hour", { withTimezone: true }).notNull(),
    method: text("method").notNull(),
    reason: text("reason").notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.hour, t.method, t.reason] })],
);

// The operator's own records (task 16), in a schema of their own: each agent version the
// deployment has run, and its test-set results. Never tenant data: no tenant_id, nothing
// from a tenant's documents, only the agent's files and its test set, which must be
// invented or public documents, never a tenant's (docs/agents.md).
// The app may add rows and read them, never change or delete them
// (migrations/0022_operator_data_security.sql).
export const operatorSchema = pgSchema("operator");

// An agent version as the deployment loaded it: its definition and the text of its files,
// so a version can still be read after a newer one replaces it.
export const agentVersions = operatorSchema.table(
  "agent_versions",
  {
    agentName: text("agent_name").notNull(),
    version: text("version").notNull(),
    // { definition, files: [{ path, text? , bytes }] } (packages/db/src/operator-data.ts).
    snapshot: jsonb("snapshot").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.agentName, t.version] })],
);

// One run of an agent version's test set against the deployment's model.
export const agentTestRuns = operatorSchema.table(
  "agent_test_runs",
  {
    runId: uuid("run_id").primaryKey().defaultRandom(),
    agentName: text("agent_name").notNull(),
    version: text("version").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    repeats: integer("repeats").notNull(),
    cases: integer("cases").notNull(),
    // Every case's runs and field checks (TestRun in @agent-core/testing).
    result: jsonb("result").notNull(),
    // Right answers out of every checked field, over all cases and runs (0 to 1).
    accuracy: doublePrecision("accuracy"),
    calls: integer("calls").notNull(),
    tokens: bigint("tokens", { mode: "number" }).notNull(),
    costUsd: numeric("cost_usd", { precision: 14, scale: 8, mode: "number" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "agent_test_runs_version_fkey",
      columns: [t.agentName, t.version],
      foreignColumns: [agentVersions.agentName, agentVersions.version],
    }),
    index("agent_test_runs_agent_idx").on(t.agentName, t.finishedAt),
  ],
);
