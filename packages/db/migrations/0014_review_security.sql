-- Task 11: row-level security for review events, as for every tenant table. The app may
-- add events and read them, never change or delete them: the log of edits and decisions
-- is append-only. Their content (values, notes) gets no planner statistics.
GRANT SELECT, INSERT ON review_events TO agentcore_app;--> statement-breakpoint
ALTER TABLE review_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE review_events FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON review_events
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));--> statement-breakpoint
ALTER TABLE review_events ALTER COLUMN field SET STATISTICS 0;--> statement-breakpoint
ALTER TABLE review_events ALTER COLUMN old_value SET STATISTICS 0;--> statement-breakpoint
ALTER TABLE review_events ALTER COLUMN new_value SET STATISTICS 0;--> statement-breakpoint
ALTER TABLE review_events ALTER COLUMN note SET STATISTICS 0;--> statement-breakpoint
ALTER TABLE job_outputs ALTER COLUMN reviewed_fields SET STATISTICS 0;
