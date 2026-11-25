-- Sign-in (task 3): row-level security for the new tables, tenant creation by the app,
-- and the one lookup that runs before a tenant is known: slug to tenant ID.

-- New tenant tables follow the same rules as 0001.
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_entra_orgs, verification_tokens TO agentcore_app;--> statement-breakpoint

ALTER TABLE tenant_entra_orgs ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE tenant_entra_orgs FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON tenant_entra_orgs
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));--> statement-breakpoint

ALTER TABLE verification_tokens ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE verification_tokens FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON verification_tokens
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));--> statement-breakpoint

ALTER TABLE users ALTER COLUMN entra_object_id SET STATISTICS 0;--> statement-breakpoint
ALTER TABLE verification_tokens ALTER COLUMN identifier SET STATISTICS 0,
  ALTER COLUMN token_hash SET STATISTICS 0;--> statement-breakpoint
ALTER TABLE tenant_entra_orgs ALTER COLUMN entra_tenant_id SET STATISTICS 0;--> statement-breakpoint

-- Creating a tenant: the app generates the ID and inserts the row inside that new
-- tenant's own signed context, so the existing policy's WITH CHECK applies.
GRANT INSERT ON tenants TO agentcore_app;--> statement-breakpoint

-- Slug directory. Sign-in starts from /t/{slug}, before any tenant is known. FORCE RLS
-- stops even the owner reading tenants without a tenant set, so a trigger keeps this
-- slug-to-ID directory in the app schema (routing data only, no tenant content; the
-- app role has no access to it).
CREATE TABLE app.tenant_slugs (
  slug text PRIMARY KEY,
  tenant_id uuid NOT NULL UNIQUE
);--> statement-breakpoint

CREATE FUNCTION app.record_tenant_slug() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  INSERT INTO app.tenant_slugs (slug, tenant_id) VALUES (NEW.slug, NEW.tenant_id);
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app.record_tenant_slug() FROM PUBLIC;--> statement-breakpoint

CREATE TRIGGER tenants_record_slug AFTER INSERT ON tenants
  FOR EACH ROW EXECUTE FUNCTION app.record_tenant_slug();--> statement-breakpoint

-- Returns the tenant ID for a slug, or null. Reveals only whether a slug exists;
-- the sign-in pages behave the same either way.
CREATE FUNCTION app.tenant_id_for_slug(p_slug text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER PARALLEL RESTRICTED
  SET search_path = pg_catalog, pg_temp
  AS $$ SELECT s.tenant_id FROM app.tenant_slugs s WHERE s.slug = p_slug $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app.tenant_id_for_slug(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.tenant_id_for_slug(text) TO agentcore_app;
--> statement-breakpoint

-- Slugs are fixed once created and tenants are not deleted, so the directory cannot go
-- stale. Applies to the owner too.
CREATE FUNCTION app.refuse_tenant_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'tenants cannot be deleted';
  END IF;
  RAISE EXCEPTION 'a tenant''s slug cannot be changed';
END
$$;--> statement-breakpoint
CREATE TRIGGER tenants_fixed_slug BEFORE UPDATE OF slug ON tenants
  FOR EACH ROW WHEN (OLD.slug IS DISTINCT FROM NEW.slug)
  EXECUTE FUNCTION app.refuse_tenant_change();--> statement-breakpoint
CREATE TRIGGER tenants_no_delete BEFORE DELETE ON tenants
  FOR EACH ROW EXECUTE FUNCTION app.refuse_tenant_change();
