// Task 12b: listing tenants for operators, managing a tenant's users (with the guards
// that keep at least one admin), removing users without losing their history, and the
// agents a tenant may use.
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addTenantUser,
  createTenantWithAdmin,
  createTenantDatabase,
  getTenantAgents,
  listTenantUsers,
  removeTenantUser,
  schema,
  setTenantAgents,
  setTenantUserRole,
  type TenantDatabase,
  SETUP_ACTOR,
} from "../src/index.ts";
import { createTestDatabase, type TestDatabase, createTestTenant } from "../src/testing.ts";

let testDb: TestDatabase;
let db: TenantDatabase;
const t = { a: "", b: "" };

beforeAll(async () => {
  testDb = await createTestDatabase();
  db = createTenantDatabase(testDb.appUrl, { contextKey: testDb.contextKey, maxConnections: 2 });
  t.a = await createTestTenant(db, { name: "Alpha Ltd", slug: "alpha" });
  t.b = await createTestTenant(db, { name: "Beta Ltd", slug: "beta" });
});

afterAll(async () => {
  await db?.close();
  await testDb?.drop();
});

describe("tenants for the operator console", () => {
  it("lists every tenant's ID and slug, and nothing more", async () => {
    expect(await db.listTenants()).toEqual([
      { tenantId: t.a, slug: "alpha" },
      { tenantId: t.b, slug: "beta" },
    ]);
  });
});

describe("a tenant's users", () => {
  it("never leaves a tenant without an admin, and an admin cannot remove themselves", async () => {
    const admin = await addTenantUser(
      db,
      t.a,
      {
        email: "admin@alpha.example",
        role: "tenant_admin",
      },
      SETUP_ACTOR,
    );
    const user = await addTenantUser(
      db,
      t.a,
      { email: "user@alpha.example", role: "tenant_user" },
      SETUP_ACTOR,
    );
    expect(
      await setTenantUserRole(db, t.a, { userId: admin, role: "tenant_user" }, SETUP_ACTOR),
    ).toEqual({
      ok: false,
      reason: "last-admin",
    });
    expect(
      await removeTenantUser(
        db,
        t.a,
        { userId: admin },
        { kind: "user", userId: admin, label: "admin@alpha.example" },
      ),
    ).toEqual({
      ok: false,
      reason: "self",
    });
    // An operator (no acting user) cannot remove the last admin either.
    expect(await removeTenantUser(db, t.a, { userId: admin }, SETUP_ACTOR)).toEqual({
      ok: false,
      reason: "last-admin",
    });
    // With a second admin, the first can be demoted.
    expect(
      await setTenantUserRole(db, t.a, { userId: user, role: "tenant_admin" }, SETUP_ACTOR),
    ).toEqual({
      ok: true,
    });
    expect(
      await setTenantUserRole(db, t.a, { userId: admin, role: "tenant_user" }, SETUP_ACTOR),
    ).toEqual({
      ok: true,
    });
    const roles = (await listTenantUsers(db, t.a)).map((u) => [u.email, u.role]);
    expect(roles).toEqual([
      ["admin@alpha.example", "tenant_user"],
      ["user@alpha.example", "tenant_admin"],
    ]);
  });

  it("removes a user without losing them, and restores them when added again", async () => {
    const id = await addTenantUser(
      db,
      t.a,
      {
        email: "leaver@alpha.example",
        displayName: "Lee Leaver",
        role: "tenant_user",
      },
      SETUP_ACTOR,
    );
    const tokens = () =>
      db.withTenant(t.a, (tx) =>
        tx
          .select()
          .from(schema.verificationTokens)
          .where(eq(schema.verificationTokens.identifier, "leaver@alpha.example")),
      );
    const addToken = () =>
      db.withTenant(t.a, (tx) =>
        tx.insert(schema.verificationTokens).values({
          tenantId: t.a,
          identifier: "leaver@alpha.example",
          tokenHash: `h-${Math.random()}`,
          expires: new Date(Date.now() + 60_000),
        }),
      );
    await addToken();
    // Linked to Microsoft before leaving: removal unlinks it, so it cannot sign them in.
    await db.withTenant(t.a, (tx) =>
      tx.update(schema.users).set({ entraObjectId: "oid-1" }).where(eq(schema.users.userId, id)),
    );
    expect(await removeTenantUser(db, t.a, { userId: id }, SETUP_ACTOR)).toEqual({ ok: true });
    const removed = (await listTenantUsers(db, t.a)).find((u) => u.userId === id);
    expect(removed?.removedAt).toBeInstanceOf(Date);
    const [row] = await db.withTenant(t.a, (tx) =>
      tx.select().from(schema.users).where(eq(schema.users.userId, id)),
    );
    expect(row?.entraObjectId).toBeNull();
    // Signed out everywhere, and an unused sign-in link stops working.
    expect(row?.sessionsValidAfter).toBeInstanceOf(Date);
    expect(await tokens()).toEqual([]);
    // Removed users are listed after current ones.
    expect((await listTenantUsers(db, t.a)).at(-1)?.userId).toBe(id);
    // Removing again finds no current user.
    expect(await removeTenantUser(db, t.a, { userId: id }, SETUP_ACTOR)).toEqual({
      ok: false,
      reason: "not-found",
    });
    // Adding the same address (any case) brings the same user back, with the new role.
    const again = await addTenantUser(
      db,
      t.a,
      {
        email: "Leaver@Alpha.example",
        role: "tenant_admin",
      },
      SETUP_ACTOR,
    );
    expect(again).toBe(id);
    const back = (await listTenantUsers(db, t.a)).find((u) => u.userId === id);
    // The old name does not come back: the address may be someone else's now.
    expect(back).toMatchObject({
      removedAt: null,
      role: "tenant_admin",
      displayName: "leaver@alpha.example",
    });
    // Sessions from before the restore stay refused (apps/web checkTenant).
    const [restored] = await db.withTenant(t.a, (tx) =>
      tx.select().from(schema.users).where(eq(schema.users.userId, id)),
    );
    expect(restored?.sessionsValidAfter?.getTime()).toBeGreaterThan(
      row?.sessionsValidAfter?.getTime() ?? Infinity,
    );
    // A current user's address is still refused.
    await expect(
      addTenantUser(db, t.a, { email: "leaver@alpha.example", role: "tenant_user" }, SETUP_ACTOR),
    ).rejects.toThrow(/already a user/);
  });

  it("keeps each tenant's users to itself", async () => {
    const other = await addTenantUser(
      db,
      t.b,
      { email: "x@beta.example", role: "tenant_admin" },
      SETUP_ACTOR,
    );
    expect((await listTenantUsers(db, t.a)).map((u) => u.userId)).not.toContain(other);
    // From tenant A's context, tenant B's user does not exist.
    expect(await removeTenantUser(db, t.a, { userId: other }, SETUP_ACTOR)).toEqual({
      ok: false,
      reason: "not-found",
    });
    expect(
      await setTenantUserRole(db, t.a, { userId: other, role: "tenant_user" }, SETUP_ACTOR),
    ).toEqual({
      ok: false,
      reason: "not-found",
    });
  });
});

describe("creating a tenant with its admin", () => {
  it("creates both together, or neither", async () => {
    const id = await createTenantWithAdmin(
      db,
      {
        name: "Gamma Ltd",
        slug: "gamma",
        adminEmail: "Boss@Gamma.example",
      },
      SETUP_ACTOR,
    );
    expect(await listTenantUsers(db, id)).toMatchObject([
      { email: "boss@gamma.example", role: "tenant_admin" },
    ]);
    // A slug already taken fails the whole thing; a bad email or slug fails before any work.
    await expect(
      createTenantWithAdmin(
        db,
        { name: "Again", slug: "gamma", adminEmail: "a@x.example" },
        SETUP_ACTOR,
      ),
    ).rejects.toThrow();
    await expect(
      createTenantWithAdmin(
        db,
        { name: "Delta", slug: "delta", adminEmail: "not-an-email" },
        SETUP_ACTOR,
      ),
    ).rejects.toThrow(/not an email/);
    await expect(
      createTenantWithAdmin(
        db,
        { name: "Bad", slug: "Bad Slug", adminEmail: "a@x.example" },
        SETUP_ACTOR,
      ),
    ).rejects.toThrow(/slug/);
    expect((await db.listTenants()).map((x) => x.slug)).not.toContain("delta");
  });
});

describe("a tenant's agents", () => {
  it("are set as a whole, per tenant, by name", async () => {
    expect(await getTenantAgents(db, t.a)).toEqual([]);
    await setTenantAgents(
      db,
      t.a,
      ["contract-summary", "invoice-check", "contract-summary"],
      SETUP_ACTOR,
    );
    expect(await getTenantAgents(db, t.a)).toEqual(["contract-summary", "invoice-check"]);
    expect(await getTenantAgents(db, t.b)).toEqual([]);
    await setTenantAgents(db, t.a, ["invoice-check"], SETUP_ACTOR);
    expect(await getTenantAgents(db, t.a)).toEqual(["invoice-check"]);
    await expect(setTenantAgents(db, t.a, ["../etc"], SETUP_ACTOR)).rejects.toThrow(
      /Not an agent name/,
    );
  });
});
