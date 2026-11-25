// Where a sign-in goes: the client's own Microsoft organisation for operators, or the
// single SSO provider a tenant has linked. Null whenever there is nowhere to go; callers
// treat every such case the same.
import { getTenantSso } from "@agent-core/db";
import { db } from "../server/db.ts";
import type { SignInScope } from "./scope.ts";

export const ENTRA_PROVIDER_ID = "microsoft-entra-id";
export const GOOGLE_PROVIDER_ID = "google";

export type SsoTarget =
  { provider: "microsoft"; entraTenantId: string } | { provider: "google"; googleDomain: string };

export function entraConfigured(): boolean {
  return Boolean(
    process.env["AUTH_MICROSOFT_ENTRA_ID_ID"] && process.env["AUTH_MICROSOFT_ENTRA_ID_SECRET"],
  );
}

export function googleConfigured(): boolean {
  return Boolean(process.env["AUTH_GOOGLE_ID"] && process.env["AUTH_GOOGLE_SECRET"]);
}

/** Whether tenant portals show "Sign in with your work account" at all. */
export function tenantSsoAvailable(): boolean {
  return entraConfigured() || googleConfigured();
}

export function providerIdFor(target: SsoTarget): string {
  return target.provider === "microsoft" ? ENTRA_PROVIDER_ID : GOOGLE_PROVIDER_ID;
}

export async function ssoTargetFor(scope: SignInScope): Promise<SsoTarget | null> {
  if (scope.kind === "operator") {
    const tid = process.env["OPERATOR_ENTRA_TENANT_ID"];
    return entraConfigured() && tid ? { provider: "microsoft", entraTenantId: tid } : null;
  }
  if (!tenantSsoAvailable()) return null;
  const tenantId = await db().tenantIdForSlug(scope.slug);
  if (!tenantId) return null;
  const { link } = await getTenantSso(db(), tenantId);
  if (link?.provider === "microsoft" && entraConfigured()) return link;
  if (link?.provider === "google" && googleConfigured()) return link;
  return null;
}
