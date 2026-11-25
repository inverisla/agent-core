import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadAgent, type LoadedAgent } from "@agent-core/core/agents";
import { modelGatewayFromEnv, type ModelGateway } from "@agent-core/core/models";
import { describe, expect, it } from "vitest";
import { agentSnapshot, runAgentTests, testSetFor } from "./agent-tests.ts";
import { loadSamples, SAMPLES_DIR } from "./samples.ts";

const agent = await loadAgent(path.join(SAMPLES_DIR, "..", "agents", "contract-summary"));

describe("a deployed agent's own test run", () => {
  it("finds the demo agent's test set in samples/, and none for an agent without one", () => {
    expect(testSetFor(agent)).toBe(SAMPLES_DIR);
    const other: LoadedAgent = {
      ...agent,
      definition: { ...agent.definition, name: "other" },
      dir: mkdtempSync(path.join(tmpdir(), "agent-")),
    };
    expect(testSetFor(other)).toBeNull();
    mkdirSync(path.join(other.dir, "tests", "expected"), { recursive: true });
    expect(testSetFor(other)).toBe(path.join(other.dir, "tests"));
    // The demo agent's own tests/ folder, if it had one, would come first.
    expect(testSetFor(agent, path.join(tmpdir(), "no-samples-here"))).toBeNull();
  });

  it("keeps agent.json and the text of the prompt and schema, and only the template's size", () => {
    const snapshot = agentSnapshot(agent);
    expect(snapshot.definition).toEqual(agent.definition);
    expect(snapshot.files.map((f) => f.path)).toEqual(agent.files);
    const prompt = snapshot.files.find((f) => f.path.endsWith(".md"));
    expect(prompt?.text).toBe(agent.contents.get(prompt?.path ?? "")?.toString("utf8"));
    const template = snapshot.files.find((f) => f.path.endsWith(".docx"));
    expect(template).toMatchObject({ text: null });
    expect(template?.bytes).toBeGreaterThan(0);
  });

  it("runs every case of the test set, as many times as asked", async () => {
    const expected = new Map(loadSamples().map((s) => [s.id, s]));
    // The demo model answers each sample with its recorded answer.
    const demo = modelGatewayFromEnv(
      {
        MODEL_PROVIDER: "demo",
        DATABASE_URL: "postgres://agentcore_app@localhost:5433/agentcore",
        DEMO_SAMPLES_DIR: SAMPLES_DIR,
      },
      async () => {},
    );
    if (!demo) throw new Error("no demo model");
    let n = 0;
    const gateway: ModelGateway = {
      ...demo,
      complete: (...args) => {
        n += 1;
        return demo.complete(...args);
      },
    };
    const run = await runAgentTests({ agent, dir: SAMPLES_DIR, gateway, calls: [], repeats: 2 });
    expect(run.cases.map((c) => c.id)).toEqual([...expected.keys()]);
    expect(run.cases.every((c) => c.runs.length === 2)).toBe(true);
    expect(n).toBe(expected.size * 2);
    // Every run answered, and the recorded answers pass their own checks.
    expect(run.cases.flatMap((c) => c.runs).every((r) => !r.error)).toBe(true);
    expect(run.cases.flatMap((c) => c.runs.flatMap((r) => r.checks)).every((c) => c.ok)).toBe(true);
  });
});
