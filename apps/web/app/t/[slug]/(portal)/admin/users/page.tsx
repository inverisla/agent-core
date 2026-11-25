import { listTenantUsers } from "@agent-core/db";
import { PortalShell } from "../../../../../../components/shells.tsx";
import {
  Alert,
  Button,
  Card,
  Field,
  FormStack,
  PageHeader,
  Select,
} from "../../../../../../components/ui/index.ts";
import { requireTenantPage } from "../../../../../../lib/auth/guards.ts";
import {
  addUserAction,
  removeUserAction,
  setRoleAction,
} from "../../../../../../lib/tenant-admin/actions.ts";
import { db } from "../../../../../../lib/server/db.ts";

// The browser tab's title (WCAG 2.4.2): "Users · <product name>".
export const metadata = { title: "Users" };

const DONE: Record<string, { tone: "success" | "danger"; text: string }> = {
  added: { tone: "success", text: "User added, and sent the sign-in address." },
  "added-not-emailed": {
    tone: "success",
    text: "User added, but no email could be sent to them just now. They can sign in from the portal's address.",
  },
  "role-changed": { tone: "success", text: "Role changed." },
  removed: { tone: "success", text: "User removed. They can no longer sign in." },
  email: { tone: "danger", text: "That is not an email address." },
  "already-a-user": { tone: "danger", text: "That address is already a user of this portal." },
  "last-admin": {
    tone: "danger",
    text: "That would leave the portal with no admin. Make someone else an admin first.",
  },
  self: { tone: "danger", text: "You cannot remove yourself. Ask another admin." },
  "not-found": { tone: "danger", text: "That user is no longer here." },
  invalid: { tone: "danger", text: "That change could not be made." },
};

const ROLES = [
  { value: "tenant_user", label: "User" },
  { value: "tenant_admin", label: "Admin" },
];

export default async function UsersPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ done?: string }>;
}) {
  const { slug } = await params;
  const { done } = await searchParams;
  const me = await requireTenantPage(slug, { admin: true });
  const users = await listTenantUsers(db(), me.tenantId);
  const outcome = done && Object.hasOwn(DONE, done) ? DONE[done] : undefined;
  return (
    <PortalShell slug={slug} me={me} current="admin" inside>
      <PageHeader
        title="Users"
        description="Who can sign in to this portal, and what they can do."
      />
      {outcome ? (
        <Alert tone={outcome.tone} testId="users-outcome">
          {outcome.text}
        </Alert>
      ) : null}
      <Card title="Add a user">
        <form action={addUserAction.bind(null, slug)}>
          <FormStack>
            <Field label="Email" type="email" name="email" required autoComplete="off" />
            <Select label="Role" name="role" defaultValue="tenant_user" options={ROLES} />
            <div>
              <Button>Add user</Button>
            </div>
          </FormStack>
        </form>
      </Card>
      {/* A list rather than a table, so each user's controls wrap under them on a phone. */}
      <Card title="All users">
        <ul className="divide-y divide-line">
          {users.map((u) => (
            <li
              key={u.userId}
              data-testid="user"
              className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 py-4 first:pt-0 last:pb-0"
            >
              <div className="min-w-0 space-y-0.5">
                <p className="break-all font-semibold">
                  {u.email}
                  {u.userId === me.userId ? (
                    <span className="font-normal text-muted"> (you)</span>
                  ) : null}
                </p>
                <p className="text-sm text-muted">
                  {u.removedAt
                    ? "Removed. Add them again to restore them."
                    : u.role === "tenant_admin"
                      ? "Admin"
                      : "User"}
                </p>
              </div>
              {u.removedAt ? null : (
                <div className="flex flex-wrap items-end gap-3">
                  <form
                    action={setRoleAction.bind(null, slug, u.userId)}
                    className="flex items-end gap-2"
                  >
                    <Select
                      label={
                        <>
                          Role<span className="sr-only"> for {u.email}</span>
                        </>
                      }
                      name="role"
                      defaultValue={u.role}
                      options={ROLES}
                      className="min-w-28"
                    />
                    <Button variant="secondary" aria-label={`Change role for ${u.email}`}>
                      Change
                    </Button>
                  </form>
                  {u.userId !== me.userId ? (
                    <form action={removeUserAction.bind(null, slug, u.userId)}>
                      <Button variant="danger" aria-label={`Remove ${u.email}`}>
                        Remove
                      </Button>
                    </form>
                  ) : null}
                </div>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </PortalShell>
  );
}
