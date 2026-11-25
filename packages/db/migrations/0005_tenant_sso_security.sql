-- Task 3b: one SSO link per tenant (Microsoft or Google) replaces tenant_entra_orgs.

-- Copy existing Microsoft links. FORCE RLS would hide them from the owner, so lift it on
-- the old table for the copy; that table is dropped by the next migration. The new table
-- has no RLS yet, so the owner can insert.
ALTER TABLE tenant_entra_orgs NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
INSERT INTO tenant_sso (tenant_id, provider, entra_tenant_id, created_at)
  SELECT tenant_id, 'microsoft', entra_tenant_id, created_at FROM tenant_entra_orgs;--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_sso TO agentcore_app;--> statement-breakpoint
ALTER TABLE tenant_sso ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE tenant_sso FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON tenant_sso
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));--> statement-breakpoint

ALTER TABLE tenant_sso ALTER COLUMN google_domain SET STATISTICS 0,
  ALTER COLUMN entra_tenant_id SET STATISTICS 0;--> statement-breakpoint
ALTER TABLE users ALTER COLUMN google_subject SET STATISTICS 0;
