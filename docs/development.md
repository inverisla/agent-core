# Working on the code

The rules every change follows (tenant separation, migrations, the model gateway, access
guards, audit) are in [CLAUDE.md](../CLAUDE.md), for people and coding agents alike. This
page is the practical side.

## Setting up

You need Node 24, Corepack (it ships with Node) and Docker.

First get a copy and go into it:

```bash
git clone https://github.com/inverisla/agent-core.git
cd agent-core
```

Then:

```bash
corepack enable
pnpm install
cp .env.example .env.local
docker compose up -d --wait
pnpm db:migrate
pnpm db:set-context-key
```

(`pnpm demo` does the last two and also seeds the demo tenant; see [demo.md](demo.md).)

| Service | Address |
| --- | --- |
| Postgres 17 | `localhost:5433`, database `agentcore`. App role `agentcore_app` (password `agentcore_app`; row-level security always applies to it); owner role `agentcore_owner` (password `agentcore_owner`, not a superuser) for migrations |
| Temporal dev server | `localhost:7233`, web UI at http://localhost:8233 |
| Azurite (Blob Storage) | `http://127.0.0.1:10000/devstoreaccount1` |

Stop them with `docker compose down`; add `-v` to delete their data too.

## Running it

`pnpm dev` starts the web app (http://localhost:3000) and the worker, which runs each
uploaded document's job through Temporal.

- **The model.** `.env.example` uses the demo model (`MODEL_PROVIDER=demo`), which only
  knows the sample contracts. For a real one see [models.md](models.md); `pnpm model:smoke`
  makes one call to check it.
- **Email.** `EMAIL_TRANSPORT=dev-outbox` writes each email to a file in
  `apps/web/.dev-outbox/` instead of sending it (only while `AUTH_URL` is local).
- **Uploads** (PDF or Word, up to `MAX_UPLOAD_MB`, 25 by default) go to Azurite, at
  `/t/{slug}/documents` or `POST /api/t/{slug}/documents` (multipart field `file`,
  `Accept: application/json`). The Temporal UI shows each job's workflow.

## Signing in locally

- **Tenant users** sign in at `/t/{slug}/sign-in` with an email link (from the outbox), or
  with "Sign in with your work account" if their tenant has linked Microsoft or Google
  sign-in. Nobody can sign in, by any method, until they have been added to the tenant.
- **Operators** sign in at `/operator/sign-in`. Locally, with `DEV_OPERATOR_SIGN_IN=true`
  (as in `.env.example`), **Sign in as the local operator** needs no Microsoft account; it
  never works on a deployment. Otherwise operators sign in with Microsoft: members of the
  client's own organisation (`OPERATOR_ENTRA_TENANT_ID`) with the "Operator" app role.
- **Microsoft sign-in** needs a multi-tenant Entra app registration
  (`AUTH_MICROSOFT_ENTRA_ID_ID` and `_SECRET`) with the redirect URI
  `{AUTH_URL}/api/auth/callback/microsoft-entra-id`, the app role "Operator" and the
  optional ID token claim `xms_edov`. Guest accounts are refused. Step 6 of
  [infra/azure/README.md](../infra/azure/README.md) walks through it.
- **Google sign-in** needs an OAuth client (`AUTH_GOOGLE_ID` and `_SECRET`) with the
  redirect URI `{AUTH_URL}/api/auth/callback/google`. Personal Google accounts are refused.
- If a sign-in is refused, the server log says why in a `sign-in.refused` line, for example
  `"reason":"unknown-user","where":"tenant:demo-ltd","method":"google"`. People only see "Sign-in was
  refused."

Tenants and users are managed in the operator console and the tenant admin pages. Before
any operator can sign in (on a new deployment, say), the setup commands do the same:

```bash
pnpm tenant:create -- --name "Demo Ltd" --admin-email you@example.com
pnpm tenant:add-user -- --slug demo-ltd --email someone@example.com --role admin
pnpm tenant:sso -- --slug demo-ltd --google lawfirm.example
```

(`tenant:sso` also takes `--microsoft <entra-tenant-id>`, and `--email-links on|off`; `on`
is how to let a locked-out admin back in.)

## Tests and checks

```bash
pnpm test         # every Vitest project; the "integration" project needs the services
pnpm test:unit    # unit tests only, no services needed
pnpm test:coverage  # all of them, with a coverage report in coverage/ (open index.html)
pnpm lint         # ESLint, no warnings allowed
pnpm typecheck
pnpm format       # Prettier (Markdown is left alone)
pnpm build
pnpm test:e2e     # Playwright against the production build: run pnpm build first
```

The demo model, the local operator sign-in and the test faults work only on your own
machine (`packages/core/src/local.ts`): they are refused when a hosting platform's variable
is set, such as `KUBERNETES_SERVICE_HOST`, which some cloud development environments set
too, and the error says which. On a machine with no such variable, the check relies on
`DATABASE_URL`, `TEMPORAL_ADDRESS` and `AUTH_URL` all naming this machine.

The coverage report counts what the Vitest tests reach; pages and components are mostly
exercised by the Playwright tests, which it does not count. CI shows the totals in each
run's summary and never fails on them: use it to find what no test reaches.

`pnpm test:e2e` starts its own copy of the app on port 3100 against a throwaway database.
CI runs all of these on every pull request, and the quick start in the README on a clean
machine.

## Agents and samples

```bash
pnpm samples:run                                        # the samples through the configured model
pnpm agent:compare -- --agent contract-summary --base origin/main   # two versions side by side
pnpm samples:build                                      # rebuild samples/files from their sources
```

See [agents.md](agents.md).
