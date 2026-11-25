import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { assertKeyAllowedFor, signTenantContext } from "./context-key.ts";
import * as schema from "./schema.ts";
import { slugProblem } from "./tenant-slug.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Defaults for every app connection (task 14): see TenantDatabaseOptions. */
export const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;
export const DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS = 30_000;
/**
 * No app transaction lasts longer than this (Postgres 17's transaction_timeout). Things
 * that read rows "as of a while ago" rely on it: anything stamped with a transaction start
 * older than this has committed or rolled back (the audit copy, the restore drill).
 */
export const MAX_TRANSACTION_MS = 60_000;
export const DEFAULT_CONNECT_TIMEOUT_S = 10;

function connect(
  url: string,
  max: number,
  timeouts: { statementMs: number; idleInTransactionMs: number; transactionMs: number },
) {
  const client = postgres(url, {
    max,
    onnotice: () => {},
    connect_timeout: DEFAULT_CONNECT_TIMEOUT_S,
    // Set when each connection starts: a stuck query, or a transaction left open, gives
    // up instead of holding a connection (and its locks) for ever.
    connection: {
      statement_timeout: timeouts.statementMs,
      idle_in_transaction_session_timeout: timeouts.idleInTransactionMs,
      transaction_timeout: timeouts.transactionMs,
    },
  });
  return { client, db: drizzle(client, { schema }) };
}

type Db = ReturnType<typeof connect>["db"];

/** A transaction scoped to one tenant. Row-level security limits every query in it. */
export type TenantTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface TenantDatabase {
  /**
   * Runs `fn` in a transaction with the tenant set and signed. This is the only way to
   * query: the tenant applies to that transaction alone and is cleared when it ends.
   */
  withTenant<T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T>;
  /**
   * The tenant ID for a portal slug, or null. The one lookup allowed before a tenant is
   * known (sign-in starts from /t/{slug}).
   */
  tenantIdForSlug(slug: string): Promise<string | null>;
  /**
   * Every tenant's ID and slug, from the slug directory: for the operator console only
   * (the caller checks the operator). Their details are read inside each tenant.
   */
  listTenants(): Promise<{ tenantId: string; slug: string }[]>;
  /**
   * Runs `fn` in a transaction with no tenant set, for the operator's own records (the
   * operator schema, task 16). Row-level security still applies, so no tenant's rows can
   * be read or written in it. Only for the worker and a signed-in operator.
   */
  withOperatorData<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface TenantDatabaseOptions {
  /** Tenant context signing key (see parseContextKey). */
  contextKey: Buffer;
  /** Connection pool size. Defaults to 10. */
  maxConnections?: number;
  /** Longest a single statement may run, in ms. Defaults to 15 s. */
  statementTimeoutMs?: number;
  /** Longest a transaction may sit idle, in ms. Defaults to 30 s. */
  idleInTransactionTimeoutMs?: number;
  /** Longest a whole transaction may last, in ms: at most MAX_TRANSACTION_MS (for tests). */
  transactionTimeoutMs?: number;
}

/**
 * Connects as the app role. Refuses to run any query if that role could get around
 * row-level security: a superuser, BYPASSRLS, CREATEROLE, owning a table, able to switch
 * to a role that can, able to create temporary or other objects, or with role-level
 * setting overrides (which injected SQL could have planted with ALTER ROLE).
 */
export function createTenantDatabase(url: string, options: TenantDatabaseOptions): TenantDatabase {
  const key = options.contextKey;
  assertKeyAllowedFor(key, url);
  const { client, db } = connect(url, options.maxConnections ?? 10, {
    statementMs: options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS,
    idleInTransactionMs:
      options.idleInTransactionTimeoutMs ?? DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS,
    transactionMs: Math.min(options.transactionTimeoutMs ?? MAX_TRANSACTION_MS, MAX_TRANSACTION_MS),
  });
  let roleChecked: Promise<void> | undefined;

  async function checkRole(): Promise<void> {
    const rows = await client<{ rolname: string; unsafe: boolean; overrides: boolean }[]>`
      select current_user::text as rolname,
        exists (
          select 1 from pg_catalog.pg_roles r
          where pg_catalog.pg_has_role(current_user, r.oid, 'MEMBER')
            and (r.rolsuper or r.rolbypassrls or r.rolcreaterole
                 or exists (select 1 from pg_catalog.pg_class c where c.relowner = r.oid))
        )
        or pg_catalog.has_database_privilege(current_user, pg_catalog.current_database(), 'CREATE, TEMPORARY')
        or exists (
          select 1 from pg_catalog.pg_namespace n
          where pg_catalog.has_schema_privilege(current_user, n.oid, 'CREATE')
        ) as unsafe,
        exists (
          select 1 from pg_catalog.pg_db_role_setting s
          where s.setrole = (select oid from pg_catalog.pg_roles where rolname = current_user)
            -- The settings that apply here: this database's, and those for every database
            -- (0). Another database's do not reach this connection.
            and s.setdatabase in (
              0,
              (select oid from pg_catalog.pg_database where datname = pg_catalog.current_database())
            )
        ) as overrides`;
    const role = rows[0];
    if (!role || role.unsafe) {
      throw new Error(
        `Refusing to query as database role "${role?.rolname ?? "unknown"}": it can bypass ` +
          "row-level security, owns tables or can create objects. Connect as the app role " +
          "(agentcore_app) instead.",
      );
    }
    if (role.overrides) {
      throw new Error(
        `Refusing to query as database role "${role.rolname}": it has role-level setting ` +
          "overrides (ALTER ROLE ... SET). Remove them with ALTER ROLE ... RESET ALL as the owner.",
      );
    }
  }

  /**
   * Undoes any session settings an earlier transaction on this pooled connection may have
   * changed, then pins the ones isolation and parsing depend on. search_path lists
   * pg_temp last so a temporary table can never shadow a tenant table.
   */
  async function pinSession(tx: TenantTx): Promise<{ pid: string; epoch: string }> {
    await tx.execute(sql`reset all`);
    const [ctx] = await tx.execute<{ pid: string; epoch: string }>(sql`
      select pg_catalog.pg_backend_pid()::text as pid,
        extract(epoch from pg_catalog.now())::text as epoch,
        pg_catalog.set_config('search_path', 'public, pg_temp', true),
        pg_catalog.set_config('row_security', 'on', true),
        pg_catalog.set_config('DateStyle', 'ISO, MDY', true),
        pg_catalog.set_config('IntervalStyle', 'postgres', true),
        pg_catalog.set_config('TimeZone', 'UTC', true),
        pg_catalog.set_config('bytea_output', 'hex', true),
        pg_catalog.set_config('client_encoding', 'UTF8', true)`);
    if (!ctx) throw new Error("Could not read the transaction context.");
    return ctx;
  }

  const api: TenantDatabase = {
    async withTenant(tenantId, fn) {
      if (!UUID.test(tenantId)) {
        throw new Error("withTenant needs a tenant ID in UUID form.");
      }
      roleChecked ??= checkRole().catch((error: unknown) => {
        roleChecked = undefined;
        throw error;
      });
      await roleChecked;
      const tenant = tenantId.toLowerCase();
      return db.transaction(
        async (tx) => {
          const ctx = await pinSession(tx);
          const sig = signTenantContext(key, tenant, ctx.pid, ctx.epoch);
          await tx.execute(
            sql`select pg_catalog.set_config('app.tenant_id', ${tenant}, true),
                       pg_catalog.set_config('app.tenant_sig', ${sig}, true)`,
          );
          return fn(tx);
        },
        { accessMode: "read write" },
      );
    },
    async tenantIdForSlug(slug) {
      if (slugProblem(slug) !== null) return null;
      roleChecked ??= checkRole().catch((error: unknown) => {
        roleChecked = undefined;
        throw error;
      });
      await roleChecked;
      const rows = await client<{ tenant_id: string | null }[]>`
        select app.tenant_id_for_slug(${slug}) as tenant_id`;
      return rows[0]?.tenant_id ?? null;
    },
    async listTenants() {
      roleChecked ??= checkRole().catch((error: unknown) => {
        roleChecked = undefined;
        throw error;
      });
      await roleChecked;
      const rows = await client<{ tenant_id: string; slug: string }[]>`
        select tenant_id, slug from app.list_tenants()`;
      return rows.map((r) => ({ tenantId: r.tenant_id, slug: r.slug }));
    },
    async withOperatorData(fn) {
      roleChecked ??= checkRole().catch((error: unknown) => {
        roleChecked = undefined;
        throw error;
      });
      await roleChecked;
      return db.transaction(
        async (tx) => {
          await pinSession(tx);
          return fn(tx);
        },
        { accessMode: "read write" },
      );
    },
    async close() {
      await client.end({ timeout: 5 });
    },
  };
  return api;
}
