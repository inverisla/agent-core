// A deployed agent version's own test run (task 16): the worker runs each new version's
// test set against the deployment's model and records the result for the operator
// console. The same test set and scoring as `pnpm agent:compare`.
import { existsSync } from "node:fs";
import path from "node:path";
import type { LoadedAgent } from "@agent-core/core/agents";
import type { ModelCallRecord, ModelGateway } from "@agent-core/core/models";
import { runTestSet, type CaseRun, type TestCase, type TestRun } from "./run-tests.ts";
import { loadSamples, SAMPLES_DIR } from "./samples.ts";

export { agentSnapshot } from "./snapshot.ts";

/** The demo agent's test set is samples/; every other agent's is its own tests/ folder. */
export const DEMO_AGENT = "contract-summary";

/**
 * An agent's test set: its own `tests/` folder if it has one, `samples/` for the demo
 * agent, or null if it has none.
 */
export function testSetFor(agent: LoadedAgent, samplesDir = SAMPLES_DIR): string | null {
  const own = path.join(agent.dir, "tests");
  if (existsSync(path.join(own, "expected"))) return own;
  if (agent.definition.name === DEMO_AGENT && existsSync(path.join(samplesDir, "expected"))) {
    return samplesDir;
  }
  return null;
}

/** Runs an agent's whole test set, `repeats` times per case. */
export async function runAgentTests(input: {
  agent: LoadedAgent;
  dir: string;
  gateway: ModelGateway;
  calls: ModelCallRecord[];
  repeats: number;
  onCase?: (id: string, run: CaseRun) => void;
}): Promise<TestRun> {
  const cases: TestCase[] = loadSamples(input.dir).map((s) => ({
    id: s.id,
    format: s.format,
    check: s.check,
    file: s.file,
  }));
  return runTestSet({ ...input, cases });
}
