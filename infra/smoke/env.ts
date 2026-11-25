// Connection settings for the local stack. Defaults match .env.example and
// infra/docker-compose.yml, so `pnpm test` works on a clean machine with no setup.
export const AZURITE_DEV_CONNECTION_STRING =
  "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;" +
  "AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;" +
  "BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;";

export const stackEnv = {
  databaseUrl:
    process.env["DATABASE_URL"] ??
    "postgres://agentcore_app:agentcore_app@localhost:5433/agentcore",
  temporalAddress: process.env["TEMPORAL_ADDRESS"] ?? "localhost:7233",
  temporalNamespace: process.env["TEMPORAL_NAMESPACE"] ?? "default",
  storageConnectionString:
    process.env["AZURE_STORAGE_CONNECTION_STRING"] ?? AZURITE_DEV_CONNECTION_STRING,
};

export const START_HINT = "Is the local stack running? Start it with `docker compose up`.";
