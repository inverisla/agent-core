import { describe, expect, it } from "vitest";
import { isLocalAddress, notLocalReason } from "./local.ts";

const local = {
  DATABASE_URL: "postgres://u:p@localhost:5433/db",
  TEMPORAL_ADDRESS: "localhost:7233",
  AUTH_URL: "http://localhost:3000",
};

describe("notLocalReason (review S8, S11, S18)", () => {
  it("accepts a developer's machine", () => {
    expect(notLocalReason(local)).toBeNull();
    expect(notLocalReason({ DATABASE_URL: "postgres://u:p@127.0.0.1/db" })).toBeNull();
  });

  it.each([
    [{ ...local, CONTAINER_APP_NAME: "web" }, "CONTAINER_APP_NAME"],
    [{ ...local, CONTAINER_APP_JOB_NAME: "migrate" }, "CONTAINER_APP_JOB_NAME"],
    [{ ...local, KUBERNETES_SERVICE_HOST: "10.0.0.1" }, "KUBERNETES_SERVICE_HOST"],
    [{ ...local, WEBSITE_SITE_NAME: "app" }, "WEBSITE_SITE_NAME"],
    [{ ...local, K_SERVICE: "web" }, "K_SERVICE"],
    [{ ...local, DATABASE_URL: "postgres://u:p@postgres:5432/db" }, "DATABASE_URL"],
    [{ ...local, DATABASE_URL: "" }, "DATABASE_URL"],
    // A deployment reaching its database through a local proxy still names a real
    // Temporal or a real address.
    [{ ...local, TEMPORAL_ADDRESS: "eu.tmprl.cloud:7233" }, "TEMPORAL_ADDRESS"],
    [{ ...local, AUTH_URL: "https://portal.example.com" }, "AUTH_URL"],
    [{ ...local, AUTH_URL: "http://localhost:80@evil.example" }, "AUTH_URL"],
  ])("refuses %#", (env, setting) => {
    expect(notLocalReason(env)).toContain(setting);
  });

  it("reads host names, not prefixes", () => {
    expect(isLocalAddress("http://localhost.example.com")).toBe(false);
    expect(isLocalAddress("localhost:7233")).toBe(true);
    expect(isLocalAddress("http://[::1]:3000")).toBe(true);
    expect(isLocalAddress("not a url")).toBe(false);
    // A Unix socket is on this machine; a socket path with a host is not a socket.
    expect(isLocalAddress("postgres://u@/db?host=/var/run/postgresql")).toBe(true);
    // ?host= wins over the URL's host, as in postgres.js: a remote one is not local.
    expect(isLocalAddress("postgres://u@localhost/db?host=db.example.com")).toBe(false);
    expect(isLocalAddress("postgres://u@localhost/db?host=localhost")).toBe(true);
  });
});
