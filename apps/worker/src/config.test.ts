import { describe, expect, it } from "vitest";
import { readConfig } from "./config.ts";

describe("readConfig", () => {
  it("defaults to the local Temporal dev server and the documents queue", () => {
    expect(readConfig({})).toEqual({
      temporalAddress: "localhost:7233",
      temporalNamespace: "default",
      taskQueue: "documents",
      allowTestFaults: false,
      model: null,
    });
  });

  it("checks the model settings at start", () => {
    expect(() => readConfig({ MODEL_PROVIDER: "openai" })).toThrow(
      "must be azure-openai, bedrock or demo",
    );
    expect(
      readConfig({
        MODEL_PROVIDER: "bedrock",
        BEDROCK_REGION: "eu-west-2",
        BEDROCK_MODEL_ID: "m",
        BEDROCK_API_KEY: "k",
      }).model,
    ).toMatchObject({ provider: "bedrock" });
  });

  it("reads overrides from the environment", () => {
    expect(
      readConfig({
        TEMPORAL_ADDRESS: "temporal:7233",
        TEMPORAL_NAMESPACE: "dev",
        JOB_TASK_QUEUE: "q1",
      }),
    ).toMatchObject({
      temporalAddress: "temporal:7233",
      temporalNamespace: "dev",
      taskQueue: "q1",
    });
  });

  it("allows test faults only against a local Temporal and database", () => {
    const local = { ALLOW_TEST_FAULTS: "true", DATABASE_URL: "postgres://u:p@localhost:5433/db" };
    expect(readConfig(local).allowTestFaults).toBe(true);
    expect(() => readConfig({ ...local, TEMPORAL_ADDRESS: "ns.tmprl.cloud:7233" })).toThrow(
      /only allowed/,
    );
    expect(() =>
      readConfig({ ...local, DATABASE_URL: "postgres://u:p@db.postgres.database.azure.com/db" }),
    ).toThrow(/only allowed/);
    expect(() => readConfig({ ...local, TEMPORAL_ADDRESS: "temporal:7233" })).toThrow(
      /only allowed/,
    );
  });
});

import { shouldForceFailure } from "./activities.ts";

describe("shouldForceFailure", () => {
  it("only fails on purpose when test faults are allowed", () => {
    expect(shouldForceFailure(false, 5, 1)).toBe(false);
    expect(shouldForceFailure(true, 2, 1)).toBe(true);
    expect(shouldForceFailure(true, 2, 2)).toBe(true);
    expect(shouldForceFailure(true, 2, 3)).toBe(false);
    expect(shouldForceFailure(true, undefined, 1)).toBe(false);
  });
});
