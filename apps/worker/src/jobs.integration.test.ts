// Task 5's done-when: a forced activity failure retries, and the status shows each
// attempt. Task 9: a job runs its agent's steps on the document and stores what they
// produce. Task 11's done-when: every edit and approval is logged, and send back re-runs
// the job. A real worker runs in-process against the compose Temporal dev server and
// Azurite, with a local fake standing in for the model provider.
import { randomUUID } from "node:crypto";
import {
  DECIDE_UPDATE,
  PROCESS_DOCUMENT_WORKFLOW,
  workflowIdForJob,
  type ProcessDocumentInput,
  type ReviewDecision,
} from "@agent-core/core";
import { agentForUploads, agentRegistry, type LoadedAgent } from "@agent-core/core/agents";
import { docxBodyText, makeTextPdf, SAMPLE_CONTRACT_PAGES } from "@agent-core/blocks/testing";
import { startFakeProviders, type FakeProviders } from "@agent-core/core/models/testing";
import {
  documentBlobName,
  reportBlobName,
  tenantContainerName,
  textBlobName,
} from "@agent-core/core/storage";
import {
  addTenantUser,
  createJob,
  createTenantDatabase,
  getJob,
  getJobOutput,
  modelUsageForJob,
  recordDecision,
  reviewHistory,
  saveReview,
  type JobStatus,
  schema,
  type TenantDatabase,
  SETUP_ACTOR,
} from "@agent-core/db";
import { BlobServiceClient } from "@azure/storage-blob";
import { createTestDatabase, type TestDatabase, createTestTenant } from "@agent-core/db/testing";
import {
  Client,
  Connection,
  WorkflowIdReusePolicy,
  WorkflowUpdateFailedError,
} from "@temporalio/client";
import type { NativeConnection, Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sweepJobs } from "./job-sweep.ts";
import { createJobWorker } from "./start-worker.ts";

const TEMPORAL = process.env["TEMPORAL_ADDRESS"] ?? "localhost:7233";
const taskQueue = `test-${randomUUID()}`;
const FAST = { initialIntervalMs: 10, backoffCoefficient: 1, maximumAttempts: 3 };
// Azurite's published development account: not a secret.
const AZURITE =
  process.env["AZURE_STORAGE_CONNECTION_STRING"] ??
  "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;";
const blobs = BlobServiceClient.fromConnectionString(AZURITE);
/** What the fake model says: fields matching the demo agent's schema. */
const FIELDS = {
  parties: [
    { name: "Example Widgets Ltd", role: "supplier" },
    { name: "Sample Retail plc", role: "customer" },
  ],
  term: "24 months from 1 March 2026",
  renewal: "12 months at a time",
  notice: "90 days",
  fees: "£4,500 per month",
};
let fake: FakeProviders;

let testDb: TestDatabase;
let db: TenantDatabase;
let worker: Worker;
let testWorker: Worker;
let workerConnection: NativeConnection;
let running: Promise<void>;
let client: Client;
let clientConnection: Connection;
const t = { a: { id: "", doc: "" }, b: { id: "", doc: "" } };
/** The agent uploads run, as the worker loads it. */
let agent: LoadedAgent;

/** A document record and its file in the tenant's container (a text PDF by default). */
async function addDocument(
  tenantId: string,
  bytes: Buffer = makeTextPdf(SAMPLE_CONTRACT_PAGES),
): Promise<string> {
  const uploader = await addTenantUser(
    db,
    tenantId,
    {
      email: `${randomUUID()}@example.com`,
      role: "tenant_user",
    },
    SETUP_ACTOR,
  );
  const documentId = await db.withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .insert(schema.documents)
      .values({
        tenantId,
        filename: "x.pdf",
        contentType: "application/pdf",
        sizeBytes: 1,
        blobPath: `tenant-${tenantId}/documents/x`,
        sha256: "x",
        uploadedBy: uploader,
      })
      .returning({ id: schema.documents.documentId });
    return row?.id ?? "";
  });
  const container = blobs.getContainerClient(tenantContainerName(tenantId));
  await container.createIfNotExists();
  await container.getBlockBlobClient(documentBlobName(documentId)).uploadData(bytes);
  return documentId;
}

/** Polls the job until its status is one of `statuses` (and, if given, its run is `run`). */
async function waitForStatus(
  tenantId: string,
  jobId: string,
  statuses: JobStatus[],
  run?: number,
): Promise<JobStatus> {
  const deadline = Date.now() + 45_000;
  for (;;) {
    const job = await getJob(db, tenantId, jobId);
    if (job && statuses.includes(job.status) && (run === undefined || job.run === run)) {
      return job.status;
    }
    if (Date.now() > deadline) throw new Error(`job ${jobId} is ${job?.status ?? "missing"}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Starts a job's workflow and waits until it fails or its draft waits for review (a job
 * that succeeds then waits for a person, so its workflow stays open).
 */
async function runJob(
  tenant: { id: string; doc: string },
  testFailAttempts: number,
  agentVersion = agent.version,
) {
  const jobId = await createJob(db, tenant.id, {
    documentId: tenant.doc,
    agentName: agent.definition.name,
    agentVersion,
  });
  const input: ProcessDocumentInput = { tenantId: tenant.id, jobId, retry: FAST, testFailAttempts };
  const handle = await client.workflow.start(PROCESS_DOCUMENT_WORKFLOW, {
    taskQueue,
    workflowId: workflowIdForJob(jobId),
    workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
    args: [input],
  });
  open.push(jobId);
  const result = await waitForStatus(tenant.id, jobId, ["awaiting_review", "failed"]);
  return { jobId, result, handle };
}

/** Workflows left waiting for review, ended when the tests finish. */
const open: string[] = [];

function runJobAgain(jobId: string, tenantId: string) {
  return client.workflow.start(PROCESS_DOCUMENT_WORKFLOW, {
    taskQueue,
    workflowId: workflowIdForJob(jobId),
    workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
    args: [{ tenantId, jobId, retry: FAST } satisfies ProcessDocumentInput],
  });
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  db = createTenantDatabase(testDb.appUrl, { contextKey: testDb.contextKey, maxConnections: 4 });
  t.a.id = await createTestTenant(db, { name: "Tenant A", slug: "tenant-a" });
  t.b.id = await createTestTenant(db, { name: "Tenant B", slug: "tenant-b" });
  t.a.doc = await addDocument(t.a.id);
  t.b.doc = await addDocument(t.b.id);
  agent = agentForUploads(await agentRegistry(process.env), process.env);
  fake = await startFakeProviders();
  fake.structuredAnswer = FIELDS;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AZURE_STORAGE_CONNECTION_STRING: AZURITE,
    MODEL_PROVIDER: "bedrock",
    BEDROCK_REGION: "eu-west-2",
    BEDROCK_MODEL_ID: "test-model",
    BEDROCK_API_KEY: "test-key",
    BEDROCK_ENDPOINT: fake.url,
  };
  delete env["AZURE_STORAGE_ACCOUNT_URL"];
  ({
    worker,
    testWorker,
    connection: workerConnection,
  } = await createJobWorker(
    {
      temporalAddress: TEMPORAL,
      temporalNamespace: "default",
      taskQueue,
      allowTestFaults: true,
      model: null,
    },
    db,
    env,
  ));
  running = Promise.all([worker.run(), testWorker.run()]).then(() => {});
  clientConnection = await Connection.connect({ address: TEMPORAL });
  client = new Client({ connection: clientConnection });
}, 120_000);

afterAll(async () => {
  for (const jobId of open) {
    await client?.workflow
      .getHandle(workflowIdForJob(jobId))
      .terminate("tests finished")
      .catch(() => {});
  }
  worker?.shutdown();
  testWorker?.shutdown();
  await running?.catch(() => {});
  await workerConnection?.close();
  await clientConnection?.close();
  await fake?.close();
  for (const id of [t.a.id, t.b.id]) {
    if (id) await blobs.getContainerClient(tenantContainerName(id)).deleteIfExists();
  }
  await db?.close();
  await testDb?.drop();
}, 60_000);

describe("job runner", () => {
  it("retries a forced failure and records every attempt", async () => {
    const { jobId, result } = await runJob(t.a, 2);
    expect(result).toBe("awaiting_review");
    const job = await getJob(db, t.a.id, jobId);
    // Task 7's done-when: the job records the agent and version that ran.
    expect(job).toMatchObject({
      status: "awaiting_review",
      agentName: agent.definition.name,
      agentVersion: agent.version,
    });
    expect(agent.version).toMatch(/^[0-9a-f]{12}$/);
    expect(job?.attempts.map((a) => [a.attempt, a.outcome, a.errorCode])).toEqual([
      [1, "failed", "test-fault"],
      [2, "failed", "test-fault"],
      [3, "succeeded", null],
    ]);
    expect(job?.attempts.every((a) => a.finishedAt !== null)).toBe(true);
  }, 60_000);

  // Task 14's done-when, in part: a failed job writes the one event the alert rule
  // watches for (infra/azure/monitoring.bicep), with its agent and reason, and no names.
  it("marks the job failed once the retries run out, and says so once for the alert", async () => {
    const lines: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      const { jobId, result } = await runJob(t.a, 99);
      expect(result).toBe("failed");
      const job = await getJob(db, t.a.id, jobId);
      expect(job?.status).toBe("failed");
      expect(job?.attempts.map((a) => a.outcome)).toEqual(["failed", "failed", "failed"]);
      const events = lines
        .flatMap((l) => l.split("\n"))
        .filter((l) => l.startsWith("{"))
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((e) => e["jobId"] === jobId);
      expect(events).toEqual([
        expect.objectContaining({
          event: "job.failed",
          level: "error",
          tenantId: t.a.id,
          agent: job?.agentName,
          attempts: 3,
          reason: "test-fault",
        }),
      ]);
    } finally {
      write.mockRestore();
    }
  }, 60_000);

  it("succeeds first time without forced failures", async () => {
    const { jobId } = await runJob(t.b, 0);
    expect((await getJob(db, t.b.id, jobId))?.attempts.map((a) => a.outcome)).toEqual([
      "succeeded",
    ]);
  }, 60_000);

  it("keeps each job and its attempts inside its own tenant", async () => {
    const { jobId } = await runJob(t.b, 1);
    expect(await getJob(db, t.a.id, jobId)).toBeNull();
    const attemptsSeenByA = await db.withTenant(t.a.id, (tx) =>
      tx.select().from(schema.jobAttempts),
    );
    expect(attemptsSeenByA.every((a) => a.tenantId === t.a.id)).toBe(true);
    expect((await getJob(db, t.b.id, jobId))?.attempts).toHaveLength(2);
  }, 60_000);

  it("runs the agent's steps and stores the fields, the report and the model call", async () => {
    // Task 9: text from the PDF, fields from the (fake) model, a report from the template.
    const { jobId, result } = await runJob(t.a, 0);
    expect(result).toBe("awaiting_review");
    expect(await getJobOutput(db, t.a.id, jobId)).toMatchObject({
      fields: FIELDS,
      reviewedFields: FIELDS,
      run: 1,
      hasReport: true,
    });
    // The text it read, saved for the review screen.
    const text = await blobs
      .getContainerClient(tenantContainerName(t.a.id))
      .getBlockBlobClient(textBlobName(jobId))
      .downloadToBuffer();
    expect(text.toString("utf8")).toContain("Example Widgets Ltd (the Supplier)");
    const report = await blobs
      .getContainerClient(tenantContainerName(t.a.id))
      .getBlockBlobClient(reportBlobName(jobId))
      .downloadToBuffer();
    expect(docxBodyText(report)).toContain("Term|24 months from 1 March 2026");
    expect(await modelUsageForJob(db, t.a.id, jobId)).toMatchObject({ calls: 1 });
    // The model was given the document's text.
    expect(JSON.stringify(fake.requests.at(-1)?.body)).toContain("Example Widgets Ltd");
  }, 60_000);

  it("fails a document with no text at once, without retrying", async () => {
    const doc = await addDocument(t.b.id, makeTextPdf([[]]));
    const { jobId, result } = await runJob({ id: t.b.id, doc }, 0);
    expect(result).toBe("failed");
    expect((await getJob(db, t.b.id, jobId))?.attempts.map((a) => a.errorCode)).toEqual([
      "no-text",
    ]);
    expect(await getJobOutput(db, t.b.id, jobId)).toBeNull();
  }, 60_000);

  it("fails a job whose file has gone at once, without retrying", async () => {
    const doc = await addDocument(t.b.id);
    await blobs
      .getContainerClient(tenantContainerName(t.b.id))
      .getBlockBlobClient(documentBlobName(doc))
      .delete();
    const { jobId, result } = await runJob({ id: t.b.id, doc }, 0);
    expect(result).toBe("failed");
    expect((await getJob(db, t.b.id, jobId))?.attempts.map((a) => a.errorCode)).toEqual([
      "document-not-found",
    ]);
  }, 60_000);

  it("retries when the model is rate-limited, then succeeds", async () => {
    // The first attempt meets the rate limit; the provider then recovers.
    fake.scenario = "rate-limited";
    fake.scenarioRequests = 1;
    const { jobId, result } = await runJob(t.a, 0);
    expect(result).toBe("awaiting_review");
    const codes = (await getJob(db, t.a.id, jobId))?.attempts.map((a) => a.errorCode);
    expect(codes?.[0]).toBe("model-rate-limited");
    expect(codes?.at(-1)).toBeNull();
  }, 60_000);

  it("refuses to run a job recorded for another version of its agent, without retrying", async () => {
    const { jobId, result } = await runJob(t.a, 0, "000000000000");
    expect(result).toBe("failed");
    const job = await getJob(db, t.a.id, jobId);
    expect(job?.status).toBe("failed");
    expect(job?.attempts.map((a) => [a.attempt, a.outcome, a.errorCode])).toEqual([
      [1, "failed", "agent-version-changed"],
    ]);
  }, 60_000);

  it("refuses a job for an agent this worker does not have", async () => {
    const jobId = await createJob(db, t.a.id, {
      documentId: t.a.doc,
      agentName: "no-such-agent",
      agentVersion: agent.version,
    });
    const result = await client.workflow.execute(PROCESS_DOCUMENT_WORKFLOW, {
      taskQueue,
      workflowId: workflowIdForJob(jobId),
      args: [{ tenantId: t.a.id, jobId, retry: FAST } satisfies ProcessDocumentInput],
    });
    expect(result).toBe("failed");
    expect((await getJob(db, t.a.id, jobId))?.attempts.map((a) => a.errorCode)).toEqual([
      "agent-version-changed",
    ]);
  }, 60_000);

  it("keeps raw error details out of Temporal's history", async () => {
    // A job that does not exist: recording its attempts fails inside the database.
    const jobId = randomUUID();
    const input: ProcessDocumentInput = { tenantId: t.a.id, jobId, retry: FAST };
    const result = await client.workflow.execute(PROCESS_DOCUMENT_WORKFLOW, {
      taskQueue,
      workflowId: workflowIdForJob(jobId),
      args: [input],
    });
    expect(result).toBe("failed");
    const history = JSON.stringify(
      await client.workflow.getHandle(workflowIdForJob(jobId)).fetchHistory(),
    );
    expect(history).toContain("job attempt failed: error");
    for (const leak of ["Failed query", "params", "insert into", "job_attempts", "foreign key"]) {
      expect(history, leak).not.toContain(leak);
    }
  }, 60_000);

  it("refuses to run a job's workflow a second time", async () => {
    const { jobId } = await runJob(t.b, 0);
    await expect(runJobAgain(jobId, t.b.id)).rejects.toThrow(/already/i);
  }, 60_000);

  // The review's Q2: an attempt reports in, so a worker that dies mid-job is noticed in a
  // minute rather than after the attempt's 10 minutes.
  it("schedules each attempt with a one-minute heartbeat timeout", async () => {
    const { jobId } = await runJob(t.a, 0);
    const history = await client.workflow.getHandle(workflowIdForJob(jobId)).fetchHistory();
    const scheduled = (history.events ?? [])
      .map((e) => e.activityTaskScheduledEventAttributes)
      .find((a) => a?.activityType?.name === "runJob");
    expect(Number(scheduled?.heartbeatTimeout?.seconds)).toBe(60);
  }, 60_000);

  it("never passes document content through Temporal: workflow input holds IDs only", async () => {
    const { jobId } = await runJob(t.a, 0);
    const history = await client.workflow.getHandle(workflowIdForJob(jobId)).fetchHistory();
    const text = JSON.stringify(history);
    expect(text).not.toContain("x.pdf");
  }, 60_000);
});

describe("review (task 11)", () => {
  let reviewer = "";
  let otherReviewer = "";

  beforeAll(async () => {
    reviewer = await addTenantUser(
      db,
      t.a.id,
      {
        email: "reviewer@a.example",
        role: "tenant_user",
      },
      SETUP_ACTOR,
    );
    otherReviewer = await addTenantUser(
      db,
      t.a.id,
      {
        email: "second@a.example",
        role: "tenant_admin",
      },
      SETUP_ACTOR,
    );
  });

  // The job shows "awaiting review" as soon as the workflow records it, a moment before
  // the workflow starts waiting for a decision, and a decision sent in that moment is
  // refused. The review screen offers Resend for that; this does the same, briefly.
  const decide = async (jobId: string, decision: ReviewDecision) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await client.workflow
          .getHandle(workflowIdForJob(jobId))
          .executeUpdate(DECIDE_UPDATE, { args: [decision], updateId: decision.eventId });
      } catch (error) {
        const refused =
          error instanceof WorkflowUpdateFailedError && /not waiting/.test(String(error.cause));
        if (!refused || attempt >= 10) throw error;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  };

  const reportText = async (jobId: string) =>
    docxBodyText(
      await blobs
        .getContainerClient(tenantContainerName(t.a.id))
        .getBlockBlobClient(reportBlobName(jobId))
        .downloadToBuffer(),
    );

  it("logs every edit and the approval, and writes the report from the approved fields", async () => {
    const { jobId } = await runJob(t.a, 0);
    const draft = await getJobOutput(db, t.a.id, jobId);
    const edited = { ...FIELDS, term: "36 months from 1 April 2026" };
    const saved = await saveReview(db, t.a.id, jobId, {
      userId: reviewer,
      revision: draft?.revision ?? -1,
      fields: edited,
      edits: [{ field: "term", oldValue: FIELDS.term, newValue: edited.term }],
    });
    if (!saved.ok) throw new Error(saved.reason);
    const decision = await recordDecision(db, t.a.id, jobId, {
      userId: otherReviewer,
      revision: saved.revision,
      kind: "approve",
    });
    if (!decision.ok) throw new Error(decision.reason);
    await decide(jobId, decision);
    expect(await waitForStatus(t.a.id, jobId, ["approved"])).toBe("approved");

    // The draft stays as the model gave it; the reviewed fields carry the edit.
    expect(await getJobOutput(db, t.a.id, jobId)).toMatchObject({
      fields: FIELDS,
      reviewedFields: edited,
    });
    expect(await reportText(jobId)).toContain("Term|36 months from 1 April 2026");
    const history = await reviewHistory(db, t.a.id, jobId);
    expect(history.map((e) => [e.kind, e.field, e.oldValue, e.newValue, e.userId])).toEqual([
      ["edit", "term", FIELDS.term, edited.term, reviewer],
      ["approve", null, null, null, otherReviewer],
    ]);
    expect(history.every((e) => e.run === 1)).toBe(true);
  }, 60_000);

  it("re-runs the job when the draft is sent back, giving the model the reviewer's reason", async () => {
    const { jobId } = await runJob(t.a, 0);
    const first = await getJobOutput(db, t.a.id, jobId);
    const decision = await recordDecision(db, t.a.id, jobId, {
      userId: reviewer,
      revision: first?.revision ?? -1,
      kind: "send_back",
      note: "Say who may give notice.",
    });
    if (!decision.ok) throw new Error(decision.reason);
    await decide(jobId, decision);
    await waitForStatus(t.a.id, jobId, ["awaiting_review"], 2);

    const job = await getJob(db, t.a.id, jobId);
    expect(job?.run).toBe(2);
    expect(job?.attempts.map((a) => [a.run, a.attempt, a.outcome])).toEqual([
      [1, 1, "succeeded"],
      [2, 1, "succeeded"],
    ]);
    // The second run's model call carried the reason, marked as the reviewer's.
    expect(JSON.stringify(fake.requests.at(-1)?.body)).toContain(
      "<reviewer-note>\\nSay who may give notice.\\n</reviewer-note>",
    );
    const second = await getJobOutput(db, t.a.id, jobId);
    expect(second?.run).toBe(2);
    expect(second?.revision).toBeGreaterThan(first?.revision ?? 0);
    expect(await modelUsageForJob(db, t.a.id, jobId)).toMatchObject({ calls: 2 });
    const history = await reviewHistory(db, t.a.id, jobId);
    expect(history.map((e) => [e.kind, e.run, e.note])).toEqual([
      ["send_back", 1, "Say who may give notice."],
    ]);

    // The new draft is reviewed in turn, and can be approved.
    const approval = await recordDecision(db, t.a.id, jobId, {
      userId: reviewer,
      revision: second?.revision ?? -1,
      kind: "approve",
    });
    if (!approval.ok) throw new Error(approval.reason);
    expect(approval.run).toBe(2);
    await decide(jobId, approval);
    expect(await waitForStatus(t.a.id, jobId, ["approved"])).toBe("approved");
  }, 90_000);

  it("refuses a save or a decision made on an out-of-date draft", async () => {
    const { jobId } = await runJob(t.a, 0);
    const draft = await getJobOutput(db, t.a.id, jobId);
    const revision = draft?.revision ?? -1;
    const first = await saveReview(db, t.a.id, jobId, {
      userId: reviewer,
      revision,
      fields: { ...FIELDS, fees: "£5,000 per month" },
      edits: [{ field: "fees", oldValue: FIELDS.fees, newValue: "£5,000 per month" }],
    });
    expect(first.ok).toBe(true);
    // A second reviewer who opened the same draft cannot overwrite it, or approve it.
    expect(
      await saveReview(db, t.a.id, jobId, {
        userId: otherReviewer,
        revision,
        fields: FIELDS,
        edits: [{ field: "fees", oldValue: FIELDS.fees, newValue: FIELDS.fees }],
      }),
    ).toEqual({ ok: false, reason: "stale" });
    expect(
      await recordDecision(db, t.a.id, jobId, { userId: otherReviewer, revision, kind: "approve" }),
    ).toEqual({ ok: false, reason: "stale" });
    expect((await reviewHistory(db, t.a.id, jobId)).map((e) => e.userId)).toEqual([reviewer]);
  }, 60_000);

  it("acts only on a decision about this job's current draft", async () => {
    const { jobId } = await runJob(t.a, 0);
    const other = await runJob(t.a, 0);
    const output = await getJobOutput(db, t.a.id, jobId);
    // Not waiting on run 2: refused at once, before anything happens.
    await expect(decide(jobId, { eventId: randomUUID(), run: 2 })).rejects.toThrow();
    // A real event, but about another job: dropped, and the draft goes on waiting.
    const otherOutput = await getJobOutput(db, t.a.id, other.jobId);
    const elsewhere = await recordDecision(db, t.a.id, other.jobId, {
      userId: reviewer,
      revision: otherOutput?.revision ?? -1,
      kind: "approve",
    });
    if (!elsewhere.ok) throw new Error(elsewhere.reason);
    await decide(jobId, { eventId: elsewhere.eventId, run: 1 });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect((await getJob(db, t.a.id, jobId))?.status).toBe("awaiting_review");
    // The proper decision still works afterwards.
    const mine = await recordDecision(db, t.a.id, jobId, {
      userId: reviewer,
      revision: output?.revision ?? -1,
      kind: "approve",
    });
    if (!mine.ok) throw new Error(mine.reason);
    await decide(jobId, mine);
    expect(await waitForStatus(t.a.id, jobId, ["approved"])).toBe("approved");
  }, 60_000);

  it("locks the draft once a decision is recorded: no more edits, and no second decision", async () => {
    const { jobId } = await runJob(t.a, 0);
    const draft = await getJobOutput(db, t.a.id, jobId);
    const revision = draft?.revision ?? -1;
    // Recorded, but (as if the delivery failed) not yet acted on by the workflow.
    const first = await recordDecision(db, t.a.id, jobId, {
      userId: reviewer,
      revision,
      kind: "approve",
    });
    if (!first.ok) throw new Error(first.reason);
    expect(
      await saveReview(db, t.a.id, jobId, {
        userId: otherReviewer,
        revision,
        fields: { ...FIELDS, fees: "£1" },
        edits: [{ field: "fees", oldValue: FIELDS.fees, newValue: "£1" }],
      }),
    ).toEqual({ ok: false, reason: "decided" });
    expect(
      await recordDecision(db, t.a.id, jobId, {
        userId: otherReviewer,
        revision,
        kind: "send_back",
        note: "No.",
      }),
    ).toEqual({ ok: false, reason: "decided" });
    // Sending the recorded decision (again) carries out exactly that approval.
    await decide(jobId, first);
    expect(await waitForStatus(t.a.id, jobId, ["approved"])).toBe("approved");
    expect(await reportText(jobId)).toContain(FIELDS.fees);
    expect((await reviewHistory(db, t.a.id, jobId)).map((e) => [e.kind, e.userId])).toEqual([
      ["approve", reviewer],
    ]);
  }, 60_000);

  it("fails a job whose workflow is cancelled while it waits for review, and says why", async () => {
    const lines: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      const { jobId, handle } = await runJob(t.a, 0);
      await handle.cancel();
      expect(await waitForStatus(t.a.id, jobId, ["failed"])).toBe("failed");
      await expect
        .poll(() =>
          lines
            .flatMap((l) => l.split("\n"))
            .filter((l) => l.includes(jobId) && l.includes('"event":"job.failed"')),
        )
        .toEqual([expect.stringContaining('"reason":"cancelled"')]);
    } finally {
      write.mockRestore();
    }
  }, 60_000);

  it("keeps each tenant's review to itself", async () => {
    const { jobId } = await runJob(t.a, 0);
    const output = await getJobOutput(db, t.a.id, jobId);
    const intruder = await addTenantUser(
      db,
      t.b.id,
      {
        email: "x@b.example",
        role: "tenant_admin",
      },
      SETUP_ACTOR,
    );
    // From tenant B's context, tenant A's job does not exist.
    expect(
      await recordDecision(db, t.b.id, jobId, {
        userId: intruder,
        revision: output?.revision ?? -1,
        kind: "approve",
      }),
    ).toEqual({ ok: false, reason: "not-awaiting-review" });
    expect(await reviewHistory(db, t.b.id, jobId)).toEqual([]);
    expect(await getJobOutput(db, t.b.id, jobId)).toBeNull();
  }, 60_000);
});

describe("the job sweep (review Q1, Q7, T11)", () => {
  // As if the sweep ran 3 minutes from now: every job here is past STUCK_AFTER_MS.
  const later = () => Date.now() + 3 * 60 * 1000;

  it("starts a job whose workflow never started", async () => {
    const jobId = await createJob(db, t.a.id, {
      documentId: t.a.doc,
      agentName: agent.definition.name,
      agentVersion: agent.version,
    });
    open.push(jobId);
    const result = await sweepJobs({ db, client, taskQueue, now: later() });
    expect(result.started).toBeGreaterThanOrEqual(1);
    expect(await waitForStatus(t.a.id, jobId, ["awaiting_review"])).toBe("awaiting_review");
    // A second sweep leaves it alone: it is no longer "uploaded".
    expect((await sweepJobs({ db, client, taskQueue, now: later() })).stuck).toBe(0);
  }, 60_000);

  it("puts right, without counting a restart, a job whose workflow did start", async () => {
    const jobId = await createJob(db, t.a.id, {
      documentId: t.a.doc,
      agentName: agent.definition.name,
      agentVersion: agent.version,
    });
    open.push(jobId);
    // The upload started it, but recording "queued" failed: it is still "uploaded".
    await runJobAgain(jobId, t.a.id);
    const result = await sweepJobs({ db, client, taskQueue, now: later() });
    expect(result.started).toBe(0);
    expect(await waitForStatus(t.a.id, jobId, ["queued", "running", "awaiting_review"])).not.toBe(
      "uploaded",
    );
  }, 60_000);

  it("sends again a decision that never reached the workflow", async () => {
    const { jobId } = await runJob(t.a, 0);
    const reviewer = await addTenantUser(
      db,
      t.a.id,
      { email: `${randomUUID()}@a.example`, role: "tenant_user" },
      SETUP_ACTOR,
    );
    const draft = await getJobOutput(db, t.a.id, jobId);
    // Recorded, as the review screen does, but the update to the workflow was lost.
    const decision = await recordDecision(db, t.a.id, jobId, {
      userId: reviewer,
      revision: draft?.revision ?? -1,
      kind: "approve",
    });
    if (!decision.ok) throw new Error(decision.reason);
    const result = await sweepJobs({ db, client, taskQueue, now: later() });
    expect(result.delivered).toBeGreaterThanOrEqual(1);
    expect(await waitForStatus(t.a.id, jobId, ["approved"])).toBe("approved");
  }, 60_000);

  it("ends, once, a job whose workflow has ended, so it does not alert for ever", async () => {
    const { jobId, handle } = await runJob(t.a, 0);
    const reviewer = await addTenantUser(
      db,
      t.a.id,
      { email: `${randomUUID()}@a.example`, role: "tenant_user" },
      SETUP_ACTOR,
    );
    const draft = await getJobOutput(db, t.a.id, jobId);
    const decision = await recordDecision(db, t.a.id, jobId, {
      userId: reviewer,
      revision: draft?.revision ?? -1,
      kind: "approve",
    });
    if (!decision.ok) throw new Error(decision.reason);
    // Someone terminates the workflow: the decision can never be acted on.
    await handle.terminate("test: an operator ended it");
    const first = await sweepJobs({ db, client, taskQueue, now: later() });
    expect(first.ended).toBe(1);
    expect((await getJob(db, t.a.id, jobId))?.status).toBe("failed");
    const second = await sweepJobs({ db, client, taskQueue, now: later() });
    expect(second.ended + second.stuck).toBe(0);
  }, 60_000);

  it("logs a job it cannot start, for the alert, and leaves it to the next sweep", async () => {
    const jobId = await createJob(db, t.b.id, {
      documentId: t.b.doc,
      agentName: agent.definition.name,
      agentVersion: agent.version,
    });
    // Temporal refuses: a namespace that does not exist.
    const broken = new Client({
      connection: clientConnection,
      namespace: `no-such-${randomUUID()}`,
    });
    const lines: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((line) => {
      lines.push(String(line));
      return true;
    });
    try {
      const result = await sweepJobs({ db, client: broken, taskQueue, now: later() });
      expect(result.stuck).toBeGreaterThanOrEqual(1);
    } finally {
      write.mockRestore();
    }
    const events = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events).toContainEqual(
      expect.objectContaining({ event: "job.stuck", tenantId: t.b.id, jobId, level: "error" }),
    );
    expect((await getJob(db, t.b.id, jobId))?.status).toBe("uploaded");
  }, 60_000);
});
