"use server";
// The operator console's actions (task 12b): create a tenant with its first admin, add
// an admin, link a tenant's Microsoft or Google sign-in, turn its email links back on,
// and choose its agents. Operators only; every tenant change runs in that tenant's
// own context.
import { agentRegistry } from "@agent-core/core/agents";
import {
  addTenantUser,
  type AuditActor,
  createTenantWithAdmin,
  linkTenantSso,
  listTenantUsers,
  normaliseEmail,
  setAllowEmailLinks,
  setTenantAgents,
  setTenantUserRole,
  slugProblem,
} from "@agent-core/db";
import { redirect } from "next/navigation";
import { operatorActor } from "../auth/actors.ts";
import { checkOperator } from "../auth/guards.ts";
import { welcomeWithinLimits } from "../email/welcome.ts";
import { db } from "../server/db.ts";
import { tenantDetail } from "./tenants.ts";

const MAX_NAME = 200;

/** The signed-in operator, as the actor for the audit log. */
async function operatorOnly(): Promise<AuditActor> {
  const access = await checkOperator();
  if (!access.ok) redirect("/operator/sign-in");
  return operatorActor(access.value);
}

/** The tenant, or back to the list if there is no such tenant. */
async function tenantOrList(tenantId: string) {
  const tenant = await tenantDetail(tenantId);
  if (!tenant) redirect("/operator");
  return tenant;
}

const toTenant = (tenantId: string, outcome: string): never =>
  redirect(`/operator/tenants/${tenantId}?done=${outcome}`);

export async function createTenantAction(formData: FormData) {
  const actor = await operatorOnly();
  const name = String(formData.get("name") ?? "").trim();
  const slug = String(formData.get("slug") ?? "")
    .trim()
    .toLowerCase();
  const adminEmail = String(formData.get("adminEmail") ?? "").trim();
  const fail = (error: string): never =>
    redirect(
      `/operator/tenants/new?error=${error}&name=${encodeURIComponent(name)}&slug=${encodeURIComponent(slug)}&adminEmail=${encodeURIComponent(adminEmail)}`,
    );
  if (!name || name.length > MAX_NAME) fail("name");
  if (slugProblem(slug) !== null) fail("slug");
  if (!normaliseEmail(adminEmail)) fail("email");
  if ((await db().tenantIdForSlug(slug)) !== null) fail("slug-taken");
  let tenantId: string;
  try {
    tenantId = await createTenantWithAdmin(db(), { name, slug, adminEmail }, actor);
  } catch (error) {
    // Another operator took the slug at the same moment.
    const cause =
      error instanceof Error ? (error.cause as { code?: string } | undefined) : undefined;
    if (cause?.code === "23505") fail("slug-taken");
    throw error;
  }
  // Within the sending limits (review S14); past them the admin asks for a link instead.
  const sent = await welcomeWithinLimits(db(), tenantId, {
    to: adminEmail,
    slug,
    tenantName: name,
    role: "tenant_admin",
  });
  toTenant(tenantId, sent ? "created" : "created-not-emailed");
}

export async function addAdminAction(tenantId: string, formData: FormData) {
  const actor = await operatorOnly();
  const tenant = await tenantOrList(tenantId);
  const email = normaliseEmail(String(formData.get("email") ?? ""));
  if (!email) return toTenant(tenantId, "email");
  // A current user of the tenant is made an admin; anyone else is added as one.
  const current = (await listTenantUsers(db(), tenantId)).find(
    (u) => !u.removedAt && u.email.toLowerCase() === email,
  );
  if (current) {
    if (current.role === "tenant_admin") toTenant(tenantId, "already-admin");
    await setTenantUserRole(
      db(),
      tenantId,
      { userId: current.userId, role: "tenant_admin" },
      actor,
    );
    toTenant(tenantId, "admin-promoted");
  }
  try {
    await addTenantUser(db(), tenantId, { email, role: "tenant_admin" }, actor);
  } catch (error) {
    // Added at the same moment by someone else; anything else is a real failure.
    if (error instanceof Error && /already a user/.test(error.message)) {
      toTenant(tenantId, "already-admin");
    }
    throw error;
  }
  const sent = await welcomeWithinLimits(db(), tenantId, {
    to: email,
    slug: tenant.slug,
    tenantName: tenant.name,
    role: "tenant_admin",
  });
  toTenant(tenantId, sent ? "admin-added" : "admin-added-not-emailed");
}

export async function linkSsoAction(tenantId: string, formData: FormData) {
  const actor = await operatorOnly();
  await tenantOrList(tenantId);
  const provider = String(formData.get("provider") ?? "");
  const value = String(formData.get("value") ?? "");
  try {
    if (provider === "microsoft") {
      await linkTenantSso(db(), tenantId, { provider: "microsoft", entraTenantId: value }, actor);
    } else if (provider === "google") {
      await linkTenantSso(db(), tenantId, { provider: "google", googleDomain: value }, actor);
    } else {
      toTenant(tenantId, "sso-invalid");
    }
  } catch {
    toTenant(tenantId, "sso-invalid");
  }
  toTenant(tenantId, "sso-linked");
}

export async function emailLinksOnAction(tenantId: string) {
  const actor = await operatorOnly();
  await tenantOrList(tenantId);
  await setAllowEmailLinks(db(), tenantId, true, actor);
  toTenant(tenantId, "email-links-on");
}

export async function setAgentsAction(tenantId: string, formData: FormData) {
  const actor = await operatorOnly();
  await tenantOrList(tenantId);
  // Only agents this deployment has: a name from the form is never trusted on its own.
  const loaded = await agentRegistry(process.env);
  const chosen = formData
    .getAll("agent")
    .map(String)
    .filter((name) => loaded.has(name));
  await setTenantAgents(db(), tenantId, chosen, actor);
  toTenant(tenantId, "agents-saved");
}
