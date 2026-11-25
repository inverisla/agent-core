// Task 14: the restore drill's checks, against a copy of a database standing in for one
// restored from backup (CREATE DATABASE ... TEMPLATE copies it byte for byte).
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addTenantUser,
  checkRestore,
  createTenantDatabase,
  createTenantWithAdmin,
  SETUP_ACTOR,
} from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";

let source: TestDatabase;
const copyName = `agentcore_restored_${Date.now()}`;
const withDb = (url: string, name: string) => {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
};
const serverAdmin = () => {
  const u = new URL(source.adminUrl);
  u.pathname = "/postgres";
  return u.toString();
};
let restored: { appUrl: string; adminUrl: string };
const later = () => new Date(Date.now() + 5 * 60_000);

beforeAll(async () => {
  source = await createTestDatabase();
  const db = createTenantDatabase(source.appUrl, {
    contextKey: source.contextKey,
    maxConnections: 1,
  });
  const id = await createTenantWithAdmin(
    db,
    { name: "Restored", slug: "restored", adminEmail: "a@restored.example" },
    SETUP_ACTOR,
  );
  await addTenantUser(db, id, { email: "b@restored.example", role: "tenant_user" }, SETUP_ACTOR);
  await db.close();
  // The "restore": a copy of the database as it is now.
  const server = postgres(serverAdmin(), { max: 1, onnotice: () => {} });
  await server.unsafe(
    `select pg_terminate_backend(pid) from pg_stat_activity where datname = '${new URL(source.adminUrl).pathname.slice(1)}' and pid <> pg_backend_pid()`,
  );
  await server.unsafe(
    `create database ${copyName} template ${new URL(source.adminUrl).pathname.slice(1)}`,
  );
  // A copy made this way, unlike a restored server, does not keep database-level rights.
  await server.unsafe(`revoke temporary on database ${copyName} from public`);
  await server.end();
  restored = {
    appUrl: withDb(source.appUrl, copyName),
    adminUrl: withDb(source.adminUrl, copyName),
  };
}, 60_000);

afterAll(async () => {
  const server = postgres(serverAdmin(), { max: 1, onnotice: () => {} });
  await server.unsafe(`drop database if exists ${copyName} with (force)`);
  await server.end();
  await source?.drop();
});

describe("the restore drill's checks", () => {
  it("pass for a faithful restore: same migrations, app role works, same rows", async () => {
    const result = await checkRestore({
      source: { appUrl: source.appUrl, adminUrl: source.adminUrl },
      restored,
      contextKey: source.contextKey,
      restorePoint: later(),
    });
    expect(result.lines.filter((l) => l.startsWith("FAIL"))).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.lines.join("\n")).toMatch(
      /2 users, 0 documents, 0 jobs, 0 review events, 3 audit events/,
    );
  });

  it("fail when the restore is missing data from before the restore point", async () => {
    const db = createTenantDatabase(source.appUrl, {
      contextKey: source.contextKey,
      maxConnections: 1,
    });
    const id = (await db.listTenants())[0]?.tenantId ?? "";
    await addTenantUser(db, id, { email: "c@restored.example", role: "tenant_user" }, SETUP_ACTOR);
    await createTenantWithAdmin(
      db,
      { name: "New", slug: "too-new", adminEmail: "n@new.example" },
      SETUP_ACTOR,
    );
    await db.close();
    const result = await checkRestore({
      source: { appUrl: source.appUrl, adminUrl: source.adminUrl },
      restored,
      contextKey: source.contextKey,
      restorePoint: later(),
    });
    expect(result.ok).toBe(false);
    expect(result.lines).toContain("FAIL tenant too-new is missing from the restore");
    expect(result.lines).toContain("FAIL tenant restored: 2 users restored, 3 in the source");
    // Rows from after the restore point are not expected in it.
    const before = await checkRestore({
      source: { appUrl: source.appUrl, adminUrl: source.adminUrl },
      restored,
      contextKey: source.contextKey,
      restorePoint: new Date(),
    });
    expect(before.lines.filter((l) => l.startsWith("FAIL"))).toEqual([]);
  });

  it("fail when the restore cannot be read with the context key", async () => {
    const result = await checkRestore({
      source: { appUrl: source.appUrl, adminUrl: source.adminUrl },
      restored,
      contextKey: Buffer.alloc(32, 7),
      restorePoint: later(),
    });
    expect(result.ok).toBe(false);
  });
});
