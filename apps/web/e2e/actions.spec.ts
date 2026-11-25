// Review T9: every server action, called directly as the wrong person, is refused by its
// guard and changes nothing. Server actions are public POST endpoints (a `Next-Action`
// header names one), so a guard is all that stands in the way: this calls each one the
// way a browser does, with forged arguments, from people who must not use it.
//
// Two tenants of this file's own: the target, which the wrong people attack, and a
// control, where the right person makes the same call first. The control call must
// change what the action changes (so the arguments are real, and a refused call that
// changed nothing means something); the same calls on the target must change nothing.
//
// Each action is found by name in the build's manifest. One the build has that is in
// neither ACTIONS nor PUBLIC fails the test, so a new action cannot go untested.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { agentForUploads, agentRegistry } from "@agent-core/core/agents";
import {
  addTenantUser,
  createJob,
  createTenantDatabase,
  createTenantWithAdmin,
  getJobOutput,
  getTenantAgents,
  getTenantSso,
  linkTenantSso,
  removeTenantUser,
  saveJobOutput,
  schema,
  setAllowEmailLinks,
  setJobStatus,
  SETUP_ACTOR,
} from "@agent-core/db";
import { expect, request, test } from "@playwright/test";
import { count, eq } from "drizzle-orm";
import { TENANT_SESSION_MS, type Identity } from "../lib/auth/identity.ts";
import { personas, state } from "./matrix.ts";
import { sessionCookie } from "./sessions.ts";
import { BASE_URL, E2E_SECOND_AGENT } from "./state.ts";

const { a } = state;

const manifest = JSON.parse(
  readFileSync(
    path.join(import.meta.dirname, "..", ".next", "server", "server-reference-manifest.json"),
    "utf8",
  ),
) as { node: Record<string, { exportedName: string; filename: string }> };

/** The build's actions, as file and name, with their IDs. */
const built = Object.entries(manifest.node).map(([id, v]) => ({
  id,
  key: `${v.filename.replace(/^apps\/web\//, "")}#${v.exportedName}`,
}));
const actionId = (key: string) => {
  const found = built.find((x) => x.key === key);
  if (!found) throw new Error(`No server action ${key} in the build.`);
  return found.id;
};

/** Open to anyone on purpose: signing in and out. Each says why. */
const PUBLIC = new Set([
  "lib/auth/actions.ts#startOperatorMicrosoftSignIn", // starts Microsoft sign-in
  "lib/auth/actions.ts#startLocalOperatorSignIn", // the demo's: refused but on this machine
  "lib/auth/actions.ts#startTenantSsoSignIn", // starts a tenant's SSO
  "lib/auth/actions.ts#requestEmailLink", // asks for a link: limited, and says nothing
  "lib/auth/actions.ts#signInWithEmailLink", // redeems a link
  "lib/auth/actions.ts#signOutTo", // signs out whoever is signed in
]);

const db = () =>
  createTenantDatabase(state.appUrl, {
    contextKey: Buffer.from(state.contextKeyBase64, "base64"),
    maxConnections: 1,
  });
type Db = ReturnType<typeof db>;

/** A tenant of this file's own: two admins, two users, a removed user, SSO, three drafts. */
interface Fixture {
  tenantId: string;
  slug: string;
  admin: string;
  user: string;
  otherUser: string;
  removed: string;
  /** Active, but signed out everywhere (sessions_valid_after) when the fixture was made. */
  signedOut: string;
  /** Jobs waiting for review: one each for saving, approving and sending back. */
  jobs: { save: string; approve: string; sendBack: string };
}

let uploadAgent: Awaited<ReturnType<typeof agentForUploads>>;
let draftFields: Record<string, unknown>;
let target: Fixture;
let control: Fixture;

async function makeFixture(d: Db, label: string): Promise<Fixture> {
  const slug = `actions-${label}-${randomUUID().slice(0, 6)}`;
  const tenantId = await createTenantWithAdmin(
    d,
    { name: `Actions ${label}`, slug, adminEmail: `admin@${slug}.example` },
    SETUP_ACTOR,
  );
  const add = (email: string, role: "tenant_admin" | "tenant_user") =>
    addTenantUser(d, tenantId, { email: `${email}@${slug}.example`, role }, SETUP_ACTOR);
  const [admin] = await d.withTenant(tenantId, (tx) =>
    tx
      .select({ id: schema.users.userId })
      .from(schema.users)
      .where(eq(schema.users.email, `admin@${slug}.example`)),
  );
  await add("second-admin", "tenant_admin");
  const user = await add("user", "tenant_user");
  const otherUser = await add("other-user", "tenant_user");
  // An admin, so once removed only the active-user check refuses them.
  const removed = await add("removed", "tenant_admin");
  await removeTenantUser(d, tenantId, { userId: removed }, SETUP_ACTOR);
  const signedOut = await add("signed-out", "tenant_user");
  await d.withTenant(tenantId, (tx) =>
    tx
      .update(schema.users)
      .set({ sessionsValidAfter: new Date() })
      .where(eq(schema.users.userId, signedOut)),
  );
  // SSO linked and email links off, so turning them on is a real change.
  await linkTenantSso(
    d,
    tenantId,
    { provider: "google", googleDomain: `${slug}.example` },
    SETUP_ACTOR,
  );
  await setAllowEmailLinks(d, tenantId, false, SETUP_ACTOR);
  const [doc] = await d.withTenant(tenantId, (tx) =>
    tx
      .insert(schema.documents)
      .values({
        tenantId,
        filename: "x.pdf",
        contentType: "application/pdf",
        sizeBytes: 1,
        blobPath: "p",
        sha256: "s",
        uploadedBy: user,
      })
      .returning({ id: schema.documents.documentId }),
  );
  // Drafts with no workflow behind them. The control's approve and send-back calls record
  // decisions nobody can deliver, so the worker's job sweep later ends those two jobs as
  // failed (workflow-ended): expected, and nothing here reads them afterwards.
  const draft = async () => {
    const jobId = await createJob(d, tenantId, {
      documentId: doc?.id ?? "",
      agentName: uploadAgent.definition.name,
      agentVersion: uploadAgent.version,
    });
    await saveJobOutput(d, tenantId, jobId, { fields: draftFields, hasReport: false });
    await setJobStatus(d, tenantId, jobId, "awaiting_review");
    return jobId;
  };
  return {
    tenantId,
    slug,
    admin: admin?.id ?? "",
    user,
    otherUser,
    removed,
    signedOut,
    jobs: { save: await draft(), approve: await draft(), sendBack: await draft() },
  };
}

const later = () => Date.now() + 60 * 60 * 1000;
const asTenant = (
  f: Fixture,
  userId: string,
  role: "tenant_admin" | "tenant_user",
  expiresAt = later(),
): Identity => ({
  kind: "tenant",
  tenantId: f.tenantId,
  slug: f.slug,
  userId,
  role,
  expiresAt,
});

/** Everyone the tests call as. */
type Who =
  | "anonymous"
  | "expiredOperator"
  | "forged"
  | "operator"
  | "admin"
  | "user"
  | "elevatedUser"
  | "removedUser"
  | "signedOut"
  | "mixedSession"
  | "crossTenant"
  | "adminA"
  | "userA";

/** A session cookie for someone, against a fixture (null: no session). */
async function cookieFor(who: Who, f: Fixture): Promise<string | null> {
  const secret = state.authSecret;
  switch (who) {
    case "anonymous":
      return null;
    case "expiredOperator":
      return personas.expiredOperator();
    case "forged":
      return sessionCookie(
        asTenant(f, f.admin, "tenant_admin"),
        "not-the-real-secret-not-the-real-secret",
      );
    case "operator":
      return personas.operator();
    case "admin":
      return sessionCookie(asTenant(f, f.admin, "tenant_admin"), secret);
    case "user":
      return sessionCookie(asTenant(f, f.user, "tenant_user"), secret);
    // A user whose session claims admin: the guard must read the role from the database.
    case "elevatedUser":
      return sessionCookie(asTenant(f, f.user, "tenant_admin"), secret);
    // Removed, in a session begun after the removal: only the active-user check refuses it.
    case "removedUser":
      return sessionCookie(
        asTenant(f, f.removed, "tenant_admin", Date.now() + TENANT_SESSION_MS),
        secret,
      );
    // Still a user, but signed out everywhere after this session began.
    case "signedOut":
      return sessionCookie(asTenant(f, f.signedOut, "tenant_user"), secret);
    // A session for tenant A carrying this tenant's user: the guard must check the
    // session's tenant is the slug's.
    case "mixedSession":
      return sessionCookie(
        {
          kind: "tenant",
          tenantId: a.tenantId,
          slug: a.slug,
          userId: f.admin,
          role: "tenant_admin",
          expiresAt: later(),
        },
        secret,
      );
    // Tenant A's user, in a session claiming to be this tenant's admin.
    case "crossTenant":
      return sessionCookie(asTenant(f, a.user.userId, "tenant_admin"), secret);
    case "adminA":
      return personas.adminA();
    case "userA":
      return personas.userA();
  }
}
const noSession = new Set<Who>(["anonymous", "expiredOperator", "forged"]);

type Arg = string | boolean | Record<string, string | string[]>;

/**
 * Calls a server action as React's client does: the arguments as JSON in field "0", each
 * form as "$K<n>" with its fields as "_<n>_<name>" (sent before "0", which is read first).
 */
async function callAction(
  cookie: string | null,
  page: string,
  id: string,
  args: Arg[],
): Promise<{ status: number; redirect: string; location: string }> {
  const ctx = await request.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: cookie ? { cookie } : {},
  });
  const parts: [string, string][] = [];
  let form = 0;
  const encoded = args.map((arg) => {
    if (typeof arg !== "object") return arg;
    form++;
    for (const [k, v] of Object.entries(arg)) {
      for (const one of Array.isArray(v) ? v : [v]) parts.push([`_${form}_${k}`, one]);
    }
    return `$K${form.toString(16)}`;
  });
  parts.push(["0", JSON.stringify(encoded)]);
  const boundary = `----actions${randomUUID()}`;
  const body =
    parts
      .map(
        ([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
      )
      .join("") + `--${boundary}--\r\n`;
  const res = await ctx.post(page, {
    headers: {
      "Next-Action": id,
      Accept: "text/x-component",
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      Origin: BASE_URL,
    },
    data: Buffer.from(body),
    maxRedirects: 0,
  });
  const result = {
    status: res.status(),
    redirect: (res.headers()["x-action-redirect"] ?? "").replace(/;\w+$/, ""),
    location: new URL(res.headers()["location"] ?? "/", BASE_URL).pathname,
  };
  await ctx.dispose();
  return result;
}

const auditCount = (d: Db, tenantId: string) =>
  d.withTenant(tenantId, async (tx) => {
    const [row] = await tx.select({ n: count() }).from(schema.auditEvents);
    return row?.n ?? 0;
  });
const userState = (d: Db, tenantId: string, userId: string) =>
  d.withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select({ role: schema.users.role, removedAt: schema.users.removedAt })
      .from(schema.users)
      .where(eq(schema.users.userId, userId));
    return row ?? null;
  });
const userByEmail = (d: Db, tenantId: string, email: string) =>
  d.withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select({ id: schema.users.userId })
      .from(schema.users)
      .where(eq(schema.users.email, email));
    return row?.id ?? null;
  });
const reviewEvents = (d: Db, tenantId: string, jobId: string) =>
  d.withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select({ n: count() })
      .from(schema.reviewEvents)
      .where(eq(schema.reviewEvents.jobId, jobId));
    return row?.n ?? 0;
  });
const revisionOf = async (d: Db, f: Fixture, jobId: string) =>
  String((await getJobOutput(d, f.tenantId, jobId))?.revision ?? -1);

interface Action {
  key: string;
  /** A page the action is served on, for this tenant. */
  page: (f: Fixture) => string;
  /** The arguments, against this tenant (read fresh before each call). */
  args: (f: Fixture, d: Db) => Promise<Arg[]>;
  /** Who may use it, for the control call. */
  allowed: Who;
  /** Who must not. */
  refused: Who[];
  /** Where its guard sends someone it refuses. */
  signIn: (f: Fixture) => string;
  /** What the action changes in this tenant: different after the control call. */
  effect: (f: Fixture, d: Db) => Promise<unknown>;
  /** Puts the control tenant back as it was, for a change that can be made only once. */
  reset?: (f: Fixture, d: Db) => Promise<void>;
}

const notOperator: Who[] = ["anonymous", "expiredOperator", "admin", "user", "adminA"];
const notAdmin: Who[] = [
  "anonymous",
  "forged",
  "user",
  "elevatedUser",
  "removedUser",
  "signedOut",
  "mixedSession",
  "crossTenant",
  "adminA",
  "operator",
];
const notReviewer: Who[] = [
  "anonymous",
  "forged",
  "removedUser",
  "signedOut",
  "mixedSession",
  "crossTenant",
  "userA",
  "adminA",
  "operator",
];
const operatorSignIn = () => "/operator/sign-in";
const tenantSignIn = (f: Fixture) => `/t/${f.slug}/sign-in`;
const operatorPage = (f: Fixture) => `/operator/tenants/${f.tenantId}`;
const usersPage = (f: Fixture) => `/t/${f.slug}/admin/users`;
const reviewPage = (job: keyof Fixture["jobs"]) => (f: Fixture) =>
  `/t/${f.slug}/jobs/${f.jobs[job]}`;
const edited = () => JSON.stringify({ ...draftFields, term: "changed in review" });

const ACTIONS: Action[] = [
  {
    key: "lib/operator/actions.ts#createTenantAction",
    page: () => "/operator/tenants/new",
    args: async (f) => [
      { name: "New Ltd", slug: `${f.slug}-new`, adminEmail: `x@${f.slug}.example` },
    ],
    allowed: "operator",
    refused: notOperator,
    signIn: operatorSignIn,
    effect: (f, d) => d.tenantIdForSlug(`${f.slug}-new`),
  },
  {
    key: "lib/operator/actions.ts#addAdminAction",
    page: operatorPage,
    args: async (f) => [f.tenantId, { email: `added-admin@${f.slug}.example` }],
    allowed: "operator",
    refused: notOperator,
    signIn: operatorSignIn,
    effect: (f, d) => userByEmail(d, f.tenantId, `added-admin@${f.slug}.example`),
  },
  {
    key: "lib/operator/actions.ts#linkSsoAction",
    page: operatorPage,
    args: async (f) => [f.tenantId, { provider: "google", value: `relinked-${f.slug}.example` }],
    allowed: "operator",
    refused: notOperator,
    signIn: operatorSignIn,
    effect: async (f, d) => (await getTenantSso(d, f.tenantId)).link,
  },
  {
    key: "lib/operator/actions.ts#emailLinksOnAction",
    page: operatorPage,
    args: async (f) => [f.tenantId],
    allowed: "operator",
    refused: notOperator,
    signIn: operatorSignIn,
    effect: async (f, d) => (await getTenantSso(d, f.tenantId)).allowEmailLinks,
    reset: async (f, d) => void (await setAllowEmailLinks(d, f.tenantId, false, SETUP_ACTOR)),
  },
  {
    key: "lib/operator/actions.ts#setAgentsAction",
    page: operatorPage,
    args: async (f) => [f.tenantId, { agent: E2E_SECOND_AGENT }],
    allowed: "operator",
    refused: notOperator,
    signIn: operatorSignIn,
    effect: (f, d) => getTenantAgents(d, f.tenantId),
  },
  {
    key: "lib/tenant-admin/actions.ts#addUserAction",
    page: usersPage,
    args: async (f) => [f.slug, { email: `added@${f.slug}.example`, role: "tenant_admin" }],
    allowed: "admin",
    refused: notAdmin,
    signIn: tenantSignIn,
    effect: (f, d) => userByEmail(d, f.tenantId, `added@${f.slug}.example`),
  },
  {
    key: "lib/tenant-admin/actions.ts#setRoleAction",
    page: usersPage,
    args: async (f) => [f.slug, f.otherUser, { role: "tenant_admin" }],
    allowed: "admin",
    refused: notAdmin,
    signIn: tenantSignIn,
    effect: (f, d) => userState(d, f.tenantId, f.otherUser),
  },
  {
    key: "lib/tenant-admin/actions.ts#removeUserAction",
    page: usersPage,
    // Not f.user: the review actions below act as them.
    args: async (f) => [f.slug, f.otherUser],
    allowed: "admin",
    refused: notAdmin,
    signIn: tenantSignIn,
    effect: (f, d) => userState(d, f.tenantId, f.otherUser),
  },
  {
    key: "lib/auth/settings-actions.ts#setEmailLinks",
    page: (f) => `/t/${f.slug}/admin/sign-in`,
    args: async (f) => [f.slug, true],
    allowed: "admin",
    refused: notAdmin,
    signIn: tenantSignIn,
    effect: async (f, d) => (await getTenantSso(d, f.tenantId)).allowEmailLinks,
    reset: async (f, d) => void (await setAllowEmailLinks(d, f.tenantId, false, SETUP_ACTOR)),
  },
  {
    key: "lib/jobs/review-actions.ts#saveReviewAction",
    page: reviewPage("save"),
    args: async (f, d) => [
      f.slug,
      f.jobs.save,
      { revision: await revisionOf(d, f, f.jobs.save), fields: edited() },
    ],
    allowed: "user",
    refused: notReviewer,
    signIn: tenantSignIn,
    effect: (f, d) => reviewEvents(d, f.tenantId, f.jobs.save),
  },
  {
    key: "lib/jobs/review-actions.ts#approveAction",
    page: reviewPage("approve"),
    args: async (f, d) => [
      f.slug,
      f.jobs.approve,
      { revision: await revisionOf(d, f, f.jobs.approve), fields: edited() },
    ],
    allowed: "user",
    refused: notReviewer,
    signIn: tenantSignIn,
    effect: (f, d) => reviewEvents(d, f.tenantId, f.jobs.approve),
  },
  {
    key: "lib/jobs/review-actions.ts#sendBackAction",
    page: reviewPage("sendBack"),
    args: async (f, d) => [
      f.slug,
      f.jobs.sendBack,
      { revision: await revisionOf(d, f, f.jobs.sendBack), note: "needs the notice period" },
    ],
    allowed: "user",
    refused: notReviewer,
    signIn: tenantSignIn,
    effect: (f, d) => reviewEvents(d, f.tenantId, f.jobs.sendBack),
  },
];

/** Changes nothing even when allowed (it sends a recorded decision again): refusal only. */
const RESEND = {
  key: "lib/jobs/review-actions.ts#resendDecisionAction",
  refused: notReviewer,
};

// Outside the serial group below, so a new, unlisted action does not hide the rest.
test("every server action is tested here, or public on purpose", () => {
  const known = new Set([...PUBLIC, RESEND.key, ...ACTIONS.map((x) => x.key)]);
  expect(built.map((x) => x.key).filter((k) => !known.has(k))).toEqual([]);
  // And every one listed here is still in the build.
  expect([...known].filter((k) => !built.some((x) => x.key === k))).toEqual([]);
});

test.describe.serial("each action, as the wrong people", () => {
  test.beforeAll(async () => {
    process.env["AGENTS_DIR"] = state.agentsDir;
    uploadAgent = agentForUploads(await agentRegistry(process.env), process.env);
    const d = db();
    try {
      // The fields of a real draft, from the seeded review job.
      draftFields = ((await getJobOutput(d, a.tenantId, state.reviewJobId))?.fields ??
        {}) as Record<string, unknown>;
      target = await makeFixture(d, "target");
      control = await makeFixture(d, "control");
    } finally {
      await d.close();
    }
  });

  /**
   * An action runs when it is posted to any page, including the public sign-in pages the
   * proxy leaves open. So people with no session are also sent there, where only the
   * action's own guard stands in the way: the caller checks nothing changed.
   */
  async function callsPastTheProxy(page: string, key: string, args: () => Promise<Arg[]>) {
    for (const who of noSession) {
      const result = await callAction(
        await cookieFor(who, target),
        page,
        actionId(key),
        await args(),
      );
      expect(result.status, `${who} on ${page}`).toBeLessThan(500);
      expect(result.redirect, `${who} on ${page}`).not.toMatch(/done=|saved=/);
    }
  }

  /** Whether a refusal went the way it should: the proxy, or the action's guard. */
  function expectRefused(who: Who, result: Awaited<ReturnType<typeof callAction>>, signIn: string) {
    if (noSession.has(who)) {
      // No session, on a protected page: the proxy sends them to sign in before the action
      // runs. (On a public page, callsPastTheProxy tests the guard itself.)
      expect(result.status, who).toBe(307);
      expect(result.location, who).toBe(signIn);
    } else {
      // Signed in, but not allowed: turned away by the action's own guard.
      expect(result.redirect, `${who}: status ${result.status}`).toBe(signIn);
    }
  }

  for (const action of ACTIONS) {
    test(`${action.key}: the right person changes something; ${action.refused.join(", ")} change nothing`, async () => {
      const d = db();
      try {
        // The control: the same kind of call, by someone allowed, makes the change.
        const before = await action.effect(control, d);
        const allowed = await callAction(
          await cookieFor(action.allowed, control),
          action.page(control),
          actionId(action.key),
          await action.args(control, d),
        );
        expect(
          await action.effect(control, d),
          `the allowed call changed nothing: ${JSON.stringify(allowed)}`,
        ).not.toEqual(before);
        await action.reset?.(control, d);

        // The target: each refused, and nothing changed.
        const unchanged = await action.effect(target, d);
        const audit = await auditCount(d, target.tenantId);
        for (const who of action.refused) {
          const result = await callAction(
            await cookieFor(who, target),
            action.page(target),
            actionId(action.key),
            await action.args(target, d),
          );
          expectRefused(who, result, action.signIn(target));
        }
        await callsPastTheProxy(action.signIn(target), action.key, () => action.args(target, d));
        expect(await action.effect(target, d)).toEqual(unchanged);
        expect(await auditCount(d, target.tenantId)).toBe(audit);
      } finally {
        await d.close();
      }
    });
  }

  test(`${RESEND.key} refuses ${RESEND.refused.join(", ")}`, async () => {
    for (const who of RESEND.refused) {
      const result = await callAction(
        await cookieFor(who, target),
        reviewPage("approve")(target),
        actionId(RESEND.key),
        [target.slug, target.jobs.approve],
      );
      expectRefused(who, result, tenantSignIn(target));
    }
    await callsPastTheProxy(tenantSignIn(target), RESEND.key, async () => [
      target.slug,
      target.jobs.approve,
    ]);
  });

  // The guard passes these: the caller is signed in to their own tenant and names it. What
  // keeps them out is that the user or job is looked up in their own tenant's context, where
  // another tenant's IDs do not exist.
  test("tenant A's admin, in tenant A, cannot change the target's users by their IDs", async () => {
    const d = db();
    try {
      const read = async () => [
        await userState(d, target.tenantId, target.otherUser),
        await userState(d, target.tenantId, target.user),
      ];
      const before = await read();
      const adminA = await personas.adminA();
      const calls: [string, Arg[]][] = [
        [
          "lib/tenant-admin/actions.ts#setRoleAction",
          [a.slug, target.otherUser, { role: "tenant_admin" }],
        ],
        ["lib/tenant-admin/actions.ts#removeUserAction", [a.slug, target.user]],
      ];
      for (const [key, args] of calls) {
        const result = await callAction(adminA, `/t/${a.slug}/admin/users`, actionId(key), args);
        // Back to their own tenant's page, refused there.
        expect(result.redirect, key).toMatch(new RegExp(`^/t/${a.slug}/admin/users\\?done=`));
        expect(result.redirect, key).not.toMatch(/done=(role-changed|removed)$/);
      }
      expect(await read()).toEqual(before);
    } finally {
      await d.close();
    }
  });

  test("tenant A's user, in tenant A, cannot review the target's drafts by their IDs", async () => {
    const d = db();
    try {
      const jobs = [target.jobs.save, target.jobs.approve, target.jobs.sendBack];
      const read = () => Promise.all(jobs.map((j) => reviewEvents(d, target.tenantId, j)));
      const before = await read();
      const userA = await personas.userA();
      const calls: [string, string, Record<string, string>][] = [
        [
          "lib/jobs/review-actions.ts#saveReviewAction",
          target.jobs.save,
          { revision: "1", fields: edited() },
        ],
        [
          "lib/jobs/review-actions.ts#approveAction",
          target.jobs.approve,
          { revision: "1", fields: edited() },
        ],
        [
          "lib/jobs/review-actions.ts#sendBackAction",
          target.jobs.sendBack,
          { revision: "1", note: "x" },
        ],
      ];
      for (const [key, job, form] of calls) {
        const result = await callAction(userA, `/t/${a.slug}/jobs/${job}`, actionId(key), [
          a.slug,
          job,
          form,
        ]);
        // No such job in their tenant: back to their own documents.
        expect(result.redirect, key).toBe(`/t/${a.slug}/documents`);
      }
      expect(await read()).toEqual(before);
    } finally {
      await d.close();
    }
  });
});
