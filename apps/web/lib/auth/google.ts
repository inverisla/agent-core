// Rules for signing in to a tenant with Google Workspace. Auth.js has already checked
// the ID token's signature and audience; issuer, domain and email are checked here.
import {
  activeUser,
  recordAudit,
  countRefusedSignIn,
  schema,
  type TenantDatabase,
} from "@agent-core/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { TENANT_SESSION_MS, type Identity, type TenantRole } from "./identity.ts";
import type { SignInScope } from "./scope.ts";

/** The ID token claims these rules use. */
export interface GoogleClaims {
  iss?: unknown;
  sub?: unknown;
  hd?: unknown;
  email?: unknown;
  email_verified?: unknown;
}

export type GoogleRefusal =
  | "invalid-token"
  | "not-for-operators"
  | "unknown-tenant"
  // A personal Google account, or an email Google has not verified as in its Workspace domain.
  | "not-workspace-account"
  | "domain-not-linked"
  | "unknown-user";

export type GoogleResult = { ok: true; identity: Identity } | { ok: false; reason: GoogleRefusal };

const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);

/** Decides a Google sign-in; a refusal at a tenant's portal is counted (task 13). */
export async function resolveGoogleSignIn(
  scope: SignInScope,
  claims: GoogleClaims,
  deps: { db: TenantDatabase; now?: number },
): Promise<GoogleResult> {
  const result = await decideGoogleSignIn(scope, claims, deps);
  if (!result.ok && scope.kind === "tenant") {
    await countRefusedSignIn(deps.db, scope.slug, "google", result.reason);
  }
  return result;
}

async function decideGoogleSignIn(
  scope: SignInScope,
  claims: GoogleClaims,
  deps: { db: TenantDatabase; now?: number },
): Promise<GoogleResult> {
  const now = deps.now ?? Date.now();
  const sub = str(claims.sub);
  if (typeof claims.iss !== "string" || !GOOGLE_ISSUERS.has(claims.iss) || !sub) {
    return { ok: false, reason: "invalid-token" };
  }
  // Operators sign in with Microsoft only.
  if (scope.kind === "operator") return { ok: false, reason: "not-for-operators" };

  // hd (hosted domain) is set only for Google Workspace accounts, for a domain the
  // organisation has proved it owns. Personal accounts have none and are refused.
  const hd = str(claims.hd)?.toLowerCase() ?? null;
  const email = str(claims.email)?.trim().toLowerCase() ?? null;
  if (!hd || !email || claims.email_verified !== true || !email.endsWith(`@${hd}`)) {
    return { ok: false, reason: "not-workspace-account" };
  }

  const tenantId = await deps.db.tenantIdForSlug(scope.slug);
  if (!tenantId) return { ok: false, reason: "unknown-tenant" };

  return deps.db.withTenant(tenantId, async (tx): Promise<GoogleResult> => {
    const [sso] = await tx.select().from(schema.tenantSso);
    if (sso?.provider !== "google" || sso.googleDomain !== hd) {
      return { ok: false, reason: "domain-not-linked" };
    }
    const users = schema.users;
    let [user] = await tx
      .select()
      .from(users)
      .where(and(eq(users.googleSubject, sub), activeUser));
    if (!user) {
      // First Google sign-in for a user the tenant added by email: record their Google
      // ID. Safe because the email is in the tenant's own verified Workspace domain.
      [user] = await tx
        .update(users)
        .set({ googleSubject: sub })
        .where(and(sql`lower(${users.email}) = ${email}`, isNull(users.googleSubject), activeUser))
        .returning();
    }
    if (!user) return { ok: false, reason: "unknown-user" };
    await recordAudit(
      tx,
      tenantId,
      { kind: "user", userId: user.userId, label: user.email },
      "sign-in",
      { method: "google" },
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
