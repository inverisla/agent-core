import { activeUser, schema } from "@agent-core/db";
import { and, eq } from "drizzle-orm";
import { forbidden, redirect } from "next/navigation";
import { auth } from "../../auth.ts";
import { LOCAL_OPERATOR_OID, localOperatorAllowedHere } from "./local-operator.ts";
import { db } from "../server/db.ts";
import {
  currentIdentity,
  TENANT_SESSION_MS,
  type OperatorIdentity,
  type TenantRole,
} from "./identity.ts";

export interface TenantAccess {
  tenantId: string;
  slug: string;
  userId: string;
  role: TenantRole;
  email: string;
  displayName: string;
}

type Outcome<T> = { ok: true; value: T } | { ok: false; status: 401 | 403 };

export async function signedInIdentity() {
  const session = await auth();
  return currentIdentity(session?.identity);
}

/** Operators only. */
export async function checkOperator(): Promise<Outcome<OperatorIdentity>> {
  const identity = await signedInIdentity();
  if (!identity) return { ok: false, status: 401 };
  if (identity.kind !== "operator") return { ok: false, status: 403 };
  // A local operator's session ends the moment the local sign-in is no longer allowed, and
  // works only on requests addressed to this machine.
  if (identity.oid === LOCAL_OPERATOR_OID && !(await localOperatorAllowedHere())) {
    return { ok: false, status: 401 };
  }
  return { ok: true, value: identity };
}

/**
 * Members of the tenant named by the slug, optionally admins only. Re-reads the user
 * from the database every time, so removing a user or changing their role takes
 * effect at once.
 */
export async function checkTenant(
  slug: string,
  opts: { admin?: boolean } = {},
): Promise<Outcome<TenantAccess>> {
  const identity = await signedInIdentity();
  if (!identity) return { ok: false, status: 401 };
  if (identity.kind !== "tenant") return { ok: false, status: 403 };
  const tenantId = await db().tenantIdForSlug(slug);
  if (!tenantId || tenantId !== identity.tenantId) return { ok: false, status: 403 };
  const user = await db().withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.users)
      // A removed user's session stops working at once.
      .where(and(eq(schema.users.userId, identity.userId), activeUser));
    return row;
  });
  if (!user) return { ok: false, status: 401 };
  // Sessions begun before the user was last removed or restored stay refused. Tenant
  // sessions have a fixed length, so the expiry gives the start.
  if (
    user.sessionsValidAfter &&
    identity.expiresAt - TENANT_SESSION_MS < user.sessionsValidAfter.getTime()
  )
    return { ok: false, status: 401 };
  if (opts.admin && user.role !== "tenant_admin") return { ok: false, status: 403 };
  return {
    ok: true,
    value: {
      tenantId,
      slug,
      userId: user.userId,
      role: user.role,
      email: user.email,
      displayName: user.displayName,
    },
  };
}

// Page versions: not signed in goes to sign-in; signed in without access gets 403.

export async function requireOperatorPage(): Promise<OperatorIdentity> {
  const result = await checkOperator();
  if (result.ok) return result.value;
  if (result.status === 401) redirect("/operator/sign-in");
  forbidden();
}

export async function requireTenantPage(
  slug: string,
  opts: { admin?: boolean } = {},
): Promise<TenantAccess> {
  const result = await checkTenant(slug, opts);
  if (result.ok) return result.value;
  if (result.status === 401) redirect(`/t/${slug}/sign-in`);
  forbidden();
}

/** JSON error for API routes. */
export function apiError(status: 401 | 403): Response {
  return Response.json({ error: status === 401 ? "not signed in" : "forbidden" }, { status });
}
