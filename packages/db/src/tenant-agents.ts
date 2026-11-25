// The agents a tenant may use (task 12b), chosen by an operator. A tenant with none uses
// the deployment's default agent. Always inside the tenant's context.
import { asc, eq } from "drizzle-orm";
import { tenantAgents } from "./schema.ts";
import { recordAudit, type AuditActor } from "./audit.ts";
import type { TenantDatabase } from "./tenant-context.ts";

const AGENT_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

export async function getTenantAgents(db: TenantDatabase, tenantId: string): Promise<string[]> {
  const rows = await db.withTenant(tenantId, (tx) =>
    tx
      .select({ name: tenantAgents.agentName })
      .from(tenantAgents)
      .where(eq(tenantAgents.tenantId, tenantId))
      .orderBy(asc(tenantAgents.agentName)),
  );
  return rows.map((r) => r.name);
}

/** Replaces the tenant's agents with `names` (agent folder names). */
export async function setTenantAgents(
  db: TenantDatabase,
  tenantId: string,
  names: string[],
  actor: AuditActor,
): Promise<void> {
  const unique = [...new Set(names)];
  for (const name of unique) {
    if (!AGENT_NAME.test(name)) throw new Error(`Not an agent name: ${name}`);
  }
  await db.withTenant(tenantId, async (tx) => {
    const before = (await tx.select({ name: tenantAgents.agentName }).from(tenantAgents))
      .map((r) => r.name)
      .sort();
    const after = [...unique].sort();
    // Saving the same agents again is not a change: no audit row.
    if (before.join(",") === after.join(",")) return;
    await tx.delete(tenantAgents).where(eq(tenantAgents.tenantId, tenantId));
    if (unique.length > 0) {
      await tx.insert(tenantAgents).values(unique.map((agentName) => ({ tenantId, agentName })));
    }
    await recordAudit(tx, tenantId, actor, "agents.changed", { agents: after, before });
  });
}
