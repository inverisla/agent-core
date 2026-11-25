// Sign-in rules against a real database: Microsoft and Google SSO, and email links.
// Task 3 done-when: a user from a Microsoft organisation not linked to a tenant is
// refused. Task 3b done-when: a tenant linked to a Google Workspace domain admits only
// users Google verifies as members of that domain, and a tenant with email links
// turned off refuses an email-link sign-in.
import { randomUUID } from "node:crypto";
import {
  createTenantDatabase,
  linkTenantSso,
  listAuditEvents,
  listRefusedSignIns,
  schema,
  setAllowEmailLinks,
  type TenantDatabase,
  SETUP_ACTOR,
} from "@agent-core/db";
import { createTestDatabase, type TestDatabase, createTestTenant } from "@agent-core/db/testing";
import { eq, lte, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  consumeEmailLink,
  createEmailLink,
  LINK_LIFETIME_MS,
  LINK_LIMITS,
  claimEmailSend,
  redeemEmailLink,
} from "./email-link.ts";
import { entraIssuer, resolveEntraSignIn, type EntraClaims } from "./entra.ts";
import { resolveGoogleSignIn, type GoogleClaims } from "./google.ts";
import { OPERATOR_SESSION_MS, TENANT_SESSION_MS } from "./identity.ts";

const OPERATOR_ORG = randomUUID();
const ORG_A = randomUUID();
const ORG_B = randomUUID();
const OTHER_ORG = randomUUID();
const BASE_URL = "http://localhost:3000";

let testDb: TestDatabase;
let db: TenantDatabase;
const t = {
  a: { id: "", slug: "tenant-a", admin: randomUUID(), user: randomUUID(), adminOid: randomUUID() },
  b: { id: "", slug: "tenant-b", admin: randomUUID() },
  unlinked: { id: "", slug: "tenant-unlinked", admin: randomUUID() },
  g: { id: "", slug: "tenant-google", admin: randomUUID(), user: randomUUID() },
};

function claims(org: string, oid: string, extra: Partial<EntraClaims> = {}): EntraClaims {
  return { iss: entraIssuer(org), tid: org, oid, ...extra };
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  db = createTenantDatabase(testDb.appUrl, { contextKey: testDb.contextKey, maxConnections: 2 });
  t.a.id = await createTestTenant(db, { name: "Tenant A", slug: t.a.slug });
  t.b.id = await createTestTenant(db, { name: "Tenant B", slug: t.b.slug });
  t.unlinked.id = await createTestTenant(db, { name: "Unlinked", slug: t.unlinked.slug });
  await db.withTenant(t.a.id, async (tx) => {
    await tx.insert(schema.users).values([
      {
        userId: t.a.admin,
        tenantId: t.a.id,
        email: "Admin@A.example",
        displayName: "A admin",
        role: "tenant_admin",
        entraObjectId: t.a.adminOid,
      },
      {
        userId: t.a.user,
        tenantId: t.a.id,
        email: "user@a.example",
        displayName: "A user",
        role: "tenant_user",
      },
    ]);
  });
  await db.withTenant(t.b.id, async (tx) => {
    await tx.insert(schema.users).values({
      userId: t.b.admin,
      tenantId: t.b.id,
      email: "admin@b.example",
      displayName: "B admin",
      role: "tenant_admin",
    });
  });
  await db.withTenant(t.unlinked.id, (tx) =>
    tx.insert(schema.users).values({
      userId: t.unlinked.admin,
      tenantId: t.unlinked.id,
      email: "admin@unlinked.example",
      displayName: "U admin",
      role: "tenant_admin",
    }),
  );
  await linkTenantSso(db, t.a.id, { provider: "microsoft", entraTenantId: ORG_A }, SETUP_ACTOR);
  await linkTenantSso(db, t.b.id, { provider: "microsoft", entraTenantId: ORG_B }, SETUP_ACTOR);
  t.g.id = await createTestTenant(db, { name: "Google tenant", slug: t.g.slug });
  await db.withTenant(t.g.id, (tx) =>
    tx.insert(schema.users).values([
      {
        userId: t.g.admin,
        tenantId: t.g.id,
        email: "admin@lawfirm.example",
        displayName: "G admin",
        role: "tenant_admin",
      },
      {
        userId: t.g.user,
        tenantId: t.g.id,
        email: "user@lawfirm.example",
        displayName: "G user",
        role: "tenant_user",
      },
    ]),
  );
  await linkTenantSso(
    db,
    t.g.id,
    { provider: "google", googleDomain: "LawFirm.example" },
    SETUP_ACTOR,
  );
});

afterAll(async () => {
  await db?.close();
  await testDb?.drop();
});

const deps = () => ({ db, operatorEntraTenantId: OPERATOR_ORG, now: 1_000_000 });
const tenantScope = (slug: string) => ({ kind: "tenant" as const, slug });

describe("Microsoft sign-in to a tenant", () => {
  it("lets a known user from the linked organisation in, with their role", async () => {
    const result = await resolveEntraSignIn(
      tenantScope(t.a.slug),
      claims(ORG_A, t.a.adminOid),
      deps(),
    );
    expect(result).toEqual({
      ok: true,
      identity: {
        kind: "tenant",
        tenantId: t.a.id,
        slug: t.a.slug,
        userId: t.a.admin,
        role: "tenant_admin",
        expiresAt: 1_000_000 + TENANT_SESSION_MS,
      },
    });
  });

  it("matches a user added by email on first sign-in, then records their Entra ID", async () => {
    const oid = randomUUID();
    const first = await resolveEntraSignIn(
      tenantScope(t.a.slug),
      claims(ORG_A, oid, { email: "USER@a.example", xms_edov: true }),
      deps(),
    );
    expect(first).toMatchObject({ ok: true, identity: { userId: t.a.user, role: "tenant_user" } });
    const second = await resolveEntraSignIn(tenantScope(t.a.slug), claims(ORG_A, oid), deps());
    expect(second).toMatchObject({ ok: true, identity: { userId: t.a.user } });
    // A different Microsoft account with the same verified email cannot take the user over.
    const other = await resolveEntraSignIn(
      tenantScope(t.a.slug),
      claims(ORG_A, randomUUID(), { email: "user@a.example", xms_edov: true }),
      deps(),
    );
    expect(other).toEqual({ ok: false, reason: "unknown-user" });
  });

  it("never matches on an email whose domain the organisation has not verified", async () => {
    // Any admin of the linked organisation can set a user's email to any address.
    for (const extra of [
      { email: "admin@unlinked.example" },
      { email: "admin@unlinked.example", xms_edov: false },
      { preferred_username: "admin@unlinked.example" },
    ]) {
      const result = await resolveEntraSignIn(
        tenantScope(t.unlinked.slug),
        claims(ORG_A, randomUUID(), extra),
        deps(),
      );
      expect(result.ok, JSON.stringify(extra)).toBe(false);
    }
    const viaUpn = await resolveEntraSignIn(
      tenantScope(t.b.slug),
      claims(ORG_B, randomUUID(), { preferred_username: "admin@b.example" }),
      deps(),
    );
    expect(viaUpn).toEqual({ ok: false, reason: "unknown-user" });
  });

  it("refuses guest accounts in the linked organisation", async () => {
    const result = await resolveEntraSignIn(
      tenantScope(t.a.slug),
      claims(ORG_A, t.a.adminOid, { idp: entraIssuer(OTHER_ORG) }),
      deps(),
    );
    expect(result).toEqual({ ok: false, reason: "guest-account" });
  });

  it("refuses a user from a Microsoft organisation not linked to the tenant", async () => {
    const result = await resolveEntraSignIn(
      tenantScope(t.a.slug),
      claims(OTHER_ORG, randomUUID(), { email: "admin@a.example" }),
      deps(),
    );
    expect(result).toEqual({ ok: false, reason: "organisation-not-linked" });
  });

  it("refuses a member of another tenant's linked organisation", async () => {
    const result = await resolveEntraSignIn(
      tenantScope(t.a.slug),
      claims(ORG_B, randomUUID(), { email: "admin@b.example" }),
      deps(),
    );
    expect(result).toEqual({ ok: false, reason: "organisation-not-linked" });
  });

  it("refuses everyone when the tenant has linked no organisation", async () => {
    const result = await resolveEntraSignIn(
      tenantScope(t.unlinked.slug),
      claims(OTHER_ORG, randomUUID(), { email: "admin@unlinked.example" }),
      deps(),
    );
    expect(result).toEqual({ ok: false, reason: "organisation-not-linked" });
  });

  it("refuses an unknown user from the linked organisation", async () => {
    const result = await resolveEntraSignIn(
      tenantScope(t.a.slug),
      claims(ORG_A, randomUUID(), { email: "stranger@a.example" }),
      deps(),
    );
    expect(result).toEqual({ ok: false, reason: "unknown-user" });
  });

  it("refuses a token whose issuer is a different organisation from the one it claims", async () => {
    const result = await resolveEntraSignIn(
      tenantScope(t.a.slug),
      { ...claims(ORG_A, t.a.adminOid), iss: entraIssuer(OTHER_ORG) },
      deps(),
    );
    expect(result).toEqual({ ok: false, reason: "invalid-token" });
  });

  it("refuses an unknown tenant", async () => {
    const result = await resolveEntraSignIn(
      tenantScope("no-such-tenant"),
      claims(ORG_A, t.a.adminOid),
      deps(),
    );
    expect(result).toEqual({ ok: false, reason: "unknown-tenant" });
  });
});

describe("Microsoft sign-in for operators", () => {
  const operatorScope = { kind: "operator" as const };

  it("lets in a member of the client's organisation with the Operator app role, for 1 hour", async () => {
    const oid = randomUUID();
    const result = await resolveEntraSignIn(
      operatorScope,
      claims(OPERATOR_ORG, oid, { roles: ["Operator"], name: "Op" }),
      deps(),
    );
    expect(result).toEqual({
      ok: true,
      identity: {
        kind: "operator",
        oid,
        name: "Op",
        email: null,
        expiresAt: 1_000_000 + OPERATOR_SESSION_MS,
      },
    });
  });

  it("refuses a member of the client's organisation without the Operator role", async () => {
    const result = await resolveEntraSignIn(
      operatorScope,
      claims(OPERATOR_ORG, randomUUID(), { roles: ["Reader"] }),
      deps(),
    );
    expect(result).toEqual({ ok: false, reason: "not-an-operator" });
  });

  it("refuses the Operator role from any other organisation", async () => {
    const result = await resolveEntraSignIn(
      operatorScope,
      claims(ORG_A, randomUUID(), { roles: ["Operator"] }),
      deps(),
    );
    expect(result).toEqual({ ok: false, reason: "not-an-operator" });
  });
});

describe("email sign-in links", () => {
  it("works once for a user of the tenant", async () => {
    const link = await createEmailLink(db, {
      slug: t.a.slug,
      email: " User@A.example ",
      baseUrl: BASE_URL,
    });
    expect(link).toMatchObject({ kind: "link", to: "user@a.example" });
    const url = new URL(link?.kind === "link" ? link.url : "");
    expect(url.pathname).toBe(`/t/${t.a.slug}/sign-in/verify`);
    const input = {
      slug: t.a.slug,
      email: url.searchParams.get("email") ?? "",
      token: url.searchParams.get("token") ?? "",
    };
    expect(await consumeEmailLink(db, input)).toMatchObject({
      kind: "tenant",
      tenantId: t.a.id,
      userId: t.a.user,
      role: "tenant_user",
    });
    expect(await consumeEmailLink(db, input)).toBeNull();
  });

  it("creates nothing for an address that is not a user of the tenant", async () => {
    expect(
      await createEmailLink(db, { slug: t.a.slug, email: "admin@b.example", baseUrl: BASE_URL }),
    ).toBeNull();
    expect(
      await createEmailLink(db, {
        slug: "no-such-tenant",
        email: "user@a.example",
        baseUrl: BASE_URL,
      }),
    ).toBeNull();
    const stored = await db.withTenant(t.a.id, (tx) =>
      tx
        .select()
        .from(schema.verificationTokens)
        .where(eq(schema.verificationTokens.identifier, "admin@b.example")),
    );
    expect(stored).toEqual([]);
  });

  it("refuses an expired link", async () => {
    const link = await createEmailLink(db, {
      slug: t.a.slug,
      email: "user@a.example",
      baseUrl: BASE_URL,
      now: Date.now() - LINK_LIFETIME_MS - 1000,
    });
    const url = new URL(link?.kind === "link" ? link.url : "");
    expect(
      await consumeEmailLink(db, {
        slug: t.a.slug,
        email: "user@a.example",
        token: url.searchParams.get("token") ?? "",
      }),
    ).toBeNull();
  });

  it("refuses a link used on another tenant's portal, or with a wrong token", async () => {
    const link = await createEmailLink(db, {
      slug: t.a.slug,
      email: "user@a.example",
      baseUrl: BASE_URL,
      now: Date.now() + 2 * 61_000, // a minute after the first test's link
    });
    const token = new URL(link?.kind === "link" ? link.url : "").searchParams.get("token") ?? "";
    expect(
      await consumeEmailLink(db, { slug: t.b.slug, email: "user@a.example", token }),
    ).toBeNull();
    expect(
      await consumeEmailLink(db, {
        slug: t.a.slug,
        email: "user@a.example",
        token: `${token.slice(0, -2)}xx`,
      }),
    ).toBeNull();
    expect(
      await consumeEmailLink(db, { slug: t.a.slug, email: "admin@a.example", token }),
    ).toBeNull();
    // Still valid for the right tenant and address.
    expect(
      await consumeEmailLink(db, { slug: t.a.slug, email: "user@a.example", token }),
    ).not.toBeNull();
  });

  it("using one link stops the user's other outstanding links working", async () => {
    const first = await createEmailLink(db, {
      slug: t.b.slug,
      email: "admin@b.example",
      baseUrl: BASE_URL,
    });
    // A minute later, as a person would ask again.
    const second = await createEmailLink(db, {
      slug: t.b.slug,
      email: "admin@b.example",
      baseUrl: BASE_URL,
      now: Date.now() + 61_000,
    });
    const token = (l: typeof first) =>
      new URL(l?.kind === "link" ? l.url : "").searchParams.get("token") ?? "";
    expect(
      await consumeEmailLink(db, {
        slug: t.b.slug,
        email: "admin@b.example",
        token: token(second),
      }),
    ).not.toBeNull();
    expect(
      await consumeEmailLink(db, { slug: t.b.slug, email: "admin@b.example", token: token(first) }),
    ).toBeNull();
  });

  it("stores only a hash of the token", async () => {
    const link = await createEmailLink(db, {
      slug: t.a.slug,
      email: "admin@a.example",
      baseUrl: BASE_URL,
    });
    const token = new URL(link?.kind === "link" ? link.url : "").searchParams.get("token") ?? "";
    const rows = await db.withTenant(t.a.id, (tx) => tx.select().from(schema.verificationTokens));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.tokenHash).not.toBe(token);
  });
});

describe("Google Workspace sign-in to a tenant (task 3b)", () => {
  const google = (extra: Partial<GoogleClaims> = {}): GoogleClaims => ({
    iss: "https://accounts.google.com",
    sub: randomUUID(),
    hd: "lawfirm.example",
    email: "user@lawfirm.example",
    email_verified: true,
    ...extra,
  });
  const scope = (slug = t.g.slug) => ({ kind: "tenant" as const, slug });
  const deps = () => ({ db, now: 1_000_000 });

  it("admits a verified member of the linked domain, then knows them by Google ID", async () => {
    const claims = google({ email: "User@LawFirm.example", hd: "LawFirm.example" });
    const first = await resolveGoogleSignIn(scope(), claims, deps());
    expect(first).toEqual({
      ok: true,
      identity: {
        kind: "tenant",
        tenantId: t.g.id,
        slug: t.g.slug,
        userId: t.g.user,
        role: "tenant_user",
        expiresAt: 1_000_000 + TENANT_SESSION_MS,
      },
    });
    const again = await resolveGoogleSignIn(
      scope(),
      { ...claims, email: "renamed@lawfirm.example" },
      deps(),
    );
    expect(again).toMatchObject({ ok: true, identity: { userId: t.g.user } });
    // Another Google account with the same email cannot take the user over.
    const other = await resolveGoogleSignIn(scope(), google(), deps());
    expect(other).toEqual({ ok: false, reason: "unknown-user" });
  });

  it("refuses a member of another Workspace domain", async () => {
    const result = await resolveGoogleSignIn(
      scope(),
      google({ hd: "other.example", email: "admin@other.example" }),
      deps(),
    );
    expect(result).toEqual({ ok: false, reason: "domain-not-linked" });
  });

  it("refuses a personal Google account, which has no hosted domain", async () => {
    const result = await resolveGoogleSignIn(
      scope(),
      google({ hd: undefined, email: "admin@gmail.com" }),
      deps(),
    );
    expect(result).toEqual({ ok: false, reason: "not-workspace-account" });
  });

  it("refuses an unverified email, or one outside the hosted domain", async () => {
    expect(
      await resolveGoogleSignIn(
        scope(),
        google({ email: "admin@lawfirm.example", email_verified: false }),
        deps(),
      ),
    ).toEqual({ ok: false, reason: "not-workspace-account" });
    expect(
      await resolveGoogleSignIn(scope(), google({ email: "admin@a.example" }), deps()),
    ).toEqual({ ok: false, reason: "not-workspace-account" });
  });

  it("refuses a token not issued by Google", async () => {
    const result = await resolveGoogleSignIn(
      scope(),
      google({ iss: "https://evil.example" }),
      deps(),
    );
    expect(result).toEqual({ ok: false, reason: "invalid-token" });
  });

  it("refuses Google sign-in to a tenant linked to Microsoft, or to the operator console", async () => {
    const claims = google({ hd: "a.example", email: "admin@a.example" });
    expect(await resolveGoogleSignIn(scope(t.a.slug), claims, deps())).toEqual({
      ok: false,
      reason: "domain-not-linked",
    });
    expect(await resolveGoogleSignIn({ kind: "operator" }, claims, deps())).toEqual({
      ok: false,
      reason: "not-for-operators",
    });
  });

  it("refuses Microsoft sign-in to a tenant linked to Google", async () => {
    const result = await resolveEntraSignIn(scope(), claims(ORG_A, t.a.adminOid), {
      db,
      operatorEntraTenantId: OPERATOR_ORG,
    });
    expect(result).toEqual({ ok: false, reason: "organisation-not-linked" });
  });
});

describe("limits on sending links (review S1)", () => {
  const ask = (email: string, now: number) =>
    createEmailLink(db, { slug: t.a.slug, email, baseUrl: BASE_URL, now });

  it("sends nothing to an address past five an hour, until one of its links is used", async () => {
    const start = Date.now() + 10 * 60 * 60 * 1000; // clear of other tests' links
    for (let n = 0; n < 5; n++) {
      expect((await ask("user@a.example", start + n * 1_000))?.kind).toBe("link");
    }
    // Five in the hour: the sixth is refused.
    expect((await ask("user@a.example", start + 5_000))?.kind).toBe("too-many");
    // An hour after the first, there is room again.
    const later = start + 61 * 60_000;
    const link = await ask("user@a.example", later);
    expect(link?.kind).toBe("link");
    for (let n = 1; n < 5; n++) await ask("user@a.example", later + n * 1_000);
    expect((await ask("user@a.example", later + 5_000))?.kind).toBe("too-many");
    // Signing in with one of its links (only the inbox's owner can) starts the count again.
    expect(
      await consumeEmailLink(db, {
        slug: t.a.slug,
        email: "user@a.example",
        token: new URL(link?.kind === "link" ? link.url : "").searchParams.get("token") ?? "",
        now: later + 6_000,
      }),
    ).not.toBeNull();
    expect((await ask("user@a.example", later + 7_000))?.kind).toBe("link");
    // Counted, never stored with the address.
    const [counted] = await db.withTenant(t.a.id, (tx) =>
      tx
        .select({ n: sql<number>`sum(${schema.signInRefusals.count})::int` })
        .from(schema.signInRefusals)
        .where(eq(schema.signInRefusals.reason, "too-many-links")),
    );
    expect(counted?.n).toBeGreaterThanOrEqual(2);
  });

  it("caps a tenant's links in an hour, whoever they are for", async () => {
    const saved = LINK_LIMITS.perTenantPerHour;
    LINK_LIMITS.perTenantPerHour = 2;
    try {
      const start = Date.now() + 20 * 60 * 60 * 1000;
      expect((await ask("user@a.example", start))?.kind).toBe("link");
      expect((await ask("admin@a.example", start + 1_000))?.kind).toBe("link");
      // Past the tenant's total, a second email to an address is refused.
      expect((await ask("Admin@A.example", start + 120_000))?.kind).toBe("too-many");
    } finally {
      LINK_LIMITS.perTenantPerHour = saved;
    }
  });

  it("forgets sends a day old, so the log cannot grow without bound", async () => {
    const start = Date.now() + 30 * 60 * 60 * 1000;
    await ask("user@a.example", start);
    await ask("admin@a.example", start + 2 * 24 * 60 * 60 * 1000);
    const left = await db.withTenant(t.a.id, (tx) =>
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.emailLinkSends)
        .where(lte(schema.emailLinkSends.sentAt, new Date(start + 24 * 60 * 60 * 1000))),
    );
    expect(left[0]?.n).toBe(0);
  });

  it("is not reset by trying a junk link (redemption deletes expired tokens)", async () => {
    const start = Date.now() + 40 * 60 * 60 * 1000;
    for (let n = 0; n < LINK_LIMITS.perAddressPerHour; n++) {
      expect((await ask("user@a.example", start + n * 61_000))?.kind).toBe("link");
    }
    await consumeEmailLink(db, {
      slug: t.a.slug,
      email: "user@a.example",
      token: "x".repeat(43),
      now: start + 20 * 60_000,
    });
    expect((await ask("user@a.example", start + 21 * 60_000))?.kind).toBe("too-many");
  });

  it("counts welcome emails too, so adding and removing someone cannot flood them (review S14)", async () => {
    const start = Date.now() + 80 * 60 * 60 * 1000;
    for (let n = 0; n < LINK_LIMITS.perAddressPerHour; n++) {
      const claimed = await db.withTenant(t.a.id, (tx) =>
        claimEmailSend(tx, t.a.id, "user@a.example", start + n * 1_000),
      );
      expect(claimed).toBe(true);
    }
    expect(
      await db.withTenant(t.a.id, (tx) =>
        claimEmailSend(tx, t.a.id, "user@a.example", start + 10_000),
      ),
    ).toBe(false);
    expect((await ask("user@a.example", start + 11_000))?.kind).toBe("too-many");
  });

  it("lets no more than the limit through when many requests come at once", async () => {
    const start = Date.now() + 50 * 60 * 60 * 1000;
    const results = await Promise.all(
      Array.from({ length: 12 }, () => ask("user@a.example", start)),
    );
    expect(results.filter((r) => r?.kind === "link")).toHaveLength(LINK_LIMITS.perAddressPerHour);
    expect(results.filter((r) => r?.kind === "too-many")).toHaveLength(7);
  });

  it("never refuses an address's first email in the hour because of the tenant's total", async () => {
    const saved = LINK_LIMITS.perTenantPerHour;
    LINK_LIMITS.perTenantPerHour = 1;
    try {
      const start = Date.now() + 60 * 60 * 60 * 1000;
      expect((await ask("user@a.example", start))?.kind).toBe("link");
      expect((await ask("admin@a.example", start + 1_000))?.kind).toBe("link");
    } finally {
      LINK_LIMITS.perTenantPerHour = saved;
    }
  });
});

describe("turning email links off (task 3b)", () => {
  it("limits the work-account notes as it limits links (review S1)", async () => {
    const start = Date.now() + 70 * 60 * 60 * 1000;
    const ask = (now: number) =>
      createEmailLink(db, {
        slug: t.g.slug,
        email: "admin@lawfirm.example",
        baseUrl: BASE_URL,
        now,
      });
    await setAllowEmailLinks(db, t.g.id, false, SETUP_ACTOR);
    try {
      for (let n = 0; n < LINK_LIMITS.perAddressPerHour; n++) {
        expect((await ask(start + n * 1_000))?.kind).toBe("use-sso");
      }
      expect((await ask(start + 10_000))?.kind).toBe("too-many");
    } finally {
      await setAllowEmailLinks(db, t.g.id, true, SETUP_ACTOR);
    }
  });

  it("cannot be turned off without SSO linked", async () => {
    expect(await setAllowEmailLinks(db, t.unlinked.id, false, SETUP_ACTOR)).toBe(false);
    const link = await createEmailLink(db, {
      slug: t.unlinked.slug,
      email: "admin@unlinked.example",
      baseUrl: BASE_URL,
    });
    expect(link?.kind).toBe("link");
  });

  it("refuses links sent before, and sends a use-your-work-account note instead of new links", async () => {
    // A minute apart, so the sending limits do not refuse them.
    const at = Date.now();
    const before = await createEmailLink(db, {
      slug: t.g.slug,
      email: "admin@lawfirm.example",
      baseUrl: BASE_URL,
      now: at,
    });
    const token =
      new URL(before?.kind === "link" ? before.url : "").searchParams.get("token") ?? "";
    expect(await setAllowEmailLinks(db, t.g.id, false, SETUP_ACTOR)).toBe(true);

    expect(
      await consumeEmailLink(db, { slug: t.g.slug, email: "admin@lawfirm.example", token }),
    ).toBeNull();
    expect(
      await createEmailLink(db, {
        slug: t.g.slug,
        email: "admin@lawfirm.example",
        baseUrl: BASE_URL,
        now: at + 61_000,
      }),
    ).toEqual({ kind: "use-sso", to: "admin@lawfirm.example" });
    // Unknown addresses still get nothing.
    expect(
      await createEmailLink(db, {
        slug: t.g.slug,
        email: "stranger@lawfirm.example",
        baseUrl: BASE_URL,
      }),
    ).toBeNull();
    // And no new token was stored.
    const stored = await db.withTenant(t.g.id, (tx) => tx.select().from(schema.verificationTokens));
    expect(stored).toEqual([]);

    expect(await setAllowEmailLinks(db, t.g.id, true, SETUP_ACTOR)).toBe(true);
    expect(
      (
        await createEmailLink(db, {
          slug: t.g.slug,
          email: "admin@lawfirm.example",
          baseUrl: BASE_URL,
          now: at + 2 * 61_000,
        })
      )?.kind,
    ).toBe("link");
  });
});

describe("removed users (task 12b)", () => {
  const add = (tenantId: string, email: string, ids: Partial<typeof schema.users.$inferInsert>) =>
    db.withTenant(tenantId, async (tx) => {
      const [row] = await tx
        .insert(schema.users)
        .values({ tenantId, email, displayName: email, role: "tenant_user", ...ids })
        .returning({ userId: schema.users.userId });
      return row?.userId ?? "";
    });
  // Marked removed but still linked, so the lookups themselves are tested, not only the
  // unlinking that removeTenantUser also does.
  const markRemoved = (tenantId: string, userId: string) =>
    db.withTenant(tenantId, (tx) =>
      tx.update(schema.users).set({ removedAt: new Date() }).where(eq(schema.users.userId, userId)),
    );

  it("cannot sign in with Microsoft, by Entra ID or by email", async () => {
    const oid = randomUUID();
    const byId = await add(t.a.id, "gone-oid@a.example", { entraObjectId: oid });
    await add(t.a.id, "gone-email@a.example", {}).then((id) => markRemoved(t.a.id, id));
    await markRemoved(t.a.id, byId);
    expect(await resolveEntraSignIn(tenantScope(t.a.slug), claims(ORG_A, oid), deps())).toEqual({
      ok: false,
      reason: "unknown-user",
    });
    const viaEmail = await resolveEntraSignIn(
      tenantScope(t.a.slug),
      claims(ORG_A, randomUUID(), { email: "gone-email@a.example", xms_edov: true }),
      deps(),
    );
    expect(viaEmail).toEqual({ ok: false, reason: "unknown-user" });
  });

  it("cannot sign in with Google, by Google ID or by email", async () => {
    const sub = randomUUID();
    const byId = await add(t.g.id, "gone-sub@lawfirm.example", { googleSubject: sub });
    await markRemoved(t.g.id, byId);
    await add(t.g.id, "gone-email@lawfirm.example", {}).then((id) => markRemoved(t.g.id, id));
    const google = (s: string, email: string): GoogleClaims => ({
      iss: "https://accounts.google.com",
      sub: s,
      hd: "lawfirm.example",
      email,
      email_verified: true,
    });
    const scope = { kind: "tenant" as const, slug: t.g.slug };
    const gdeps = { db, now: 1_000_000 };
    expect(await resolveGoogleSignIn(scope, google(sub, "renamed@lawfirm.example"), gdeps)).toEqual(
      { ok: false, reason: "unknown-user" },
    );
    expect(
      await resolveGoogleSignIn(scope, google(randomUUID(), "gone-email@lawfirm.example"), gdeps),
    ).toEqual({ ok: false, reason: "unknown-user" });
  });

  it("gets no sign-in link, and one sent before removal stops working", async () => {
    const userId = await add(t.a.id, "gone-link@a.example", {});
    const link = await createEmailLink(db, {
      slug: t.a.slug,
      email: "gone-link@a.example",
      baseUrl: BASE_URL,
    });
    const url = new URL(link?.kind === "link" ? link.url : "");
    await markRemoved(t.a.id, userId);
    expect(
      await consumeEmailLink(db, {
        slug: t.a.slug,
        email: url.searchParams.get("email") ?? "",
        token: url.searchParams.get("token") ?? "",
      }),
    ).toBeNull();
    expect(
      await createEmailLink(db, {
        slug: t.a.slug,
        email: "gone-link@a.example",
        baseUrl: BASE_URL,
      }),
    ).toBeNull();
  });
});

describe("the audit log of sign-ins (task 13)", () => {
  // Counts this hour, by "method reason" (earlier tests here refuse sign-ins too).
  const refusals = async (tenantId: string) =>
    Object.fromEntries(
      (await listRefusedSignIns(db, tenantId, new Date(Date.now() - 3_600_000))).map(
        ({ method, reason, count }) => [`${method} ${reason}`, count],
      ),
    );
  const lastEvent = async (tenantId: string) =>
    (await listAuditEvents(db, tenantId, { limit: 1 }))[0];

  it("records each successful sign-in, with who and how", async () => {
    await resolveEntraSignIn(tenantScope(t.a.slug), claims(ORG_A, t.a.adminOid), deps());
    expect(await lastEvent(t.a.id)).toMatchObject({
      action: "sign-in",
      actorKind: "user",
      actorId: t.a.admin,
      actorLabel: "Admin@A.example",
      detail: { method: "microsoft" },
    });
    // Later than the links other tests asked this address for.
    const link = await createEmailLink(db, {
      slug: t.b.slug,
      email: "admin@b.example",
      baseUrl: BASE_URL,
      now: Date.now() + 3 * 61_000,
    });
    const url = new URL(link?.kind === "link" ? link.url : "");
    await consumeEmailLink(db, {
      slug: t.b.slug,
      email: url.searchParams.get("email") ?? "",
      token: url.searchParams.get("token") ?? "",
    });
    expect(await lastEvent(t.b.id)).toMatchObject({
      action: "sign-in",
      actorId: t.b.admin,
      detail: { method: "email-link" },
    });
  });

  it("counts refused sign-ins to a tenant by reason, without recording a sign-in", async () => {
    const before = (await listAuditEvents(db, t.unlinked.id)).length;
    const counted = await refusals(t.unlinked.id);
    // Three junk links and an unknown Microsoft account.
    for (let i = 0; i < 3; i++) {
      expect(
        await consumeEmailLink(db, {
          slug: t.unlinked.slug,
          email: "admin@unlinked.example",
          token: "x".repeat(43),
        }),
      ).toBeNull();
    }
    await resolveEntraSignIn(tenantScope(t.unlinked.slug), claims(ORG_A, randomUUID()), deps());
    const now = await refusals(t.unlinked.id);
    const added = (key: string) => (now[key] ?? 0) - (counted[key] ?? 0);
    expect(added("email-link link-not-valid")).toBe(3);
    expect(added("microsoft organisation-not-linked")).toBe(1);
    expect((await listAuditEvents(db, t.unlinked.id)).length).toBe(before);
    // Refusals before the tenant's settings are even read are counted too: a personal
    // Google account, a Microsoft guest, a malformed link.
    await resolveGoogleSignIn(
      tenantScope(t.unlinked.slug),
      {
        iss: "https://accounts.google.com",
        sub: randomUUID(),
        email: "someone@gmail.com",
        email_verified: true,
      },
      { db },
    );
    await resolveEntraSignIn(
      tenantScope(t.unlinked.slug),
      claims(ORG_A, randomUUID(), { idp: "https://sts.windows.net/other/" }),
      deps(),
    );
    expect(
      await redeemEmailLink(db, { slug: t.unlinked.slug, email: "not an address", token: "short" }),
    ).toEqual({ ok: false, reason: "link-not-valid" });
    const later = await refusals(t.unlinked.id);
    const more = (key: string) => (later[key] ?? 0) - (now[key] ?? 0);
    expect(more("google not-workspace-account")).toBe(1);
    expect(more("microsoft guest-account")).toBe(1);
    expect(more("email-link link-not-valid")).toBe(1);
    // Nothing is counted for a tenant that does not exist.
    await consumeEmailLink(db, {
      slug: "no-such-tenant",
      email: "a@b.example",
      token: "x".repeat(43),
    });
  });
});
