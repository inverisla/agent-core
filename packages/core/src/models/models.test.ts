// Task 8's done-when: switching provider is a config change, and both pass the same test.
// One suite runs against each provider's adapter, pointed at a local fake of its API; the
// only difference between the two runs is the environment.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  FAKE_JSON,
  FAKE_TEXT,
  FAKE_TOKENS,
  PROVIDER_SECRET,
  startFakeProviders,
  type FakeProviders,
  type FakeScenario,
} from "./fake-providers.ts";
import {
  ModelError,
  ModelSettingsError,
  modelGatewayFromEnv,
  modelSettings,
  type ModelCallContext,
  type ModelCallRecord,
  type ModelErrorCode,
  type ModelGateway,
} from "./index.ts";

let fake: FakeProviders;
beforeAll(async () => {
  fake = await startFakeProviders();
});
afterAll(async () => {
  await fake?.close();
});
// Every request the adapters sent must be one the real API would accept.
afterEach(() => {
  expect(fake.requests.map((r) => r.problem).filter(Boolean)).toEqual([]);
});

const PRICES = {
  "azure-openai/test-model": { inputPerMillionUsd: 2, outputPerMillionUsd: 8 },
  "bedrock/test-model": { inputPerMillionUsd: 2, outputPerMillionUsd: 8 },
};
const EXPECTED_COST = (FAKE_TOKENS.input * 2 + FAKE_TOKENS.output * 8) / 1_000_000;

/** The whole difference between the two providers: these settings. */
const environments = (): Record<string, NodeJS.ProcessEnv> => ({
  "azure-openai": {
    MODEL_PROVIDER: "azure-openai",
    AZURE_OPENAI_ENDPOINT: fake.url,
    AZURE_OPENAI_DEPLOYMENT: "summaries",
    AZURE_OPENAI_MODEL: "test-model",
    AZURE_OPENAI_API_KEY: "fake-azure-key",
  },
  bedrock: {
    MODEL_PROVIDER: "bedrock",
    BEDROCK_REGION: "eu-west-2",
    BEDROCK_MODEL_ID: "test-model",
    BEDROCK_API_KEY: "fake-bedrock-key",
    BEDROCK_ENDPOINT: fake.url,
  },
});

const context: ModelCallContext = { tenantId: "t-1", jobId: "j-1", step: "fields" };
const SCHEMA = {
  name: "contract fields",
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["term", "notice"],
    properties: { term: { type: "string" }, notice: { type: "string" } },
  },
};

describe.each(["azure-openai", "bedrock"] as const)("the gateway with %s", (provider) => {
  let gateway: ModelGateway;
  let records: { context: ModelCallContext; record: ModelCallRecord }[];

  beforeEach(() => {
    fake.scenario = "ok";
    fake.requests.length = 0;
    records = [];
    const env = environments()[provider] as NodeJS.ProcessEnv;
    const made = modelGatewayFromEnv(
      env,
      async (ctx, record) => {
        records.push({ context: ctx, record });
      },
      { prices: PRICES, timeoutMs: 200 },
    );
    if (!made) throw new Error("no gateway");
    gateway = made;
  });

  it("is the provider the settings name", () => {
    expect(gateway.provider).toBe(provider);
    expect(gateway.model).toBe("test-model");
  });

  it("answers in text, with tokens and cost, and records the call", async () => {
    const answer = await gateway.complete(context, { system: "Be brief.", user: "Hello" });
    expect(answer).toMatchObject({
      text: FAKE_TEXT,
      inputTokens: FAKE_TOKENS.input,
      outputTokens: FAKE_TOKENS.output,
      provider,
      model: "test-model",
    });
    expect(answer.json).toBeUndefined();
    expect(answer.costUsd).toBeCloseTo(EXPECTED_COST, 10);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      context,
      record: {
        provider,
        model: "test-model",
        outcome: "succeeded",
        errorCode: null,
        inputTokens: FAKE_TOKENS.input,
        outputTokens: FAKE_TOKENS.output,
      },
    });
  });

  it("asks for the schema and answers with the parsed object", async () => {
    const answer = await gateway.complete(context, { user: "A contract", schema: SCHEMA });
    expect(answer.json).toEqual(FAKE_JSON);
    expect(JSON.parse(answer.text)).toEqual(FAKE_JSON);
    // The schema reached the provider in its own format.
    expect(JSON.stringify(fake.requests[0]?.body)).toContain('"required":["term","notice"]');
  });

  it("sends the instructions, the material and the limit, in the provider's fields", async () => {
    await gateway.complete(context, { system: "Be brief.", user: "Hello", maxOutputTokens: 50 });
    const body = fake.requests[0]?.body ?? {};
    const sent = JSON.stringify(body);
    expect(sent).toContain("Be brief.");
    expect(sent).toContain("Hello");
    const limit =
      provider === "azure-openai"
        ? body["max_completion_tokens"]
        : (body["inferenceConfig"] as { maxTokens?: number } | undefined)?.maxTokens;
    expect(limit).toBe(50);
  });

  it("signs in", async () => {
    await gateway.complete(context, { user: "Hello" });
    const headers = fake.requests[0]?.headers ?? {};
    const credential = headers["api-key"] ?? headers["authorization"];
    expect(credential).toMatch(/fake-(azure|bedrock)-key/);
  });

  // Scenario, code, with a schema, and whether the provider billed the answer (a 200).
  it.each<[FakeScenario, ModelErrorCode, boolean, boolean]>([
    ["rate-limited", "model-rate-limited", false, false],
    ["refused", "model-refused", false, provider === "bedrock"],
    ["refused-in-answer", "model-refused", false, true],
    ["malformed", "model-bad-response", false, false],
    ["bad-tokens", "model-bad-response", false, false],
    ["truncated", "model-bad-response", true, true],
    ["no-structured-answer", "model-bad-response", true, true],
    ["server-error", "model-error", false, false],
    ["slow", "model-timeout", false, false],
    ["stalled-body", "model-timeout", false, false],
  ])(
    "turns %s into %s, records it (with any billed tokens), and says nothing the provider said",
    async (scenario, code, withSchema, billed) => {
      fake.scenario = scenario;
      const error = await gateway
        .complete(context, { user: "Hello", ...(withSchema ? { schema: SCHEMA } : {}) })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ModelError);
      expect((error as ModelError).code).toBe(code);
      expect(String((error as Error).message)).not.toContain(PROVIDER_SECRET);
      expect(records).toHaveLength(1);
      expect(records[0]?.record).toMatchObject({
        outcome: "failed",
        errorCode: code,
        inputTokens: billed ? FAKE_TOKENS.input : 0,
        outputTokens: billed ? FAKE_TOKENS.output : 0,
      });
      if (billed) expect(records[0]?.record.costUsd).toBeCloseTo(EXPECTED_COST, 10);
      // Timed out: the provider may still bill it, so unknown. Otherwise not billed: $0.
      else if (code === "model-timeout") expect(records[0]?.record.costUsd).toBeNull();
      else expect(records[0]?.record.costUsd).toBe(0);
    },
  );

  it("keeps the model's reason code if recording the failed call fails", async () => {
    const env = environments()[provider] as NodeJS.ProcessEnv;
    const failing = modelGatewayFromEnv(
      env,
      async () => {
        throw new Error("db down: insert into model_calls values ('secret')");
      },
      { prices: PRICES },
    );
    fake.scenario = "rate-limited";
    const error = await failing?.complete(context, { user: "Hello" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelError);
    expect((error as ModelError).code).toBe("model-rate-limited");
  });

  it("does not hide a failure to record a successful call", async () => {
    const env = environments()[provider] as NodeJS.ProcessEnv;
    const failing = modelGatewayFromEnv(
      env,
      async () => {
        throw new Error("db down");
      },
      { prices: PRICES },
    );
    await expect(failing?.complete(context, { user: "Hello" })).rejects.toThrow("db down");
  });

  it("records no cost for a model with no price", async () => {
    const env = environments()[provider] as NodeJS.ProcessEnv;
    const unpriced = modelGatewayFromEnv(
      env,
      async (_c, record) => void records.push({ context, record }),
      {
        prices: {},
      },
    );
    const answer = await unpriced?.complete(context, { user: "Hello" });
    expect(answer?.costUsd).toBeNull();
    expect(records.at(-1)?.record).toMatchObject({ costUsd: null, inputTokens: FAKE_TOKENS.input });
  });
});

const bedrockBase = {
  MODEL_PROVIDER: "bedrock",
  BEDROCK_REGION: "eu-west-2",
  BEDROCK_MODEL_ID: "m",
  BEDROCK_API_KEY: "k",
};

describe("switching provider", () => {
  it("is only a change of settings", () => {
    const envs = environments();
    const recorder = async () => {};
    const both = { ...envs["azure-openai"], ...envs["bedrock"] };
    expect(
      modelGatewayFromEnv({ ...both, MODEL_PROVIDER: "azure-openai" }, recorder, { prices: {} })
        ?.provider,
    ).toBe("azure-openai");
    expect(
      modelGatewayFromEnv({ ...both, MODEL_PROVIDER: "bedrock" }, recorder, { prices: {} })
        ?.provider,
    ).toBe("bedrock");
  });

  it("has no model when MODEL_PROVIDER is not set", () => {
    expect(modelSettings({})).toBeNull();
    expect(modelGatewayFromEnv({}, async () => {})).toBeNull();
  });

  it.each([
    [{ MODEL_PROVIDER: "openai" }, "must be azure-openai, bedrock or demo"],
    [{ MODEL_PROVIDER: "azure-openai" }, "AZURE_OPENAI_ENDPOINT must be set"],
    [
      {
        MODEL_PROVIDER: "azure-openai",
        AZURE_OPENAI_ENDPOINT: "http://example.com",
        AZURE_OPENAI_DEPLOYMENT: "d",
      },
      "https://",
    ],
    [
      { MODEL_PROVIDER: "bedrock", BEDROCK_REGION: "eu-west-2", BEDROCK_MODEL_ID: "m" },
      "BEDROCK_API_KEY must be set",
    ],
    [{ ...bedrockBase, BEDROCK_REGION: "us-east-1" }, "UK or EU region"],
    [{ ...bedrockBase, BEDROCK_MODEL_ID: "us.vendor.model-v1:0" }, "EU inference profile"],
    [{ ...bedrockBase, BEDROCK_MODEL_ID: "global.vendor.model-v1:0" }, "EU inference profile"],
    [
      { ...bedrockBase, BEDROCK_MODEL_ID: "arn:aws:bedrock:us-east-1:123:inference-profile/x" },
      "EU inference profile",
    ],
    [{ ...bedrockBase, BEDROCK_ENDPOINT: "http://example.com" }, "local address"],
    // The review's S3 cases: each a misconfiguration that once passed.
    [
      { ...bedrockBase, BEDROCK_ENDPOINT: "https://bedrock-runtime.us-east-1.amazonaws.com" },
      "local address",
    ],
    [{ ...bedrockBase, BEDROCK_ENDPOINT: "http://localhost:80@evil.example" }, "local address"],
    [{ ...bedrockBase, BEDROCK_REGION: "eu-central-2" }, "UK or EU region"],
    [
      {
        ...bedrockBase,
        BEDROCK_MODEL_ID: "arn:aws:bedrock:eu-west-1:123:inference-profile/global.vendor.m-v1:0",
      },
      "EU inference profile",
    ],
    // Areas spelt in a way the check does not know: refused, not taken for a model.
    [{ ...bedrockBase, BEDROCK_MODEL_ID: "EU.vendor.model-v1:0" }, "EU inference profile"],
    [{ ...bedrockBase, BEDROCK_MODEL_ID: "us1.vendor.model-v1:0" }, "EU inference profile"],
    [{ ...bedrockBase, BEDROCK_MODEL_ID: "apac2.vendor.model-v1:0" }, "EU inference profile"],
    [
      {
        ...bedrockBase,
        BEDROCK_MODEL_ID: "arn:aws:bedrock:eu-west-1:123:application-inference-profile/abc",
      },
      "EU inference profile",
    ],
    [
      {
        MODEL_PROVIDER: "azure-openai",
        AZURE_OPENAI_ENDPOINT: "https://my-openai.example.com",
        AZURE_OPENAI_DEPLOYMENT: "d",
      },
      "Azure OpenAI",
    ],
    [
      {
        MODEL_PROVIDER: "azure-openai",
        AZURE_OPENAI_ENDPOINT: "http://localhost:80@evil.example",
        AZURE_OPENAI_DEPLOYMENT: "d",
      },
      "Azure OpenAI",
    ],
  ])("refuses incomplete settings %#", (env, message) => {
    expect(() => modelSettings(env)).toThrow(ModelSettingsError);
    expect(() => modelSettings(env)).toThrow(message);
  });

  it.each([
    "eu.vendor.model-v1:0",
    "vendor.model-v1:0",
    "arn:aws:bedrock:eu-west-2:123:inference-profile/eu.vendor.model-v1:0",
    "arn:aws:bedrock:eu-west-2::foundation-model/vendor.model-v1:0",
  ])("accepts the EU Bedrock model %s", (modelId) => {
    expect(() => modelSettings({ ...bedrockBase, BEDROCK_MODEL_ID: modelId })).not.toThrow();
  });

  it("accepts Azure OpenAI's own hosts", () => {
    for (const endpoint of [
      "https://oai-x.openai.azure.com/",
      "https://x.cognitiveservices.azure.com",
    ]) {
      expect(() =>
        modelSettings({
          MODEL_PROVIDER: "azure-openai",
          AZURE_OPENAI_ENDPOINT: endpoint,
          AZURE_OPENAI_DEPLOYMENT: "d",
        }),
      ).not.toThrow();
    }
  });

  it("signs in to Azure OpenAI with a managed identity token when there is no key", async () => {
    const env = { ...environments()["azure-openai"], AZURE_OPENAI_API_KEY: "" };
    fake.scenario = "ok";
    fake.requests.length = 0;
    const gateway = modelGatewayFromEnv(env, async () => {}, {
      prices: {},
      azureToken: async () => "entra-token",
    });
    await gateway?.complete(context, { user: "Hello" });
    expect(fake.requests[0]?.headers["authorization"]).toBe("Bearer entra-token");
    expect(fake.requests[0]?.headers["api-key"]).toBeUndefined();
  });

  it("puts a Bedrock model ID with : in the path safely", async () => {
    fake.scenario = "ok";
    fake.requests.length = 0;
    const env = { ...environments()["bedrock"], BEDROCK_MODEL_ID: "eu.vendor.model-v1:0" };
    await modelGatewayFromEnv(env, async () => {}, { prices: {} })?.complete(context, {
      user: "Hello",
    });
    expect(fake.requests[0]?.path).toBe("/model/eu.vendor.model-v1%3A0/converse");
  });

  it("calls Azure's v1 API by default, or a dated version when one is set", async () => {
    const env = environments()["azure-openai"] as NodeJS.ProcessEnv;
    for (const [version, path, model] of [
      [undefined, "/openai/v1/chat/completions", "summaries"],
      [
        "2024-10-21",
        "/openai/deployments/summaries/chat/completions?api-version=2024-10-21",
        undefined,
      ],
    ] as const) {
      fake.scenario = "ok";
      fake.requests.length = 0;
      await modelGatewayFromEnv(
        { ...env, ...(version ? { AZURE_OPENAI_API_VERSION: version } : {}) },
        async () => {},
        { prices: {} },
      )?.complete(context, { user: "Hello" });
      expect(fake.requests[0]?.path).toBe(path);
      expect(fake.requests[0]?.body["model"]).toBe(model);
    }
  });

  it("gives a schema name the providers accept", async () => {
    fake.scenario = "ok";
    fake.requests.length = 0;
    const env = environments()["azure-openai"] as NodeJS.ProcessEnv;
    await modelGatewayFromEnv(env, async () => {}, { prices: {} })?.complete(context, {
      user: "Hello",
      schema: { ...SCHEMA, name: "contract fields: v2" },
    });
    const format = fake.requests[0]?.body["response_format"] as {
      json_schema: { name: string };
    };
    expect(format.json_schema.name).toBe("contract_fields__v2");
  });

  it("reports an unreachable provider as model-error", async () => {
    const env = { ...environments()["bedrock"], BEDROCK_ENDPOINT: "http://127.0.0.1:1" };
    const gateway = modelGatewayFromEnv(env, async () => {}, { prices: {} });
    await expect(gateway?.complete(context, { user: "Hello" })).rejects.toMatchObject({
      code: "model-error",
    });
  });
});
