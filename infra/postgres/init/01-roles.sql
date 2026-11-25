-- Local development only: runs once, when the Postgres volume is first created.
--
-- agentcore_owner owns the database and runs migrations. Like the Azure admin it is not a
-- superuser, so local runs and CI behave as Azure does (FORCE RLS applies to it, and it
-- cannot name SUPERUSER or BYPASSRLS in ALTER ROLE).
-- agentcore_app is the login the app uses; it cannot bypass row-level security.
-- Passwords here are throwaway local values; in Azure they come from Key Vault.
CREATE ROLE agentcore_owner LOGIN PASSWORD 'agentcore_owner' CREATEDB CREATEROLE;
ALTER DATABASE agentcore OWNER TO agentcore_owner;
CREATE ROLE agentcore_app LOGIN PASSWORD 'agentcore_app';
