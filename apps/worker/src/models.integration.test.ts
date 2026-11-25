// Task 8: the worker's gateway records each call in model_calls, against the right
// tenant, job and step, through a provider (here a local fake of Bedrock's API).
import { randomUUID } from "node:crypto";
import { ModelError } from "@agent-core/core/models";
import {
  FAKE_TOKENS,
  startFakeProviders,
  type FakeProviders,
} from "@agent-core/core/models/testing";
import {
  addTenantUser,
  createJob,
  createTenantDatabase,
  modelUsageForJob,
  schema,
  type TenantDatabase,
  SETUP_ACTOR,
} from "@agent-core/db";
import { createTestDatabase, type TestDatabase, createTestTenant } from "@agent-core/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workerModelGateway } from "./models.ts";

let testDb: TestDatabase;
let db: TenantDatabase;
let fake: FakeProviders;
let tenantId = "";
let jobId = "";

beforeAll(async () => {
  fake = await startFakeProviders();
  testDb = await createTestDatabase();
  db = createTenantDatabase(testDb.appUrl, { contextKey: testDb.contextKey, maxConnections: 2 });
  tenantId = await createTestTenant(db, { name: "Models", slug: "models-test" });
  const user = await addTenantUser(
    db,
    tenantId,
    {
      email: "u@models.example",
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
        blobPath: `p-${randomUUID()}`,
        sha256: "s",
        uploadedBy: user,
      })
      .returning({ id: schema.documents.documentId });
    return row?.id ?? "";
  });
  jobId = await createJob(db, tenantId, {
    documentId,
    agentName: "contract-summary",
    agentVersion: "v",
  });
}, 60_000);

afterAll(async () => {
  await fake?.close();
  await db?.close();
  await testDb?.drop();
});

describe("the worker's model gateway", () => {
  it("records successful and failed calls against the tenant, job and step", async () => {
    const gateway = workerModelGateway(db, {
      MODEL_PROVIDER: "bedrock",
      BEDROCK_REGION: "eu-west-2",
      BEDROCK_MODEL_ID: "test-model",
      BEDROCK_API_KEY: "k",
      BEDROCK_ENDPOINT: fake.url,
    });
    const context = { tenantId, jobId, step: "fields" };
    fake.scenario = "ok";
    await gateway?.complete(context, { user: "Hello" });
    fake.scenario = "rate-limited";
    await expect(gateway?.complete(context, { user: "Hello" })).rejects.toBeInstanceOf(ModelError);

    expect(await modelUsageForJob(db, tenantId, jobId)).toMatchObject({
      calls: 2,
      inputTokens: FAKE_TOKENS.input,
      outputTokens: FAKE_TOKENS.output,
    });
    const rows = await db.withTenant(tenantId, (tx) => tx.select().from(schema.modelCalls));
    expect(rows.map((r) => [r.step, r.provider, r.model, r.outcome, r.errorCode]).sort()).toEqual([
      ["fields", "bedrock", "test-model", "failed", "model-rate-limited"],
      ["fields", "bedrock", "test-model", "succeeded", null],
    ]);
  });

  it("is absent when no model is configured", () => {
    expect(workerModelGateway(db, {})).toBeNull();
  });
});
