-- Task 8: row-level security for model calls, as for every tenant table. The app may add
-- and read rows but not change or delete them: they are a record of usage and cost.
GRANT SELECT, INSERT ON model_calls TO agentcore_app;--> statement-breakpoint
ALTER TABLE model_calls ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE model_calls FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON model_calls
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));--> statement-breakpoint
ALTER TABLE model_calls ALTER COLUMN step SET STATISTICS 0;--> statement-breakpoint
ALTER TABLE model_calls ALTER COLUMN provider SET STATISTICS 0;--> statement-breakpoint
ALTER TABLE model_calls ALTER COLUMN model SET STATISTICS 0;--> statement-breakpoint
ALTER TABLE model_calls ALTER COLUMN error_code SET STATISTICS 0;
