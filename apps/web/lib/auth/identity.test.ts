import { describe, expect, it } from "vitest";
import { currentIdentity } from "./identity.ts";
import { scopeFromCookie, scopeToCookie } from "./scope.ts";

describe("currentIdentity", () => {
  const tenant = {
    kind: "tenant",
    tenantId: "t",
    slug: "abc",
    userId: "u",
    role: "tenant_user",
    expiresAt: 2000,
  };

  it("accepts a well-formed identity that has not expired", () => {
    expect(currentIdentity(tenant, 1000)).toEqual(tenant);
    expect(
      currentIdentity(
        { kind: "operator", oid: "o", name: null, email: null, expiresAt: 2000 },
        1000,
      ),
    ).not.toBeNull();
  });

  it("rejects expired, malformed or unknown identities", () => {
    expect(currentIdentity(tenant, 3000)).toBeNull();
    expect(currentIdentity({ ...tenant, role: "superuser" }, 1000)).toBeNull();
    expect(currentIdentity({ ...tenant, kind: "admin" }, 1000)).toBeNull();
    expect(currentIdentity(undefined, 1000)).toBeNull();
  });
});

describe("sign-in scope cookie", () => {
  it("round-trips operator and tenant scopes", () => {
    expect(scopeFromCookie(scopeToCookie({ kind: "operator" }))).toEqual({ kind: "operator" });
    expect(scopeFromCookie(scopeToCookie({ kind: "tenant", slug: "abc" }))).toEqual({
      kind: "tenant",
      slug: "abc",
    });
  });

  it("ignores anything else", () => {
    for (const v of [undefined, "", "tenant:", "tenant:Bad Slug", "tenant:operator", "admin"]) {
      expect(scopeFromCookie(v), String(v)).toBeNull();
    }
  });
});
