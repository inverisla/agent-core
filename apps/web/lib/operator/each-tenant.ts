// Runs some work for every tenant, each inside its own context, for the operator console
// (task 16). A few tenants at a time, so a long list does not take every database
// connection; a tenant that cannot be read is counted, not fatal, so one bad tenant
// does not hide the others.
import { schema } from "@agent-core/db";
import { eq } from "drizzle-orm";
import { db } from "../server/db.ts";

const AT_ONCE = 4;

export interface TenantRef {
  tenantId: string;
  name: string;
}

export async function eachTenant<T>(
  work: (tenant: TenantRef) => Promise<T>,
): Promise<{ results: T[]; unreadable: number }> {
  const tenants = await db().listTenants();
  const results: T[] = [];
  let unreadable = 0;
  for (let i = 0; i < tenants.length; i += AT_ONCE) {
    const settled = await Promise.allSettled(
      tenants.slice(i, i + AT_ONCE).map(async (t) => {
        const [row] = await db().withTenant(t.tenantId, (tx) =>
          tx
            .select({ name: schema.tenants.name })
            .from(schema.tenants)
            .where(eq(schema.tenants.tenantId, t.tenantId)),
        );
        return work({ tenantId: t.tenantId, name: row?.name ?? t.slug });
      }),
    );
    for (const s of settled) {
      if (s.status === "fulfilled") results.push(s.value);
      else {
        unreadable += 1;
        console.error(
          `operator console: a tenant could not be read: ${s.reason instanceof Error ? s.reason.name : "unknown"}`,
        );
      }
    }
  }
  return { results, unreadable };
}
