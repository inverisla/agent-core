import { createHmac } from "node:crypto";
import postgres from "postgres";

/**
 * The key in .env.example. Public, so it is only accepted for a database on this machine;
 * anywhere else it would let injected SQL sign any tenant. Not a database host named
 * "postgres" (review S10): that is an ordinary service name in a deployed compose or
 * Kubernetes setup too.
 */
export const LOCAL_DEV_CONTEXT_KEY = "hvGbAchRJxTDr44wRf2cGBUcFqkmoOlGjn7gn7fVsjs=";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Throws if the public dev key is used with a database that is not local. */
export function assertKeyAllowedFor(key: Buffer, databaseUrl: string): void {
  if (key.equals(Buffer.from(LOCAL_DEV_CONTEXT_KEY, "base64"))) {
    const host = new URL(databaseUrl).hostname;
    if (!LOCAL_HOSTS.has(host)) {
      throw new Error(
        `TENANT_CONTEXT_KEY is the public development key from .env.example; refusing to use it ` +
          `with database host "${host}". Set a real key from Key Vault.`,
      );
    }
  }
}

/**
 * Reads the tenant context signing key: base64, at least 32 bytes. The app holds it
 * (TENANT_CONTEXT_KEY, from Key Vault in Azure) and the database holds the same key in
 * app.tenant_context_key, which the app role cannot read.
 */
export function parseContextKey(value: string | undefined): Buffer {
  if (!value) {
    throw new Error("TENANT_CONTEXT_KEY is not set. Copy .env.example to .env.local.");
  }
  const key = Buffer.from(value, "base64");
  if (key.length < 32) {
    throw new Error("TENANT_CONTEXT_KEY must be base64 for at least 32 bytes.");
  }
  return key;
}

/**
 * Signs a tenant for one transaction on one backend. Must match the message built by
 * app.current_tenant_id() in migrations/0001_row_level_security.sql.
 */
export function signTenantContext(
  key: Buffer,
  tenantId: string,
  backendPid: string,
  transactionEpoch: string,
): string {
  return createHmac("sha256", key)
    .update(`${tenantId}:${backendPid}:${transactionEpoch}`, "utf8")
    .digest("hex");
}

/** Stores the signing key in the database. Run as the owner role. */
export async function setContextKey(adminUrl: string, key: Buffer): Promise<void> {
  assertKeyAllowedFor(key, adminUrl);
  const client = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    await client`
      insert into app.tenant_context_key (singleton, key) values (true, ${key})
      on conflict (singleton) do update set key = excluded.key, updated_at = now()`;
  } finally {
    await client.end({ timeout: 5 });
  }
}
