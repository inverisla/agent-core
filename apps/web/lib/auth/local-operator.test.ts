import { describe, expect, it } from "vitest";
import {
  localOperatorAllowed,
  localOperatorEnabled,
  localOperatorIdentity,
} from "./local-operator.ts";

const local = {
  DEV_OPERATOR_SIGN_IN: "true",
  AUTH_URL: "http://localhost:3000",
  DATABASE_URL: "postgres://u:p@localhost:5433/db",
};

describe("the local operator sign-in", () => {
  it("is enabled only when asked for, with a local AUTH_URL, outside Container Apps", () => {
    expect(localOperatorEnabled(local)).toBe(true);
    expect(localOperatorEnabled({ ...local, AUTH_URL: "http://127.0.0.1:3100" })).toBe(true);
    for (const env of [
      { ...local, DEV_OPERATOR_SIGN_IN: undefined },
      { ...local, DEV_OPERATOR_SIGN_IN: "1" },
      { ...local, AUTH_URL: "https://ca-agentcore-dev-web.example.azurecontainerapps.io" },
      { ...local, AUTH_URL: "http://localhost.example.com" },
      { ...local, AUTH_URL: "not a url" },
      { ...local, CONTAINER_APP_NAME: "ca-agentcore-dev-web" },
      { ...local, CONTAINER_APP_JOB_NAME: "caj-agentcore-dev-migrate" },
      // Review S8: a deployment elsewhere, with .env.example copied whole.
      { ...local, KUBERNETES_SERVICE_HOST: "10.0.0.1" },
      { ...local, DATABASE_URL: "postgres://u:p@db.example.com/db" },
      { ...local, TEMPORAL_ADDRESS: "temporal.example.com:7233" },
    ]) {
      expect(localOperatorEnabled(env), JSON.stringify(env)).toBe(false);
      expect(localOperatorAllowed("localhost:3000", env), JSON.stringify(env)).toBe(false);
    }
  });

  it("is allowed only for requests addressed to this machine", () => {
    for (const host of ["localhost:3000", "127.0.0.1:3000", "[::1]:3000", "localhost"]) {
      expect(localOperatorAllowed(host, local), host).toBe(true);
    }
    // A LAN address, a rebound domain, a look-alike, garbage, or no request at all.
    for (const host of [
      "192.168.1.20:3000",
      "evil.example:3000",
      "localhost.evil.example:3000",
      "localhost@evil.example",
      "",
      null,
    ]) {
      expect(localOperatorAllowed(host, local), String(host)).toBe(false);
    }
  });

  it("signs in as a recognisable, short-lived operator", () => {
    expect(localOperatorIdentity(1_000)).toEqual({
      kind: "operator",
      oid: "local-operator",
      name: "Local operator",
      email: null,
      expiresAt: 1_000 + 60 * 60 * 1000,
    });
  });
});
