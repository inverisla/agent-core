# Architecture

Two pages on how agent-core fits together. The reasons for each choice are in
[DECISIONS.md](DECISIONS.md); the rules every change keeps to are in
[CLAUDE.md](../CLAUDE.md).

## The parts

```
 tenant users ──► web app (Next.js) ──────────────► Postgres (row-level security)
 operators   ──►  portal, operator console, API      ▲
                    │ upload: file to Blob Storage   │ status, fields, audit
                    │ then start a workflow          │
                    ▼                                │
                 Temporal ──────────► worker ────────┘
                                       │  runs the job's agent:
                                       │  extract text ─► model gateway ─► Word report
                                       ▼                    (Azure OpenAI, Bedrock)
                                  Blob Storage (one private container per tenant)
```

- **Web app** (`apps/web`): the tenant portal (documents, review, tenant admin), the
  operator console (tenants, agents, jobs, usage) and the API. Sign-in is Auth.js: email links, or a
  tenant's own Microsoft or Google; operators with Microsoft only.
- **Worker** (`apps/worker`): Temporal workflows and activities. Each upload starts one
  workflow, `job-{job_id}`, which runs the agent, waits for a person's review, and writes
  the report. Workflows carry IDs only, never document content.
- **Postgres**: everything about tenants, users, documents, jobs, reviews, model calls and
  the audit log; and, in a schema of its own, the operator's records of each agent
  version and its test runs.
- **Blob Storage**: the documents, the text read from them, and the reports.
- **On Azure** (`infra/azure`, Bicep): Container Apps for the web app, the worker and the
  jobs that migrate and check; Postgres Flexible Server and Storage reachable only inside
  a virtual network; Key Vault for every secret; Application Insights and Log Analytics.
  UK or EU regions only.

## Keeping tenants apart

Every table holding tenant data has `tenant_id`, and Postgres row-level security limits
every query to one tenant. The app connects as a role that cannot bypass it, and the only
way to query is `withTenant(tenantId, tx => …)`, which sets the tenant for that one
transaction, signed with a key held in the database, so injected SQL cannot pick another.
A test checks every table has the policy.

Blob Storage has no such rules, so names do the work: one private container per tenant,
built only from server-side IDs (`packages/core/src/storage.ts`), never from anything a
user sent.

Operators manage tenants from outside any one tenant; the console lists them through a
single function that returns IDs and portal addresses only, then reads each tenant inside
its own context (its jobs list too, which shows status and reason codes only). The one
place outside every tenant is the `operator` schema: agent versions and their test-set
results, never tenant data, which the app can add to but not change.

## A document's journey

1. **Upload.** The file's type and size are checked, it is stored, and a job is created
   with the agent and agent version it will run. Then its workflow starts.
2. **Run.** The worker reads the text (unpdf for PDF, its own reader for Word), asks the
   model for the agent's fields through the gateway, checks the answer against the agent's
   schema, and writes a draft report. A failure that retrying could fix is retried; one
   that cannot (a document with no text) fails at once. Every failure becomes a fixed
   reason code before it leaves the worker.
3. **Review.** A person sees the source beside the draft, edits fields, and approves or
   sends it back with a reason. Every edit and decision is kept, append-only.
4. **Done.** Approval writes the report again from the reviewed fields; a send-back runs
   the agent again, giving the model the reason.

## Agents, models and versions

An agent is a folder under `agents/`: its steps, prompt, output schema and report template
(see [agents.md](agents.md)). Its version is a hash of exactly those files, and every job
records the version it ran; a worker refuses a job recorded for a version it does not
have. There is no agent editor: agents change by pull request, and `pnpm agent:compare`
(also a GitHub workflow) runs the sample set through two versions and shows accuracy per
field. Once deployed, the worker runs each new version's test set once with the real
model, and the operator console shows and compares the results.

Every model call goes through one gateway (`packages/core/src/models`; a lint rule allows
no other way). Which provider answers is configuration: Azure OpenAI in the EU data zone,
or Claude on AWS Bedrock in an EU region, or locally the demo model. The gateway records
each call's tokens and estimated cost for the job and tenant.

## Audit, usage and operations

- **Audit log**: every change to a tenant's users and settings, and every successful
  sign-in, written in the same transaction as the change. Nobody can change or delete it
  through the app; every five minutes the worker also copies it to write-once storage,
  which only the worker's own identity can reach (not the web app's). Once its
  retention policy is locked (`docs/operations.md`), not even the database's or the
  subscription's owner can alter the copy; it ships unlocked, so until then an Azure
  administrator could remove the policy. Refused sign-ins are only counted.
- **Usage**: documents, jobs, model calls, tokens and cost per tenant and month, from the
  records above, with CSV export.
- **Operations** ([operations.md](operations.md)): structured events from both apps, alert
  rules (a failed job, a silent worker, errors, refused sign-in spikes, the audit copy,
  database storage), timeouts on every database, model, storage and email call,
  point-in-time backups, and a restore drill that has been run.

## The stack

TypeScript throughout (pnpm workspaces): Next.js, Drizzle with SQL migrations, Temporal,
Auth.js, unpdf and docxtemplater, Vitest and Playwright, Bicep and GitHub Actions,
OpenTelemetry. CI runs migrations, lint, type checks, unit and integration tests against
real Postgres, Temporal and Azurite, the Playwright suite (including accessibility and
phone-width checks on every page) and the README's quick start, on every pull request.
