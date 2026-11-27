// The agent:compare command as a function, so the tests can run it: pnpm agent:compare
// -- --agent contract-summary [--base origin/main] [--tests samples] [--repeats 3]
// [--out test-results/agent-compare]. See compare-cli.ts.
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadAgent } from "@agent-core/core/agents";
import {
  modelGatewayFromEnv,
  type ModelCallRecord,
  type ModelGateway,
} from "@agent-core/core/models";
import { compareRuns, comparisonHtml, comparisonMarkdown, type Comparison } from "./compare.ts";
import { loadAgentAtRef } from "./git-agent.ts";
import { runTestSet, type CaseRun, type TestCase } from "./run-tests.ts";
import { loadSamples } from "./samples.ts";

export interface CompareDeps {
  /** The repository root (agents/ and the test sets are under it). */
  root: string;
  env: NodeJS.ProcessEnv;
  /** Tests only: a gateway in place of the configured model. */
  gateway?: ModelGateway;
  calls?: ModelCallRecord[];
  log?: (line: string) => void;
}

/** Runs the comparison; returns the exit code and, if it got that far, the comparison. */
export async function compareCommand(
  argv: string[],
  deps: CompareDeps,
): Promise<{ code: number; comparison?: Comparison }> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const { values } = parseArgs({
    // pnpm passes on the "--" that separates its own arguments from the script's.
    args: argv.filter((a) => a !== "--"),
    options: {
      agent: { type: "string", default: "contract-summary" },
      base: { type: "string", default: "origin/main" },
      tests: { type: "string" },
      repeats: { type: "string", default: "3" },
      out: { type: "string", default: "test-results/agent-compare" },
    },
    allowPositionals: false,
  });
  const name = values.agent;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`Not an agent name: ${name}`);
  const repeats = Number(values.repeats);
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) {
    throw new Error("--repeats must be a whole number from 1 to 10.");
  }
  const { root } = deps;
  const agentDir = path.posix.join("agents", name);
  // The agent's own test set, or the one named; the demo agent's is samples/.
  const testsDir = path.resolve(
    root,
    values.tests ??
      (existsSync(path.join(root, agentDir, "tests"))
        ? path.join(agentDir, "tests")
        : name === "contract-summary"
          ? "samples"
          : path.join(agentDir, "tests")),
  );
  if (!existsSync(path.join(testsDir, "expected"))) {
    throw new Error(
      `No test set at ${path.relative(root, testsDir) || "."} (it needs expected/ and files/).`,
    );
  }

  const calls = deps.calls ?? [];
  const gateway =
    deps.gateway ??
    modelGatewayFromEnv(deps.env, async (_context, record) => {
      calls.push(record);
    });
  if (!gateway) {
    log("No model configured: set MODEL_PROVIDER and its settings in .env.local (docs/models.md).");
    return { code: 1 };
  }
  if (gateway.provider === "demo") {
    // It only repeats the recorded answers, so every version would score 100%.
    log(
      "The demo model cannot compare versions: it answers with the answers recorded in samples/, whatever the prompt says. Set up a real model (docs/models.md).",
    );
    return { code: 1 };
  }

  const cases: TestCase[] = loadSamples(testsDir).map((s) => ({
    id: s.id,
    format: s.format,
    check: s.check,
    file: s.file,
  }));
  const current = await loadAgent(path.join(root, agentDir));
  const before = await loadAgentAtRef(root, values.base, agentDir);
  let errors = 0;
  const progress = (version: string) => (id: string, run: CaseRun) => {
    if (run.error) errors += 1;
    const wrong = run.checks.filter((c) => !c.ok).length;
    log(
      `${version} ${id}: ${run.error ? `error ${run.error}` : wrong === 0 ? "all right" : `${wrong} wrong`}`,
    );
  };
  log(
    `${name}: ${cases.length} cases, ${repeats} runs each, ${gateway.provider} ${gateway.model}; ` +
      `now ${current.version}, ${values.base} ${before ? before.agent.version : "has no such agent"}`,
  );
  try {
    const sameVersion = before?.agent.version === current.version;
    const baseRun =
      before && !sameVersion
        ? await runTestSet({
            agent: before.agent,
            cases,
            dir: testsDir,
            gateway,
            calls,
            repeats,
            onCase: progress(before.agent.version),
          })
        : null;
    const currentRun = await runTestSet({
      agent: current,
      cases,
      dir: testsDir,
      gateway,
      calls,
      repeats,
      onCase: progress(current.version),
    });
    const comparison = compareRuns(baseRun, currentRun, { baseRef: values.base, sameVersion });
    const markdown = comparisonMarkdown(comparison);
    // A fresh folder: no report from an earlier run left beside this one.
    const out = path.resolve(root, values.out);
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, "report.md"), markdown);
    writeFileSync(path.join(out, "report.html"), comparisonHtml(comparison));
    writeFileSync(path.join(out, "results.json"), `${JSON.stringify(comparison, null, 2)}\n`);
    log(`\n${markdown}`);
    const summary = deps.env["GITHUB_STEP_SUMMARY"];
    if (summary) appendFileSync(summary, `${markdown}\n`);
    if (errors > 0) {
      log(`${errors} runs failed (see above): the comparison is incomplete.`);
      return { code: 1, comparison };
    }
    return { code: 0, comparison };
  } finally {
    before?.cleanup();
  }
}
