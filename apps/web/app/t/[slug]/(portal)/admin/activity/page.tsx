import { listAuditEvents, listRefusedSignIns } from "@agent-core/db";
import { refusalsSince } from "../../../../../../lib/audit/describe.ts";
import { Activity } from "../../../../../../components/activity.tsx";
import { PortalShell } from "../../../../../../components/shells.tsx";
import { PageHeader } from "../../../../../../components/ui/index.ts";
import { requireTenantPage } from "../../../../../../lib/auth/guards.ts";
import { db } from "../../../../../../lib/server/db.ts";

// The browser tab's title (WCAG 2.4.2): "Activity · <product name>".
export const metadata = { title: "Activity" };

export default async function ActivityPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const me = await requireTenantPage(slug, { admin: true });
  const [events, refusals] = await Promise.all([
    listAuditEvents(db(), me.tenantId, { limit: 100 }),
    listRefusedSignIns(db(), me.tenantId, refusalsSince()),
  ]);
  return (
    <PortalShell slug={slug} me={me} current="admin" inside>
      <PageHeader
        title="Activity"
        description="Who changed users and settings in this portal, and who signed in."
      />
      <Activity
        events={events}
        refusals={refusals}
        csvHref={`/api/t/${slug}/admin/audit`}
        view="tenant"
        title="Latest activity"
      />
    </PortalShell>
  );
}
