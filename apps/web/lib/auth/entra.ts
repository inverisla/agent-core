// Rules for signing in with Microsoft Entra ID. Auth.js has already checked the ID
// token's signature, audience and issuer before these run; they are checked again
// here so the rules stand on their own.
import {
  activeUser,
  recordAudit,
  countRefusedSignIn,
  schema,
  type TenantDatabase,
} from "@agent-core/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  OPERATOR_SESSION_MS,
  TENANT_SESSION_MS,
  type Identity,
  type TenantRole,
} from "./identity.ts";
import type { SignInScope } from "./scope.ts";

/** The ID token claims these rules use. */
export interface EntraClaims {
  iss?: unknown;
  tid?: unknown;
  oid?: unknown;
  email?: unknown;
  preferred_username?: unknown;
  name?: unknown;
  roles?: unknown;
  /** Present for guests: the issuer of the user's home organisation. */
  idp?: unknown;
  /** Optional claim: true when the email's domain is verified by the organisation. */
  xms_edov?: unknown;
}

export const OPERATOR_APP_ROLE = "Operator";

export type EntraRefusal =
  | "invalid-token"
  | "not-an-operator"
  | "unknown-tenant"
  | "organisation-not-linked"
  | "guest-account"
  | "unknown-user";

export type EntraResult = { ok: true; identity: Identity } | { ok: false; reason: EntraRefusal };

export function entraIssuer(entraTenantId: string): string {
  return `https://login.microsoftonline.com/${entraTenantId}/v2.0`;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);

type EntraDeps = { db: TenantDatabase; operatorEntraTenantId: string | undefined; now?: number };

/** Decides a Microsoft sign-in; a refusal at a tenant's portal is counted (task 13). */
export async function resolveEntraSignIn(
  scope: SignInScope,
  claims: EntraClaims,
  deps: EntraDeps,
): Promise<EntraResult> {
  const result = await decideEntraSignIn(scope, claims, deps);
  if (!result.ok && scope.kind === "tenant") {
    await countRefusedSignIn(deps.db, scope.slug, "microsoft", result.reason);
  }
  return result;
}

async function decideEntraSignIn(
  scope: SignInScope,
  claims: EntraClaims,
  deps: EntraDeps,
): Promise<EntraResult> {
  const now = deps.now ?? Date.now();
  const tid = str(claims.tid)?.toLowerCase() ?? null;
  const oid = str(claims.oid)?.toLowerCase() ?? null;
  if (!tid || !oid || !GUID.test(tid) || !GUID.test(oid) || claims.iss !== entraIssuer(tid)) {
    return { ok: false, reason: "invalid-token" };
  }
  // Guests sign in to an organisation they do not belong to; their tid is the host's.
  // Only the organisation's own members are accepted.
  if (claims.idp !== undefined && claims.idp !== claims.iss) {
    return { ok: false, reason: "guest-account" };
  }
  // Email is only trusted for matching when Entra says its domain is verified by the
  // organisation (optional claim xms_edov); otherwise any admin there could set any
  // address and take over a user.
  const email = claims.xms_edov === true ? (str(claims.email)?.trim().toLowerCase() ?? null) : null;
  const name = str(claims.name);

  if (scope.kind === "operator") {
    const roles = Array.isArray(claims.roles) ? claims.roles : [];
    if (tid !== deps.operatorEntraTenantId?.toLowerCase() || !roles.includes(OPERATOR_APP_ROLE)) {
      return { ok: false, reason: "not-an-operator" };
    }
    return {
      ok: true,
      // Display only: never used to match anyone.
      identity: {
        kind: "operator",
        oid,
        name,
        email: str(claims.email) ?? str(claims.preferred_username),
        expiresAt: now + OPERATOR_SESSION_MS,
      },
    };
  }

  const tenantId = await deps.db.tenantIdForSlug(scope.slug);
  if (!tenantId) return { ok: false, reason: "unknown-tenant" };

  return deps.db.withTenant(tenantId, async (tx): Promise<EntraResult> => {
    const [sso] = await tx.select().from(schema.tenantSso);
    if (sso?.provider !== "microsoft" || sso.entraTenantId?.toLowerCase() !== tid) {
      return { ok: false, reason: "organisation-not-linked" };
    }
    const users = schema.users;
    let [user] = await tx
      .select()
      .from(users)
      .where(and(eq(users.entraObjectId, oid), activeUser));
    if (!user && email) {
      // First Microsoft sign-in for a user the tenant added by email: record their oid.
      // Only members of the linked organisation get here, with a domain-verified email.
      [user] = await tx
        .update(users)
        .set({ entraObjectId: oid })
        .where(and(sql`lower(${users.email}) = ${email}`, isNull(users.entraObjectId), activeUser))
        .returning();
    }
    if (!user) return { ok: false, reason: "unknown-user" };
    await recordAudit(
      tx,
      tenantId,
      { kind: "user", userId: user.userId, label: user.email },
      "sign-in",
      { method: "microsoft" },
    );
    return {
      ok: true,
      identity: {
        kind: "tenant",
        tenantId,
        slug: scope.slug,
        userId: user.userId,
        role: user.role as TenantRole,
        expiresAt: now + TENANT_SESSION_MS,
      },
    };
  });
}
