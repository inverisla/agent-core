-- Task 13: row-level security for the audit log and refused sign-in counts, as for every
-- tenant table.
--
-- The audit log is append-only. The app may add rows and read them, never change or
-- delete them, and cannot alter the table. A statement trigger also refuses any UPDATE,
-- DELETE or TRUNCATE from every other role, the owner included, however many rows it
-- would touch. The owner could still deliberately disable or drop the trigger first (an
-- owner controls its own tables); keeping a copy where the owner cannot reach it is
-- listed under "Later" in docs/PLAN.md.
GRANT SELECT, INSERT ON audit_events TO agentcore_app;--> statement-breakpoint
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON audit_events
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));--> statement-breakpoint
ALTER TABLE audit_events ALTER COLUMN actor_id SET STATISTICS 0,
  ALTER COLUMN actor_label SET STATISTICS 0,
  ALTER COLUMN action SET STATISTICS 0,
  ALTER COLUMN detail SET STATISTICS 0;--> statement-breakpoint

CREATE FUNCTION app.refuse_audit_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  RAISE EXCEPTION 'the audit log cannot be changed or deleted';
END
$$;--> statement-breakpoint
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_audit_change();--> statement-breakpoint

-- Refused sign-in counts: the app adds to a count and reads them, never deletes them.
GRANT SELECT, INSERT, UPDATE ON sign_in_refusals TO agentcore_app;--> statement-breakpoint
ALTER TABLE sign_in_refusals ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE sign_in_refusals FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON sign_in_refusals
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));--> statement-breakpoint
ALTER TABLE sign_in_refusals ALTER COLUMN method SET STATISTICS 0,
  ALTER COLUMN reason SET STATISTICS 0;
