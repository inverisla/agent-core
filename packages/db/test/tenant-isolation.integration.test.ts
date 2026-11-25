// Task 2's done-when test: a user in one tenant cannot read another tenant's rows,
// even with a crafted query.
//
// Each run creates its own database as the owner role (not a superuser, as in Azure),
// applies the migrations, sets a fresh tenant context key, seeds two tenants, then
// attacks tenant B's data as the app role (agentcore_app) from tenant A's context.
// "Crafted query" includes injected SQL that tries to switch tenant with set_config.
import { createTestTenant } from "../src/testing.ts";
import { randomBytes, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setContextKey, signTenantContext } from "../src/context-key.ts";
import { createTenantDatabase, type TenantDatabase } from "../src/index.ts";
import { runMigrations } from "../src/migrate.ts";
import { documents, jobs, tenants, users } from "../src/schema.ts";

const ADMIN_URL =
  process.env["DATABASE_ADMIN_URL"] ??
  "postgres://agentcore_owner:agentcore_owner@localhost:5433/agentcore";
const APP_URL =
  process.env["DATABASE_URL"] ?? "postgres://agentcore_app:agentcore_app@localhost:5433/agentcore";
const HINT =
  "Is the local stack running (`docker compose up`)? If your Postgres volume predates task 2, " +
  "recreate it once with `docker compose down -v` so the agentcore_owner and agentcore_app logins exist.";

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

const testDb = `agentcore_test_${randomUUID().replaceAll("-", "")}`;
const adminUrl = withDatabase(ADMIN_URL, testDb);
const appUrl = withDatabase(APP_URL, testDb);
const contextKey = randomBytes(32);

const A = {
  tenant: randomUUID(),
  user: randomUUID(),
  docs: [randomUUID(), randomUUID()],
  job: randomUUID(),
};
const B = { tenant: randomUUID(), user: randomUUID(), docs: [randomUUID()], job: randomUUID() };
const B_IDS = [B.tenant, B.user, B.job, ...B.docs];
const TENANT_TABLES = [
  "audit_events",
  "documents",
  "email_link_sends",
  "job_attempts",
  "job_outputs",
  "jobs",
  "model_calls",
  "review_events",
  "sign_in_refusals",
  "tenant_agents",
  "tenant_sso",
  "tenants",
  "users",
  "verification_tokens",
];

let owner: postgres.Sql;
let app: TenantDatabase;

/** Signs and sets the tenant on an open transaction, the way withTenant does. */
async function signIn(tx: postgres.TransactionSql, tenantId: string): Promise<string> {
  const [ctx] = await tx<{ pid: string; epoch: string }[]>`
    select pg_backend_pid()::text as pid, extract(epoch from now())::text as epoch`;
  const sig = signTenantContext(contextKey, tenantId, ctx?.pid ?? "", ctx?.epoch ?? "");
  await tx`select set_config('app.tenant_id', ${tenantId}, true),
                  set_config('app.tenant_sig', ${sig}, true)`;
  return sig;
}

/** Runs as the owner in one tenant's context. FORCE RLS applies to the owner too. */
function ownerAs<T>(tenantId: string, fn: (tx: postgres.TransactionSql) => Promise<T>) {
  return owner.begin(async (tx) => {
    await signIn(tx, tenantId);
    return fn(tx);
  }) as Promise<T>;
}

async function seed(t: typeof A, slug: string) {
  await ownerAs(t.tenant, async (tx) => {
    await tx`insert into tenants (tenant_id, name, slug) values (${t.tenant}, ${slug}, ${slug})`;
    await tx`insert into users (user_id, tenant_id, email, display_name, role)
      values (${t.user}, ${t.tenant}, ${`admin@${slug}.example`}, 'Admin', 'tenant_admin')`;
    for (const doc of t.docs) {
      await tx`insert into documents
        (document_id, tenant_id, filename, content_type, size_bytes, blob_path, sha256, uploaded_by)
        values (${doc}, ${t.tenant}, ${`${slug}-contract.pdf`}, 'application/pdf', 1024,
                ${`${t.tenant}/${doc}`}, 'abc', ${t.user})`;
    }
    await tx`insert into jobs (job_id, tenant_id, document_id, agent_name, agent_version)
      values (${t.job}, ${t.tenant}, ${t.docs[0] ?? ""}, 'contract-summary', 'v-test')`;
  });
}

beforeAll(async () => {
  const server = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    await server.unsafe(`create database ${testDb}`);
  } catch (error) {
    throw new Error(`Could not create the test database. ${HINT}`, { cause: error });
  } finally {
    await server.end();
  }
  await runMigrations(adminUrl);
  await setContextKey(adminUrl, contextKey);
  owner = postgres(adminUrl, { max: 1, onnotice: () => {} });
  await seed(A, "tenant-a");
  await seed(B, "tenant-b");
  app = createTenantDatabase(appUrl, { contextKey, maxConnections: 1 });
});

afterAll(async () => {
  await app?.close();
  await owner?.end();
  const server = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await server.unsafe(`drop database if exists ${testDb} with (force)`);
  await server.end();
});

/**
 * Resolves to the Postgres error message of a rejected query. Drizzle wraps driver
 * errors in "Failed query: …" and keeps the Postgres error as the cause.
 */
async function pgError(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    return cause instanceof Error ? cause.message : String(cause);
  }
  throw new Error("Expected the query to be rejected, but it succeeded.");
}

/** Runs raw SQL as tenant A and returns the rows. */
function asA<T extends Record<string, unknown>>(query: string): Promise<T[]> {
  return app.withTenant(A.tenant, async (tx) => {
    const rows = await tx.execute(sql.raw(query));
    return rows as unknown as T[];
  });
}

/** A raw app-role connection with no tenant set, for attacks outside withTenant. */
async function withRawApp<T>(fn: (raw: postgres.Sql) => Promise<T>): Promise<T> {
  const raw = postgres(appUrl, { max: 1, onnotice: () => {} });
  try {
    return await fn(raw);
  } finally {
    await raw.end();
  }
}

describe("tenant separation", () => {
  it("connects as a role that cannot bypass row-level security", async () => {
    const [role] = await app.withTenant(A.tenant, async (tx) =>
      tx.execute<{ rolsuper: boolean; rolbypassrls: boolean; rolname: string }>(
        sql`select rolname, rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
      ),
    );
    expect(role).toEqual({ rolname: "agentcore_app", rolsuper: false, rolbypassrls: false });
  });

  describe("schema rules", () => {
    it("every relation the app role can use, outside the operator schema, is a public table with tenant_id and forced RLS", async () => {
      const usable = await owner<
        {
          schema: string;
          name: string;
          kind: string;
          rls: boolean;
          forced: boolean;
          tenant: boolean;
        }[]
      >`
        select n.nspname as schema, c.relname as name, c.relkind::text as kind,
          c.relrowsecurity as rls, c.relforcerowsecurity as forced,
          exists (select 1 from pg_attribute a
                  where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped) as tenant
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r', 'p', 'v', 'm', 'f')
          -- The operator schema holds no tenant data, and has rules of its own
          -- (operator-data.integration.test.ts).
          and n.nspname not in ('pg_catalog', 'information_schema', 'operator')
          and has_table_privilege('agentcore_app', c.oid, 'SELECT, INSERT, UPDATE, DELETE')`;
      expect(usable.map((r) => r.name).sort()).toEqual(TENANT_TABLES);
      for (const r of usable) {
        expect(r, r.name).toMatchObject({
          schema: "public",
          kind: "r",
          rls: true,
          forced: true,
          tenant: true,
        });
      }

      const publicTables = await owner<{ name: string }[]>`
        select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')`;
      expect(publicTables.map((r) => r.name).sort()).toEqual(TENANT_TABLES);
    });

    it("each table has exactly one policy, tenant_isolation, on the signed tenant", async () => {
      const policies = await owner<
        {
          table: string;
          name: string;
          permissive: string;
          roles: string[];
          cmd: string;
          qual: string;
          check: string;
        }[]
      >`
        select tablename as table, policyname as name, permissive, roles, cmd,
          qual, with_check as check
        from pg_policies where schemaname = 'public' order by tablename`;
      expect(policies.map((p) => p.table)).toEqual(TENANT_TABLES);
      const expected =
        /^\(tenant_id = \( SELECT app\.current_tenant_id\(\) AS current_tenant_id\)\)$/;
      for (const p of policies) {
        expect(p, p.table).toMatchObject({
          name: "tenant_isolation",
          permissive: "PERMISSIVE",
          roles: ["public"],
          cmd: "ALL",
        });
        expect(p.qual, p.table).toMatch(expected);
        expect(p.check, p.table).toMatch(expected);
      }
    });

    it("every foreign key between tables includes tenant_id", async () => {
      const fks = await owner<{ name: string; hasTenant: boolean }[]>`
        select con.conname as name,
          (select a.attnum from pg_attribute a
           where a.attrelid = con.conrelid and a.attname = 'tenant_id') = any (con.conkey) as "hasTenant"
        from pg_constraint con join pg_namespace n on n.oid = con.connamespace
        where con.contype = 'f' and n.nspname = 'public'`;
      expect(fks.length).toBeGreaterThan(0);
      for (const fk of fks) expect(fk.hasTenant, fk.name).toBe(true);
    });
  });

  it("returns only the current tenant's rows from every table", async () => {
    const seen = await app.withTenant(A.tenant, async (tx) => ({
      tenants: await tx.select().from(tenants),
      users: await tx.select().from(users),
      documents: await tx.select().from(documents),
      jobs: await tx.select().from(jobs),
    }));
    expect(seen.tenants.map((r) => r.tenantId)).toEqual([A.tenant]);
    expect(seen.users.map((r) => r.userId)).toEqual([A.user]);
    expect(seen.documents.map((r) => r.documentId).sort()).toEqual([...A.docs].sort());
    expect(seen.jobs.map((r) => r.jobId)).toEqual([A.job]);
  });

  describe("crafted queries as tenant A never return tenant B's rows", () => {
    const crafted: [string, string][] = [
      ["filter on B's tenant_id", `select * from documents where tenant_id = '${B.tenant}'`],
      [
        "look up B's row by primary key",
        `select * from documents where document_id = '${B.docs[0]}'`,
      ],
      ["always-true condition", `select * from documents where tenant_id = '${B.tenant}' or true`],
      [
        "union with B's rows",
        `select document_id from documents where tenant_id = '${A.tenant}'
         union all select document_id from documents where tenant_id = '${B.tenant}'`,
      ],
      [
        "subquery into B's ids",
        `select * from jobs where document_id in
           (select document_id from documents where tenant_id = '${B.tenant}')`,
      ],
      [
        "join across tables",
        `select d.* from jobs j join documents d on d.document_id = j.document_id
         where j.tenant_id = '${B.tenant}'`,
      ],
      ["read B's tenant record", `select * from tenants where slug = 'tenant-b'`],
      ["read B's users", `select * from users where email like '%tenant-b%'`],
      [
        "CTE and lateral join",
        `with t as (select '${B.tenant}'::uuid as id)
         select d.* from t, lateral (select * from documents where tenant_id = t.id) d`,
      ],
    ];

    it.each(crafted)("%s", async (_name, query) => {
      const text = JSON.stringify(await asA(query));
      for (const id of B_IDS) expect(text).not.toContain(id);
      expect(text).not.toContain("tenant-b");
    });

    it("counts only tenant A's rows", async () => {
      const [row] = await asA<{ n: string }>("select count(*)::text as n from documents");
      expect(row?.n).toBe(String(A.docs.length));
    });
  });

  describe("injected SQL cannot switch tenant", () => {
    const injected: [string, string][] = [
      [
        "set_config inside a single SELECT",
        `select filename from documents where filename = 'tenant-a-contract.pdf'
         union all select d.filename
         from (select set_config('app.tenant_id', '${B.tenant}', true)) s,
              lateral (select filename from documents limit 5) d`,
      ],
      [
        "set_config in a materialised CTE",
        `with s as materialized (select set_config('app.tenant_id', '${B.tenant}', true))
         select d.filename from s, documents d`,
      ],
      [
        "set_config with a forged signature",
        `select d.filename from (select set_config('app.tenant_id', '${B.tenant}', true),
                                        set_config('app.tenant_sig', repeat('0', 64), true)) s,
                                lateral (select filename from documents) d`,
      ],
      [
        "session-level set_config",
        `select d.filename from (select set_config('app.tenant_id', '${B.tenant}', false)) s,
                                lateral (select filename from documents) d`,
      ],
    ];

    it.each(injected)("%s fails instead of returning B's rows", async (_name, query) => {
      expect(await pgError(asA(query))).toMatch(/invalid tenant context/);
    });

    it("later queries in the same transaction cannot see B's rows either", async () => {
      const outcome = await app
        .withTenant(A.tenant, async (tx) => {
          await tx.execute(sql.raw(`select set_config('app.tenant_id', '${B.tenant}', true)`));
          return tx.execute(sql.raw("select filename from documents"));
        })
        .then(
          (rows) => JSON.stringify(rows),
          (error: unknown) => String((error as Error).cause ?? error),
        );
      expect(outcome).not.toContain("tenant-b");
      expect(outcome).toMatch(/invalid tenant context/);
    });

    it("rejects a valid signature replayed on another connection", async () => {
      // A genuine signature for tenant B, taken from B's own transaction (as if read
      // from pg_stat_activity), is useless on any other backend.
      let bSig = "";
      await ownerAs(B.tenant, async (tx) => {
        const [row] = await tx`select current_setting('app.tenant_sig') as sig`;
        bSig = String(row?.["sig"]);
      });
      expect(
        await pgError(
          asA(
            `select d.filename from (select set_config('app.tenant_id', '${B.tenant}', true),
                                            set_config('app.tenant_sig', '${bSig}', true)) s,
                                    lateral (select filename from documents) d`,
          ),
        ),
      ).toMatch(/invalid tenant context/);
    });

    it("rejects a signature replayed in a later transaction on the same connection", async () => {
      await withRawApp(async (raw) => {
        const sig = await raw.begin((tx) => signIn(tx, A.tenant));
        const result = raw.begin(async (tx) => {
          await tx`select set_config('app.tenant_id', ${A.tenant}, true),
                          set_config('app.tenant_sig', ${sig}, true)`;
          return tx`select * from documents`;
        });
        expect(await pgError(result)).toMatch(/invalid tenant context/);
      });
    });
  });

  describe("writes as tenant A cannot touch tenant B's rows", () => {
    it("rejects inserting a row with B's tenant_id", async () => {
      const work = app.withTenant(A.tenant, (tx) =>
        tx.insert(users).values({
          tenantId: B.tenant,
          email: "intruder@example.com",
          displayName: "Intruder",
          role: "tenant_admin",
        }),
      );
      expect(await pgError(work)).toMatch(/row-level security/);
    });

    it("rejects moving A's row into tenant B", async () => {
      const work = app.withTenant(A.tenant, (tx) =>
        tx.update(jobs).set({ tenantId: B.tenant }).where(eq(jobs.jobId, A.job)),
      );
      expect(await pgError(work)).toMatch(/row-level security/);
    });

    it("updates and deletes of B's rows affect nothing", async () => {
      const result = await app.withTenant(A.tenant, async (tx) => ({
        updated: await tx
          .update(documents)
          .set({ filename: "hacked.pdf" })
          .where(eq(documents.tenantId, B.tenant))
          .returning(),
        deleted: await tx.delete(jobs).where(eq(jobs.jobId, B.job)).returning(),
      }));
      expect(result).toEqual({ updated: [], deleted: [] });
      await ownerAs(B.tenant, async (tx) => {
        const [bDoc] =
          await tx`select filename from documents where document_id = ${B.docs[0] ?? ""}`;
        expect(bDoc?.["filename"]).toBe("tenant-b-contract.pdf");
        expect(await tx`select 1 from jobs where job_id = ${B.job}`).toHaveLength(1);
      });
    });

    it("rejects a job that points at B's document", async () => {
      const work = app.withTenant(A.tenant, (tx) =>
        tx.insert(jobs).values({
          tenantId: A.tenant,
          documentId: B.docs[0] ?? "",
          agentName: "contract-summary",
          agentVersion: "v-test",
        }),
      );
      expect(await pgError(work)).toMatch(/foreign key/);
    });

    it("cannot create a tenant other than the one in context", async () => {
      expect(
        await pgError(
          asA(`insert into tenants (tenant_id, name, slug) values ('${randomUUID()}', 'x', 'xyz')`),
        ),
      ).toMatch(/row-level security/);
    });
  });

  describe("without tenant context", () => {
    it("sees no rows and cannot write", async () => {
      await withRawApp(async (raw) => {
        for (const table of ["tenants", "users", "documents", "jobs"]) {
          expect(await raw.unsafe(`select * from ${table}`), table).toHaveLength(0);
        }
        const work = raw`insert into users (tenant_id, email, display_name, role)
            values (${A.tenant}, 'x@example.com', 'X', 'tenant_user')`;
        expect(await pgError(work)).toMatch(/row-level security/);
      });
    });

    it("does not carry the tenant over to the next transaction on the same connection", async () => {
      await withRawApp(async (raw) => {
        await raw.begin((tx) => signIn(tx, A.tenant));
        const [setting] = await raw`select current_setting('app.tenant_id', true) as value`;
        expect(setting?.["value"] ?? "").toBe("");
        expect(await raw`select * from documents`).toHaveLength(0);
      });
    });

    it("switches cleanly between tenants on one pooled connection", async () => {
      const first = await app.withTenant(A.tenant, (tx) => tx.select().from(jobs));
      const second = await app.withTenant(B.tenant, (tx) => tx.select().from(jobs));
      expect(first.map((j) => j.jobId)).toEqual([A.job]);
      expect(second.map((j) => j.jobId)).toEqual([B.job]);
    });
  });

  describe("the app role cannot weaken the rules", () => {
    const attempts: [string, string, RegExp][] = [
      ["disable RLS", "alter table documents disable row level security", /must be owner/],
      ["stop forcing RLS", "alter table documents no force row level security", /must be owner/],
      ["drop the policy", "drop policy tenant_isolation on documents", /must be owner/],
      ["add a permissive policy", "create policy open on users using (true)", /must be owner/],
      ["switch to the owner role", "set role agentcore_owner", /permission denied/],
      ["switch session user", "set session authorization agentcore_owner", /permission denied/],
      ["grant itself bypass", "alter role agentcore_app bypassrls", /permission denied/],
      ["read the signing key", "select * from app.tenant_context_key", /permission denied/],
      ["create a temporary table", "create temp table t (x int)", /permission denied/],
      ["create a view", "create view v as select * from documents", /permission denied/],
      [
        "replace the tenant function",
        "create or replace function app.current_tenant_id() returns uuid language sql as $$ select null::uuid $$",
        /permission denied|must be owner/,
      ],
    ];

    it.each(attempts)("cannot %s", async (_name, statement, error) => {
      expect(await pgError(asA(statement))).toMatch(error);
    });
  });

  describe("tenants and slugs", () => {
    it("creates a tenant in its own context and finds it by slug", async () => {
      const slug = `new-${randomUUID().slice(0, 8)}`;
      const id = await createTestTenant(app, { name: "New tenant", slug });
      expect(await app.tenantIdForSlug(slug)).toBe(id);
      const seen = await app.withTenant(id, (tx) => tx.select().from(tenants));
      expect(seen.map((t) => t.slug)).toEqual([slug]);
      // Tenant A still sees only itself.
      const fromA = await app.withTenant(A.tenant, (tx) => tx.select().from(tenants));
      expect(fromA.map((t) => t.tenantId)).toEqual([A.tenant]);
    });

    it("returns null for unknown or malformed slugs", async () => {
      expect(await app.tenantIdForSlug("no-such-tenant")).toBeNull();
      expect(await app.tenantIdForSlug("' or true --")).toBeNull();
      expect(await app.tenantIdForSlug("tenant-b")).toBe(B.tenant);
    });

    it("rejects malformed and reserved slugs", async () => {
      await expect(createTestTenant(app, { name: "x", slug: "Bad Slug" })).rejects.toThrow(/slug/);
      await expect(createTestTenant(app, { name: "x", slug: "operator" })).rejects.toThrow(
        /reserved/,
      );
      await expect(createTestTenant(app, { name: "x", slug: "tenant-a" })).rejects.toThrow();
    });

    it("refuses slug changes, tenant deletion and double hyphens, even for the owner", async () => {
      await expect(
        ownerAs(A.tenant, (tx) => tx`update tenants set slug = 'renamed-a'`),
      ).rejects.toThrow(/slug cannot be changed/);
      await expect(ownerAs(A.tenant, (tx) => tx`delete from tenants`)).rejects.toThrow(
        /cannot be deleted/,
      );
      const id = randomUUID();
      await expect(
        ownerAs(
          id,
          (tx) => tx`insert into tenants (tenant_id, name, slug) values (${id}, 'x', 'a--b')`,
        ),
      ).rejects.toThrow(/tenants_slug_format/);
      // A name change is fine.
      await ownerAs(A.tenant, (tx) => tx`update tenants set name = 'Tenant A Ltd'`);
    });

    it("the app role cannot read the slug directory directly", async () => {
      expect(await pgError(asA("select * from app.tenant_slugs"))).toMatch(/permission denied/);
    });
  });

  describe("withTenant", () => {
    it("rejects a tenant ID that is not a UUID", async () => {
      expect(await pgError(app.withTenant("' or true --", async () => 1))).toMatch(/UUID/);
    });

    it("refuses to run as the owner role", async () => {
      const asOwner = createTenantDatabase(adminUrl, { contextKey, maxConnections: 1 });
      try {
        expect(await pgError(asOwner.withTenant(A.tenant, async () => 1))).toMatch(
          /bypass row-level security, owns tables or can create objects/,
        );
      } finally {
        await asOwner.close();
      }
    });

    it("fails when signed with the wrong key", async () => {
      const wrong = createTenantDatabase(appUrl, {
        contextKey: randomBytes(32),
        maxConnections: 1,
      });
      try {
        expect(
          await pgError(wrong.withTenant(A.tenant, (tx) => tx.select().from(documents))),
        ).toMatch(/invalid tenant context/);
      } finally {
        await wrong.close();
      }
    });
  });
  describe("side channels and shared connections", () => {
    it("keeps statistics off tenant content columns", async () => {
      const cols = await owner<{ col: string; target: number | null }[]>`
        select c.relname || '.' || a.attname as col, a.attstattarget as target
        from pg_attribute a
        join pg_class c on c.oid = a.attrelid
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
          and a.atttypid in ('text'::regtype, 'varchar'::regtype, 'jsonb'::regtype)`;
      expect(cols.length).toBeGreaterThan(0);
      for (const c of cols) expect(c.target, c.col).toBe(0);
    });

    it("EXPLAIN estimates do not reveal tenant B's values", async () => {
      await ownerAs(B.tenant, async (tx) => {
        for (let i = 0; i < 200; i++) {
          await tx`insert into documents
            (tenant_id, filename, content_type, size_bytes, blob_path, sha256, uploaded_by)
            values (${B.tenant}, ${`secret-merger-${i}.pdf`}, 'application/pdf', ${i},
                    'p', ${`hash-${i}`}, ${B.user})`;
        }
      });
      await owner`analyze documents`;
      const estimate = async (probe: string) => {
        const plan = await asA<{ "QUERY PLAN": string }>(
          `explain select * from documents where filename < '${probe}'`,
        );
        return /rows=(\d+)/.exec(plan.map((r) => r["QUERY PLAN"]).join("\n"))?.[1];
      };
      const probes = await Promise.all(["r", "t", "secret-me", "secret-mf"].map(estimate));
      expect(new Set(probes).size, `estimates ${probes.join(", ")}`).toBe(1);
    });

    it("the tenant check stays available to parallel query", async () => {
      const [fn] = await owner<{ parallel: string }[]>`
        select proparallel as parallel from pg_proc where oid = 'app.current_tenant_id'::regproc`;
      expect(fn?.parallel).toBe("r");
    });

    it("the operator's tenant list gives slugs and IDs only, never a tenant's content", async () => {
      const [fn] = await owner<{ result: string; definer: boolean }[]>`
        select pg_catalog.pg_get_function_result('app.list_tenants'::regproc) as result,
               prosecdef as definer
        from pg_proc where oid = 'app.list_tenants'::regproc`;
      expect(fn).toEqual({ result: "TABLE(tenant_id uuid, slug text)", definer: true });
    });

    it("the review log is append-only: the app role may add and read, never change or delete", async () => {
      const [privs] = await owner<
        { insert: boolean; update: boolean; del: boolean; trunc: boolean }[]
      >`
        select has_table_privilege('agentcore_app', 'review_events', 'INSERT') as insert,
          has_table_privilege('agentcore_app', 'review_events', 'UPDATE') as update,
          has_table_privilege('agentcore_app', 'review_events', 'DELETE') as del,
          has_table_privilege('agentcore_app', 'review_events', 'TRUNCATE') as trunc`;
      expect(privs).toEqual({ insert: true, update: false, del: false, trunc: false });
    });

    it("the app role cannot create temporary or schema objects", async () => {
      const [privs] = await owner<{ temp: boolean; publicCreate: boolean; anyCreate: boolean }[]>`
        select has_database_privilege('agentcore_app', current_database(), 'TEMPORARY') as temp,
          has_schema_privilege('agentcore_app', 'public', 'CREATE') as "publicCreate",
          exists (select 1 from pg_namespace n
                  where has_schema_privilege('agentcore_app', n.oid, 'CREATE')) as "anyCreate"`;
      expect(privs).toEqual({ temp: false, publicCreate: false, anyCreate: false });
    });

    it("session settings injected by one tenant do not affect the next transaction", async () => {
      await asA(
        `select set_config('search_path', 'app', false),
                set_config('default_transaction_read_only', 'on', false),
                set_config('row_security', 'off', false),
                set_config('DateStyle', 'SQL, DMY', false),
                set_config('TimeZone', 'Pacific/Kiritimati', false)`,
      );
      // Same pooled connection (maxConnections: 1), now as tenant B.
      const outcome = await app.withTenant(B.tenant, async (tx) => {
        const seen = await tx.select().from(jobs);
        const [inserted] = await tx
          .insert(users)
          .values({
            tenantId: B.tenant,
            email: "new@tenant-b.example",
            displayName: "New",
            role: "tenant_user",
          })
          .returning();
        await tx.delete(users).where(eq(users.userId, inserted?.userId ?? ""));
        return { jobs: seen.map((j) => j.jobId), created: inserted?.createdAt };
      });
      expect(outcome.jobs).toEqual([B.job]);
      expect(Math.abs((outcome.created?.getTime() ?? 0) - Date.now())).toBeLessThan(60_000);
    });

    it("refuses to start when the app role has planted role-level settings", async () => {
      await withRawApp(async (raw) => {
        // Postgres always lets a role change its own defaults; withTenant must notice.
        await raw.unsafe(`alter role agentcore_app in database ${testDb} set row_security = off`);
        try {
          const fresh = createTenantDatabase(appUrl, { contextKey, maxConnections: 1 });
          try {
            expect(await pgError(fresh.withTenant(A.tenant, async () => 1))).toMatch(
              /role-level setting overrides/,
            );
          } finally {
            await fresh.close();
          }
        } finally {
          await raw.unsafe(`alter role agentcore_app in database ${testDb} reset all`);
        }
      });
    });
  });
});
