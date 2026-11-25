import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { agentForUploads, agentRegistry } from "@agent-core/core/agents";
import { reportBlobName, tenantContainer, textBlobName } from "@agent-core/core/storage";
import { makeTemplate } from "@agent-core/blocks/testing";
import {
  createJob,
  createTenantDatabase,
  type TenantDatabase,
  finishJob,
  getJob,
  linkTenantSso,
  setJobStatus,
  saveJobOutput,
  schema,
  SETUP_ACTOR,
} from "@agent-core/db";
import { BlobServiceClient } from "@azure/storage-blob";
import { createTestDatabase, createTestTenant } from "@agent-core/db/testing";
import { eq } from "drizzle-orm";
import { startFakeProviders } from "@agent-core/core/models/testing";
import { AZURITE, BASE_URL, E2E_SECOND_AGENT, PORT, STATE_FILE, type RunState } from "./state.ts";

/** What the fake model answers: fields matching the demo agent's schema. */
const E2E_FIELDS = {
  parties: [
    { name: "Example Widgets Ltd", role: "supplier" },
    { name: "Sample Retail plc", role: "customer" },
  ],
  term: "24 months",
  renewal: "12 months at a time",
  notice: "90 days",
  fees: "£4,500 per month",
};

async function jobDocumentId(db: TenantDatabase, tenantId: string, jobId: string) {
  return (await getJob(db, tenantId, jobId))?.documentId;
}

async function waitForServer(url: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`The app did not start on ${url}.`);
}

export default async function globalSetup() {
  const webDir = path.join(import.meta.dirname, "..");
  // A second agent, so choosing one at upload can be tested: a copy of the demo agent
  // under another name, in an agents folder the web app and the worker both use.
  const agentsDir = mkdtempSync(path.join(tmpdir(), "agentcore-agents-"));
  cpSync(
    path.join(webDir, "..", "..", "agents", "contract-summary"),
    path.join(agentsDir, "contract-summary"),
    { recursive: true },
  );
  const copy = path.join(agentsDir, E2E_SECOND_AGENT);
  cpSync(path.join(agentsDir, "contract-summary"), copy, { recursive: true });
  const definition = JSON.parse(readFileSync(path.join(copy, "agent.json"), "utf8")) as Record<
    string,
    unknown
  >;
  writeFileSync(
    path.join(copy, "agent.json"),
    JSON.stringify(
      { ...definition, name: E2E_SECOND_AGENT, title: "Second agent (e2e copy)" },
      null,
      2,
    ),
  );
  process.env["AGENTS_DIR"] = agentsDir;
  if (!existsSync(path.join(webDir, ".next", "BUILD_ID"))) {
    throw new Error("No production build. Run `pnpm build` before `pnpm test:e2e`.");
  }
  const testDb = await createTestDatabase();
  const db = createTenantDatabase(testDb.appUrl, {
    contextKey: testDb.contextKey,
    maxConnections: 1,
  });

  const persona = (email: string) => ({ userId: randomUUID(), email });
  const a = {
    tenantId: await createTestTenant(db, { name: "Tenant A", slug: "tenant-a" }),
    slug: "tenant-a",
    admin: persona("admin@a.example"),
    user: persona("user@a.example"),
    removed: persona("removed@a.example"),
  };
  const b = {
    tenantId: await createTestTenant(db, { name: "Tenant B", slug: "tenant-b" }),
    slug: "tenant-b",
    admin: persona("admin@b.example"),
    user: persona("user@b.example"),
  };
  // Linked to a Google Workspace domain, for the email-links-off tests.
  const g = {
    tenantId: await createTestTenant(db, { name: "Tenant G", slug: "tenant-g" }),
    slug: "tenant-g",
    admin: persona("admin@lawfirm.example"),
    // An admin who has never signed in with Google, so may not turn email links off.
    newAdmin: persona("new-admin@lawfirm.example"),
    user: persona("user@lawfirm.example"),
  };
  await linkTenantSso(
    db,
    g.tenantId,
    { provider: "google", googleDomain: "lawfirm.example" },
    SETUP_ACTOR,
  );
  for (const [t, users] of [
    [
      a,
      [
        [a.admin, "tenant_admin"],
        [a.user, "tenant_user"],
        [a.removed, "tenant_user"],
      ],
    ],
    [
      b,
      [
        [b.admin, "tenant_admin"],
        [b.user, "tenant_user"],
      ],
    ],
    [
      g,
      [
        [g.admin, "tenant_admin"],
        [g.newAdmin, "tenant_admin"],
        [g.user, "tenant_user"],
      ],
    ],
  ] as const) {
    await db.withTenant(t.tenantId, (tx) =>
      tx.insert(schema.users).values(
        users.map(([p, role]) => ({
          userId: p.userId,
          tenantId: t.tenantId,
          email: p.email,
          displayName: p.email,
          role,
        })),
      ),
    );
  }
  // Tenant G's admin has signed in with Google before (their Google ID is recorded).
  await db.withTenant(g.tenantId, (tx) =>
    tx
      .update(schema.users)
      .set({ googleSubject: "e2e-google-sub-admin" })
      .where(eq(schema.users.userId, g.admin.userId)),
  );
  // A user who had a session and has since been removed.
  await db.withTenant(a.tenantId, (tx) =>
    tx
      .update(schema.users)
      .set({ removedAt: new Date() })
      .where(eq(schema.users.userId, a.removed.userId)),
  );
  // A job for the role matrix's job routes (not run; the e2e worker runs uploaded ones).
  const aJobId = await db
    .withTenant(a.tenantId, async (tx) => {
      const [doc] = await tx
        .insert(schema.documents)
        .values({
          tenantId: a.tenantId,
          filename: "seeded.pdf",
          contentType: "application/pdf",
          sizeBytes: 1,
          blobPath: `tenant-${a.tenantId}/documents/seeded`,
          sha256: "seeded",
          uploadedBy: a.admin.userId,
        })
        .returning({ id: schema.documents.documentId });
      return doc?.id ?? "";
    })
    .then((documentId) =>
      createJob(db, a.tenantId, { documentId, agentName: "skeleton", agentVersion: "skeleton-1" }),
    );
  // It has succeeded with a report, so the role matrix can fetch it.
  await finishJob(db, a.tenantId, aJobId, "succeeded");
  await saveJobOutput(db, a.tenantId, aJobId, { fields: E2E_FIELDS, hasReport: true });
  const container = await tenantContainer(
    BlobServiceClient.fromConnectionString(AZURITE),
    a.tenantId,
  );
  await container
    .getBlockBlobClient(reportBlobName(aJobId))
    .uploadData(makeTemplate(["Seeded report"]));
  // A job waiting for review (task 11), for the look checks: its draft and its text,
  // recorded for the agent uploads run, so the review form is built from its schema.
  const uploadAgent = agentForUploads(await agentRegistry(process.env), process.env);
  const reviewJobId = await createJob(db, a.tenantId, {
    documentId: (await jobDocumentId(db, a.tenantId, aJobId)) ?? "",
    agentName: uploadAgent.definition.name,
    agentVersion: uploadAgent.version,
  });
  await saveJobOutput(db, a.tenantId, reviewJobId, { fields: E2E_FIELDS, hasReport: true });
  await setJobStatus(db, a.tenantId, reviewJobId, "awaiting_review");
  await container
    .getBlockBlobClient(textBlobName(reviewJobId))
    .uploadData(
      Buffer.from("SUPPLY AGREEMENT\n\nBetween Example Widgets Ltd and Sample Retail plc."),
    );
  await db.close();

  // Jobs go to a queue of this run's own, so a developer's local worker cannot take them.
  const taskQueue = `e2e-${randomUUID()}`;
  // A local fake of Bedrock's API stands in for the model; it runs in this (the test
  // runner's) process until the run ends.
  const fake = await startFakeProviders();
  fake.structuredAnswer = E2E_FIELDS;
  (globalThis as { agentCoreFakeModel?: { close(): Promise<void> } }).agentCoreFakeModel = fake;
  // Azurite for both processes; an account URL would mean Azure (an empty one is unset).
  const LOCAL_STORAGE = { AZURE_STORAGE_CONNECTION_STRING: AZURITE, AZURE_STORAGE_ACCOUNT_URL: "" };
  const workerEnv = {
    ...process.env,
    DATABASE_URL: testDb.appUrl,
    TENANT_CONTEXT_KEY: testDb.contextKey.toString("base64"),
    JOB_TASK_QUEUE: taskQueue,
    // The same Azurite as the web app, whatever a developer's shell has set.
    ...LOCAL_STORAGE,
    MODEL_PROVIDER: "bedrock",
    BEDROCK_REGION: "eu-west-2",
    BEDROCK_MODEL_ID: "e2e-model",
    BEDROCK_API_KEY: "e2e-fake-key",
    BEDROCK_ENDPOINT: fake.url,
  };
  // Outside CI the worker's output goes to e2e/.state/worker.log, for when it fails.
  mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const workerLog = openSync(path.join(path.dirname(STATE_FILE), "worker.log"), "w");
  const workerProcess = spawn(
    process.execPath,
    [path.join(webDir, "..", "worker", "src", "main.ts")],
    {
      cwd: path.join(webDir, "..", "worker"),
      detached: process.platform !== "win32",
      stdio: process.env["CI"] ? "inherit" : ["ignore", workerLog, workerLog],
      env: workerEnv,
    },
  );
  workerProcess.unref();

  const authSecret = randomBytes(32).toString("base64");
  const outboxDir = mkdtempSync(path.join(tmpdir(), "agentcore-outbox-"));
  // Run Next.js's own CLI with this Node directly (no shell, no pnpm wrapper), so it
  // starts the same way on Windows, macOS and Linux. On Unix it gets its own process
  // group so teardown can stop it and any children together.
  const nextCli = createRequire(path.join(webDir, "package.json")).resolve("next/dist/bin/next");
  const server = spawn(
    process.execPath,
    [nextCli, "start", "--hostname", "127.0.0.1", "--port", String(PORT)],
    {
      cwd: webDir,
      detached: process.platform !== "win32",
      stdio: process.env["CI"] ? "inherit" : "ignore",
      env: {
        ...process.env,
        DATABASE_URL: testDb.appUrl,
        TENANT_CONTEXT_KEY: testDb.contextKey.toString("base64"),
        AUTH_SECRET: authSecret,
        AUTH_URL: BASE_URL,
        JOB_TASK_QUEUE: taskQueue,
        ...LOCAL_STORAGE,
        // The failing page at /test/error, for checking the error page.
        ALLOW_TEST_FAULTS: "true",
        EMAIL_TRANSPORT: "dev-outbox",
        // Small, so the oversize test does not have to send 25 MB.
        MAX_UPLOAD_MB: "1",
        DEV_OUTBOX_DIR: outboxDir,
        // Fake app registrations: they show "Sign in with your work account" so the refusal
        // paths can be tested. No test clicks it for tenant G (the one linked tenant), and
        // no operator organisation is set, so nothing ever contacts Microsoft or Google.
        AUTH_MICROSOFT_ENTRA_ID_ID: "e2e-fake-client-id",
        AUTH_MICROSOFT_ENTRA_ID_SECRET: "e2e-fake-client-secret",
        OPERATOR_ENTRA_TENANT_ID: "",
        AUTH_GOOGLE_ID: "e2e-fake-google-client-id",
        AUTH_GOOGLE_SECRET: "e2e-fake-google-client-secret",
      },
    },
  );
  server.unref();

  const state: RunState = {
    authSecret,
    outboxDir,
    agentsDir,
    appUrl: testDb.appUrl,
    adminUrl: testDb.adminUrl,
    contextKeyBase64: testDb.contextKey.toString("base64"),
    serverPid: server.pid ?? 0,
    workerPid: workerProcess.pid ?? 0,
    taskQueue,
    aJobId,
    reviewJobId,
    a,
    b,
    g,
  };
  mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  await waitForServer(`${BASE_URL}/api/health`, 60_000);
}
