import { OperatorShell } from "../../../../components/shells.tsx";
import {
  Alert,
  EmptyState,
  PageHeader,
  Table,
  Td,
  Th,
  Tr,
} from "../../../../components/ui/index.ts";
import { requireOperatorPage } from "../../../../lib/auth/guards.ts";
import { listAgentOverviews } from "../../../../lib/operator/agents.ts";
import { percent, shortDate } from "../../../../lib/operator/format.ts";

// The browser tab's title (WCAG 2.4.2): "Agents · <product name>".
export const metadata = { title: "Agents" };

export default async function AgentsPage() {
  const operator = await requireOperatorPage();
  const { agents, unreadable } = await listAgentOverviews();
  return (
    <OperatorShell name={operator.name ?? operator.email ?? "operator"} current="agents">
      <PageHeader
        title="Agents"
        description="The agents this deployment runs. Agents are files under agents/ and change by pull request; each new version's test set runs once, with this deployment's model."
      />
      {unreadable > 0 ? (
        <Alert tone="warning">
          {unreadable === 1 ? "One tenant" : `${unreadable} tenants`} could not be read just now, so
          &ldquo;Used by&rdquo; may be missing {unreadable === 1 ? "it" : "them"}.
        </Alert>
      ) : null}
      {agents.length === 0 ? (
        <EmptyState title="No agents.">Add one under agents/ (see docs/agents.md).</EmptyState>
      ) : (
        <Table caption="Agents">
          <thead>
            <tr>
              <Th>Agent</Th>
              <Th>Version</Th>
              <Th>Steps</Th>
              <Th>Used by</Th>
              <Th>Latest test</Th>
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => (
              <Tr key={a.name}>
                <Td>
                  <a href={`/operator/agents/${a.name}`}>{a.title}</a>
                  <div className="text-sm text-muted">
                    {a.name}
                    {a.isDefault ? " (the default)" : ""}
                  </div>
                </Td>
                <Td>
                  <code>{a.version}</code>
                </Td>
                <Td>{a.steps.map((s) => s.block).join(", ")}</Td>
                <Td>
                  {a.tenants.length === 0
                    ? "no tenant"
                    : a.tenants.length === 1
                      ? (a.tenants[0]?.name ?? "")
                      : `${a.tenants.length} tenants`}
                </Td>
                <Td>
                  {a.latestRun
                    ? `${percent(a.latestRun.accuracy)} right, ${shortDate(a.latestRun.finishedAt)}`
                    : "not run yet"}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </OperatorShell>
  );
}
