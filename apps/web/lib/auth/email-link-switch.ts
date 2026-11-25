// Whether a tenant admin may turn email links off. Only when that is safe: the tenant's
// SSO must work on this deployment, and the admin must already have signed in with it,
// which proves at least one admin can still get in afterwards.
import { activeUser, schema } from "@agent-core/db";
import { and, eq } from "drizzle-orm";
import { db } from "../server/db.ts";
import type { TenantAccess } from "./guards.ts";
import { ssoTargetFor } from "./sso.ts";

export type SwitchOffCheck =
  { ok: true } | { ok: false; reason: "sso-not-available" | "sign-in-with-sso-first" };

export async function canTurnOffEmailLinks(access: TenantAccess): Promise<SwitchOffCheck> {
  const target = await ssoTargetFor({ kind: "tenant", slug: access.slug });
  if (!target) return { ok: false, reason: "sso-not-available" };
  const [me] = await db().withTenant(access.tenantId, (tx) =>
    tx
      .select()
      .from(schema.users)
      .where(and(eq(schema.users.userId, access.userId), activeUser)),
  );
  const ssoId = target.provider === "microsoft" ? me?.entraObjectId : me?.googleSubject;
  return ssoId ? { ok: true } : { ok: false, reason: "sign-in-with-sso-first" };
}
