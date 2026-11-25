-- Task 9: row-level security for job outputs, as for every tenant table. The fields are
-- tenant content: statistics are kept off them, as for text columns.
GRANT SELECT, INSERT, UPDATE ON job_outputs TO agentcore_app;--> statement-breakpoint
ALTER TABLE job_outputs ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE job_outputs FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON job_outputs
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));--> statement-breakpoint
ALTER TABLE job_outputs ALTER COLUMN fields SET STATISTICS 0;
