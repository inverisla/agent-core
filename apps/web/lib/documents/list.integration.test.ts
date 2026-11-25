// Review Q8: the documents list pages through every document, newest first, with none
// repeated or missed, and a page cursor works only within its own tenant.
import { randomUUID } from "node:crypto";
import {
  addTenantUser,
  createTenantDatabase,
  schema,
  type TenantDatabase,
  SETUP_ACTOR,
} from "@agent-core/db";
import { createTestDatabase, type TestDatabase, createTestTenant } from "@agent-core/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { documentPage } from "./list.ts";

let testDb: TestDatabase;
let db: TenantDatabase;
const t = { a: "", b: "" };
const made: string[] = [];

async function addDocuments(tenantId: string, n: number, at: Date): Promise<string[]> {
  const user = await addTenantUser(
    db,
    tenantId,
    { email: `${randomUUID()}@example.com`, role: "tenant_user" },
    SETUP_ACTOR,
  );
  return db.withTenant(tenantId, async (tx) => {
    const rows = await tx
      .insert(schema.documents)
      .values(
        Array.from({ length: n }, (_, i) => ({
          tenantId,
          filename: `doc-${i}.pdf`,
          contentType: "application/pdf",
          sizeBytes: 1,
          blobPath: "p",
          sha256: "s",
          uploadedBy: user,
          // Three share a moment, so the order also has to use the ID.
          createdAt: new Date(at.getTime() + Math.floor(i / 3) * 1000),
        })),
      )
      .returning({ id: schema.documents.documentId });
    return rows.map((r) => r.id);
  });
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  db = createTenantDatabase(testDb.appUrl, { contextKey: testDb.contextKey, maxConnections: 2 });
  t.a = await createTestTenant(db, { name: "Paged A", slug: "paged-a" });
  t.b = await createTestTenant(db, { name: "Paged B", slug: "paged-b" });
  made.push(...(await addDocuments(t.a, 8, new Date("2026-01-01T00:00:00Z"))));
  await addDocuments(t.b, 2, new Date("2026-01-01T00:00:00Z"));
});

afterAll(async () => {
  await db?.close();
  await testDb?.drop();
});

describe("documentPage (review Q8)", () => {
  it("reaches every document, newest first, a page at a time, with none repeated", async () => {
    const seen: string[] = [];
    let before: string | null = null;
    for (let pages = 0; pages < 10; pages++) {
      const page = await documentPage(db, t.a, before, 3);
      seen.push(...page.documents.map((d) => d.documentId));
      if (!page.older) break;
      before = page.older;
    }
    expect(seen).toHaveLength(8);
    expect(new Set(seen)).toEqual(new Set(made));
    const first = await documentPage(db, t.a, null, 8);
    expect(first.documents.map((d) => d.documentId)).toEqual(seen);
    expect(first.older).toBeNull();
  });

  it("gives an empty page for a cursor that is not one of the tenant's documents", async () => {
    const other = (await documentPage(db, t.b)).documents[0]?.documentId ?? "";
    expect((await documentPage(db, t.a, other)).documents).toEqual([]);
    expect((await documentPage(db, t.a, "not-an-id")).documents).toEqual([]);
    expect((await documentPage(db, t.a, randomUUID())).documents).toEqual([]);
  });
});
