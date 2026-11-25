import { describe, expect, it } from "vitest";
import { AUTH_PAGES_POLICY, contentSecurityPolicy, strictTransportSecurity } from "./headers.ts";

describe("security headers (review S2)", () => {
  it("allows scripts and styles only from the app or with the request's nonce", () => {
    const policy = contentSecurityPolicy("abc", false);
    expect(policy).toContain("script-src 'self' 'nonce-abc' 'strict-dynamic'");
    expect(policy).toContain("style-src 'self';");
    expect(policy).not.toContain("unsafe-eval");
    expect(policy).not.toContain("unsafe-inline");
    // Development: eval for fast refresh, inline styles for the error overlay.
    expect(contentSecurityPolicy("abc", true)).toContain("'unsafe-eval'");
    expect(contentSecurityPolicy("abc", true)).toContain("style-src 'self' 'unsafe-inline'");
  });

  it("gives Auth.js's own pages a policy with no scripts", () => {
    expect(AUTH_PAGES_POLICY).toContain("default-src 'none'");
    expect(AUTH_PAGES_POLICY).not.toContain("script-src");
    expect(AUTH_PAGES_POLICY).toContain("frame-ancestors 'none'");
  });

  it("sends HSTS only for a real https address", () => {
    expect(strictTransportSecurity("https://portal.example.com")).toContain("max-age=");
    for (const url of [
      undefined,
      "",
      "not a url",
      "http://portal.example.com",
      "https://localhost:3000",
      "https://127.0.0.1",
      "http://localhost:3000",
    ]) {
      expect(strictTransportSecurity(url)).toBeNull();
    }
  });
});
