# agent-core

An open-source (Apache 2.0) starter kit for document-processing agent platforms. A firm
(the **client**) takes a copy, hosts it on Azure, and builds its own agents on it for its
customers (its **tenants**), each kept separate from the others.

Out of the box it has two demo agents. Upload a supplier contract and one drafts a summary
(the parties, term, renewal, notice and fees); the other checks it against a sample
purchasing policy, in two model steps (find the clauses, then judge them). A person
reviews and approves the draft, and a Word report is written. Around that: sign-in for tenants and the client's own staff (the
**operators**), tenant and user management, an audit log, usage per tenant, a testing tool
for agent versions, and monitoring, backups and alerts on Azure.

## Quick start: the demo in under 10 minutes

You need [Node 24](https://nodejs.org) and [Docker](https://docs.docker.com/get-docker/)
running. No cloud account or model key: the demo uses a stand-in "demo model" that knows
the sample contracts (see [docs/demo.md](docs/demo.md)).

First get a copy and go into it:

```bash
git clone https://github.com/inverisla/agent-core.git
cd agent-core
```

<!-- quickstart:start -->
```bash
corepack enable
pnpm install
cp .env.example .env.local
docker compose up -d --wait
pnpm demo
pnpm dev
```
<!-- quickstart:end -->

Then open http://localhost:3000/t/demo-ltd/sign-in and follow **[the demo](docs/demo.md)**.
(`corepack enable` may need `sudo` on macOS and Linux. The first `docker compose up`
downloads three images, which takes a minute or two. It needs ports 3000, 5433, 7233, 8233
and 10000 to 10002 free.)

## The operator console

The client's own staff (operators) run the platform from `/operator`. In the demo, sign
in with **Sign in as the local operator**; on Azure, operators sign in with Microsoft and
need the "Operator" app role ([infra/azure/README.md](infra/azure/README.md), step 6).

| Page | What it is for |
| --- | --- |
| **Tenants** | Every tenant (customer), with its users and how it signs in. **New tenant** makes one with its first admin; a tenant's page adds admins, links Microsoft or Google sign-in, turns email links back on, chooses its agents and shows its activity log. |
| **Agents** | The agents this deployment runs: version, steps, files (prompt, schema) and which tenants use them, read-only (agents change by pull request). Each new version's test set is run once with the real model; compare any two runs field by field. |
| **Jobs** | Every tenant's jobs, for support: status, attempts and reason codes only, never a document's name or content. Find a job by the ID in a failed-job alert. |
| **Usage** | Each tenant's documents, jobs, model calls, tokens and estimated cost per month, with a CSV export. |

Tenant admins manage their own users and see their own activity log from their portal's
**Admin** pages.

## What is where

| | |
| --- | --- |
| [docs/demo.md](docs/demo.md) | The walkthrough (about eleven minutes) |
| [docs/architecture.md](docs/architecture.md) | How it fits together, in two pages |
| [docs/development.md](docs/development.md) | Working on the code: services, commands, tests, signing in locally |
| [docs/agents.md](docs/agents.md) | Writing and versioning agents; testing and comparing them |
| [docs/models.md](docs/models.md) | Connecting a real model (Azure OpenAI or Bedrock) |
| [infra/azure/README.md](infra/azure/README.md) | Setting up the hosted environment on Azure |
| [docs/operations.md](docs/operations.md) | Alerts, backups, restores and the audit log's copy |
| [docs/branding.md](docs/branding.md) | Colours, logo and product name |
| [docs/PLAN.md](docs/PLAN.md), [docs/DECISIONS.md](docs/DECISIONS.md) | What was built, in what order, and why |

```
apps/web/        Next.js: the tenant portal, the operator console and the API
apps/worker/     Temporal worker: runs each document's job
packages/db/     schema, migrations, row-level security, tenant context, audit
packages/core/   agent definitions and registry, the model gateway, storage names
packages/blocks/ text extraction, extract-to-schema, the Word report
packages/testing/ the test-set runner, scoring and version comparison
agents/          the agents (the demos: contract-summary, contract-risk)
samples/         ten invented sample contracts and their expected answers
infra/           Bicep for Azure, Docker for local services
```

## Contributing and security

Issues are welcome; please agree a change in an issue before opening a pull request
([CONTRIBUTING.md](CONTRIBUTING.md)). Report security problems privately, never in an
issue ([SECURITY.md](SECURITY.md)).

## Licence

Apache 2.0, copyright Inverisla Ltd. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

Third-party packages are installed by pnpm, not copied into this repository; `pnpm licenses
list` shows each one's licence. If you distribute the built container images, note that
they also carry other licences: the web image includes sharp's prebuilt libvips
(LGPL-3.0-or-later, through Next.js's image optimisation), and both images include Debian
packages from the Node base image. The sample contracts in `samples/` were invented for
this project.
