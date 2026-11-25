// Who a signed-in person is. Stored in the encrypted Auth.js session cookie and
// re-checked on every protected request (see guards.ts).

export type TenantRole = "tenant_admin" | "tenant_user";

export interface OperatorIdentity {
  kind: "operator";
  /** Entra object ID in the client's own Microsoft organisation. */
  oid: string;
  name: string | null;
  email: string | null;
  /** Epoch milliseconds. Operators get 1 hour: removing their Entra role takes at most that long. */
  expiresAt: number;
}

export interface TenantIdentity {
  kind: "tenant";
  tenantId: string;
  slug: string;
  userId: string;
  role: TenantRole;
  expiresAt: number;
}

export type Identity = OperatorIdentity | TenantIdentity;

export const OPERATOR_SESSION_MS = 60 * 60 * 1000;
export const TENANT_SESSION_MS = 8 * 60 * 60 * 1000;

export function isIdentity(value: unknown): value is Identity {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v["expiresAt"] !== "number") return false;
  if (v["kind"] === "operator") return typeof v["oid"] === "string";
  if (v["kind"] === "tenant") {
    return (
      typeof v["tenantId"] === "string" &&
      typeof v["slug"] === "string" &&
      typeof v["userId"] === "string" &&
      (v["role"] === "tenant_admin" || v["role"] === "tenant_user")
    );
  }
  return false;
}

/** The identity if present, well-formed and not expired; otherwise null. */
export function currentIdentity(value: unknown, now = Date.now()): Identity | null {
  return isIdentity(value) && value.expiresAt > now ? value : null;
}
