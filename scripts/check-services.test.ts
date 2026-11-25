import { describe, expect, it } from "vitest";
import { nonLocalSettings } from "./check-services.ts";

const example = {
  DATABASE_URL: "postgres://agentcore_app:agentcore_app@localhost:5433/agentcore",
  DATABASE_ADMIN_URL: "postgres://agentcore_owner:agentcore_owner@localhost:5433/agentcore",
  AUTH_URL: "http://localhost:3000",
  TEMPORAL_ADDRESS: "localhost:7233",
  AZURE_STORAGE_CONNECTION_STRING:
    "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=x;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;",
};

describe("pnpm demo's check that everything is local", () => {
  it("accepts the values in .env.example", () => {
    expect(nonLocalSettings(example)).toEqual([]);
  });

  it("names every setting that points elsewhere", () => {
    expect(
      nonLocalSettings({
        ...example,
        DATABASE_ADMIN_URL:
          "postgres://owner:x@psql-agentcore-dev.postgres.database.azure.com/agentcore",
        TEMPORAL_ADDRESS: "temporal.example.com:7233",
        AZURE_STORAGE_ACCOUNT_URL: "https://stagentcoredev.blob.core.windows.net",
        AZURE_STORAGE_CONNECTION_STRING:
          "DefaultEndpointsProtocol=https;AccountName=x;AccountKey=y",
      }),
    ).toEqual([
      "DATABASE_ADMIN_URL",
      "TEMPORAL_ADDRESS",
      "AZURE_STORAGE_ACCOUNT_URL",
      "AZURE_STORAGE_CONNECTION_STRING",
    ]);
  });
});
