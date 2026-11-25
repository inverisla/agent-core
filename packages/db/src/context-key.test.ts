import { describe, expect, it } from "vitest";
import {
  assertKeyAllowedFor,
  LOCAL_DEV_CONTEXT_KEY,
  parseContextKey,
  signTenantContext,
} from "./context-key.ts";

describe("parseContextKey", () => {
  it("accepts base64 for 32 bytes or more", () => {
    expect(parseContextKey(Buffer.alloc(32, 7).toString("base64"))).toHaveLength(32);
  });

  it("rejects a missing or short key", () => {
    expect(() => parseContextKey(undefined)).toThrow(/not set/);
    expect(() => parseContextKey(Buffer.alloc(16).toString("base64"))).toThrow(/32 bytes/);
  });
});

describe("signTenantContext", () => {
  it("binds the signature to the tenant, backend and transaction", () => {
    const key = Buffer.alloc(32, 1);
    const base = signTenantContext(key, "t", "1", "100.5");
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(signTenantContext(key, "u", "1", "100.5")).not.toBe(base);
    expect(signTenantContext(key, "t", "2", "100.5")).not.toBe(base);
    expect(signTenantContext(key, "t", "1", "100.6")).not.toBe(base);
  });
});

describe("assertKeyAllowedFor", () => {
  const devKey = Buffer.from(LOCAL_DEV_CONTEXT_KEY, "base64");

  it("allows the public dev key only for a local database", () => {
    expect(() => assertKeyAllowedFor(devKey, "postgres://u:p@localhost:5432/db")).not.toThrow();
    expect(() => assertKeyAllowedFor(devKey, "postgres://u:p@postgres:5432/db")).toThrow();
    expect(() =>
      assertKeyAllowedFor(devKey, "postgres://u:p@agentcore.postgres.database.azure.com/db"),
    ).toThrow(/public development key/);
  });

  it("allows any other key anywhere", () => {
    expect(() =>
      assertKeyAllowedFor(Buffer.alloc(32, 9), "postgres://u:p@db.example.com/db"),
    ).not.toThrow();
  });
});
