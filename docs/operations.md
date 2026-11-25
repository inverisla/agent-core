# Operations

How the deployment is watched, backed up and restored (task 14). The settings named here
are variables on the GitHub `dev` environment (and `ALERT_EMAIL` a secret there, so logs
mask it), passed to `infra/azure/main.bicep` by the deploy workflow.

## Alerts

Alerts email the address in `ALERT_EMAIL`. With it unset the rules still fire, in the Azure
portal (Monitor, Alerts), but nobody is told.

Most rules read the apps' event lines: one JSON object per line on standard output, written
by `logEvent` (`packages/core/src/telemetry.ts`), which Container Apps sends to Log Analytics
(table `ContainerAppConsoleLogs_CL`). Event lines carry IDs and reason codes only, never an
email address, a name or document content.

| Alert | Fires when | What to do |
| --- | --- | --- |
| job-failed | A job ends failed after its retries (`job.failed`); one alert, and one email, per job. | The line has the tenant and job IDs, the agent and version, and the reason code (see `apps/web/lib/jobs/reasons.ts`). `model-*` codes: check the model deployment and its quota. `no-text`: a scanned PDF. `agent-version-changed`: a deploy changed the agent mid-job; upload again. `approve-failed`: the approved report could not be written. `cancelled`: the job's workflow was cancelled. (If the worker stops in the instant after recording the failure and before logging it, there is no event: the job still shows as failed in the portal.) |
| worker-silent | No `worker.heartbeat` or `worker.started` from the worker for 15 minutes. | Jobs are not running. Check the worker container app's revision and logs, and that Temporal Cloud is reachable (`TEMPORAL_ADDRESS`, the `temporal-api-key` secret). |
| web-errors | More than 5 unhandled errors (`app.error`) in 15 minutes. | Each line has the route pattern and the error's name. Look at Application Insights (Failures) for the traces. |
| sign-in-refusals | More than 50 refused sign-ins in an hour (`sign-in.refused`). | Each line has a reason code, where (`tenant:<slug>`, `operator` or `none`) and the method. Many `link-not-valid` from one portal: someone may be guessing links (they cannot succeed, but watch it). Tenant admins see the counts on their Activity page. |
| audit-copy-failed | The audit log could not be copied to write-once storage (`audit.copy-failed`). | Check the worker's access to the audit storage account (role assignment, network rule). Nothing is lost while it is fixed: the next copy catches up. |
| job-stuck | A job could not be started (`job.stuck`), or a review decision could not reach its job (`job.decision-undelivered`). The job sweep (below) tries again every 5 minutes. | The line has the tenant and job IDs and the error's name. Usually Temporal is unreachable: see worker-silent. A decision that keeps failing for one job: its workflow has ended (the operator console's **Jobs** page shows the job); upload the document again. |
| upload-failed | More than 3 uploads in 15 minutes could not be stored (`upload.failed`). | The line has the tenant ID and the error's name. Check the web app's access to Blob Storage and the database. |
| email-failed | A sign-in or welcome email could not be sent (`email.failed`). | Check Azure Communication Services (the domain, `EMAIL_FROM`, the `acs-connection-string` secret). People asking for links get nothing meanwhile. |
| postgres-storage | Postgres storage is over 80% full. | Storage grows by itself (auto-grow is on); check why it is growing. |
| postgres-cpu | Postgres CPU has averaged over 80% for 30 minutes. | Look at what is running (Azure portal, the server, Query performance insight); a larger size is `POSTGRES_SKU`. |
| postgres-connections | Over 32 connections open (the default size, Standard_B1ms, lets the apps use 35 of its 50; two busy web replicas and the worker can open 30). | Each app replica uses up to 10. Azure's own sessions count too, and deploys run old and new revisions side by side, so check the idle count (the server's Metrics, Active connections) and set `postgresConnectionAlert` in `infra/azure/modules/monitoring.bicep` above what a busy day shows. Before adding replicas, move to a larger size (`POSTGRES_SKU`) and raise it to match. |

Some event lines have no alert: `job.succeeded`, `job.restarted` (the sweep started a job
whose workflow had not started), `worker.started` and `worker.heartbeat` (only their
absence matters), `audit.copied`, `agent.tested` (the worker recorded a new agent
version's test run, task 16) and `agent.test-failed` (an attempt at that run failed, with
a reason code and whether it will be retried: `model-unavailable` means some cases got no
answer, usually the model's quota or access; `agent-version-elsewhere` happens during a
deploy, when a worker of the old revision took the run; if the retries run out, the next
worker start tries again). Failed jobs are also listed, with their reason codes, on
the operator console's **Jobs** page, which finds a job by the ID in an alert.

### The job sweep

Every 5 minutes a Temporal schedule (`job-sweep`, created by the worker) looks at every
tenant's jobs. A job still "uploaded" after 2 minutes (Temporal did not answer the upload
in time) has its workflow started; a review decision recorded 2 minutes ago that the job
has not acted on is sent again. Both are safe to repeat: a job's workflow runs once only,
and the same decision sent twice is one decision. What still fails is logged and alerts
(job-stuck).

Both schedules are named after the worker's task queue when it is not `documents` (the
deployment's own): after changing `JOB_TASK_QUEUE`, the worker makes new ones, so delete
the old `audit-copy` and `job-sweep` schedules (Temporal Cloud, Schedules), or they keep
starting runs on a queue nobody serves.

To see that an alert reaches you, fail one job on purpose on the dev environment and wait
for the email. A PDF with no text at all fails at once with `no-text` (a blank page will do:
`makeTextPdf([[]])` in `packages/blocks/src/test-files.ts` makes one). A scanned PDF may
not: scanners often add a hidden text layer, which the agent reads. The event line reaches
Log Analytics within seconds, but Azure runs alert rules on its own schedule and then sends
the email, so it can take well over 10 minutes. If nothing comes, run the rule's query in
Logs (the rule, Edit, Condition) to see whether it finds the event.

### Alert record

Record each test of the alerts here, in your own copy: when, what you failed on purpose,
and whether the email arrived. (When this kit was built, a PDF with no text failed with
`no-text`, the event reached Log Analytics within seconds, and the job-failed email took
well over 10 minutes.)

| Date | Environment | What failed | Result |
| --- | --- | --- | --- |
| | | | |

Application Insights (`appi-agentcore-dev`) has the apps' traces and metrics: requests,
dependencies (database, Blob Storage, Temporal, model calls) and the `agentcore.*` counters.
Each app is named in it (`cloud_RoleName`): `agentcore-web` and `agentcore-worker`, unless
the deployment sets `OTEL_SERVICE_NAME` itself. Traces are kept at up to 5 a second (`tracesPerSecond` in `apps/web/instrumentation.ts` and `apps/worker/src/telemetry.ts`); above that, Application Insights holds a sample, and its counts are estimates. The alerts don't depend on it: they read the console logs.

## Backups

- **Postgres**: Azure keeps point-in-time backups for `POSTGRES_BACKUP_DAYS` days (7 in dev,
  up to 35). `POSTGRES_GEO_BACKUP=true` also keeps them in the paired region; use it only in
  a region whose pair stays in the UK or EU (UK South and UK West, for example).
- **Documents and reports** (Blob Storage): a deleted or overwritten file can be got back
  for 7 days: soft delete for files and containers, earlier versions, and point-in-time
  restore of a whole container.
- **The audit log**: copied every 5 minutes to write-once storage (below).

## Restore drill

`.github/workflows/restore-drill.yml`, run by hand (Actions, Restore drill, Run workflow).
It restores the dev Postgres server as it was a few minutes ago to a new, temporary server,
then runs the restore-check job inside the network against it:

- the same migrations as the live database;
- the app role signs in and sets a tenant's context there (so the context key came back);
- every tenant from before the restore point is there, with the same number of users,
  documents, jobs, review events and audit events;
- a document can be got back from its earlier version, and from its last version after
  being deleted.

It does not exercise point-in-time restore of a whole Blob container, which Azure offers
for the same 7 days (Azure portal, the storage account, Data protection, Restore
containers).

Then it deletes the temporary server, whatever happened. The run's summary shows the
check's output and how long the restore took. A run takes about 20 to 40 minutes, mostly
the restore.

### Restore record

Record each drill here, in your own copy, with a link to its run. (When this kit was built,
a restore of the B1ms dev server to 10 minutes before took 12 minutes and every check
passed.)

| Date | Environment | Restore point | Restore took | Result | Run |
| --- | --- | --- | --- | --- | --- |
| | | | | | |

## Restoring for real

Postgres cannot be restored in place: a point-in-time restore makes a new server.

1. Restore to a new server at the time you need: `az postgres flexible-server restore -g
   <rg> -n <new name> --source-server <server> --restore-time <UTC time>`, with the same
   `--subnet` and `--private-dns-zone` as the live server (the drill shows how).
2. Run the restore-check job against it, as the drill does, to see it is complete.
3. Point the apps at it: update the `database-url` and `database-admin-url` secrets in Key
   Vault to the new host, then restart the web and worker apps (new revisions).
4. Keep the old server until you are sure, then delete it. To keep the server's original
   name, change `postgresServerName` in the deploy instead.

A deleted document or report: undelete it, or restore its earlier version, in the storage
account (Azure portal, the container, Show deleted blobs or Versions), within 7 days.

## The audit log's write-once copy

Every 5 minutes, a Temporal schedule (`audit-copy`, created by the worker) copies each
tenant's audit events, up to the newest that is 2 minutes old and every event before it,
to the `audit` container of the audit storage account
(`staudit…`), as JSON lines in `epoch-{n}/tenants/{tenant_id}/{day}.jsonl`. (Events wait
2 minutes because an event's number is taken when it is written, not when it is
committed, and no app transaction lasts longer than a minute: after two, every earlier
event is in.) The container has a
time-based retention policy: for `AUDIT_RETENTION_DAYS` days (30 in dev) nothing written
can be changed or deleted, by the app or by an account owner; new lines can only be
appended. This is the record the database owner cannot alter (the database's own guard,
from task 13, stops the app but not a determined owner).

**It ships unlocked.** Until you lock the retention policy (below), anyone who can manage
the storage account, such as an Azure administrator, can shorten or remove it and then
delete the copy; only a locked policy makes it truly write-once. Locking cannot be undone,
so do it once the retention period is right. Only the worker's identity
(`id-agentcore-<env>-worker`) has access to the audit account, with Storage Blob Data
Contributor: the retention policy stops it changing or deleting anything younger than
`AUDIT_RETENTION_DAYS`, but a copy older than that it could delete. The web app, the
part on the internet, has no access to it at all. A custom role allowing only read and
add would close that gap; it is under "Later" in `docs/PLAN.md`, since the deploy
identity cannot create roles and it would need a one-off step by an owner.

Events deleted from the database before they are copied, which is at most about 7 minutes
after they happen, are not in the copy.

**After restoring the database to an earlier point**, the copy holds events the database
no longer has, and the copy stops for each tenant with an `audit-copy-failed` alert (reason
`CopyDiverged`) rather than guess. That record is worth keeping: it shows what happened
after the restore point. Set the GitHub variable `AUDIT_COPY_EPOCH` to one more than it was
(it starts at 1) and deploy: the copy starts again, complete, under `epoch-{n+1}/`, and the
earlier epoch stays as it was.

**Locking the policy.** In dev the policy is unlocked: still enforced, but an admin can
remove it, so the environment can be torn down. In production, set the retention a client
needs (seven years is common: `AUDIT_RETENTION_DAYS=2557`) and lock it once deployed:

```bash
az storage container immutability-policy lock --account-name <staudit…> -c audit \
  --if-match "$(az storage container immutability-policy show --account-name <staudit…> -c audit --query etag -o tsv)"
```

Then set the GitHub variable `AUDIT_POLICY_LOCKED=true`, so deploys leave the locked policy
alone (writing it again would fail). Locking cannot be undone: the retention can then only
be lengthened, and the storage account cannot be deleted until every blob in it is older
than the retention.

## Before production

The dev environment is the kit as it ships. These are left to each client, because the
right answer depends on its contracts and its customers. Settle them before real tenants
use a deployment.

- **Tenant erasure and export.** There is no way to remove a tenant, and a trigger
  refuses deleting one by any role (`0003_sign_in_security.sql`). A removed user keeps
  their row, email included, so their name stays on their history; `audit_events` holds
  email addresses and is append-only, and its write-once copy cannot be changed for
  `AUDIT_RETENTION_DAYS`. A client with GDPR duties must decide what erasure and export
  mean (delete the tenant's container, its rows, pseudonymise the audit log?) and build
  that, deliberately and itself audited, **before locking the audit copy's retention
  policy**, which cannot then be shortened.
- **Key rotation.** `TENANT_CONTEXT_KEY` signs every tenant context and the database
  holds the same key (`pnpm db:set-context-key`); there is no overlap period, so between
  changing it in Key Vault and in the database every query fails. Rotate it in a
  maintenance window: change the `tenant-context-key` secret in Key Vault, run the migrate
  job (it stores the key in the database on every run), then restart the web and worker
  apps so they read the new secret version, and check they do. `AUTH_SECRET` signs sessions and is single-valued: changing it signs
  everyone out. Neither has been rehearsed.
- **Scaling.** The worker runs one replica (`main.bicep`), four jobs at a time; the web
  app up to two. Each process's database pool allows 10 connections (opened as needed),
  against the 35 the default Postgres size (`Standard_B1ms`) leaves the apps, and the
  postgres-connections alert is set at 32 (`postgresConnectionAlert` in
  `infra/azure/modules/monitoring.bicep`). During a deploy the old and new revisions run
  side by side, and the migrate and other jobs connect too, so the count can briefly
  double. Before adding replicas, move Postgres to a larger size (`POSTGRES_SKU`) and
  raise the alert in that file to match.
- **Deploys.** The deploy runs the migrations, then the new apps. While it does, the
  previous revision still runs against the migrated database, and there is no rollback
  of a migration: write each change as expand then contract (add the new column, deploy
  code that uses it, remove the old one in a later deploy), never a rename or drop the
  running code needs. The migrate job refuses a migration edited after it was applied
  (restore it, and make the change in a new one), or one older than those applied (from
  upstream, say: give its journal entry's `when` a later time; the file stays as it is). There is only a `dev` pipeline and no
  custom domain setting: a production environment needs its own GitHub environment,
  Bicep parameters and approval rule.
