// Task 13's done-when, first half: audit rows cannot be edited, by the app or by the
// database owner. Also: every change writes exactly one row, in the same transaction, so
// a refused or failed change writes none; and refused sign-ins are counted, not listed.
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addTenantUser,
  auditEventsAfter,
  createTenantWithAdmin,
  createTenantDatabase,
  linkTenantSso,
  listAuditEvents,
  listRefusedSignIns,
  recordRefusedSignIn,
  removeTenantUser,
  schema,
  setAllowEmailLinks,
  setTenantAgents,
  setTenantUserRole,
  SETUP_ACTOR,
  type AuditActor,
  type TenantDatabase,
} from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";

let testDb: TestDatabase;
let db: TenantDatabase;
let owner: postgres.Sql;
let tenantId = "";
let adminId = "";

const operator: AuditActor = { kind: "operator", oid: "op-oid-1", label: "op@client.example" };
const actions = async (id = tenantId) =>
  (await listAuditEvents(db, id)).map((e) => e.action).reverse();

beforeAll(async () => {
  testDb = await createTestDatabase();
  db = createTenantDatabase(testDb.appUrl, { contextKey: testDb.contextKey, maxConnections: 2 });
  owner = postgres(testDb.adminUrl, { max: 1, onnotice: () => {} });
  tenantId = await createTenantWithAdmin(
    db,
    { name: "Audit Ltd", slug: "audit", adminEmail: "boss@audit.example" },
    operator,
  );
  const [admin] = await db.withTenant(tenantId, (tx) => tx.select().from(schema.users));
  adminId = admin?.userId ?? "";
});

afterAll(async () => {
  await owner?.end();
  await db?.close();
  await testDb?.drop();
});

describe("the audit log cannot be edited", () => {
  it("refuses the app any update or delete, or switching the guard off", async () => {
    const before = await listAuditEvents(db, tenantId);
    expect(before.length).toBeGreaterThan(0);
    await expect(
      db.withTenant(tenantId, (tx) => tx.update(schema.auditEvents).set({ action: "forged" })),
    ).rejects.toThrow();
    await expect(db.withTenant(tenantId, (tx) => tx.delete(schema.auditEvents))).rejects.toThrow();
    // Only the table's owner may alter it.
    await expect(
      db.withTenant(tenantId, (tx) =>
        tx.execute(sql`alter table audit_events disable trigger audit_events_append_only`),
      ),
    ).rejects.toThrow();
    expect(await listAuditEvents(db, tenantId)).toEqual(before);
  });

  // The owner could still disable or drop the trigger on purpose; this guards against
  // the owner's ordinary statements (a mistaken script, a console session).
  it("refuses the database owner's own updates, deletes and truncates", async () => {
    const count = async () =>
      Number((await owner`select count(*)::int as n from audit_events`)[0]?.["n"]);
    const before = await count();
    await expect(owner`update audit_events set action = 'forged'`).rejects.toThrow(
      /audit log cannot be changed/,
    );
    await expect(owner`delete from audit_events`).rejects.toThrow(/audit log cannot be changed/);
    await expect(owner`truncate audit_events`).rejects.toThrow(/audit log cannot be changed/);
    expect(await count()).toBe(before);
    expect(
      (await owner`select count(*)::int as n from audit_events where action = 'forged'`)[0]?.["n"],
    ).toBe(0);
  });
});

describe("every change writes one row, with who did it", () => {
  it("records a new tenant and its first admin, by the operator who created it", async () => {
    const events = (await listAuditEvents(db, tenantId)).reverse();
    expect(events.slice(0, 2)).toMatchObject([
      {
        action: "tenant.created",
        actorKind: "operator",
        actorId: "op-oid-1",
        actorLabel: "op@client.example",
        detail: { name: "Audit Ltd", slug: "audit" },
      },
      {
        action: "user.added",
        actorKind: "operator",
        detail: { userId: adminId, email: "boss@audit.example", role: "tenant_admin" },
      },
    ]);
  });

  it("records user changes, and nothing for a refused or failed one", async () => {
    const me: AuditActor = { kind: "user", userId: adminId, label: "boss@audit.example" };
    const start = (await actions()).length;
    const id = await addTenantUser(
      db,
      tenantId,
      { email: "a@audit.example", role: "tenant_user" },
      me,
    );
    // Refused: already a user; the last admin demoted; removing yourself.
    await expect(
      addTenantUser(db, tenantId, { email: "A@audit.example", role: "tenant_user" }, me),
    ).rejects.toThrow(/already a user/);
    expect(
      await setTenantUserRole(db, tenantId, { userId: adminId, role: "tenant_user" }, me),
    ).toMatchObject({ ok: false });
    expect(await removeTenantUser(db, tenantId, { userId: adminId }, me)).toMatchObject({
      ok: false,
      reason: "self",
    });
    // No change, no row.
    expect(await setTenantUserRole(db, tenantId, { userId: id, role: "tenant_user" }, me)).toEqual({
      ok: true,
    });
    await setTenantUserRole(db, tenantId, { userId: id, role: "tenant_admin" }, me);
    await removeTenantUser(db, tenantId, { userId: id }, me);
    await addTenantUser(db, tenantId, { email: "a@audit.example", role: "tenant_user" }, me);
    expect((await actions()).slice(start)).toEqual([
      "user.added",
      "user.role-changed",
      "user.removed",
      "user.restored",
    ]);
    const [restored, removed, changed] = await listAuditEvents(db, tenantId, { limit: 3 });
    expect(changed).toMatchObject({
      actorKind: "user",
      actorId: adminId,
      actorLabel: "boss@audit.example",
      detail: { userId: id, from: "tenant_user", to: "tenant_admin" },
    });
    expect(removed?.detail).toMatchObject({ userId: id, role: "tenant_admin" });
    expect(restored?.detail).toMatchObject({ userId: id, role: "tenant_user" });
  });

  it("records sign-in settings and agents, by a setup command", async () => {
    const start = (await actions()).length;
    // Refused: email links cannot go off before SSO is linked.
    expect(await setAllowEmailLinks(db, tenantId, false, SETUP_ACTOR)).toBe(false);
    await linkTenantSso(
      db,
      tenantId,
      { provider: "google", googleDomain: "Audit.example" },
      SETUP_ACTOR,
    );
    expect(await setAllowEmailLinks(db, tenantId, false, SETUP_ACTOR)).toBe(true);
    await setTenantAgents(db, tenantId, ["b-agent", "a-agent"], SETUP_ACTOR);
    // A bad agent name is refused before anything is written.
    await expect(setTenantAgents(db, tenantId, ["Bad Name"], SETUP_ACTOR)).rejects.toThrow();
    const events = (await listAuditEvents(db, tenantId)).slice(0, 3).reverse();
    expect((await actions()).slice(start)).toEqual([
      "sso.linked",
      "email-links.changed",
      "agents.changed",
    ]);
    // The same again changes nothing, so it records nothing.
    const count = (await actions()).length;
    await linkTenantSso(
      db,
      tenantId,
      { provider: "google", googleDomain: "audit.example" },
      SETUP_ACTOR,
    );
    expect(await setAllowEmailLinks(db, tenantId, false, SETUP_ACTOR)).toBe(true);
    await setTenantAgents(db, tenantId, ["a-agent", "b-agent", "a-agent"], SETUP_ACTOR);
    expect((await actions()).length).toBe(count);
    expect(events).toMatchObject([
      {
        actorKind: "setup",
        actorId: null,
        detail: { provider: "google", organisation: "audit.example" },
      },
      { detail: { on: false } },
      { detail: { agents: ["a-agent", "b-agent"] } },
    ]);
  });

  it("keeps each tenant's log to itself", async () => {
    const other = await createTenantWithAdmin(
      db,
      { name: "Other", slug: "other-audit", adminEmail: "x@other.example" },
      SETUP_ACTOR,
    );
    expect(await actions(other)).toEqual(["tenant.created", "user.added"]);
    const ids = new Set((await listAuditEvents(db, other)).map((e) => e.eventId));
    expect((await listAuditEvents(db, tenantId)).some((e) => ids.has(e.eventId))).toBe(false);
  });

  it("lists a time range, newest first", async () => {
    const all = await listAuditEvents(db, tenantId);
    const future = await listAuditEvents(db, tenantId, { from: new Date(Date.now() + 60_000) });
    expect(future).toEqual([]);
    const ranged = await listAuditEvents(db, tenantId, {
      from: new Date(0),
      to: new Date(Date.now() + 60_000),
    });
    expect(ranged).toEqual(all);
    const times = all.map((e) => e.occurredAt.getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });
});

describe("refused sign-ins", () => {
  it("are counted per hour, method and reason, never one row each", async () => {
    for (let i = 0; i < 3; i++) {
      await db.withTenant(tenantId, (tx) =>
        recordRefusedSignIn(tx, tenantId, "email-link", "link-not-valid"),
      );
    }
    await db.withTenant(tenantId, (tx) =>
      recordRefusedSignIn(tx, tenantId, "google", "unknown-user"),
    );
    const counts = await listRefusedSignIns(db, tenantId, new Date(Date.now() - 3_600_000));
    expect(counts.map(({ method, reason, count }) => ({ method, reason, count }))).toEqual([
      { method: "email-link", reason: "link-not-valid", count: 3 },
      { method: "google", reason: "unknown-user", count: 1 },
    ]);
    const rows = await db.withTenant(tenantId, (tx) =>
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.signInRefusals)
        .where(eq(schema.signInRefusals.tenantId, tenantId)),
    );
    expect(rows[0]?.n).toBe(2);
  });
});

// Review S4: occurred_at is when a transaction started and seq when it inserted, so two
// overlapping transactions can settle out of seq order. The copy must not skip the one
// that settles second.
describe("the audit log's pages for its write-once copy", () => {
  it("never passes over an event that settles after a later-numbered one", async () => {
    const tenant = await createTenantWithAdmin(
      db,
      { name: "Copy Ltd", slug: "copy-order", adminEmail: "a@copy.example" },
      SETUP_ACTOR,
    );
    const insert = (action: string, minutesAgo: number) =>
      db.withTenant(tenant, (tx) =>
        tx
          .insert(schema.auditEvents)
          .values({
            tenantId: tenant,
            actorKind: "setup",
            action,
            occurredAt: new Date(Date.now() - minutesAgo * 60_000),
          })
          .returning({ seq: schema.auditEvents.seq }),
      );
    const before = await listAuditEvents(db, tenant);
    const last = Math.max(...before.map((e) => Number(e.seq)));
    // Inserted first (lower seq), stamped as by a transaction that started recently.
    const [early] = await insert("agents.changed", 0);
    // Inserted second (higher seq), by one that started 10 minutes ago: settled.
    const [late] = await insert("agents.changed", 10);
    const settle = 2 * 60_000;

    // A copy now, then another once everything is old enough, carrying on after the
    // last event the first copied, as the worker does.
    const first = await auditEventsAfter(db, tenant, last, 100, settle);
    const after = first.length > 0 ? Number(first[first.length - 1]?.seq) : last;
    const second = await auditEventsAfter(db, tenant, after, 100, settle);
    const copied = [...first, ...second].map((e) => Number(e.seq));
    expect(copied).toEqual([Number(early?.seq), Number(late?.seq)]);
  });

  it("copies nothing while no event is old enough", async () => {
    const tenant = await createTenantWithAdmin(
      db,
      { name: "Fresh Ltd", slug: "copy-fresh", adminEmail: "a@fresh.example" },
      SETUP_ACTOR,
    );
    expect(await auditEventsAfter(db, tenant, 0, 100, 2 * 60_000)).toEqual([]);
    expect((await auditEventsAfter(db, tenant, 0, 100, 0)).length).toBeGreaterThan(0);
  });
});
