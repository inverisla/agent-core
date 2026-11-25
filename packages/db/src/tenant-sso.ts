// A tenant's single sign-on link (Microsoft or Google) and its email-link switch.
import { eq, sql } from "drizzle-orm";
import { tenantSso } from "./schema.ts";
import { recordAudit, type AuditActor } from "./audit.ts";
import type { TenantDatabase } from "./tenant-context.ts";

export type SsoLink =
  { provider: "microsoft"; entraTenantId: string } | { provider: "google"; googleDomain: string };

export interface TenantSsoSettings {
  link: SsoLink | null;
  allowEmailLinks: boolean;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOMAIN = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

/** Checks and normalises a link: lowercase GUID or domain. Throws if malformed. */
export function normaliseSsoLink(link: SsoLink): SsoLink {
  if (link.provider === "microsoft") {
    const id = link.entraTenantId.trim().toLowerCase();
    if (!GUID.test(id))
      throw new Error("A Microsoft organisation is identified by its Entra tenant ID (a GUID).");
    return { provider: "microsoft", entraTenantId: id };
  }
  const domain = link.googleDomain.trim().toLowerCase();
  if (!DOMAIN.test(domain))
    throw new Error("A Google Workspace link needs a domain, such as lawfirm.example.");
  return { provider: "google", googleDomain: domain };
}

export async function getTenantSso(
  db: TenantDatabase,
  tenantId: string,
): Promise<TenantSsoSettings> {
  return db.withTenant(tenantId, async (tx) => {
    const [row] = await tx.select().from(tenantSso);
    if (!row) return { link: null, allowEmailLinks: true };
    const link: SsoLink =
      row.provider === "microsoft"
        ? { provider: "microsoft", entraTenantId: row.entraTenantId ?? "" }
        : { provider: "google", googleDomain: row.googleDomain ?? "" };
    return { link, allowEmailLinks: row.allowEmailLinks };
  });
}

/** Links (or relinks) a tenant's SSO. The email-link setting is kept. */
export async function linkTenantSso(
  db: TenantDatabase,
  tenantId: string,
  link: SsoLink,
  actor: AuditActor,
): Promise<void> {
  const l = normaliseSsoLink(link);
  const values = {
    provider: l.provider,
    entraTenantId: l.provider === "microsoft" ? l.entraTenantId : null,
    googleDomain: l.provider === "google" ? l.googleDomain : null,
  };
  await db.withTenant(tenantId, async (tx) => {
    const [current] = await tx.select().from(tenantSso).for("update");
    const same =
      current?.provider === values.provider &&
      current.entraTenantId === values.entraTenantId &&
      current.googleDomain === values.googleDomain;
    // Linking what is already linked is not a change: no audit row.
    if (same) return;
    await tx
      .insert(tenantSso)
      .values({ tenantId, ...values })
      .onConflictDoUpdate({
        target: tenantSso.tenantId,
        set: { ...values, updatedAt: sql`now()` },
      });
    await recordAudit(tx, tenantId, actor, "sso.linked", {
      provider: l.provider,
      organisation: l.provider === "microsoft" ? l.entraTenantId : l.googleDomain,
    });
  });
}

/**
 * Turns email links on or off. Turning them off needs SSO linked first, so a tenant
 * cannot lock everyone out. Returns false when that is refused.
 */
export async function setAllowEmailLinks(
  db: TenantDatabase,
  tenantId: string,
  allow: boolean,
  actor: AuditActor,
): Promise<boolean> {
  return db.withTenant(tenantId, async (tx) => {
    const [current] = await tx.select().from(tenantSso).for("update");
    // Without SSO linked there is no row: links are on, and cannot be turned off.
    if (!current) return allow;
    // Already as asked: not a change, no audit row.
    if (current.allowEmailLinks === allow) return true;
    await tx
      .update(tenantSso)
      .set({ allowEmailLinks: allow, updatedAt: sql`now()` })
      .where(eq(tenantSso.tenantId, tenantId));
    await recordAudit(tx, tenantId, actor, "email-links.changed", { on: allow });
    return true;
  });
}
