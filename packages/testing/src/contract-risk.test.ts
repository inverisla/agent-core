// Task 17's done-when, as far as it runs without a real model: the risk review agent
// (agents/contract-risk) runs end to end on every sample contract with the demo model and
// produces a Word file; its test set is the ten samples' files with answers of its own;
// and the demo model's recorded answers fit the schema each step asks for.
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractText, runAgent } from "@agent-core/blocks";
import { checkFields, fieldsSchema, loadAgent, type LoadedAgent } from "@agent-core/core/agents";
import {
  demoAnswer,
  loadDemoSamples,
  modelGatewayFromEnv,
  type ModelGateway,
  type ModelRequest,
} from "@agent-core/core/models";
import { describe, expect, it } from "vitest";
import { testSetFor } from "./agent-tests.ts";
import {
  checkAnswer,
  containsPhrase,
  loadSamples,
  normalise,
  RISK_TESTS_DIR,
  SAMPLES_DIR,
} from "./samples.ts";
import { buildContractRiskTemplate, RISK_TEMPLATE_PATH } from "./template.ts";

const AGENT_DIR = path.join(SAMPLES_DIR, "..", "agents", "contract-risk");
const agent = await loadAgent(AGENT_DIR);
const samples = loadSamples();
const cases = loadSamples(RISK_TESTS_DIR);
const RESULTS = ["meets", "falls short", "missing", "not applicable"];
const RULES = [
  "Payment terms",
  "Liability cap",
  "Insurance",
  "Automatic renewal",
  "Data protection",
];

interface Finding {
  rule: string;
  contract_says: string | null;
  result: string;
  note: string;
}

/** The schema each of the agent's model steps asks for, by its title. */
function stepSchemas(loaded: LoadedAgent): Map<string, Record<string, unknown>> {
  const schemas = new Map<string, Record<string, unknown>>();
  for (const step of loaded.definition.steps) {
    if (step.block !== "extract-to-schema") continue;
    const schema = JSON.parse(
      loaded.contents.get(step.schema ?? "")?.toString("utf8") ?? "{}",
    ) as Record<string, unknown>;
    schemas.set(String(schema["title"]), schema);
  }
  return schemas;
}

const recorded = (id: string) =>
  JSON.parse(readFileSync(path.join(SAMPLES_DIR, "demo", `${id}.json`), "utf8")) as Record<
    string,
    unknown
  >;

/** The demo model, through the real gateway, remembering what it was asked. */
function demo(): ModelGateway & { requests: ModelRequest[] } {
  const gateway = modelGatewayFromEnv(
    {
      MODEL_PROVIDER: "demo",
      DATABASE_URL: "postgres://agentcore_app@localhost:5433/agentcore",
      DEMO_SAMPLES_DIR: SAMPLES_DIR,
    },
    async () => {},
  );
  if (!gateway) throw new Error("no gateway");
  const requests: ModelRequest[] = [];
  return {
    ...gateway,
    requests,
    complete(context, request) {
      requests.push(request);
      return gateway.complete(context, request);
    },
  };
}

describe("the risk review agent's test set", () => {
  it("is the agent's own tests/ folder, with a case for every sample", () => {
    expect(testSetFor(agent)).toBe(RISK_TESTS_DIR);
    expect(cases.map((c) => c.id)).toEqual(samples.map((s) => s.id));
    expect(readdirSync(path.join(RISK_TESTS_DIR, "files")).sort()).toEqual(
      samples.map((s) => path.basename(s.file)).sort(),
    );
  });

  it.each(cases.map((c) => [c.id, c] as const))(
    "%s: its document is the sample's file, as pnpm samples:build copies it",
    (id, testCase) => {
      const sample = samples.find((s) => s.id === id);
      expect(testCase.format).toBe(sample?.format);
      expect(
        readFileSync(path.join(RISK_TESTS_DIR, testCase.file)).equals(
          readFileSync(path.join(SAMPLES_DIR, sample?.file ?? "")),
        ),
      ).toBe(true);
    },
  );

  it.each(cases.map((c) => [c.id, c] as const))(
    "%s: its answer fits the schema, passes its own check, one finding per rule, facts in the contract",
    async (_id, testCase) => {
      const schema = fieldsSchema(agent);
      if (!schema) throw new Error("no schema");
      expect(checkFields(schema, testCase.answer)).toEqual([]);
      expect(checkAnswer(testCase.answer, testCase.check).filter((r) => !r.ok)).toEqual([]);
      const findings = testCase.answer["findings"] as Finding[];
      expect(findings.map((f) => f.rule)).toEqual(RULES);
      for (const f of findings) expect(RESULTS).toContain(f.result);
      // Every finding is checked (at least by its rule), so a missing or invented one
      // counts against the answer.
      const checked = testCase.check["findings"] as Record<string, string>[];
      expect(checked.map((c) => c["rule"])).toEqual(RULES);
      // A check is only fair if the contract says it: each fact checked is in its text.
      const { text } = await extractText(
        readFileSync(path.join(RISK_TESTS_DIR, testCase.file)),
        testCase.format,
      );
      for (const c of checked) {
        if (c["contract_says"]) {
          expect(containsPhrase(normalise(text), c["contract_says"]), c["contract_says"]).toBe(
            true,
          );
        }
      }
    },
  );

  it("tests each result at least once, and leaves some results unchecked (judgements)", () => {
    const results = cases.flatMap((c) =>
      (c.check["findings"] as Record<string, string>[]).map((f) => f["result"]),
    );
    expect(new Set(results)).toEqual(new Set([...RESULTS, undefined]));
  });
});

describe("the demo model's recorded answers for the risk review", () => {
  it.each(samples.map((s) => [s.id] as const))(
    "%s: are recorded for every model step, fit its schema, and match the test set",
    (id) => {
      const answers = recorded(id);
      const schemas = stepSchemas(agent);
      expect(Object.keys(answers).sort()).toEqual([...schemas.keys()].sort());
      for (const [title, schema] of schemas) {
        expect(checkFields(schema, answers[title]), title).toEqual([]);
      }
      // The demo's last answer is the test set's: one source of truth, written twice.
      const fieldsTitle = String(fieldsSchema(agent)?.["title"]);
      expect(answers[fieldsTitle]).toEqual(cases.find((c) => c.id === id)?.answer);
    },
  );

  it("answers each schema by its title, and the summary's from samples/expected", () => {
    const loaded = loadDemoSamples(SAMPLES_DIR);
    const first = loaded[0];
    if (!first) throw new Error("no samples");
    expect(demoAnswer(loaded, first, "Supplier contract risk review")).toEqual(cases[0]?.answer);
    // A title no sample records (the contract summary's, or none) gets the example answer.
    expect(demoAnswer(loaded, first, "Supplier contract summary")).toEqual(samples[0]?.answer);
    expect(demoAnswer(loaded, first, undefined)).toEqual(samples[0]?.answer);
    // A title other samples record, but not this one, gets nothing rather than the summary.
    const without = { ...first, byTitle: new Map() };
    expect(demoAnswer(loaded, without, "Supplier contract risk review")).toBeUndefined();
  });

  it("refuses a step whose schema this sample has no answer for, though others have", async () => {
    // A copy of samples/ where the first contract has no recorded answers of its own.
    const dir = mkdtempSync(path.join(tmpdir(), "demo-samples-"));
    try {
      for (const sub of ["sources", "expected", "demo"]) {
        cpSync(path.join(SAMPLES_DIR, sub), path.join(dir, sub), { recursive: true });
      }
      const [first, second] = samples;
      rmSync(path.join(dir, "demo", `${first?.id}.json`));
      const gateway = modelGatewayFromEnv(
        {
          MODEL_PROVIDER: "demo",
          DATABASE_URL: "postgres://agentcore_app@localhost:5433/agentcore",
          DEMO_SAMPLES_DIR: dir,
        },
        async () => {},
      );
      const ask = async (sample: (typeof samples)[number] | undefined, title: string) => {
        const { text } = await extractText(
          readFileSync(path.join(SAMPLES_DIR, sample?.file ?? "")),
          sample?.format ?? "pdf",
        );
        return gateway?.complete(
          { tenantId: "samples", jobId: "samples", step: "x" },
          { user: text, schema: { name: "fields", jsonSchema: { title } } },
        );
      };
      // Recognised, but with no answer for that title: refused, not given the summary.
      await expect(ask(first, "Supplier contract risk review")).rejects.toMatchObject({
        code: "model-demo-unknown",
      });
      // The same sample still answers the summary, and another sample the risk review.
      await expect(ask(first, "Supplier contract summary")).resolves.toMatchObject({
        json: first?.answer,
      });
      await expect(ask(second, "Supplier contract risk review")).resolves.toMatchObject({
        json: cases[1]?.answer,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the template is up to date with its builder", () => {
    expect(readFileSync(RISK_TEMPLATE_PATH).equals(buildContractRiskTemplate())).toBe(true);
  });

  it.each(samples.map((s) => [s.id, s] as const))(
    "%s: the agent runs end to end with the demo model and produces a Word file",
    async (id, sample) => {
      const gateway = demo();
      const result = await runAgent({
        agent,
        document: { bytes: readFileSync(path.join(SAMPLES_DIR, sample.file)), kind: sample.format },
        gateway,
        tenantId: "samples",
        jobId: "samples",
      });
      const expected = cases.find((c) => c.id === id)?.answer as {
        overall: string;
        findings: Finding[];
      };
      expect(result.fields).toEqual(expected);
      // One model call per model step, each with its own schema and prompt.
      const steps = agent.definition.steps.filter((s) => s.block === "extract-to-schema");
      expect(gateway.requests.map((r) => r.schema?.jsonSchema["title"])).toEqual([
        ...stepSchemas(agent).keys(),
      ]);
      expect(gateway.requests).toHaveLength(steps.length);
      // A step that uses another's fields gets them, marked, after the document's text.
      steps.forEach((step, i) => {
        const user = gateway.requests[i]?.user ?? "";
        for (const used of step.uses ?? []) {
          expect(user).toContain(`<step-output id="${used}">`);
          const party = sample.check.parties[0]?.name ?? "";
          expect(user.indexOf(party)).toBeGreaterThanOrEqual(0);
          expect(user.indexOf(party)).toBeLessThan(user.indexOf("<step-output"));
        }
        if (!step.uses) expect(user).not.toContain("<step-output");
      });
      // The report is a Word file with the overall line and every finding in it.
      expect(result.report?.subarray(0, 2).toString()).toBe("PK");
      const report = (await extractText(result.report ?? Buffer.alloc(0), "docx")).text;
      expect(report).toContain("Contract risk review");
      expect(report).toContain(expected.overall);
      for (const f of expected.findings) {
        expect(report).toContain(f.rule);
        expect(report).toContain(f.result);
        expect(report).toContain(f.contract_says ?? "Not stated");
      }
      expect(report).not.toMatch(/[{}]/);
    },
  );
});
