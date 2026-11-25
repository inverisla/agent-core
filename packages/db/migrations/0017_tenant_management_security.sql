-- Task 12b: row-level security for the agents a tenant may use, as for every tenant
-- table, and the tenant list for the operator console.
GRANT SELECT, INSERT, DELETE ON tenant_agents TO agentcore_app;--> statement-breakpoint
ALTER TABLE tenant_agents ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE tenant_agents FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON tenant_agents
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));--> statement-breakpoint
ALTER TABLE tenant_agents ALTER COLUMN agent_name SET STATISTICS 0;--> statement-breakpoint

-- Every tenant's ID and slug, from the slug directory (routing data, no tenant content),
-- for the operator console to list tenants. Each tenant's own details are then read
-- inside that tenant's signed context, as everything else is. The web app only calls
-- this for a signed-in operator.
CREATE FUNCTION app.list_tenants() RETURNS TABLE (tenant_id uuid, slug text)
  LANGUAGE sql STABLE SECURITY DEFINER PARALLEL RESTRICTED
  SET search_path = pg_catalog, pg_temp
  AS $$ SELECT s.tenant_id, s.slug FROM app.tenant_slugs s ORDER BY s.slug $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app.list_tenants() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.list_tenants() TO agentcore_app;
