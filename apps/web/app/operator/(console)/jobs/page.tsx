import { OperatorShell } from "../../../../components/shells.tsx";
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Field,
  PageHeader,
  Select,
  StatusBadge,
  Table,
  Td,
  Th,
  Tr,
} from "../../../../components/ui/index.ts";
import { requireOperatorPage } from "../../../../lib/auth/guards.ts";
import { dateTimeUtc } from "../../../../lib/operator/format.ts";
import { findJob, JOB_LIST_LIMIT, listJobsAcrossTenants } from "../../../../lib/operator/jobs.ts";

// The browser tab's title (WCAG 2.4.2): "Jobs · <product name>".
export const metadata = { title: "Jobs" };

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v.trim() : "");

export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const operator = await requireOperatorPage();
  const query = await searchParams;
  const jobId = one(query["job"]);
  const failedOnly = one(query["show"]) === "failed";
  // A search shows that job only; otherwise the list.
  const search = jobId ? await findJob(jobId) : null;
  const found = search?.job ?? null;
  const list = jobId ? null : await listJobsAcrossTenants({ failedOnly });
  const unreadable = (search?.unreadable ?? 0) + (list?.unreadable ?? 0);
  return (
    <OperatorShell name={operator.name ?? operator.email ?? "operator"} current="jobs">
      <PageHeader
        title="Jobs"
        description="Every tenant's jobs, for support: status, attempts and reason codes only, never a document's name or content. A failed-job alert gives the job ID."
      />
      <Card title="Find a job">
        <form method="get" className="flex flex-wrap items-end gap-3">
          <Field label="Job ID" name="job" defaultValue={jobId} className="font-mono" />
          <Button variant="secondary">Find</Button>
        </form>
      </Card>
      {unreadable > 0 ? (
        <Alert tone="warning">
          {unreadable === 1 ? "One tenant" : `${unreadable} tenants`} could not be read just now, so{" "}
          {unreadable === 1 ? "its" : "their"} jobs are missing here. Try again in a moment.
        </Alert>
      ) : null}
      {jobId && !found ? (
        <Alert tone="danger" testId="job-not-found">
          No tenant has a job with that ID.
        </Alert>
      ) : null}
      {found ? (
        <Card title={`Job ${found.jobId}`}>
          <div className="space-y-4" data-testid="found-job">
            <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-[max-content_1fr]">
              <dt className="font-semibold">Tenant</dt>
              <dd>
                <a href={`/operator/tenants/${found.tenantId}`}>{found.tenantName}</a>
              </dd>
              <dt className="font-semibold">Status</dt>
              <dd>
                <StatusBadge status={found.status} />
              </dd>
              <dt className="font-semibold">Agent</dt>
              <dd>
                <a href={`/operator/agents/${found.agentName}?version=${found.agentVersion}`}>
                  {found.agentName} {found.agentVersion}
                </a>
              </dd>
              <dt className="font-semibold">Created</dt>
              <dd>{dateTimeUtc(found.createdAt)}</dd>
              <dt className="font-semibold">Last change</dt>
              <dd>{dateTimeUtc(found.updatedAt)}</dd>
            </dl>
            {found.attempts.length === 0 ? (
              <p>No attempts yet.</p>
            ) : (
              <Table caption="Attempts">
                <thead>
                  <tr>
                    <Th>Run</Th>
                    <Th>Attempt</Th>
                    <Th>Outcome</Th>
                    <Th>Reason</Th>
                    <Th>Started</Th>
                    <Th>Finished</Th>
                  </tr>
                </thead>
                <tbody>
                  {found.attempts.map((a) => (
                    <Tr key={`${a.run}-${a.attempt}`}>
                      <Td>{a.run}</Td>
                      <Td>{a.attempt}</Td>
                      <Td>
                        <StatusBadge status={a.outcome} />
                      </Td>
                      <Td>{a.errorCode ? <code>{a.errorCode}</code> : "–"}</Td>
                      <Td>{dateTimeUtc(a.startedAt)}</Td>
                      <Td>{a.finishedAt ? dateTimeUtc(a.finishedAt) : "–"}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </div>
        </Card>
      ) : null}
      {list ? (
        <Card title="Recent jobs">
          <div className="space-y-4">
            <form method="get" className="flex flex-wrap items-end gap-3">
              <Select
                label="Show"
                name="show"
                defaultValue={failedOnly ? "failed" : "all"}
                options={[
                  { value: "all", label: "All jobs" },
                  { value: "failed", label: "Failed jobs only" },
                ]}
              />
              <Button variant="secondary">Show</Button>
            </form>
            {list.jobs.length === 0 ? (
              <EmptyState title={failedOnly ? "No failed jobs." : "No jobs yet."} />
            ) : (
              <Table
                caption={`The ${JOB_LIST_LIMIT} most recently changed ${failedOnly ? "failed " : ""}jobs at most`}
              >
                <thead>
                  <tr>
                    <Th>Last change</Th>
                    <Th>Tenant</Th>
                    <Th>Job</Th>
                    <Th>Agent</Th>
                    <Th>Status</Th>
                    <Th>Attempts</Th>
                    <Th>Reason</Th>
                  </tr>
                </thead>
                <tbody>
                  {list.jobs.map((j) => (
                    <Tr key={j.jobId}>
                      <Td>{dateTimeUtc(j.updatedAt)}</Td>
                      <Td>
                        <a href={`/operator/tenants/${j.tenantId}`}>{j.tenantName}</a>
                      </Td>
                      <Td>
                        <a href={`/operator/jobs?job=${j.jobId}`}>
                          <code>{j.jobId.slice(0, 8)}</code>
                        </a>
                      </Td>
                      <Td>
                        {j.agentName} <code>{j.agentVersion}</code>
                      </Td>
                      <Td>
                        <StatusBadge status={j.status} />
                      </Td>
                      <Td>{j.attempts}</Td>
                      <Td>{j.errorCode ? <code>{j.errorCode}</code> : "–"}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </div>
        </Card>
      ) : (
        <p>
          <a href="/operator/jobs">Back to the recent jobs</a>
        </p>
      )}
    </OperatorShell>
  );
}
