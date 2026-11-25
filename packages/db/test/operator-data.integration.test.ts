// Task 16: the operator schema holds the operator's own records, never tenant data, and
// the app may only add to it and read it. Also the console's view of jobs across tenants:
// status and codes only, each tenant read in its own context.
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addTenantUser,
  createJob,
  createTenantDatabase,
  finishAttempt,
  getAgentTestRun,
  getAgentVersion,
  hasAgentTestRun,
  jobCountsByAgentVersion,
  listAgentTestRuns,
  listAgentVersions,
  recentJobs,
  recordAgentTestRun,
  recordAgentVersion,
  schema,
  setJobStatus,
  SETUP_ACTOR,
  startAttempt,
  type TenantDatabase,
} from "../src/index.ts";
import { createTestDatabase, type TestDatabase, createTestTenant } from "../src/testing.ts";

let testDb: TestDatabase;
let db: TenantDatabase;
let owner: postgres.Sql;
let tenantA = "";
let tenantB = "";

const OPERATOR_TABLES: Record<string, string[]> = {
  agent_test_runs: [
    "accuracy",
    "agent_name",
    "calls",
    "cases",
    "cost_usd",
    "finished_at",
    "model",
    "provider",
    "repeats",
    "result",
    "run_id",
    "started_at",
    "tokens",
    "version",
  ],
  agent_versions: ["agent_name", "recorded_at", "snapshot", "version"],
};

const snapshot = {
  definition: { name: "summary", steps: [] },
  files: [{ path: "prompts/extract.md", text: "Read the contract.", bytes: 18 }],
};

async function document(tenantId: string): Promise<string> {
  const user = await addTenantUser(
    db,
    tenantId,
    { email: `u${Math.random()}@op.example`, role: "tenant_user" },
    SETUP_ACTOR,
  );
  const [doc] = await db.withTenant(tenantId, (tx) =>
    tx
      .insert(schema.documents)
      .values({
        tenantId,
        filename: "secret-name.pdf",
        contentType: "application/pdf",
        sizeBytes: 1,
        blobPath: "documents/x",
        sha256: "s",
        uploadedBy: user,
      })
      .returning(),
  );
  if (!doc) throw new Error("no document");
  return doc.documentId;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  db = createTenantDatabase(testDb.appUrl, { contextKey: testDb.contextKey, maxConnections: 2 });
  owner = postgres(testDb.adminUrl, { max: 1, onnotice: () => {} });
  tenantA = await createTestTenant(db, { name: "A Ltd", slug: "op-a" });
  tenantB = await createTestTenant(db, { name: "B Ltd", slug: "op-b" });
});

afterAll(async () => {
  await owner?.end();
  await db?.close();
  await testDb?.drop();
});

describe("the operator schema", () => {
  it("has only the known tables, with no tenant column and no link to tenant tables", async () => {
    const columns = await owner<{ table: string; column: string }[]>`
      select c.relname as table, a.attname as column
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      where n.nspname = 'operator' and c.relkind in ('r', 'p', 'v', 'm', 'f')
      order by 1, 2`;
    const tables: Record<string, string[]> = {};
    for (const r of columns) (tables[r.table] ??= []).push(r.column);
    // A new table or column here must hold no tenant data: think before adding it to the list.
    expect(tables).toEqual(OPERATOR_TABLES);

    const links = await owner<{ name: string }[]>`
      select con.conname as name from pg_constraint con
      join pg_class c on c.oid = con.conrelid join pg_namespace n on n.oid = c.relnamespace
      join pg_class r on r.oid = con.confrelid join pg_namespace rn on rn.oid = r.relnamespace
      where con.contype = 'f' and (n.nspname = 'operator') <> (rn.nspname = 'operator')`;
    expect(links).toEqual([]);
  });

  it("the app may read and add, never change, delete or create anything there", async () => {
    const grants = await owner<{ table: string; privilege: string }[]>`
      select table_name as table, privilege_type as privilege
      from information_schema.role_table_grants
      where table_schema = 'operator' and grantee = 'agentcore_app' order by 1, 2`;
    expect(grants).toEqual([
      { table: "agent_test_runs", privilege: "INSERT" },
      { table: "agent_test_runs", privilege: "SELECT" },
      { table: "agent_versions", privilege: "INSERT" },
      { table: "agent_versions", privilege: "SELECT" },
    ]);
    const [create] = await owner<{ ok: boolean }[]>`
      select has_schema_privilege('agentcore_app', 'operator', 'CREATE') as ok`;
    expect(create?.ok).toBe(false);
  });

  it("refuses changes and deletions, even by the owner", async () => {
    await recordAgentVersion(db, { agentName: "fixed", version: "v1", snapshot });
    await expect(
      db.withOperatorData((tx) => tx.update(schema.agentVersions).set({ version: "v2" })),
    ).rejects.toThrow();
    await expect(db.withOperatorData((tx) => tx.delete(schema.agentVersions))).rejects.toThrow();
    await expect(owner`update operator.agent_versions set version = 'v2'`).rejects.toThrow(
      /cannot be changed or deleted/,
    );
    await expect(owner`delete from operator.agent_test_runs`).rejects.toThrow(
      /cannot be changed or deleted/,
    );
    await expect(owner`truncate operator.agent_versions cascade`).rejects.toThrow(
      /cannot be changed or deleted/,
    );
  });

  it("is read and written outside every tenant: no tenant's rows are visible there", async () => {
    await document(tenantA);
    const rows = await db.withOperatorData((tx) => tx.select().from(schema.documents));
    expect(rows).toEqual([]);
    await expect(
      db.withOperatorData((tx) =>
        tx.insert(schema.tenantAgents).values({ tenantId: tenantA, agentName: "x" }),
      ),
    ).rejects.toThrow();
  });

  it("records versions once and test runs in full", async () => {
    await recordAgentVersion(db, { agentName: "summary", version: "aaa", snapshot });
    await recordAgentVersion(db, {
      agentName: "summary",
      version: "aaa",
      snapshot: { definition: {}, files: [] },
    });
    expect((await getAgentVersion(db, "summary", "aaa"))?.snapshot).toEqual(snapshot);
    expect(await getAgentVersion(db, "summary", "nope")).toBeNull();
    await recordAgentVersion(db, { agentName: "summary", version: "bbb", snapshot });
    expect((await listAgentVersions(db, "summary")).map((v) => v.version).sort()).toEqual([
      "aaa",
      "bbb",
    ]);

    const run = {
      agentName: "summary",
      version: "aaa",
      provider: "azure-openai",
      model: "gpt-5.4-mini",
      repeats: 3,
      cases: 10,
      accuracy: 0.8,
      result: { cases: [{ id: "01", runs: [] }] },
      calls: 30,
      tokens: 12_345,
      costUsd: 0.0123,
      startedAt: new Date("2026-11-23T10:00:00Z"),
    };
    const runId = await recordAgentTestRun(db, run);
    expect(
      await hasAgentTestRun(db, {
        agentName: "summary",
        version: "aaa",
        provider: "azure-openai",
        model: "gpt-5.4-mini",
      }),
    ).toBe(true);
    expect(
      await hasAgentTestRun(db, {
        agentName: "summary",
        version: "aaa",
        provider: "bedrock",
        model: "gpt-5.4-mini",
      }),
    ).toBe(false);
    expect(await getAgentTestRun(db, runId)).toMatchObject({ ...run, runId });
    expect(await getAgentTestRun(db, "not-a-uuid")).toBeNull();
    const [listed] = await listAgentTestRuns(db, "summary");
    expect(listed).toMatchObject({
      runId,
      version: "aaa",
      calls: 30,
      costUsd: 0.0123,
      accuracy: 0.8,
    });
    expect(listed).not.toHaveProperty("result");
    // A run must belong to a recorded version.
    await expect(recordAgentTestRun(db, { ...run, version: "unrecorded" })).rejects.toThrow();
  });
});

describe("recent jobs, for the operator's job list", () => {
  it("gives status, attempts and the last reason code, newest first, for one tenant only", async () => {
    const docA = await document(tenantA);
    const ok = await createJob(db, tenantA, {
      documentId: docA,
      agentName: "summary",
      agentVersion: "aaa",
    });
    const bad = await createJob(db, tenantA, {
      documentId: docA,
      agentName: "summary",
      agentVersion: "aaa",
    });
    await setJobStatus(db, tenantA, ok, "queued");
    for (const attempt of [1, 2]) {
      await startAttempt(db, tenantA, bad, attempt);
      await finishAttempt(
        db,
        tenantA,
        bad,
        attempt,
        "failed",
        attempt === 1 ? "model-timeout" : "no-text",
      );
    }
    await setJobStatus(db, tenantA, bad, "failed");
    const docB = await document(tenantB);
    await createJob(db, tenantB, { documentId: docB, agentName: "summary", agentVersion: "aaa" });

    const all = await recentJobs(db, tenantA, { limit: 10 });
    expect(all.map((j) => j.jobId)).toEqual([bad, ok]);
    expect(all[0]).toMatchObject({ status: "failed", attempts: 2, errorCode: "no-text" });
    expect(all[1]).toMatchObject({ status: "queued", attempts: 0, errorCode: null });
    // Nothing from the document: no file name, no fields.
    expect(Object.keys(all[0] ?? {}).sort()).toEqual([
      "agentName",
      "agentVersion",
      "attempts",
      "createdAt",
      "errorCode",
      "jobId",
      "run",
      "status",
      "updatedAt",
    ]);
    expect(
      (await recentJobs(db, tenantA, { failedOnly: true, limit: 10 })).map((j) => j.jobId),
    ).toEqual([bad]);
    expect(await recentJobs(db, tenantA, { limit: 1 })).toHaveLength(1);
    expect(await jobCountsByAgentVersion(db, tenantA, new Date(Date.now() - 60_000))).toEqual([
      { agentName: "summary", agentVersion: "aaa", jobs: 2 },
    ]);
    expect(await jobCountsByAgentVersion(db, tenantA, new Date(Date.now() + 60_000))).toEqual([]);
  });
});
