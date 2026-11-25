# Agent core

Open-source (Apache 2.0) starter kit for document-processing agent platforms. A client takes a copy, hosts it on Azure and builds its own agents on it. The build plan is in `docs/PLAN.md`. Design choices are logged in `docs/DECISIONS.md`.

## Terms

- **Client**: a firm that licenses and runs a copy of the core.
- **Tenant**: one of that client's customers, kept separate inside the copy.
- **Operator**: the client's own staff, who build and version agents.

Use these words in code, UI copy and docs. Database columns use `tenant_id`, never `client_id`.

## Hard constraints

- Nothing specific to any real client: no names, data, prompts or domain logic. The demo agent summarises supplier contracts using only files in `samples/`.
- Every table that holds tenant data has `tenant_id`, and Postgres row-level security enforces it. Tables in the `app` schema hold system configuration only, and the app role has no access to them. Tables in the `operator` schema hold the operator's own records (agent versions and their test runs), never tenant data (so a test set is invented or public documents, never a tenant's); the app may only add and read rows there, through `withOperatorData`, and a test pins their columns. App code connects as a role without `BYPASSRLS` and sets the tenant per transaction. Never query without tenant context.
- Data stays in a UK or EU Azure region. Model calls go through the gateway only (`@agent-core/core/models`, see `docs/models.md`; a lint rule refuses the usual ways round it, tested in `apps/web/lib/theme/gateway-lint.test.ts`, and review catches the rest).
- Agents are defined in files under `agents/`. There is no agent editor UI. The format, checks and versioning are in `docs/agents.md`.
- Every job records the agent version it ran.

## Stack

Stay within this list. Ask before adding any other dependency.

- Next.js (App Router), TypeScript strict, pnpm workspaces
- Tailwind CSS for styling (from task 10b)
- Azure Database for PostgreSQL; Drizzle with SQL migrations checked in
- Temporal for jobs (local dev server while building)
- Azure Blob Storage (Azurite locally)
- Auth.js with Microsoft Entra ID, Google Workspace (tenant SSO) and email link
- Models: Azure OpenAI (EU data zone); Claude via AWS Bedrock as second provider
- unpdf for extraction; docxtemplater for Word output
- Vitest (with @vitest/coverage-v8), Playwright, Postgres in Docker for tests
- Azure Container Apps, Bicep, GitHub Actions
- OpenTelemetry to Application Insights

## Layout

```
apps/web/                  Next.js: tenant portal, operator console, API
apps/worker/               Temporal workers
packages/db/               schema, migrations, RLS policies, tenant context
packages/core/             agent definition, registry, model gateway
packages/blocks/           extraction, extract-to-schema, Word report
packages/testing/          test-set runner, scoring, version comparison
agents/contract-summary/   demo agent: config, prompts, schema, template
samples/                   public sample contracts and expected outputs
infra/                     Bicep, docker-compose for local dev
docs/                      PLAN.md, DECISIONS.md, architecture.md, demo.md, development.md, operations.md
```

## Commands

Node 24 and pnpm 10 (via Corepack). Copy `.env.example` to `.env.local`.

```
docker compose up -d --wait   # Postgres 17, Temporal dev server, Azurite (defined in infra/docker-compose.yml)
pnpm demo                     # set up the local demo: Demo Ltd and three sample contracts (docs/demo.md)
pnpm dev                      # web (Next.js) and worker
pnpm test                     # all Vitest projects; "integration" needs the compose stack
pnpm test:unit                # unit tests only, no services needed
pnpm test:coverage            # all Vitest projects with a coverage report (a report only; CI never fails on it)
pnpm lint                     # ESLint, zero warnings allowed
pnpm typecheck                # tsc in the root and every package
pnpm format                   # Prettier (Markdown is excluded)
pnpm build                    # production build
pnpm test:e2e                 # Playwright against the production build (run pnpm build first)
pnpm db:migrate               # apply migrations as the owner role (DATABASE_ADMIN_URL)
pnpm db:set-context-key       # store TENANT_CONTEXT_KEY in the database (after migrating)
pnpm db:generate              # generate a table migration from packages/db/src/schema.ts
pnpm model:smoke              # one call to the configured model (docs/models.md)
pnpm samples:build            # rebuild samples/files and the demo template from their sources
pnpm samples:run              # run the samples through the configured model and check them
pnpm agent:compare -- --agent contract-summary --base origin/main   # two versions side by side, accuracy per field
# Tenants and users are managed in the operator console and tenant admin pages (task 12b);
# these commands are for setting up before operator sign-in works.
pnpm tenant:create -- --name "Demo Ltd" --admin-email you@example.com   # tenant plus first admin
pnpm tenant:add-user -- --slug demo-ltd --email someone@example.com --role admin   # role defaults to user
pnpm tenant:sso -- --slug demo-ltd --google lawfirm.example             # or --microsoft <id>, --email-links on|off
```

Deploy: `.github/workflows/deploy.yml` deploys the Azure dev environment (`infra/azure/`, Bicep) after CI passes on `main`, once `AZURE_DEPLOY_ENABLED` is set. Images: `infra/docker/web.Dockerfile` and `worker.Dockerfile` (the worker image also runs the migrate job). New settings go in `main.bicep`, with secrets in Key Vault. In GitHub, values that identify the environment or a person (Azure and Entra IDs, the Temporal address, the alert email) are environment secrets, read as `secrets.X || vars.X`, so logs mask them; names and addresses read from Azure are masked with `::add-mask::` as soon as a workflow reads them. Actions are pinned by commit and base images by digest; Dependabot proposes updates.

CI (`.github/workflows/ci.yml`) runs migrations, format check, lint, typecheck, test, build and the Playwright tests against the compose stack on every PR. Jobs run on the runner named by the repository variable `CI_RUNNER` (for example `ubicloud-standard-2-ubuntu-2404`, with the Ubicloud GitHub app installed), or `ubuntu-latest` if it is unset or the PR comes from a fork. Not a runner hosted on Kubernetes (Actions Runner Controller): its `KUBERNETES_SERVICE_HOST` makes the own-machine check (`packages/core/src/local.ts`) refuse the test faults, the demo model and the local operator sign-in, so the e2e tests and the quick start fail there.

Look: pages are built from the shared components in `apps/web/components/ui/` (a lint rule refuses raw buttons, inputs, selects, textareas and tables elsewhere); the brand is `apps/web/theme.ts` plus the logo in `apps/web/public/` (see `docs/branding.md`). Every page must pass the axe check and fit a phone screen (`apps/web/e2e/look.spec.ts`); add new pages there or to the role matrix.

Users: a removed user keeps their row (`users.removed_at`), so their name stays on their history; every sign-in and access lookup must use `activeUser` from `@agent-core/db`. A tenant always keeps at least one admin (`setTenantUserRole`, `removeTenantUser`). Uploads use the tenant's assigned agents (`tenant_agents`), or the deployment's default if none.

Audit: every change to a tenant's users or settings goes through a change function in `@agent-core/db` that takes the actor (`AuditActor`: the signed-in user via `tenantActor`, the operator via `operatorActor`, or `SETUP_ACTOR` for setup commands and tests) and writes one `audit_events` row in the same transaction. A new kind of change gets its own action and the same treatment. `audit_events` is append-only: the app may only add and read rows, and a trigger refuses any update, delete or truncate by any role (the owner could still disable it deliberately). Successful sign-ins are recorded there; refused ones are only counted (`sign_in_refusals`, per hour, method and reason), never stored with what was typed. Every CSV export goes through `apps/web/lib/export/csv.ts`. Every 5 minutes the worker copies new audit events to write-once storage (`apps/worker/src/audit-copy.ts`).

Operations (task 14): alerts, backups, the restore drill and the audit copy are described in `docs/operations.md`. Operational events go through `logEvent` from `@agent-core/core/telemetry`, with a name from its `EventName` list and IDs and codes only (anything else is redacted); the alert rules in `infra/azure/modules/monitoring.bicep` match on those names, so renaming one means changing its rule. App database connections time out statements after 15 s, idle transactions after 30 s and whole transactions after 60 s (the audit copy and the restore drill rely on that limit), so never hold a transaction open across a model, storage or network call.

Demo (task 15): the README's quick start must keep working on a fresh machine in under 10 minutes; CI runs it word for word (`scripts/run-quickstart.ts`, from between the README's `quickstart` markers) and then follows `docs/demo.md` (`apps/web/e2e-demo`). Change the README, `pnpm demo` (`apps/web/scripts/demo.ts`) and that walkthrough together. The demo model (`MODEL_PROVIDER=demo`) and the local operator sign-in (`DEV_OPERATOR_SIGN_IN`) are refused anywhere but a local machine; keep it that way.

Operator console (task 16): **Agents** reads agent files and test runs from the `operator` schema; the worker records each version it loads and runs each new version's test set once (`apps/worker/src/agent-tests.ts`), never with the demo model. **Jobs** reads each tenant's jobs in its own context and shows status, attempts and reason codes only: never a file name, a document ID, fields or text.

Access: every protected page and API route calls a guard from `apps/web/lib/auth/guards.ts` (`requireOperatorPage`, `requireTenantPage`, `checkOperator`, `checkTenant`); the proxy only redirects people with no session. Add each new route to the role matrix in `apps/web/e2e/matrix.ts` (used by `access.spec.ts` and `look.spec.ts`); `routes.spec.ts` fails for a route in neither the matrix nor its short public list. Every server action is called directly as the wrong people in `actions.spec.ts`, which fails for an action it does not list.

Jobs: uploading a document creates a job and starts a Temporal workflow (`apps/worker/src/workflows.ts`) whose ID is `job-{job_id}`, run once only. An attempt runs the job's agent steps (`@agent-core/blocks`) and stores the fields in `job_outputs`, the report at `reports/{job_id}.docx` and the document's text at `texts/{job_id}.txt`. Then the job waits for review (task 11): reviewers edit the fields, and approve (the worker writes the report again from the reviewed fields) or send back with a reason (another run, with the reason given to the model). The review screen records each edit and decision in `review_events`, which the app can only add to, and sends the workflow a `decide` update carrying the event's ID and the run only. Every 5 minutes the worker's job sweep (`apps/worker/src/job-sweep.ts`) starts jobs whose workflow never started and sends again decisions that never arrived. Workflow inputs carry tenant and job IDs only, never document content. The worker writes job status and one `job_attempts` row per attempt through `withTenant`, like the web app. Workflow code must stay deterministic: no I/O there, only activities. Activities must turn every failure into a fixed message and reason code before it leaves them, because Temporal stores failures in its history.

Files: tenant documents live in Azure Blob Storage, one private container per tenant (`tenant-{tenant_id}`), each file at `documents/{document_id}`. Build container and blob names only with `@agent-core/core/storage` (`packages/core/src/storage.ts`), from server-side IDs; never put anything a user sent into a path. Reports live at `reports/{job_id}.docx` in the same container. Blob Storage has no row-level security and one credential covers every tenant, so this is what keeps tenants' files apart.

Database access: app code uses `createTenantDatabase(DATABASE_URL, { contextKey }).withTenant(tenantId, tx => …)` from `@agent-core/db` and nothing else. Every new table needs `tenant_id`, tenant-scoped foreign keys (the one exception: a log's user ID, such as `review_events.user_id`, which must outlive a removed user) and a hand-written migration that enables and forces RLS with one `tenant_isolation` policy on `(SELECT app.current_tenant_id())` (see `packages/db/migrations/0001_row_level_security.sql`); the isolation test fails otherwise. Never set `app.tenant_id` any other way: an unsigned or wrongly signed tenant makes every query fail. New text columns need `SET STATISTICS 0`. Pass values as query parameters; `sql.raw` only takes constant SQL. In a select field of a query with no join, Drizzle writes a column inside `sql` without its table name, so in a correlated subquery it binds to the subquery's own table; use a join instead.

## How to work

1. Do one task from `docs/PLAN.md` at a time. Propose a plan first and wait for approval before writing code.
2. Write the task's done-when test first, or alongside the code. A task is finished only when that test passes in CI.
3. Use a branch per task with small commits. Open a PR when the task is done.
4. Before opening a PR, get an independent review of the diff from a fresh reviewer (a new agent given the code, the task and CLAUDE.md, not your own conclusions). Fix what it finds or say why not, and list each finding and its outcome in the PR description. Don't open the PR until this is done.
5. When you stop, summarise what you built, what you decided and anything left open. Add each decision as one line in `docs/DECISIONS.md`.
6. Never commit secrets. Use `.env.local` locally and Key Vault in Azure. Keep `.env.example` up to date.
7. If a task needs something from an open question in `docs/PLAN.md`, stop and ask rather than guessing.
