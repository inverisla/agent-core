"use server";
// The tenant admin pages' actions (task 12b): add a user, change a role, remove a user.
// The tenant's own admins only. The database refuses anything that would leave the
// tenant with no admin, and an admin removing themselves.
import {
  addTenantUser,
  normaliseEmail,
  removeTenantUser,
  schema,
  setTenantUserRole,
  type TenantUserRole,
} from "@agent-core/db";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { checkTenant } from "../auth/guards.ts";
import { tenantActor } from "../auth/actors.ts";
import { welcomeWithinLimits } from "../email/welcome.ts";
import { db } from "../server/db.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLES = new Set<string>(["tenant_admin", "tenant_user"]);

async function adminOnly(slug: string) {
  const access = await checkTenant(slug, { admin: true });
  if (!access.ok) redirect(`/t/${encodeURIComponent(slug)}/sign-in`);
  return access.value;
}

const back = (slug: string, outcome: string): never =>
  redirect(`/t/${encodeURIComponent(slug)}/admin/users?done=${outcome}`);

export async function addUserAction(slug: string, formData: FormData) {
  const me = await adminOnly(slug);
  const email = String(formData.get("email") ?? "").trim();
  const role = String(formData.get("role") ?? "tenant_user");
  if (!normaliseEmail(email)) back(slug, "email");
  if (!ROLES.has(role)) back(slug, "invalid");
  try {
    await addTenantUser(
      db(),
      me.tenantId,
      { email, role: role as TenantUserRole },
      tenantActor(me),
    );
  } catch {
    back(slug, "already-a-user");
  }
  const [tenant] = await db().withTenant(me.tenantId, (tx) =>
    tx
      .select({ name: schema.tenants.name })
      .from(schema.tenants)
      .where(eq(schema.tenants.tenantId, me.tenantId)),
  );
  const sent = await welcomeWithinLimits(db(), me.tenantId, {
    to: email,
    slug,
    tenantName: tenant?.name ?? slug,
    role: role as TenantUserRole,
  });
  if (!sent) back(slug, "added-not-emailed");
  back(slug, "added");
}

export async function setRoleAction(slug: string, userId: string, formData: FormData) {
  const me = await adminOnly(slug);
  const role = String(formData.get("role") ?? "");
  if (!UUID.test(userId) || !ROLES.has(role)) back(slug, "invalid");
  const result = await setTenantUserRole(
    db(),
    me.tenantId,
    {
      userId,
      role: role as TenantUserRole,
    },
    tenantActor(me),
  );
  // An admin who made themselves a user can no longer see this page: go to the portal.
  if (result.ok && userId === me.userId && role !== "tenant_admin")
    redirect(`/t/${encodeURIComponent(slug)}`);
  back(slug, result.ok ? "role-changed" : result.reason);
}

export async function removeUserAction(slug: string, userId: string) {
  const me = await adminOnly(slug);
  if (!UUID.test(userId)) back(slug, "invalid");
  const result = await removeTenantUser(db(), me.tenantId, { userId }, tenantActor(me));
  back(slug, result.ok ? "removed" : result.reason);
}
