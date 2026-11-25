// pnpm samples:run: every sample contract through the demo agent with the configured
// model (.env.local, docs/models.md), checked against its expected facts. Writes each
// report and a results file to samples/out/ (not committed) and prints a summary.
// Records nothing in a database. To compare two versions side by side, use
// `pnpm agent:compare` (the "Test agent" workflow runs that against Azure).
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BlockError, runAgent } from "@agent-core/blocks";
import { loadAgent } from "@agent-core/core/agents";
import {
  describeModelError,
  modelGatewayFromEnv,
  type ModelCallRecord,
} from "@agent-core/core/models";
import { checkAnswer, loadSamples, SAMPLES_DIR, type FieldResult } from "./samples.ts";

const gatewayCalls: ModelCallRecord[] = [];
const gateway = modelGatewayFromEnv(process.env, async (_context, record) => {
  gatewayCalls.push(record);
});
if (!gateway) {
  console.error(
    "No model configured: set MODEL_PROVIDER and its settings in .env.local (docs/models.md).",
  );
  process.exit(1);
}
const agent = await loadAgent(path.join(SAMPLES_DIR, "..", "agents", "contract-summary"));
const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const all = loadSamples();
const unknown = only.filter((id) => !all.some((s) => s.id === id));
if (unknown.length > 0) {
  console.error(
    `No such sample: ${unknown.join(", ")}. Samples: ${all.map((s) => s.id).join(", ")}`,
  );
  process.exit(2);
}
const out = path.join(SAMPLES_DIR, "out");
mkdirSync(out, { recursive: true });

interface Result {
  id: string;
  error?: string;
  fields?: Record<string, unknown> | null;
  checks?: FieldResult[];
}
const results: Result[] = [];
console.log(
  `Agent ${agent.definition.name} ${agent.version}; model ${gateway.provider} ${gateway.model}`,
);
for (const sample of all.filter((s) => only.length === 0 || only.includes(s.id))) {
  try {
    const result = await runAgent({
      agent,
      document: { bytes: readFileSync(path.join(SAMPLES_DIR, sample.file)), kind: sample.format },
      gateway,
      tenantId: "samples",
      jobId: sample.id,
    });
    if (result.report) writeFileSync(path.join(out, `${sample.id}.docx`), result.report);
    const checks = checkAnswer(result.fields ?? {}, sample.check);
    results.push({ id: sample.id, fields: result.fields, checks });
    const failed = checks.filter((c) => !c.ok);
    console.log(
      `${failed.length === 0 ? "PASS" : "FAIL"} ${sample.id}` +
        failed.map((c) => `\n     ${c.field}: ${c.problem}`).join(""),
    );
    if (failed.length > 0) console.log(`     answer: ${JSON.stringify(result.fields)}`);
  } catch (error) {
    const message = error instanceof BlockError ? error.code : describeModelError(error);
    results.push({ id: sample.id, error: message });
    console.log(`ERROR ${sample.id}: ${message}`);
  }
}

const fields = ["parties", "term", "renewal", "notice", "fees"];
console.log("\nField     right");
for (const field of fields) {
  const right = results.filter((r) => r.checks?.find((c) => c.field === field)?.ok).length;
  console.log(`${field.padEnd(9)} ${right}/${results.length}`);
}
const tokens = gatewayCalls.reduce((t, c) => t + c.inputTokens + c.outputTokens, 0);
const cost = gatewayCalls.reduce((t, c) => t + (c.costUsd ?? 0), 0);
const priced = gatewayCalls.every((c) => c.costUsd !== null);
console.log(
  `\n${gatewayCalls.length} model calls, ${tokens} tokens` +
    (priced ? `, $${cost.toFixed(4)}` : " (no price in prices.json)"),
);
// In GitHub Actions, the same results on the run's summary page.
const summary = process.env["GITHUB_STEP_SUMMARY"];
if (summary) {
  const mark = (r: Result, field: string) =>
    r.error ? "error" : r.checks?.find((c) => c.field === field)?.ok ? "✓" : "✗";
  appendFileSync(
    summary,
    [
      `### Samples: agent ${agent.version}, ${gateway.provider} ${gateway.model}`,
      "",
      `| Sample | ${fields.join(" | ")} |`,
      `| --- | ${fields.map(() => "---").join(" | ")} |`,
      ...results.map((r) => `| ${r.id} | ${fields.map((f) => mark(r, f)).join(" | ")} |`),
      "",
      `${gatewayCalls.length} model calls, ${tokens} tokens${priced ? `, $${cost.toFixed(4)}` : ""}`,
      "",
    ].join("\n"),
  );
}
writeFileSync(
  path.join(out, "results.json"),
  `${JSON.stringify({ agent: agent.version, model: gateway.model, results, calls: gatewayCalls }, null, 2)}\n`,
);

// A failed check or an error fails the run (and the workflow), so a broken prompt or
// setup never shows as a green tick.
const bad = results.filter((r) => r.error || r.checks?.some((c) => !c.ok)).length;
if (bad > 0) {
  console.log(`\n${bad} of ${results.length} samples failed.`);
  process.exitCode = 1;
}
