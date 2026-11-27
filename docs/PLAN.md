# Agent core: build plan

Three-week build of the agent core, one task at a time. Each task ends with passing tests.

## Context

The agent core is an open-source starter kit (Apache 2.0) for document-processing agent platforms. A client takes a copy, hosts it and builds its own agents on it. This plan turned its scope into tasks, built in order; `DECISIONS.md` records why each choice was made.

**Terms**

- **Client:** a firm that licenses and runs a copy of the core.
- **Tenant:** one of that client's customers, kept separate inside the copy.
- **Operator:** the client's own staff, who build and version agents.

**Hard constraints**

- Nothing specific to any real client: no names, data, prompts or domain logic. The demo agent summarises supplier contracts.
- Every table that holds tenant data carries a tenant ID, and Postgres row-level security enforces it. System configuration and the operator's own records (agent versions and their test runs) are kept apart from it.
- Data stays in a UK or EU Azure region.
- Agents are defined in files. There is no agent editor UI.
- Done means the task's test passes in CI, not that the code is written.

## Stack and repo layout

Rows marked *Suggested* are defaults for choices the original scope left open. Ask before changing any of them.

| Area | Choice | Status |
| --- | --- | --- |
| App | Next.js (App Router), TypeScript strict | Decided |
| Database | Azure Database for PostgreSQL, row-level security | Decided |
| ORM and migrations | Drizzle, SQL migrations checked in | Suggested |
| Jobs | Temporal; local dev server while building | Decided |
| Files | Azure Blob Storage; Azurite locally | Decided |
| Sign-in | Auth.js with Microsoft Entra ID, Google Workspace and email link | Decided 17 Nov: Google added for tenant SSO |
| Models | Azure OpenAI (EU data zone); Claude via Bedrock as second provider | Decided |
| PDF and text | unpdf for extraction | Suggested |
| Word output | docxtemplater | Suggested |
| Tests | Vitest, Playwright, Postgres in Docker | Suggested |
| Hosting | Azure Container Apps for web and worker; Bicep for infrastructure | Suggested |
| CI/CD | GitHub Actions | Suggested |
| Monitoring | OpenTelemetry to Application Insights | Suggested |
| Styling | Tailwind CSS | Decided 19 Nov (task 10b) |

```text
agent-core/
  apps/web/                  Next.js: tenant portal, operator console, API
  apps/worker/               Temporal workers
  packages/db/               schema, migrations, RLS policies, tenant context
  packages/core/             agent definition, registry, model gateway
  packages/blocks/           extraction, extract-to-schema, Word report
  packages/testing/          test-set runner, scoring, version comparison
  agents/contract-summary/   demo agent: config, prompts, schema, template
  samples/                   public sample contracts and expected outputs
  infra/                     Bicep, docker-compose for local dev
  docs/                      PLAN.md, DECISIONS.md, architecture note
```

## Tasks

Do them in this order: each task builds on the ones before it. The end goal is a demo that runs in under 10 minutes.

### Week 1: foundation

| # | Task | Covers | Done when |
| --- | --- | --- | --- |
| 1 | Repo and local dev | Monorepo, TypeScript strict, lint, Vitest, docker-compose (Postgres, Temporal dev server, Azurite), Apache 2.0 licence, CI on every PR | `docker compose up` and `pnpm test` pass on a clean machine and in CI |
| 2 | Database and tenant separation | Schema for tenants, users, documents and jobs; RLS policies; tenant context helper | A test proves a user in one tenant cannot read another tenant's rows, even with a crafted query |
| 3 | Sign-in and roles | Entra ID and email link; operator, tenant admin and tenant user roles; route guards | Tests show each role reaches only its own pages and API routes, and a user from a Microsoft organisation not linked to a tenant is refused |
| 3b | Tenant SSO choices | Google Workspace as a second SSO option for tenants; one linked-SSO model for Microsoft and Google; a per-tenant setting, for tenant admins, to turn off email links once SSO is linked | A tenant linked to a Google Workspace domain admits only users Google verifies as members of that domain, and a tenant with email links turned off refuses an email-link sign-in |
| 4 | Document intake | Upload to Blob under a per-tenant path; file type and size checks; document record | A file lands in the right tenant's path, and a wrong type or oversize file is rejected |
| 5 | Job runner skeleton | Temporal workflow, worker, job status table (uploaded, queued, running) | A forced activity failure retries, and the status shows each attempt |
| 6 | Azure dev environment | Bicep for Postgres, Blob, Key Vault, Container Apps; deploy from GitHub Actions | A merge to main deploys, and sign-in works on the dev URL |

### Week 2: agents

| # | Task | Covers | Done when |
| --- | --- | --- | --- |
| 7 | Agent definition and registry | File format for steps, prompts, output schema and report template; version from content hash | Every job records the agent version it ran |
| 8 | Model gateway | One interface; Azure OpenAI and Bedrock adapters; token and cost logging per job and tenant | Switching provider is a config change, and both pass the same test |
| 9 | Building blocks | Text and PDF extraction; extract-to-schema with validation; Word report from template | Each block has unit tests on sample files |
| 10 | Demo agent | Supplier contract to one-page summary: parties, term, renewal, notice, fees | It runs end to end on every sample contract and produces a Word file |
| 10b | Look and feel | A small design system built with Tailwind CSS (layout, navigation, typography, forms, tables, status badges, empty and error states), applied to every existing portal and operator page; accessible to WCAG 2.2 AA and usable on a phone; colours, logo and product name in one theme file each client can change | Every existing page uses the shared components, an automated accessibility check passes on each, and changing the theme file rebrands the whole app |
| 11 | Review screen | Source beside draft; edit fields; approve or send back; workflow waits for the decision | Every edit and approval is logged, and send back re-runs the job |

### Week 3: quality

| # | Task | Covers | Done when |
| --- | --- | --- | --- |
| 12 | Testing tool | Run a test set against an agent version; score each field; compare two versions | Two versions show side by side with accuracy per field |
| 12b | Tenant and user management | Operator console: create a tenant and its first admin, list tenants, link a tenant's Microsoft or Google sign-in, turn a tenant's email links back on, assign agents to a tenant. Tenant admin pages: add and remove users, change roles. Upload form: choose the agent when the tenant has more than one. Replaces the command-line route except before operator sign-in is set up | An operator creates a tenant whose admin then signs in and adds a user, all through the UI, and each new route is in the role matrix |
| 13 | Audit and usage | Append-only audit log, including task 12b's tenant and user changes; jobs and tokens per tenant; CSV export | Usage per tenant exports, and audit rows cannot be edited |
| 14 | Hardening | Error handling, timeouts, monitoring and alerts, database backups | A failed job alerts, and a restore from backup is tested once |
| 15 | Demo and docs | Demo script, seed data, README, two-page architecture note | Someone new can run the demo from the README in under 10 minutes |

### After the plan

| # | Task | Covers | Done when |
| --- | --- | --- | --- |
| 16 | More in the operator console | Agents: each agent's version, steps, files and which tenants use it, read-only; each new deployed version's test set run once by the worker with the deployment's model, kept in an operator schema that holds no tenant data; two runs compared per field. Jobs across tenants for support: status, attempts and reason codes only, and a search by job ID | An operator sees each agent's version, steps and latest test results, compares two recorded versions per field, and finds a failed job from any tenant by its ID with status and reason codes only; each new route is in the role matrix |
| 17 | Chained steps and a second demo agent | An `extract-to-schema` step can also take the fields of earlier `extract-to-schema` steps (`uses`); a second demo agent, `contract-risk`, that pulls out key clauses and then checks them against an invented purchasing policy; recorded demo answers for both of its model steps; its own test set | `contract-risk` runs end to end on every sample contract, with the demo model and a real model, and produces a Word file; loading refuses a bad `uses`; `pnpm agent:compare -- --agent contract-risk --base origin/main` shows accuracy per field; the quick start still passes in CI |

## Later, if clients need it

- Reading scanned PDFs (OCR). Until then a scanned PDF fails with `no-text` (task 9).
- Self-hosting Temporal in a client's own Azure (task 6 uses Temporal Cloud).
- A custom read-and-add-only role for the worker on the audit storage account, in place of Storage Blob Data Contributor (review S7). The worker already has an identity of its own and is the only one with access there, and the retention policy stops it changing or deleting a copy younger than the retention period; an older one it could delete, which this role would stop. The deploy identity cannot create roles, so this needs a one-off step by an owner.
- Tenant erasure and export, key rotation, scaling and safer deploys: what a client must settle before going to production is in "Before production" in `docs/operations.md`.
- How long to keep the audit log. It is kept forever and nothing can delete it (task 13); a client that needs a retention period would add a deliberate, itself-audited way to archive old rows.

## Open questions

None of these blocks task 1. Each one is needed by the task named. Stop and ask when a task needs one that is still open.

| Question | Suggested answer | Needed by |
| --- | --- | --- |
| Make the agent-core repo public from day one? | Decided 16 Nov: private until it is ready to publish | Task 1 |
| Which Azure subscription and region? | Decided 18 Nov: resource group `rg-agent-core-dev` in a subscription of its own, first UK South, then West Europe (see DECISIONS.md) | Task 6 |
| Which Entra app registration is used for sign-in? | Decided 16 Nov: a multi-tenant app in the maintainer's own Entra tenant for development; each client registers its own, so Entra IDs come from config | Task 3 |
| How are email-link messages sent? | Decided 16 Nov: Azure Communication Services Email | Task 3 |
| Azure OpenAI deployment and model | Decided 19 Nov: an Azure OpenAI account and one Data Zone Standard (EU) deployment in the Bicep, off until the agents need a model (task 10). 20 Nov: gpt-5.4-mini | Task 8 |
| Is Bedrock access set up in an EU region? | Decided 19 Nov: the Bedrock adapter is built and tested against a local fake now; real access (eu-west-2, a Bedrock API key) is set up when needed | Task 8 |
| Where do the sample contracts come from? | Decided 20 Nov: 10 invented contracts written for this repository (no licences to check), each with expected outputs written by hand | Task 10 |
| Temporal Cloud or self-hosted for the hosted demo? | Decided 18 Nov: Temporal Cloud, Developer plan, for the demo; self-hosting in the client's own Azure stays their choice, to be added as a later task | Task 6 |
| Do clients need other identity providers for tenants (Okta, OneLogin, SAML)? | Not until a client asks: Auth.js has no SAML, so it would need a broker, with cost and UK/EU data-location questions | Later |
