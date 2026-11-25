import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTenantDatabase, schema, type TenantDatabase, SETUP_ACTOR } from "../src/index.ts";
import { createTestDatabase, type TestDatabase, createTestTenant } from "../src/testing.ts";
import { eq } from "drizzle-orm";
import { addTenantUser, createTenantWithAdmin, endUserSessions } from "../src/tenant-users.ts";

let testDb: TestDatabase;
let db: TenantDatabase;
let n = 0;
const newTenant = () => createTestTenant(db, { name: "Users test", slug: `users-test-${++n}` });

beforeAll(async () => {
  testDb = await createTestDatabase();
  db = createTenantDatabase(testDb.appUrl, { contextKey: testDb.contextKey, maxConnections: 4 });
});

afterAll(async () => {
  await db?.close();
  await testDb?.drop();
});

describe("addTenantUser", () => {
  it("adds a user with a lowercase email, defaulting the display name", async () => {
    const tenantId = await newTenant();
    const id = await addTenantUser(
      db,
      tenantId,
      {
        email: " New.Person@Example.com ",
        role: "tenant_admin",
      },
      SETUP_ACTOR,
    );
    const rows = await db.withTenant(tenantId, (tx) => tx.select().from(schema.users));
    expect(rows).toMatchObject([
      {
        userId: id,
        email: "new.person@example.com",
        displayName: "new.person@example.com",
        role: "tenant_admin",
      },
    ]);
  });

  it("refuses a duplicate in the same tenant regardless of case, but allows it in another", async () => {
    const tenantId = await newTenant();
    const other = await newTenant();
    await addTenantUser(
      db,
      tenantId,
      { email: "same@example.com", role: "tenant_user" },
      SETUP_ACTOR,
    );
    await expect(
      addTenantUser(db, tenantId, { email: "SAME@example.com", role: "tenant_user" }, SETUP_ACTOR),
    ).rejects.toThrow("same@example.com is already a user of this tenant.");
    await expect(
      addTenantUser(db, other, { email: "same@example.com", role: "tenant_user" }, SETUP_ACTOR),
    ).resolves.toBeTruthy();
  });

  it("gives the same plain message when the same address is added concurrently", async () => {
    const tenantId = await newTenant();
    const results = await Promise.allSettled(
      ["race@example.com", "RACE@example.com", "Race@Example.com", "race@EXAMPLE.com"].map(
        (email) => addTenantUser(db, tenantId, { email, role: "tenant_user" }, SETUP_ACTOR),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) {
      if (r.status === "rejected") {
        expect((r.reason as Error).message).toBe(
          "race@example.com is already a user of this tenant.",
        );
      }
    }
  });

  it("refuses non-addresses, control characters and over-long names", async () => {
    const tenantId = await newTenant();
    for (const email of ["not-an-email", "a\u001b[31m@b.example", "a b@c.example"]) {
      await expect(
        addTenantUser(db, tenantId, { email, role: "tenant_user" }, SETUP_ACTOR),
        email,
      ).rejects.toThrow("That is not an email address.");
    }
    await expect(
      addTenantUser(
        db,
        tenantId,
        {
          email: "long@example.com",
          displayName: "x".repeat(201),
          role: "tenant_user",
        },
        SETUP_ACTOR,
      ),
    ).rejects.toThrow(/at most 200/);
  });
});

describe("createTenantWithAdmin", () => {
  it("creates nothing when the admin email is not an address", async () => {
    await expect(
      createTenantWithAdmin(
        db,
        {
          name: "Half made",
          slug: "half-made",
          adminEmail: "not-an-email",
        },
        SETUP_ACTOR,
      ),
    ).rejects.toThrow(/not an email address/);
    expect(await db.tenantIdForSlug("half-made")).toBeNull();
  });

  it("creates the tenant with its admin", async () => {
    const tenantId = await createTenantWithAdmin(
      db,
      {
        name: "Whole",
        slug: "whole-co",
        adminEmail: "Boss@Whole.example",
      },
      SETUP_ACTOR,
    );
    const rows = await db.withTenant(tenantId, (tx) => tx.select().from(schema.users));
    expect(rows).toMatchObject([{ email: "boss@whole.example", role: "tenant_admin" }]);
  });
});

describe("endUserSessions (review S15)", () => {
  it("refuses the user's earlier sessions from now on, and records the sign-out", async () => {
    const tenantId = await newTenant();
    const userId = await addTenantUser(
      db,
      tenantId,
      { email: "leaving@example.com", role: "tenant_user" },
      SETUP_ACTOR,
    );
    const before = Date.now();
    await endUserSessions(db, tenantId, { kind: "user", userId, label: "leaving@example.com" });
    const [row] = await db.withTenant(tenantId, (tx) => tx.select().from(schema.users));
    expect(row?.sessionsValidAfter?.getTime()).toBeGreaterThanOrEqual(before - 1000);
    const events = await db.withTenant(tenantId, (tx) =>
      tx.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, "sign-out")),
    );
    expect(events).toMatchObject([{ actorKind: "user", actorId: userId }]);
  });
});
