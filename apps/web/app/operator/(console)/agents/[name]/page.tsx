import { notFound } from "next/navigation";
import { OperatorShell } from "../../../../../components/shells.tsx";
import {
  Alert,
  Button,
  Card,
  EmptyState,
  PageHeader,
  Select,
  Table,
  Td,
  Th,
  Tr,
} from "../../../../../components/ui/index.ts";
import { requireOperatorPage } from "../../../../../lib/auth/guards.ts";
import { agentDetail, compareTestRuns } from "../../../../../lib/operator/agents.ts";
import { dateTimeUtc, dollars, percent, shortDate } from "../../../../../lib/operator/format.ts";

// The browser tab's title (WCAG 2.4.2): "Agent · <product name>".
export const metadata = { title: "Agent" };

type Step = {
  id?: string;
  block?: string;
  input?: string;
  prompt?: string;
  schema?: string;
  template?: string;
};

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

export default async function AgentPage({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const operator = await requireOperatorPage();
  const { name } = await params;
  const query = await searchParams;
  const agent = await agentDetail(name, one(query["version"]));
  if (!agent) notFound();
  const baseId = one(query["base"]);
  const currentId = one(query["current"]);
  const compared = baseId && currentId ? await compareTestRuns(name, baseId, currentId) : null;
  const definition = (agent.shown?.snapshot.definition ?? {}) as {
    accepts?: string[];
    steps?: Step[];
  };
  const runOptions = agent.runs.map((r) => ({
    value: r.runId,
    label: `${shortDate(r.finishedAt)} · ${r.version} · ${percent(r.accuracy)} right`,
  }));

  return (
    <OperatorShell name={operator.name ?? operator.email ?? "operator"} current="agents" inside>
      <PageHeader
        title={agent.title}
        description={
          agent.loadedVersion
            ? `${agent.name}, version ${agent.loadedVersion} running now${agent.isDefault ? " (the default for tenants with no agents chosen)" : ""}.`
            : `${agent.name}: this deployment no longer has this agent. Its recorded versions are below.`
        }
      />
      {agent.unreadable > 0 ? (
        <Alert tone="warning">
          {agent.unreadable === 1 ? "One tenant" : `${agent.unreadable} tenants`} could not be read
          just now, so its use and job counts are missing below.
        </Alert>
      ) : null}
      <Card title="Used by">
        {agent.tenants.length === 0 ? (
          <p>No tenant uses this agent.</p>
        ) : (
          <ul className="list-disc space-y-1 pl-5">
            {agent.tenants.map((t) => (
              <li key={t.tenantId}>
                <a href={`/operator/tenants/${t.tenantId}`}>{t.name}</a>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Versions">
        <Table caption="Versions of this agent">
          <thead>
            <tr>
              <Th>Version</Th>
              <Th>First run here</Th>
              <Th>Jobs in the last 30 days</Th>
            </tr>
          </thead>
          <tbody>
            {agent.versions.map((v) => (
              <Tr key={v.version}>
                <Td>
                  <a href={`/operator/agents/${agent.name}?version=${v.version}`}>
                    <code>{v.version}</code>
                  </a>
                  {v.loaded ? " (running now)" : ""}
                </Td>
                <Td>{v.recordedAt ? dateTimeUtc(v.recordedAt) : "–"}</Td>
                <Td>{v.jobs}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </Card>

      {agent.shown ? (
        <Card title={`Version ${agent.shown.version}`}>
          <div className="space-y-4">
            <p>Accepts: {(definition.accepts ?? []).join(", ") || "–"}</p>
            <div>
              <h3 className="font-semibold">Steps</h3>
              <ol className="list-decimal space-y-1 pl-5">
                {(definition.steps ?? []).map((s) => (
                  <li key={s.id}>
                    <code>{s.id}</code>: {s.block}
                    {s.input ? `, from ${s.input}` : ""}
                    {[s.prompt, s.schema, s.template].filter(Boolean).length > 0
                      ? ` (${[s.prompt, s.schema, s.template].filter(Boolean).join(", ")})`
                      : ""}
                  </li>
                ))}
              </ol>
            </div>
            <div className="space-y-2">
              <h3 className="font-semibold">Files</h3>
              {agent.shown.snapshot.files.map((f) =>
                f.text === null ? (
                  <p key={f.path}>
                    <code>{f.path}</code> ({Math.ceil(f.bytes / 1024)} KB)
                  </p>
                ) : (
                  <details key={f.path} className="rounded-md border border-line">
                    <summary className="cursor-pointer px-3 py-2">
                      <code>{f.path}</code>
                    </summary>
                    <pre
                      tabIndex={0}
                      aria-label={f.path}
                      className="max-h-96 overflow-auto whitespace-pre-wrap break-words border-t border-line px-3 py-2 text-sm"
                    >
                      {f.text}
                    </pre>
                  </details>
                ),
              )}
            </div>
          </div>
        </Card>
      ) : null}

      <Card title="Test runs">
        {agent.runs.length === 0 ? (
          <EmptyState title="No test runs yet.">
            The worker runs each new version&apos;s test set once, when it starts, with this
            deployment&apos;s model (never the demo model). An agent with no test set (a tests/
            folder beside agent.json; the demo agent uses samples/) is never run.
          </EmptyState>
        ) : (
          <div className="space-y-4">
            <Table caption="Test runs of this agent">
              <thead>
                <tr>
                  <Th>Finished</Th>
                  <Th>Version</Th>
                  <Th>Model</Th>
                  <Th>Runs</Th>
                  <Th>Right</Th>
                  <Th>Cost</Th>
                </tr>
              </thead>
              <tbody>
                {agent.runs.map((r) => (
                  <Tr key={r.runId}>
                    <Td>{dateTimeUtc(r.finishedAt)}</Td>
                    <Td>
                      <code>{r.version}</code>
                    </Td>
                    <Td>
                      {r.provider} {r.model}
                    </Td>
                    <Td>
                      {r.cases} cases × {r.repeats}
                    </Td>
                    <Td>{percent(r.accuracy)}</Td>
                    <Td>{dollars(r.costUsd)}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
            <form method="get" className="flex flex-wrap items-end gap-3">
              <Select
                label="Compare"
                name="base"
                options={runOptions}
                defaultValue={baseId ?? agent.runs[1]?.runId ?? agent.runs[0]?.runId}
              />
              <Select
                label="with"
                name="current"
                options={runOptions}
                defaultValue={currentId ?? agent.runs[0]?.runId}
              />
              <Button variant="secondary">Compare</Button>
            </form>
          </div>
        )}
      </Card>

      {baseId && currentId && !compared ? (
        <Alert tone="danger">Choose two test runs of this agent to compare.</Alert>
      ) : null}
      {compared ? (
        <Card title={`${compared.base.version} compared with ${compared.current.version}`}>
          <div className="space-y-4">
            <Table caption="Right answers per field">
              <thead>
                <tr>
                  <Th>Field</Th>
                  <Th>
                    {shortDate(compared.base.finishedAt)} · {compared.base.version}
                  </Th>
                  <Th>
                    {shortDate(compared.current.finishedAt)} · {compared.current.version}
                  </Th>
                </tr>
              </thead>
              <tbody>
                {compared.comparison.fields.map((f) => (
                  <Tr key={f.field}>
                    <Td>{f.field}</Td>
                    <Td>
                      {f.base
                        ? `${percent(f.base.right / f.base.total)} (${f.base.right}/${f.base.total})`
                        : "–"}
                    </Td>
                    <Td>
                      {percent(f.current.total ? f.current.right / f.current.total : null)} (
                      {f.current.right}/{f.current.total})
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
            {compared.comparison.changes.length === 0 ? (
              <p>No case changed.</p>
            ) : (
              <Table caption="Cases that changed (right out of the runs)">
                <thead>
                  <tr>
                    <Th>Case</Th>
                    <Th>Field</Th>
                    <Th>Before</Th>
                    <Th>After</Th>
                    <Th>Problem now</Th>
                  </tr>
                </thead>
                <tbody>
                  {compared.comparison.changes.map((c) => (
                    <Tr key={`${c.id}-${c.field}`}>
                      <Td>{c.id}</Td>
                      <Td>{c.field}</Td>
                      <Td>
                        {c.base}/{c.repeats}
                      </Td>
                      <Td>
                        {c.current}/{c.repeats}
                      </Td>
                      <Td>{c.problem ?? "–"}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </div>
        </Card>
      ) : null}
    </OperatorShell>
  );
}
