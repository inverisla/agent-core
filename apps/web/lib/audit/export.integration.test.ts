// Task 13: the whole-log CSV is read a page at a time, oldest first, and a tenant's own
// export says an operator acted without saying who.
import {
  addTenantUser,
  createTenantDatabase,
  createTenantWithAdmin,
  SETUP_ACTOR,
  type TenantDatabase,
} from "@agent-core/db";
import { createTestDatabase, type TestDatabase } from "@agent-core/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditCsv, type AuditView } from "./describe.ts";

let testDb: TestDatabase;
let db: TenantDatabase;
let tenantId = "";

beforeAll(async () => {
  testDb = await createTestDatabase();
  db = createTenantDatabase(testDb.appUrl, { contextKey: testDb.contextKey, maxConnections: 2 });
  tenantId = await createTenantWithAdmin(
    db,
    { name: "Export Ltd", slug: "export", adminEmail: "boss@export.example" },
    { kind: "operator", oid: "oid-export", label: "op@client.example" },
  );
  for (const n of [1, 2, 3]) {
    await addTenantUser(
      db,
      tenantId,
      { email: `u${n}@export.example`, role: "tenant_user" },
      SETUP_ACTOR,
    );
  }
});

afterAll(async () => {
  await db?.close();
  await testDb?.drop();
});

async function lines(view: AuditView, pageSize: number): Promise<string[]> {
  let text = "";
  for await (const chunk of auditCsv(db, tenantId, view, pageSize)) text += chunk;
  return text.split("\r\n").slice(0, -1);
}

describe("exporting the whole audit log", () => {
  it("reads every page, oldest first, whatever the page size", async () => {
    const small = await lines("operator", 2);
    // Header, tenant created, its admin, then three users.
    expect(small).toHaveLength(6);
    expect(small[1]).toContain("tenant.created");
    expect(small[2]).toContain("Added boss@export.example as Admin");
    expect(small.slice(3).map((l) => /Added (u\d)@/.exec(l)?.[1])).toEqual(["u1", "u2", "u3"]);
    expect(await lines("operator", 1000)).toEqual(small);
    // A page size that divides the rows exactly still ends.
    expect(await lines("operator", 5)).toEqual(small);
  });

  it("names the operator for operators, and not for the tenant", async () => {
    const forOperator = (await lines("operator", 1000))[1] ?? "";
    expect(forOperator).toContain("op@client.example (operator),operator,oid-export");
    const forTenant = (await lines("tenant", 1000))[1] ?? "";
    expect(forTenant).toContain(",Operator,operator,,tenant.created");
    expect(forTenant).not.toMatch(/op@client|oid-export/);
  });
});
