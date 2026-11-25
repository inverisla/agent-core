// The Auth.js signIn callback's own refusals, before any sign-in rule runs.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { NextAuthConfig } from "next-auth";
import { ssoTargetFor } from "./sso.ts";
import {
  buildAuthConfig,
  EMAIL_LINK_PROVIDER_ID,
  ENTRA_PROVIDER_ID,
  GOOGLE_PROVIDER_ID,
  LOCAL_DEV_AUTH_SECRET,
} from "./config.ts";

// The SSO lookup needs a database; here it is replaced so each test chooses the target.
vi.mock("./sso.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sso.ts")>()),
  ssoTargetFor: vi.fn(async () => null),
}));

type SignInArgs = Parameters<NonNullable<NonNullable<NextAuthConfig["callbacks"]>["signIn"]>>[0];
const args = (provider: string, extra: Partial<SignInArgs> = {}) =>
  ({
    user: {},
    account: { provider, type: "oidc", providerAccountId: "x" },
    ...extra,
  }) as SignInArgs;

beforeAll(() => {
  process.env["AUTH_SECRET"] = "test-secret-test-secret-test-secret";
  process.env["AUTH_URL"] = "http://localhost:3000";
  delete process.env["AUTH_MICROSOFT_ENTRA_ID_ID"];
});

describe("signIn callback", () => {
  it("refuses Microsoft sign-in with no sign-in in progress", async () => {
    const config = await buildAuthConfig(null);
    expect(await config.callbacks?.signIn?.(args(ENTRA_PROVIDER_ID))).toBe(
      "/operator/sign-in?error=refused",
    );
  });

  it("refuses an unknown provider, to the tenant's own sign-in page", async () => {
    const config = await buildAuthConfig({ kind: "tenant", slug: "tenant-a" });
    expect(await config.callbacks?.signIn?.(args("github"))).toBe(
      "/t/tenant-a/sign-in?error=refused",
    );
  });

  it("refuses an email-link sign-in without a checked identity", async () => {
    const config = await buildAuthConfig(null);
    expect(await config.callbacks?.signIn?.(args(EMAIL_LINK_PROVIDER_ID))).toBe(false);
  });

  it("has no Microsoft provider unless a sign-in names an organisation", async () => {
    const config = await buildAuthConfig(null);
    const types = (config.providers ?? []).map((p) =>
      typeof p === "function" ? p().type : p.type,
    );
    expect(types).toEqual(["credentials"]);
  });
});

describe("development secrets", () => {
  it("refuses the public dev AUTH_SECRET off localhost", async () => {
    process.env["AUTH_SECRET"] = LOCAL_DEV_AUTH_SECRET;
    process.env["AUTH_URL"] = "https://portal.example.com";
    await expect(buildAuthConfig(null)).rejects.toThrow(/public development value/);
    process.env["AUTH_URL"] = "http://localhost:3000";
    await expect(buildAuthConfig(null)).resolves.toBeDefined();
  });
});

describe("SSO providers per sign-in", () => {
  const ids = (config: NextAuthConfig) =>
    (config.providers ?? []).map((p) => (typeof p === "function" ? p() : p).id);

  beforeAll(() => {
    // The callbacks create the database client (lazily connecting); these refusals
    // happen before any query, so nothing is reachable at this address.
    process.env["DATABASE_URL"] = "postgres://nobody:nothing@127.0.0.1:1/none";
    process.env["TENANT_CONTEXT_KEY"] = Buffer.alloc(32, 7).toString("base64");
    process.env["AUTH_MICROSOFT_ENTRA_ID_ID"] = "entra-id";
    process.env["AUTH_MICROSOFT_ENTRA_ID_SECRET"] = "entra-secret";
    process.env["AUTH_GOOGLE_ID"] = "google-id";
    process.env["AUTH_GOOGLE_SECRET"] = "google-secret";
  });

  it("offers only Google to a Google-linked tenant, without its domain in the request", async () => {
    vi.mocked(ssoTargetFor).mockResolvedValueOnce({
      provider: "google",
      googleDomain: "lawfirm.example",
    });
    const config = await buildAuthConfig({ kind: "tenant", slug: "tenant-g" });
    expect(ids(config)).toEqual([GOOGLE_PROVIDER_ID, "credentials"]);
    expect(JSON.stringify(config.providers)).not.toContain("lawfirm.example");
  });

  it("offers only Microsoft to a Microsoft-linked tenant", async () => {
    vi.mocked(ssoTargetFor).mockResolvedValueOnce({
      provider: "microsoft",
      entraTenantId: "00000000-0000-0000-0000-000000000001",
    });
    const config = await buildAuthConfig({ kind: "tenant", slug: "tenant-a" });
    expect(ids(config)).toEqual([ENTRA_PROVIDER_ID, "credentials"]);
  });

  // Without it, the provider silently reuses whichever account the browser is signed in
  // with, so someone who first chose the wrong account is refused again and again.
  it("asks Microsoft and Google to let the person choose their account every time", async () => {
    // What Auth.js merges over the provider's defaults and sends to Microsoft or Google.
    const prompt = (config: NextAuthConfig, id: string) => {
      const p = (config.providers ?? [])
        .map((x) => (typeof x === "function" ? x() : x))
        .find((x) => x.id === id) as
        { options?: { authorization?: { params?: Record<string, unknown> } } } | undefined;
      return p?.options?.authorization?.params?.["prompt"];
    };
    vi.mocked(ssoTargetFor).mockResolvedValueOnce({
      provider: "microsoft",
      entraTenantId: "00000000-0000-0000-0000-000000000001",
    });
    expect(prompt(await buildAuthConfig({ kind: "operator" }), ENTRA_PROVIDER_ID)).toBe(
      "select_account",
    );
    vi.mocked(ssoTargetFor).mockResolvedValueOnce({
      provider: "google",
      googleDomain: "lawfirm.example",
    });
    expect(
      prompt(await buildAuthConfig({ kind: "tenant", slug: "tenant-g" }), GOOGLE_PROVIDER_ID),
    ).toBe("select_account");
  });

  it("runs the Google rules for a Google sign-in, refusing a token not from Google", async () => {
    const config = await buildAuthConfig({ kind: "tenant", slug: "tenant-g" });
    const refused = await config.callbacks?.signIn?.(
      args(GOOGLE_PROVIDER_ID, { profile: { iss: "https://evil.example", sub: "1" } }),
    );
    expect(refused).toBe("/t/tenant-g/sign-in?error=refused");
  });

  it("refuses Google sign-in to the operator console", async () => {
    const config = await buildAuthConfig({ kind: "operator" });
    const refused = await config.callbacks?.signIn?.(
      args(GOOGLE_PROVIDER_ID, {
        profile: {
          iss: "https://accounts.google.com",
          sub: "1",
          hd: "x.example",
          email: "a@x.example",
          email_verified: true,
        },
      }),
    );
    expect(refused).toBe("/operator/sign-in?error=refused");
  });
});

describe("refusal logging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  const spyWarn = () => vi.spyOn(console, "warn").mockImplementation(() => {});
  /** The sign-in.refused event lines written, as "reason (where, method)". */
  const spyRefusals = () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    return () =>
      write.mock.calls
        .map((c) => JSON.parse(String(c[0])) as Record<string, string>)
        .filter((e) => e["event"] === "sign-in.refused")
        .map((e) => `${e["reason"]} (${e["where"]}, ${e["method"]})`);
  };

  it("logs a refused Google sign-in once, with reason, tenant and provider but no email", async () => {
    const refusals = spyRefusals();
    const config = await buildAuthConfig({ kind: "tenant", slug: "tenant-g" });
    const result = await config.callbacks?.signIn?.(
      args(GOOGLE_PROVIDER_ID, {
        profile: { iss: "https://evil.example", sub: "1", email: "someone@lawfirm.example" },
      }),
    );
    expect(result).toBe("/t/tenant-g/sign-in?error=refused");
    expect(refusals()).toEqual(["invalid-token (tenant:tenant-g, google)"]);
    expect(JSON.stringify(refusals())).not.toContain("someone@");
  });

  it("logs a sign-in with no scope and one from an unknown provider", async () => {
    const refusals = spyRefusals();
    await (await buildAuthConfig(null)).callbacks?.signIn?.(args(GOOGLE_PROVIDER_ID));
    await (await buildAuthConfig({ kind: "operator" })).callbacks?.signIn?.(args("github"));
    expect(refusals()).toEqual(["no-scope (none, google)", "unknown-provider (operator, unknown)"]);
  });

  it("an email link with a crafted slug cannot forge a log line", async () => {
    const refusals = spyRefusals();
    const config = await buildAuthConfig(null);
    const credentials = (config.providers ?? [])
      .map((p) => (typeof p === "function" ? p() : p))
      .find((p) => p.type === "credentials") as unknown as {
      options: { authorize: (c: Record<string, unknown>, r: Request) => Promise<unknown> };
    };
    const forged = "x\nsign-in ok: admin";
    const user = await credentials.options.authorize(
      { slug: forged, email: "someone@example.com", token: "short" },
      new Request("http://localhost/"),
    );
    expect(user).toBeNull();
    expect(refusals()).toEqual(["link-not-valid (tenant:malformed, email-link)"]);
    await credentials.options.authorize(
      { slug: 1, email: 2, token: 3 },
      new Request("http://localhost/"),
    );
    expect(refusals().at(-1)).toBe("malformed-request (none, email-link)");
  });

  it("logs only the type of errors Auth.js raises itself", async () => {
    const warn = spyWarn();
    const config = await buildAuthConfig(null);
    const error = new Error("details from the request: someone@example.com");
    error.name = "InvalidCheck";
    config.logger?.error?.(error);
    expect(warn.mock.calls).toEqual([["sign-in error: InvalidCheck"]]);
  });
});
