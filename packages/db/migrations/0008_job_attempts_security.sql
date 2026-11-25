-- Task 5: row-level security for job attempts, as for every tenant table.
GRANT SELECT, INSERT, UPDATE ON job_attempts TO agentcore_app;--> statement-breakpoint
ALTER TABLE job_attempts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE job_attempts FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON job_attempts
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));--> statement-breakpoint
ALTER TABLE job_attempts ALTER COLUMN error_code SET STATISTICS 0;
