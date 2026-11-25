// Review Q4, T15: migrations run against a database that already holds data, and refuse,
// changing nothing, when the database's applied migrations do not match the repository's.
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTenantDatabase, type TenantDatabase } from "../src/index.ts";
import { MigrationMismatchError, runMigrations } from "../src/migrate.ts";
import {
  createTestDatabase,
  createTestTenant,
  serverAdminUrl,
  type TestDatabase,
} from "../src/testing.ts";

const DEPLOY_CLI = fileURLToPath(new URL("../src/deploy-cli.ts", import.meta.url));

let testDb: TestDatabase;
let db: TenantDatabase;
let admin: postgres.Sql;

beforeAll(async () => {
  testDb = await createTestDatabase();
  db = createTenantDatabase(testDb.appUrl, { contextKey: testDb.contextKey, maxConnections: 1 });
  admin = postgres(testDb.adminUrl, { max: 1, onnotice: () => {} });
});

afterAll(async () => {
  await admin?.end({ timeout: 5 });
  await db?.close();
  await testDb?.drop();
});

const appliedCount = async () =>
  Number((await admin`select count(*)::int as n from drizzle.__drizzle_migrations`)[0]?.["n"]);

describe("runMigrations on a database in use", () => {
  it("runs again over existing data, changing nothing", async () => {
    const tenantId = await createTestTenant(db, { name: "Kept", slug: "kept" });
    const before = await appliedCount();
    await runMigrations(testDb.adminUrl);
    expect(await appliedCount()).toBe(before);
    expect((await db.listTenants()).map((t) => t.tenantId)).toContain(tenantId);
  });

  it("two at once on an empty database apply each migration once (the lock)", async () => {
    // Without the lock, concurrent runs on an empty database fail part-way (each tries to
    // create the same tables).
    const name = `agentcore_test_${randomUUID().replaceAll("-", "")}`;
    const server = postgres(serverAdminUrl(), { max: 1, onnotice: () => {} });
    await server.unsafe(`create database ${name}`);
    const url = new URL(testDb.adminUrl);
    url.pathname = `/${name}`;
    try {
      await Promise.all([1, 2, 3].map(() => runMigrations(url.toString())));
      const fresh = postgres(url.toString(), { max: 1, onnotice: () => {} });
      const [row] = await fresh`select count(*)::int as n from drizzle.__drizzle_migrations`;
      await fresh.end({ timeout: 5 });
      expect(row?.["n"]).toBe(await appliedCount());
    } finally {
      await server.unsafe(`drop database if exists ${name} with (force)`);
      await server.end({ timeout: 5 });
    }
  });

  it("refuses, applying nothing, when an applied migration has changed", async () => {
    // The newest migration is left pending, so "nothing applied" is tested, not given.
    const [newest] =
      await admin`select id, hash, created_at from drizzle.__drizzle_migrations order by created_at desc limit 1`;
    const [older] =
      await admin`select id, hash from drizzle.__drizzle_migrations order by created_at offset 3 limit 1`;
    await admin`delete from drizzle.__drizzle_migrations where id = ${newest?.["id"]}`;
    await admin`update drizzle.__drizzle_migrations set hash = 'edited' where id = ${older?.["id"]}`;
    const before = await appliedCount();
    try {
      await expect(runMigrations(testDb.adminUrl)).rejects.toBeInstanceOf(MigrationMismatchError);
      expect(await appliedCount()).toBe(before);
    } finally {
      await admin`update drizzle.__drizzle_migrations set hash = ${older?.["hash"]} where id = ${older?.["id"]}`;
      await admin`insert into drizzle.__drizzle_migrations (hash, created_at) values (${newest?.["hash"]}, ${newest?.["created_at"]})`;
    }
  });

  it("makes the deploy step exit 1 and say why", async () => {
    const [older] =
      await admin`select id, hash from drizzle.__drizzle_migrations order by created_at offset 3 limit 1`;
    await admin`update drizzle.__drizzle_migrations set hash = 'edited' where id = ${older?.["id"]}`;
    try {
      const run = spawnSync(process.execPath, [DEPLOY_CLI], {
        env: {
          ...process.env,
          DATABASE_ADMIN_URL: testDb.adminUrl,
          APP_DB_PASSWORD: "unused-in-this-test",
          TENANT_CONTEXT_KEY: randomBytes(32).toString("base64"),
        },
        encoding: "utf8",
      });
      expect(run.status).toBe(1);
      expect(run.stderr + run.stdout).toContain("Migrations not applied");
    } finally {
      await admin`update drizzle.__drizzle_migrations set hash = ${older?.["hash"]} where id = ${older?.["id"]}`;
    }
  });

  it("refuses, applying nothing, when an older migration was never applied", async () => {
    // As if 0005 had been merged from upstream after later ones were applied.
    const [row] =
      await admin`select id, hash, created_at from drizzle.__drizzle_migrations order by created_at offset 5 limit 1`;
    await admin`delete from drizzle.__drizzle_migrations where id = ${row?.["id"]}`;
    const before = await appliedCount();
    try {
      await expect(runMigrations(testDb.adminUrl)).rejects.toThrow(/would be skipped/);
      expect(await appliedCount()).toBe(before);
    } finally {
      await admin`insert into drizzle.__drizzle_migrations (hash, created_at) values (${row?.["hash"]}, ${row?.["created_at"]})`;
    }
  });
});
