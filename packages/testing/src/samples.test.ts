// Task 10's done-when: the demo agent runs end to end on every sample contract and
// produces a Word file. The model's answer is the sample's hand-written expected output
// (a real model is run by `pnpm samples:run`); everything else is the real agent.
import { readFileSync } from "node:fs";
import path from "node:path";
import { extractText, runAgent } from "@agent-core/blocks";
import { loadAgent } from "@agent-core/core/agents";
import {
  ModelError,
  modelGatewayFromEnv,
  type ModelGateway,
  type ModelRequest,
} from "@agent-core/core/models";
import { makeTextPdf } from "@agent-core/blocks/testing";
import { describe, expect, it } from "vitest";
import {
  buildSample,
  checkAnswer,
  containsPhrase,
  loadSamples,
  normalise,
  SAMPLES_DIR,
  type FieldCheck,
} from "./samples.ts";
import { buildContractSummaryTemplate, TEMPLATE_PATH } from "./template.ts";

const samples = loadSamples();
const agent = await loadAgent(path.join(SAMPLES_DIR, "..", "agents", "contract-summary"));

/** A gateway that answers with the given fields, and remembers what it was asked. */
function answering(fields: Record<string, unknown>): ModelGateway & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    provider: "azure-openai",
    model: "expected-output",
    requests,
    async complete(_context, request) {
      requests.push(request);
      return {
        text: JSON.stringify(fields),
        json: fields,
        inputTokens: 1,
        outputTokens: 1,
        provider: "azure-openai",
        model: "expected-output",
        durationMs: 1,
        costUsd: null,
      };
    },
  };
}

/** A field's facts (a facts check only), each as the list of ways it may be written. */
const facts = (check: FieldCheck | undefined): string[][] =>
  Array.isArray(check)
    ? check.flatMap((f) =>
        typeof f === "string" ? [[f]] : Array.isArray(f) ? [f as string[]] : [],
      )
    : [];

describe("sample contracts", () => {
  it("are ten, in both formats, each with a source, a file and an expected output", () => {
    expect(samples).toHaveLength(10);
    expect(new Set(samples.map((s) => s.format))).toEqual(new Set(["pdf", "docx"]));
  });

  it.each(samples.map((s) => [s.id, s] as const))(
    "%s: the committed file is up to date with its source",
    (_id, sample) => {
      expect(readFileSync(path.join(SAMPLES_DIR, sample.file)).equals(buildSample(sample))).toBe(
        true,
      );
    },
  );

  it("the demo agent's template is up to date with its builder", () => {
    expect(readFileSync(TEMPLATE_PATH).equals(buildContractSummaryTemplate())).toBe(true);
  });

  it.each(samples.map((s) => [s.id, s] as const))(
    "%s: its expected output passes its own check, and every fact is in the contract",
    async (_id, sample) => {
      expect(checkAnswer(sample.answer, sample.check).filter((r) => !r.ok)).toEqual([]);
      const { text } = await extractText(
        readFileSync(path.join(SAMPLES_DIR, sample.file)),
        sample.format,
      );
      const contract = normalise(text);
      for (const party of sample.check.parties) expect(contract).toContain(normalise(party.name));
      for (const field of ["term", "renewal", "notice", "fees"] as const) {
        for (const fact of facts(sample.check[field])) {
          const ways = fact.map(normalise);
          expect(
            ways.some((w) => containsPhrase(contract, w)),
            `${field}: ${ways.join(" or ")}`,
          ).toBe(true);
        }
      }
    },
  );

  it.each(samples.map((s) => [s.id, s] as const))(
    "%s: the demo agent runs end to end and produces a Word file",
    async (_id, sample) => {
      const gateway = answering(sample.answer);
      const result = await runAgent({
        agent,
        document: { bytes: readFileSync(path.join(SAMPLES_DIR, sample.file)), kind: sample.format },
        gateway,
        tenantId: "samples",
        jobId: "samples",
      });
      expect(result.fields).toEqual(sample.answer);
      // The model was given the contract's text, with the agent's prompt and schema.
      const request = gateway.requests[0];
      expect(request?.user).toContain(sample.check.parties[0]?.name);
      expect(request?.system).toContain("supplier contracts");
      expect(request?.schema?.jsonSchema).toMatchObject({ required: expect.any(Array) });
      // The report is a Word file with every party and every stated field in it.
      expect(result.report?.subarray(0, 2).toString()).toBe("PK");
      const report = (await extractText(result.report ?? Buffer.alloc(0), "docx")).text;
      expect(report).toContain("Contract summary");
      for (const party of sample.check.parties) expect(report).toContain(party.name);
      for (const field of ["term", "renewal", "notice", "fees"] as const) {
        const value = sample.answer[field];
        expect(report).toContain(typeof value === "string" ? value : "Not stated");
      }
      expect(report).not.toMatch(/[{}]/);
    },
  );
});

describe("checking an answer", () => {
  const check = loadSamples().find((s) => s.id === "06-warehousing")?.check;
  it("needs every fact, accepts other ways of writing them, and wants null where nothing is said", () => {
    if (!check) throw new Error("sample missing");
    const good = {
      parties: [
        { name: "Granitebeck Logistics Ltd", role: "Supplier (Granitebeck)" },
        { name: "MAYWEATHER GARDEN GOODS LTD", role: "customer" },
      ],
      term: "1 February 2026 – 31 December 2028",
      renewal: null,
      notice: null,
      fees: "£4.20/pallet/week; £1.15 per line; £7.90 per parcel; minimum £3500 monthly",
    };
    expect(checkAnswer(good, check).every((r) => r.ok)).toBe(true);
    const bad = checkAnswer(
      { ...good, parties: good.parties.slice(0, 1), fees: "£4.20 per pallet", notice: "None." },
      check,
    );
    expect(bad.filter((r) => !r.ok).map((r) => [r.field, r.problem])).toEqual([
      ["parties", "lacks Mayweather Garden Goods Ltd (Customer)"],
      ["notice", "expected null (the document does not say)"],
      ["fees", "lacks £1.15; £7.90; £3,500"],
    ]);
  });
});

describe("normalising text for the checks", () => {
  it("drops every thousands comma, and keeps other commas", () => {
    expect(normalise("£1,234,567 and £4,500, then 1,2")).toBe("£1234567 and £4500, then 1,2");
    expect(normalise("‘90 days’ – “notice”")).toBe("'90 days' - \"notice\"");
  });
});

// Task 15: the demo model, for running the demo without a model account.
describe("the demo model", () => {
  const demo = () => {
    const gateway = modelGatewayFromEnv(
      {
        MODEL_PROVIDER: "demo",
        DATABASE_URL: "postgres://agentcore_app@localhost:5433/agentcore",
        DEMO_SAMPLES_DIR: SAMPLES_DIR,
      },
      async () => {},
    );
    if (!gateway) throw new Error("no gateway");
    return gateway;
  };

  it.each(samples.map((s) => [s.id, s] as const))(
    "%s: recognises the sample's file and answers with its example answer",
    async (_id, sample) => {
      const result = await runAgent({
        agent,
        document: { bytes: readFileSync(path.join(SAMPLES_DIR, sample.file)), kind: sample.format },
        gateway: demo(),
        tenantId: "samples",
        jobId: "samples",
      });
      expect(result.fields).toEqual(sample.answer);
    },
  );

  it("refuses any other document, even one with a sample's title", async () => {
    const lookalike = makeTextPdf([
      [
        "SUPPLY AGREEMENT FOR OFFICE CONSUMABLES",
        "Between Some Other Supplier Ltd and A Different Customer plc.",
      ],
    ]);
    await expect(
      runAgent({
        agent,
        document: { bytes: lookalike, kind: "pdf" },
        gateway: demo(),
        tenantId: "samples",
        jobId: "samples",
      }),
    ).rejects.toMatchObject({ code: "model-demo-unknown" });
    expect(new ModelError("model-demo-unknown").message).toContain("model-demo-unknown");
  });

  it("is refused anywhere but a local machine", () => {
    const recorder = async () => {};
    const local = { MODEL_PROVIDER: "demo", DEMO_SAMPLES_DIR: SAMPLES_DIR };
    for (const env of [
      {
        ...local,
        DATABASE_URL: "postgres://u@pg-agentcore-dev.postgres.database.azure.com/agentcore",
      },
      {
        ...local,
        DATABASE_URL: "postgres://u@localhost/agentcore",
        CONTAINER_APP_NAME: "ca-agentcore-dev-worker",
      },
      {
        ...local,
        DATABASE_URL: "postgres://u@localhost/agentcore",
        CONTAINER_APP_JOB_NAME: "caj-agentcore-dev-migrate",
      },
      // Review S11: a database reached through a local proxy, on a real deployment.
      {
        ...local,
        DATABASE_URL: "postgres://u@localhost/agentcore",
        TEMPORAL_ADDRESS: "eu-west.tmprl.cloud:7233",
      },
      {
        ...local,
        DATABASE_URL: "postgres://u@localhost/agentcore",
        AUTH_URL: "https://portal.example.com",
      },
      { ...local },
    ]) {
      expect(() => modelGatewayFromEnv(env, recorder)).toThrow(/only for running the demo/);
    }
  });
});
