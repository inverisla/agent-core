-- Tenant separation: row-level security on every table, keyed on a signed tenant context.
--
-- The app connects as agentcore_app: not a superuser, cannot bypass RLS, owns nothing.
-- withTenant() in packages/db sets two transaction-local settings:
--   app.tenant_id   the tenant UUID
--   app.tenant_sig  HMAC-SHA256 of "<tenant_id>:<backend pid>:<transaction start epoch>"
-- The signing key lives in Key Vault for the app, and in app.tenant_context_key for the
-- database, which the app role cannot read. Injected SQL can change app.tenant_id but
-- cannot produce a valid signature for another tenant, and a signature seen elsewhere
-- (for example in pg_stat_activity) is bound to that backend and transaction.
--
-- No tenant set: app.current_tenant_id() is null and no rows match.
-- Tenant set with a missing or wrong signature: the query fails.
--
-- Runs as the owner role, which need not be a superuser (Azure Database for PostgreSQL).
-- Each environment gives agentcore_app its login, and sets the key with
-- `pnpm db:set-context-key`; this migration never holds a password or key.

-- The app role: created without login if missing, and must not bypass RLS.
-- (From Postgres 16 a non-superuser cannot name SUPERUSER or BYPASSRLS in ALTER ROLE,
-- so this checks rather than sets them.)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentcore_app') THEN
    CREATE ROLE agentcore_app NOLOGIN;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles
             WHERE rolname = 'agentcore_app' AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'agentcore_app must not be a superuser or have BYPASSRLS';
  END IF;
END
$$;--> statement-breakpoint

-- The app role must not create anything: no temporary tables (which could shadow
-- tenant tables on a pooled connection) and no objects in public.
-- REVOKE run by a role that is not the database owner only warns, so check after.
DO $$
BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
  REVOKE CREATE ON SCHEMA public FROM PUBLIC;
  IF has_database_privilege('agentcore_app', current_database(), 'TEMPORARY')
     OR has_schema_privilege('agentcore_app', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'agentcore_app can still create temporary or public objects; '
      'run migrations as the database owner';
  END IF;
END
$$;--> statement-breakpoint

CREATE SCHEMA IF NOT EXISTS extensions;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;--> statement-breakpoint
DO $$
BEGIN
  IF (SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
      WHERE e.extname = 'pgcrypto') <> 'extensions' THEN
    RAISE EXCEPTION 'pgcrypto is installed outside the extensions schema; move it with '
      'ALTER EXTENSION pgcrypto SET SCHEMA extensions';
  END IF;
END
$$;--> statement-breakpoint

CREATE SCHEMA app;--> statement-breakpoint

-- System configuration, not tenant data: the one table without tenant_id. The app role
-- has no access to the app schema's tables.
CREATE TABLE app.tenant_context_key (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  key bytea NOT NULL CHECK (octet_length(key) >= 32),
  updated_at timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

-- The current tenant, or null when none is set. Raises when the signature is wrong.
-- SECURITY DEFINER so it can read the key; search_path is fixed. PARALLEL RESTRICTED
-- keeps parallel query available while the check runs in the leader, whose backend PID
-- is the one that was signed (never SAFE: a worker's PID would not match).
CREATE FUNCTION app.current_tenant_id() RETURNS uuid
  LANGUAGE plpgsql STABLE SECURITY DEFINER PARALLEL RESTRICTED
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  tenant text := nullif(current_setting('app.tenant_id', true), '');
  sig text := current_setting('app.tenant_sig', true);
  signing_key bytea;
BEGIN
  IF tenant IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT k.key INTO signing_key FROM app.tenant_context_key k;
  IF signing_key IS NULL THEN
    RAISE EXCEPTION 'tenant context key is not set; run pnpm db:set-context-key';
  END IF;
  IF sig IS NULL OR sig <> encode(
       extensions.hmac(
         convert_to(tenant || ':' || pg_backend_pid()::text || ':' || extract(epoch FROM now())::text, 'UTF8'),
         signing_key, 'sha256'),
       'hex') THEN
    RAISE EXCEPTION 'invalid tenant context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN tenant::uuid;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app.current_tenant_id() FROM PUBLIC;--> statement-breakpoint

GRANT USAGE ON SCHEMA public, app TO agentcore_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.current_tenant_id() TO agentcore_app;--> statement-breakpoint
-- Tenants are created by operators (task 3), not from tenant context.
GRANT SELECT ON tenants TO agentcore_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON users, documents, jobs TO agentcore_app;--> statement-breakpoint

-- One policy per table. "(SELECT app.current_tenant_id())" is evaluated once per query,
-- not once per row. FORCE applies the policies to the table owner too.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON tenants
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));--> statement-breakpoint

ALTER TABLE users ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE users FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON users
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));--> statement-breakpoint

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE documents FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON documents
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));--> statement-breakpoint

ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON jobs
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));;--> statement-breakpoint

-- Planner statistics are gathered over all tenants, and EXPLAIN estimates on
-- leakproof comparisons can reveal another tenant's values from histogram bounds.
-- No statistics on tenant content columns; keys keep theirs for planning. New text
-- columns need the same (the isolation test checks every text column).
ALTER TABLE tenants ALTER COLUMN name SET STATISTICS 0, ALTER COLUMN slug SET STATISTICS 0;--> statement-breakpoint
ALTER TABLE users ALTER COLUMN email SET STATISTICS 0,
  ALTER COLUMN display_name SET STATISTICS 0;--> statement-breakpoint
ALTER TABLE documents ALTER COLUMN filename SET STATISTICS 0,
  ALTER COLUMN content_type SET STATISTICS 0, ALTER COLUMN blob_path SET STATISTICS 0,
  ALTER COLUMN sha256 SET STATISTICS 0, ALTER COLUMN size_bytes SET STATISTICS 0;--> statement-breakpoint
ALTER TABLE jobs ALTER COLUMN agent_name SET STATISTICS 0,
  ALTER COLUMN agent_version SET STATISTICS 0;
