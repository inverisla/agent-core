// The operator console's view of tenants (task 12b). The tenant list comes from the slug
// directory; each tenant's details are read inside that tenant's own context, as every
// tenant read is. Only for a signed-in operator: callers check first.
import {
  getTenantAgents,
  getTenantSso,
  listTenantUsers,
  schema,
  type TenantSsoSettings,
  type TenantUser,
} from "@agent-core/db";
import { eq } from "drizzle-orm";
import { db } from "../server/db.ts";

export interface TenantSummary {
  tenantId: string;
  slug: string;
  name: string;
  users: number;
  admins: number;
  sso: TenantSsoSettings;
  agents: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function summary(
  tenantId: string,
  slug: string,
  users: TenantUser[],
): Promise<TenantSummary> {
  const [row] = await db().withTenant(tenantId, (tx) =>
    tx
      .select({ name: schema.tenants.name })
      .from(schema.tenants)
      .where(eq(schema.tenants.tenantId, tenantId)),
  );
  const current = users.filter((u) => !u.removedAt);
  return {
    tenantId,
    slug,
    name: row?.name ?? slug,
    users: current.length,
    admins: current.filter((u) => u.role === "tenant_admin").length,
    sso: await getTenantSso(db(), tenantId),
    agents: await getTenantAgents(db(), tenantId),
  };
}

export async function listTenantSummaries(): Promise<TenantSummary[]> {
  const tenants = await db().listTenants();
  return Promise.all(
    tenants.map(async (t) => summary(t.tenantId, t.slug, await listTenantUsers(db(), t.tenantId))),
  );
}

/** One tenant with its users, or null (also for anything that is not a tenant ID). */
export async function tenantDetail(
  tenantId: string,
): Promise<(TenantSummary & { userList: TenantUser[] }) | null> {
  if (!UUID.test(tenantId)) return null;
  const found = (await db().listTenants()).find((t) => t.tenantId === tenantId);
  if (!found) return null;
  const users = await listTenantUsers(db(), tenantId);
  return { ...(await summary(tenantId, found.slug, users)), userList: users };
}
