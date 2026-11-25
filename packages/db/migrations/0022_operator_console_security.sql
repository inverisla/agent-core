-- Task 16: the operator's own records (each agent version the deployment ran, and its
-- test-set results). Not tenant data, so no tenant_id and no row-level security: they
-- hold only an agent's files and the results of its test set (sample contracts), never
-- anything from a tenant. A test checks the schema stays that way
-- (packages/db/test/operator-data.integration.test.ts).
--
-- The app may read the schema and add rows, never change or delete them, and cannot
-- create anything in it. A statement trigger also refuses UPDATE, DELETE or TRUNCATE from
-- every other role (the owner could still disable it deliberately), as for the audit log.
REVOKE ALL ON SCHEMA operator FROM PUBLIC;--> statement-breakpoint
GRANT USAGE ON SCHEMA operator TO agentcore_app;--> statement-breakpoint
GRANT SELECT, INSERT ON operator.agent_versions, operator.agent_test_runs TO agentcore_app;--> statement-breakpoint

CREATE FUNCTION app.refuse_operator_record_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  RAISE EXCEPTION 'operator records cannot be changed or deleted';
END
$$;--> statement-breakpoint
CREATE TRIGGER agent_versions_append_only BEFORE UPDATE OR DELETE OR TRUNCATE
  ON operator.agent_versions
  FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_operator_record_change();--> statement-breakpoint
CREATE TRIGGER agent_test_runs_append_only BEFORE UPDATE OR DELETE OR TRUNCATE
  ON operator.agent_test_runs
  FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_operator_record_change();
