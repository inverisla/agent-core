-- Review S1: row-level security for the sign-in email send log, as for every tenant table.
-- The app adds a row per email sent, reads them to count against the limits, and deletes
-- rows a day old; nothing else.
GRANT SELECT, INSERT, DELETE ON email_link_sends TO agentcore_app;--> statement-breakpoint
ALTER TABLE email_link_sends ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE email_link_sends FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON email_link_sends
  USING (tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));--> statement-breakpoint
ALTER TABLE email_link_sends ALTER COLUMN identifier SET STATISTICS 0;
