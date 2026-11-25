// Task 4's done-when: a file lands in the right tenant's path, and a wrong type or
// oversize file is rejected. Runs against Azurite and a throwaway database.
import { randomUUID } from "node:crypto";
import {
  addTenantUser,
  createTenantDatabase,
  schema,
  type TenantDatabase,
  SETUP_ACTOR,
} from "@agent-core/db";
import { createTestDatabase, type TestDatabase, createTestTenant } from "@agent-core/db/testing";
import { BlobServiceClient } from "@azure/storage-blob";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DOCX, PDF } from "./file-type.ts";
import { intakeDocument } from "./intake.ts";
import { listDocuments, maxUploadsPerDay, uploadsSince } from "./list.ts";
import { tenantContainerName } from "@agent-core/core/storage";
import { makeDocm, makeDocx, makeExe, makeOleFile, makePdf } from "./test-files.ts";

const AZURITE =
  process.env["AZURE_STORAGE_CONNECTION_STRING"] ??
  "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;";

let testDb: TestDatabase;
let db: TenantDatabase;
const blobs = BlobServiceClient.fromConnectionString(AZURITE);
const t = { a: { id: "", user: "" }, b: { id: "", user: "" } };
const MB = 1024 * 1024;

async function blobNames(tenantId: string): Promise<string[]> {
  const container = blobs.getContainerClient(tenantContainerName(tenantId));
  if (!(await container.exists())) return [];
  const names: string[] = [];
  for await (const b of container.listBlobsFlat()) names.push(b.name);
  return names;
}

const intake = (
  tenant: { id: string; user: string },
  filename: string,
  bytes: Buffer,
  maxBytes = 25 * MB,
) =>
  intakeDocument({
    db,
    blobs,
    tenantId: tenant.id,
    userId: tenant.user,
    filename,
    bytes,
    maxBytes,
  });

beforeAll(async () => {
  testDb = await createTestDatabase();
  db = createTenantDatabase(testDb.appUrl, { contextKey: testDb.contextKey, maxConnections: 2 });
  t.a.id = await createTestTenant(db, { name: "Tenant A", slug: "tenant-a" });
  t.b.id = await createTestTenant(db, { name: "Tenant B", slug: "tenant-b" });
  t.a.user = await addTenantUser(
    db,
    t.a.id,
    { email: "user@a.example", role: "tenant_user" },
    SETUP_ACTOR,
  );
  t.b.user = await addTenantUser(
    db,
    t.b.id,
    { email: "user@b.example", role: "tenant_user" },
    SETUP_ACTOR,
  );
});

afterAll(async () => {
  for (const id of [t.a.id, t.b.id]) {
    if (id) await blobs.getContainerClient(tenantContainerName(id)).deleteIfExists();
  }
  await db?.close();
  await testDb?.drop();
});

describe("document intake", () => {
  it("puts a PDF in the uploading tenant's container, with a record in that tenant only", async () => {
    const bytes = makePdf();
    const result = await intake(t.a, "Supplier Agreement.pdf", bytes);
    if (!result.ok) throw new Error(result.reason);
    const { documentId } = result.document;

    expect(result.document).toMatchObject({
      filename: "Supplier Agreement.pdf",
      contentType: PDF,
      sizeBytes: bytes.length,
      blobPath: `tenant-${t.a.id}/documents/${documentId}`,
    });
    const blob = blobs
      .getContainerClient(tenantContainerName(t.a.id))
      .getBlockBlobClient(`documents/${documentId}`);
    expect(await blob.downloadToBuffer()).toEqual(bytes);
    const props = await blob.getProperties();
    expect(props.contentType).toBe(PDF);

    expect((await listDocuments(db, t.a.id)).map((d) => d.documentId)).toContain(documentId);
    expect(await listDocuments(db, t.b.id)).toEqual([]);
    expect(await blobNames(t.b.id)).toEqual([]);
  });

  it("accepts a Word file", async () => {
    const result = await intake(t.b, "terms.docx", makeDocx());
    expect(result).toMatchObject({ ok: true, document: { contentType: DOCX } });
    expect(await blobNames(t.b.id)).toHaveLength(1);
  });

  it("rejects a wrong type, a macro document, an oversize file and an empty file, storing nothing", async () => {
    const blobsBefore = await blobNames(t.a.id);
    const docsBefore = await listDocuments(db, t.a.id);
    expect(await intake(t.a, "contract.pdf", makeExe())).toEqual({
      ok: false,
      reason: "unsupported-type",
    });
    expect(await intake(t.a, "contract.docm", makeDocm())).toEqual({
      ok: false,
      reason: "unsupported-type",
    });
    expect(await intake(t.a, "big.pdf", makePdf(2 * MB), 1 * MB)).toEqual({
      ok: false,
      reason: "too-large",
    });
    expect(await intake(t.a, "empty.pdf", Buffer.alloc(0))).toEqual({ ok: false, reason: "empty" });
    expect(await intake(t.a, "old.doc", makeOleFile())).toEqual({
      ok: false,
      reason: "protected-or-legacy",
    });
    expect(await blobNames(t.a.id)).toEqual(blobsBefore);
    expect(await listDocuments(db, t.a.id)).toEqual(docsBefore);
  });

  it("removes the file again if the record cannot be written", async () => {
    const blobsBefore = await blobNames(t.a.id);
    // A user from another tenant: the tenant-scoped foreign key refuses the record.
    await expect(intake({ id: t.a.id, user: t.b.user }, "orphan.pdf", makePdf())).rejects.toThrow();
    expect(await blobNames(t.a.id)).toEqual(blobsBefore);
  });

  it("keeps the uploader's filename for display only, never in the path", async () => {
    const result = await intake(t.a, "../../tenant-b/documents/evil.pdf", makePdf());
    if (!result.ok) throw new Error(result.reason);
    expect(result.document.filename).toBe("evil.pdf");
    expect(result.document.blobPath).toBe(
      `tenant-${t.a.id}/documents/${result.document.documentId}`,
    );
    const rows = await db.withTenant(t.a.id, (tx) => tx.select().from(schema.documents));
    expect(rows.every((r) => r.blobPath.startsWith(`tenant-${t.a.id}/`))).toBe(true);
  });
});

describe("tenant container names", () => {
  it("come only from a tenant ID", () => {
    expect(tenantContainerName(t.a.id || randomUUID())).toMatch(/^tenant-[0-9a-f-]{36}$/);
    expect(() => tenantContainerName("../other")).toThrow();
  });
});

describe("the daily upload allowance (review S5)", () => {
  it("counts a tenant's own uploads in the last day, and no other tenant's", async () => {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const before = await uploadsSince(db, t.b.id, dayAgo);
    const result = await intake(t.b, "one more.pdf", makePdf());
    if (!result.ok) throw new Error(result.reason);
    expect(await uploadsSince(db, t.b.id, dayAgo)).toBe(before + 1);
    expect(await uploadsSince(db, t.b.id, new Date(Date.now() + 60_000))).toBe(0);
  });

  it("is 500 a day unless set otherwise, and ignores a setting that is not a whole number", () => {
    expect(maxUploadsPerDay({})).toBe(500);
    expect(maxUploadsPerDay({ MAX_UPLOADS_PER_TENANT_PER_DAY: "50" })).toBe(50);
    expect(maxUploadsPerDay({ MAX_UPLOADS_PER_TENANT_PER_DAY: "lots" })).toBe(500);
    expect(maxUploadsPerDay({ MAX_UPLOADS_PER_TENANT_PER_DAY: "0" })).toBe(500);
  });
});
