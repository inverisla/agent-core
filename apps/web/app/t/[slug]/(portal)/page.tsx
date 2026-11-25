import { PortalShell } from "../../../../components/shells.tsx";
import { ButtonLink, Card, PageHeader } from "../../../../components/ui/index.ts";
import { requireTenantPage } from "../../../../lib/auth/guards.ts";

// The browser tab's title (WCAG 2.4.2): "Portal · <product name>".
export const metadata = { title: "Portal" };

export default async function TenantHomePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const me = await requireTenantPage(slug);
  return (
    <PortalShell slug={slug} me={me} current="home">
      <PageHeader
        title="Portal"
        description={`Signed in as ${me.displayName} (${me.role === "tenant_admin" ? "admin" : "user"}).`}
      />
      <Card title="Documents">
        <p>Upload a contract to have it summarised, and see the summaries of earlier uploads.</p>
        <ButtonLink href={`/t/${slug}/documents`} variant="primary">
          Documents
        </ButtonLink>
      </Card>
    </PortalShell>
  );
}
