import { OperatorShell } from "../../../../components/shells.tsx";
import {
  Alert,
  Button,
  ButtonLink,
  Card,
  EmptyState,
  Field,
  PageHeader,
  Table,
  Td,
  Th,
  Tr,
} from "../../../../components/ui/index.ts";
import { requireOperatorPage } from "../../../../lib/auth/guards.ts";
import { currentMonth, USAGE_COLUMNS, usageForMonth } from "../../../../lib/operator/usage.ts";

// The browser tab's title (WCAG 2.4.2): "Usage · <product name>".
export const metadata = { title: "Usage" };

const number = new Intl.NumberFormat("en-GB");

export default async function UsagePage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const operator = await requireOperatorPage();
  const asked = (await searchParams).month;
  const month = typeof asked === "string" && asked !== "" ? asked : currentMonth();
  const rows = await usageForMonth(month);
  return (
    <OperatorShell name={operator.name ?? operator.email ?? "operator"} current="usage">
      <PageHeader
        title="Usage"
        description="Each tenant's documents, jobs and model use in a calendar month (UTC). Cost is estimated from the price list at the time of each call."
      />
      <Card title="Month">
        <form method="get" className="flex flex-wrap items-end gap-3">
          <Field label="Month" type="month" name="month" defaultValue={month} required />
          <Button variant="secondary">Show</Button>
          {rows ? (
            <ButtonLink href={`/api/operator/usage?month=${month}`}>Download CSV</ButtonLink>
          ) : null}
        </form>
      </Card>
      {!rows ? (
        <Alert tone="danger" testId="usage-month">
          Give the month as YYYY-MM, such as {currentMonth()}.
        </Alert>
      ) : rows.length === 0 ? (
        <EmptyState title="No tenants yet.">Usage shows here once you create one.</EmptyState>
      ) : (
        <Table caption={`Usage in ${month}`}>
          <thead>
            <tr>
              <Th>Tenant</Th>
              {USAGE_COLUMNS.map((c) => (
                <Th key={c.key}>{c.label}</Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Tr key={r.tenantId}>
                <Td>
                  <a href={`/operator/tenants/${r.tenantId}`}>{r.name}</a>
                </Td>
                {USAGE_COLUMNS.map((c) => (
                  <Td key={c.key}>
                    {c.key === "costUsd"
                      ? `$${Number(r.costUsd).toFixed(2)}`
                      : number.format(r[c.key] as number)}
                  </Td>
                ))}
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </OperatorShell>
  );
}
