import { PortalShell } from "../../../../../components/shells.tsx";
import { Card, PageHeader } from "../../../../../components/ui/index.ts";
import { requireTenantPage } from "../../../../../lib/auth/guards.ts";

// The browser tab's title (WCAG 2.4.2): "Portal admin · <product name>".
export const metadata = { title: "Portal admin" };

export default async function TenantAdminPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const me = await requireTenantPage(slug, { admin: true });
  return (
    <PortalShell slug={slug} me={me} current="admin">
      <PageHeader title="Portal admin" description={`Signed in as ${me.displayName}.`} />
      <Card title="Users">
        <p>
          <a href={`/t/${slug}/admin/users`}>Users</a>: add people, change their role, remove them.
        </p>
      </Card>
      <Card title="Activity">
        <p>
          <a href={`/t/${slug}/admin/activity`}>Activity</a>: who changed users and settings, and
          who signed in.
        </p>
      </Card>
      <Card title="Sign-in">
        <p>
          <a href={`/t/${slug}/admin/sign-in`}>Sign-in settings</a>: how people sign in. The
          portal&apos;s operator links work account sign-in (Microsoft or Google); you can then turn
          off email links.
        </p>
      </Card>
    </PortalShell>
  );
}
