import { agentRegistry } from "@agent-core/core/agents";
import { listAuditEvents, listRefusedSignIns } from "@agent-core/db";
import { refusalsSince } from "../../../../../lib/audit/describe.ts";
import { Activity } from "../../../../../components/activity.tsx";
import { notFound } from "next/navigation";
import { OperatorShell } from "../../../../../components/shells.tsx";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Field,
  FormStack,
  PageHeader,
  Select,
  Table,
  Td,
  Th,
  Tr,
} from "../../../../../components/ui/index.ts";
import { requireOperatorPage } from "../../../../../lib/auth/guards.ts";
import {
  addAdminAction,
  emailLinksOnAction,
  linkSsoAction,
  setAgentsAction,
} from "../../../../../lib/operator/actions.ts";
import { tenantDetail } from "../../../../../lib/operator/tenants.ts";
import { db } from "../../../../../lib/server/db.ts";

// The browser tab's title (WCAG 2.4.2): "Tenant · <product name>".
export const metadata = { title: "Tenant" };

const DONE: Record<string, { tone: "success" | "danger"; text: string }> = {
  created: {
    tone: "success",
    text: "Tenant created. Its admin has been sent the sign-in address.",
  },
  "created-not-emailed": {
    tone: "success",
    text: "Tenant created, but no email could be sent to its admin just now. Give them the portal's address.",
  },
  "admin-added": { tone: "success", text: "Admin added, and sent the sign-in address." },
  "admin-added-not-emailed": {
    tone: "success",
    text: "Admin added, but no email could be sent to them just now. Give them the portal's address.",
  },
  "admin-promoted": { tone: "success", text: "That user is now an admin." },
  "already-admin": { tone: "danger", text: "That address is already an admin of this tenant." },
  email: { tone: "danger", text: "That is not an email address." },
  "sso-linked": { tone: "success", text: "Work account sign-in linked." },
  "sso-invalid": {
    tone: "danger",
    text: "For Microsoft, give the organisation's Entra tenant ID (a GUID); for Google, its Workspace domain.",
  },
  "email-links-on": { tone: "success", text: "Email sign-in links are on." },
  "agents-saved": { tone: "success", text: "Agents saved." },
};

export default async function TenantPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ done?: string }>;
}) {
  const operator = await requireOperatorPage();
  const { tenantId } = await params;
  const { done } = await searchParams;
  const tenant = await tenantDetail(tenantId);
  if (!tenant) notFound();
  const registry = await agentRegistry(process.env);
  const agents = [...registry.values()];
  const missing = tenant.agents.filter((name) => !registry.has(name));
  const [events, refusals] = await Promise.all([
    listAuditEvents(db(), tenant.tenantId, { limit: 20 }),
    listRefusedSignIns(db(), tenant.tenantId, refusalsSince()),
  ]);
  const outcome = done && Object.hasOwn(DONE, done) ? DONE[done] : undefined;
  const link = tenant.sso.link;
  return (
    <OperatorShell name={operator.name ?? operator.email ?? "operator"} inside>
      <PageHeader title={tenant.name} description={`Portal: /t/${tenant.slug}`} />
      {outcome ? (
        <Alert tone={outcome.tone} testId="tenant-outcome">
          {outcome.text}
        </Alert>
      ) : null}

      <Card title="Users">
        <Table caption="Users">
          <thead>
            <tr>
              <Th>Email</Th>
              <Th>Role</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {tenant.userList.map((u) => (
              <Tr key={u.userId}>
                <Td>{u.email}</Td>
                <Td>{u.role === "tenant_admin" ? "Admin" : "User"}</Td>
                <Td>{u.removedAt ? "Removed" : "Current"}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
        <p className="text-sm text-muted">
          The tenant&apos;s admins add and remove users. Add an admin here if they cannot.
        </p>
        <form action={addAdminAction.bind(null, tenant.tenantId)}>
          <FormStack>
            <Field
              label="Add an admin (email)"
              type="email"
              name="email"
              required
              autoComplete="off"
            />
            <div>
              <Button variant="secondary">Add admin</Button>
            </div>
          </FormStack>
        </form>
      </Card>

      <Card title="Work account sign-in">
        <p>
          {link
            ? link.provider === "google"
              ? `Linked to Google Workspace (${link.googleDomain}).`
              : `Linked to Microsoft (organisation ${link.entraTenantId}).`
            : "Not linked."}
        </p>
        <form action={linkSsoAction.bind(null, tenant.tenantId)}>
          <FormStack>
            <Select
              label="Provider"
              name="provider"
              defaultValue={link?.provider ?? "microsoft"}
              options={[
                { value: "microsoft", label: "Microsoft (Entra ID)" },
                { value: "google", label: "Google Workspace" },
              ]}
            />
            <Field
              label="Organisation"
              hint="Microsoft: the organisation's Entra tenant ID. Google: its Workspace domain, such as lawfirm.example."
              name="value"
              required
              autoComplete="off"
            />
            <div>
              <Button variant="secondary">{link ? "Change link" : "Link"}</Button>
            </div>
          </FormStack>
        </form>
      </Card>

      <Card title="Email sign-in links">
        <p>Email sign-in links are {tenant.sso.allowEmailLinks ? "on" : "off"}.</p>
        {!tenant.sso.allowEmailLinks ? (
          <form action={emailLinksOnAction.bind(null, tenant.tenantId)}>
            <Button variant="secondary">Turn email links back on</Button>
          </form>
        ) : (
          <p className="text-sm text-muted">The tenant&apos;s admins can turn them off.</p>
        )}
      </Card>

      <Card title="Agents">
        {missing.length > 0 ? (
          <Alert tone="warning" testId="agents-missing">
            Assigned but not in this deployment: {missing.join(", ")}.{" "}
            {missing.length === tenant.agents.length
              ? "This tenant cannot upload until you choose an agent here."
              : "Its users cannot use these."}{" "}
            Saving removes them.
          </Alert>
        ) : null}
        <form action={setAgentsAction.bind(null, tenant.tenantId)} className="space-y-3">
          <fieldset className="space-y-1">
            <legend className="text-sm text-muted">
              The agents this tenant&apos;s users can choose when they upload. With none ticked,
              uploads use this deployment&apos;s default agent.
            </legend>
            {agents.map((a) => (
              <div key={a.definition.name}>
                <Checkbox
                  name="agent"
                  value={a.definition.name}
                  defaultChecked={tenant.agents.includes(a.definition.name)}
                  label={`${a.definition.title} (${a.definition.name})`}
                />
              </div>
            ))}
          </fieldset>
          <Button variant="secondary">Save agents</Button>
        </form>
      </Card>

      <Activity
        events={events}
        refusals={refusals}
        csvHref={`/api/operator/tenants/${tenant.tenantId}/audit`}
        view="operator"
      />
    </OperatorShell>
  );
}
