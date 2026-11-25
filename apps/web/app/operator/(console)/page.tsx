import { OperatorShell } from "../../../components/shells.tsx";
import {
  ButtonLink,
  EmptyState,
  PageHeader,
  Table,
  Td,
  Th,
  Tr,
} from "../../../components/ui/index.ts";
import { requireOperatorPage } from "../../../lib/auth/guards.ts";
import { listTenantSummaries } from "../../../lib/operator/tenants.ts";

// The browser tab's title (WCAG 2.4.2): "Tenants · <product name>".
export const metadata = { title: "Tenants" };

const signIn = (t: Awaited<ReturnType<typeof listTenantSummaries>>[number]) => {
  const link = t.sso.link
    ? t.sso.link.provider === "google"
      ? `Google (${t.sso.link.googleDomain})`
      : "Microsoft"
    : null;
  const links = t.sso.allowEmailLinks ? "email links" : null;
  return [link, links].filter(Boolean).join(", ") || "none";
};

export default async function OperatorHomePage() {
  const operator = await requireOperatorPage();
  const name = operator.name ?? operator.email ?? "operator";
  const tenants = await listTenantSummaries();
  return (
    <OperatorShell name={name}>
      <PageHeader
        title="Tenants"
        description="Each tenant has its own portal, users and agents."
        actions={
          <ButtonLink href="/operator/tenants/new" variant="primary">
            New tenant
          </ButtonLink>
        }
      />
      {tenants.length === 0 ? (
        <EmptyState title="No tenants yet.">Create the first one with New tenant.</EmptyState>
      ) : (
        <Table caption="Tenants">
          <thead>
            <tr>
              <Th>Tenant</Th>
              <Th>Portal</Th>
              <Th>Users</Th>
              <Th>Sign-in</Th>
              <Th>Agents</Th>
            </tr>
          </thead>
          <tbody>
            {tenants.map((t) => (
              <Tr key={t.tenantId}>
                <Td>
                  <a href={`/operator/tenants/${t.tenantId}`}>{t.name}</a>
                </Td>
                <Td>/t/{t.slug}</Td>
                <Td>
                  {t.users} ({t.admins} {t.admins === 1 ? "admin" : "admins"})
                </Td>
                <Td>{signIn(t)}</Td>
                <Td>{t.agents.length > 0 ? t.agents.join(", ") : "default"}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </OperatorShell>
  );
}
