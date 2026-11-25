import { describe, expect, it } from "vitest";
import { temporalConnectionOptions, temporalSettings } from "./jobs.ts";

describe("Temporal connection settings", () => {
  it("uses the local dev server without TLS by default", () => {
    const s = temporalSettings({});
    expect(s).toEqual({ address: "localhost:7233", namespace: "default" });
    expect(temporalConnectionOptions(s)).toEqual({ address: "localhost:7233" });
  });

  it("uses TLS and the API key for Temporal Cloud", () => {
    const s = temporalSettings({
      TEMPORAL_ADDRESS: "eu-west-2.aws.api.temporal.io:7233",
      TEMPORAL_NAMESPACE: "agentcore-dev.abc12",
      TEMPORAL_API_KEY: "key",
    });
    expect(temporalConnectionOptions(s)).toEqual({
      address: "eu-west-2.aws.api.temporal.io:7233",
      tls: true,
      apiKey: "key",
      metadata: { "temporal-namespace": "agentcore-dev.abc12" },
    });
  });
});
