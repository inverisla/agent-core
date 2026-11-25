// Task 12's done-when: two versions of an agent show side by side with accuracy per field.
// A small agent is committed to a throwaway git repository, then changed; the earlier
// version is read back from git and both run the same test set, with a fake model whose
// answer depends on the version's prompt.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeTextPdf } from "@agent-core/blocks/testing";
import { loadAgent } from "@agent-core/core/agents";
import { ModelError, type ModelCallRecord, type ModelGateway } from "@agent-core/core/models";
import { afterAll, describe, expect, it } from "vitest";
import { compareRuns, comparisonHtml, comparisonMarkdown } from "./compare.ts";
import { compareCommand } from "./compare-command.ts";
import { loadAgentAtRef } from "./git-agent.ts";
import { runTestSet, type TestCase } from "./run-tests.ts";
import { checkField, checkProblem, containsPhrase } from "./scoring.ts";
import { loadSamples } from "./samples.ts";

const repo = mkdtempSync(path.join(tmpdir(), "compare-test-"));
afterAll(() => rmSync(repo, { recursive: true, force: true }));
const git = (...args: string[]) =>
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    {
      cwd: repo,
    },
  );

const agentDir = path.join("agents", "demo");
const write = (file: string, content: string | Buffer) => {
  mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  writeFileSync(path.join(repo, file), content);
};
write(
  path.join(agentDir, "agent.json"),
  JSON.stringify({
    name: "demo",
    title: "Demo",
    accepts: ["pdf"],
    steps: [
      { id: "text", block: "extract-text" },
      {
        id: "fields",
        block: "extract-to-schema",
        input: "text",
        prompt: "prompt.md",
        schema: "schema.json",
      },
    ],
  }),
);
write(
  path.join(agentDir, "schema.json"),
  JSON.stringify({
    type: "object",
    additionalProperties: false,
    required: ["term", "fees", "parties"],
    properties: {
      term: { type: ["string", "null"] },
      fees: { type: ["string", "null"] },
      parties: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name"],
          properties: { name: { type: "string" } },
        },
      },
    },
  }),
);

/** The test set: two contracts, with the facts each field must contain. */
const cases: TestCase[] = [
  {
    id: "a",
    format: "pdf",
    file: "files/a.pdf",
    check: { term: ["24 months"], fees: ["£100"], parties: [{ name: "Alpha Ltd" }] },
  },
  {
    id: "b",
    format: "pdf",
    file: "files/b.pdf",
    check: { term: ["12 months"], fees: ["£200"], parties: [{ name: "Beta Ltd" }] },
  },
];
const testsDir = path.join(repo, "tests");
mkdirSync(path.join(testsDir, "files"), { recursive: true });
writeFileSync(
  path.join(testsDir, "files/a.pdf"),
  makeTextPdf([["Alpha Ltd. Term: 24 months. Fees: £100."]]),
);
writeFileSync(
  path.join(testsDir, "files/b.pdf"),
  makeTextPdf([["Beta Ltd. Term: 12 months. Fees: £200."]]),
);

/**
 * A model that reads the version from the prompt: version one misses the term (it gives
 * "13 months", which only a substring match would accept), version two gets it right;
 * both get the fees, and version two invents an extra party in case b.
 */
function fakeModel(calls: ModelCallRecord[]): ModelGateway {
  return {
    provider: "azure-openai",
    model: "fake",
    async complete(_context, request) {
      const doc = request.user;
      const two = (request.system ?? "").includes("VERSION TWO");
      const term = /Term: (\d+ months)/.exec(doc)?.[1] ?? null;
      const fees = /Fees: (£\d+)/.exec(doc)?.[1] ?? null;
      const name = /^(\w+ Ltd)/m.exec(doc)?.[1] ?? "";
      const parties = [{ name }, ...(two && name === "Beta Ltd" ? [{ name: "Gamma Ltd" }] : [])];
      const json = { term: two ? term : `1${term}`, fees, parties };
      calls.push({
        provider: "azure-openai",
        model: "fake",
        outcome: "succeeded",
        errorCode: null,
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0.001,
        durationMs: 1,
      });
      return {
        text: JSON.stringify(json),
        json,
        inputTokens: 10,
        outputTokens: 5,
        provider: "azure-openai",
        model: "fake",
        durationMs: 1,
        costUsd: 0.001,
      };
    },
  };
}

describe("comparing two versions of an agent", () => {
  it("shows both side by side, with accuracy per field and the cases that changed", async () => {
    write(path.join(agentDir, "prompt.md"), "VERSION ONE: fill in the fields.");
    git("init", "-q");
    git("add", ".");
    git("commit", "-q", "-m", "version one");
    write(path.join(agentDir, "prompt.md"), "VERSION TWO: fill in the fields.");

    const before = await loadAgentAtRef(repo, "HEAD", agentDir);
    if (!before) throw new Error("no agent at HEAD");
    const current = await loadAgent(path.join(repo, agentDir));
    expect(before.agent.version).not.toBe(current.version);

    const calls: ModelCallRecord[] = [];
    const gateway = fakeModel(calls);
    const baseRun = await runTestSet({
      agent: before.agent,
      cases,
      dir: testsDir,
      gateway,
      calls,
      repeats: 2,
    });
    const currentRun = await runTestSet({
      agent: current,
      cases,
      dir: testsDir,
      gateway,
      calls,
      repeats: 2,
    });
    before.cleanup();
    const comparison = compareRuns(baseRun, currentRun);

    expect(comparison.fields).toEqual([
      { field: "term", base: { right: 0, total: 4 }, current: { right: 4, total: 4 } },
      { field: "fees", base: { right: 4, total: 4 }, current: { right: 4, total: 4 } },
      {
        field: "parties",
        base: { right: 4, total: 4, precision: 1, recall: 1 },
        // Case b invents a party in version two: precision drops, recall does not.
        current: { right: 2, total: 4, precision: 0.75, recall: 1 },
      },
    ]);
    expect(comparison.changes.map((c) => [c.id, c.field, c.base, c.current])).toEqual([
      ["a", "term", 0, 2],
      ["b", "term", 0, 2],
      ["b", "parties", 2, 0],
    ]);
    expect(comparison.changes.find((c) => c.field === "parties")?.problem).toBe(
      "1 item not expected",
    );

    const markdown = comparisonMarkdown(comparison);
    expect(markdown).toContain(
      `| Field | Before (${before.agent.version}) | Now (${current.version}) | Change |`,
    );
    expect(markdown).toContain("| term | 0% (0/4) | 100% (4/4) | ▲ better |");
    expect(markdown).toContain("| fees | 100% (4/4) | 100% (4/4) | same |");
    expect(markdown).toContain(
      "| parties | 100% (4/4, precision 1.00, recall 1.00) | 50% (2/4, precision 0.75, recall 1.00) | ▼ worse |",
    );
    expect(markdown).toContain("| b | parties | 2/2 | 0/2 | 1 item not expected |");
    expect(markdown).toContain(
      "Before: 4 model calls, 60 tokens, $0.0040. Now: 4 model calls, 60 tokens, $0.0040.",
    );
    const html = comparisonHtml(comparison);
    expect(html).toContain("<caption>Accuracy per field</caption>");
    expect(html).not.toContain("<script");
  });

  it("has no earlier version to compare with when the agent is new, and refuses a bad ref", async () => {
    expect(await loadAgentAtRef(repo, "HEAD", "agents/no-such-agent")).toBeNull();
    await expect(loadAgentAtRef(repo, "--output=/tmp/x", agentDir)).rejects.toThrow(
      /Not a git ref/,
    );
    // A mistyped ref is an error, not "no earlier version".
    await expect(loadAgentAtRef(repo, "orgin/main", agentDir)).rejects.toThrow(/Not a commit/);
  });
});

describe("scoring", () => {
  it("matches whole words only", () => {
    expect(containsPhrase("lasts 13 months", "3 months")).toBe(false);
    expect(containsPhrase("lasts 3 months.", "3 months")).toBe(true);
    expect(containsPhrase("the customers", "customer")).toBe(false);
    expect(containsPhrase("£4,500 a month", "£4500")).toBe(true);
    expect(containsPhrase("rises by 3%.", "3%")).toBe(true);
  });

  it("checks exact values", () => {
    expect(checkField("currency", "GBP", { exact: "gbp" }).ok).toBe(true);
    expect(checkField("currency", "GBP only", { exact: "GBP" }).ok).toBe(false);
    expect(checkField("count", 3, { exact: 3 }).ok).toBe(true);
  });

  it("compares lists item by item, with precision and recall", () => {
    const want = [
      { name: "Alpha Ltd", role: "Supplier" },
      { name: "Beta plc", role: "Customer" },
    ];
    expect(
      checkField(
        "parties",
        [
          { name: "Alpha Ltd", role: "Supplier" },
          { name: "Beta plc", role: "the Customer" },
        ],
        want,
      ),
    ).toEqual({ field: "parties", ok: true, precision: 1, recall: 1 });
    expect(checkField("parties", [{ name: "Alpha Ltd", role: "Supplier" }], want)).toMatchObject({
      ok: false,
      precision: 1,
      recall: 0.5,
      problem: "lacks Beta plc (Customer)",
    });
    expect(
      checkField("parties", [...want, { name: "Gamma LLP", role: "Guarantor" }], want),
    ).toMatchObject({ ok: false, precision: 2 / 3, recall: 1, problem: "1 item not expected" });
    // One answer item cannot stand for two expected items.
    expect(
      checkField("parties", [{ name: "Alpha Ltd", role: "Supplier" }], [want[0], want[0]] as never),
    ).toMatchObject({
      ok: false,
      recall: 0.5,
    });
  });
});

describe("the agent:compare command", () => {
  const out = path.join(repo, "out");
  // The same two cases, as a test set on disk.
  mkdirSync(path.join(testsDir, "expected"), { recursive: true });
  for (const c of cases) {
    writeFileSync(
      path.join(testsDir, "expected", `${c.id}.json`),
      JSON.stringify({ format: c.format, answer: {}, check: c.check }),
    );
  }
  const run = (args: string[], gateway?: ModelGateway) => {
    const calls: ModelCallRecord[] = [];
    return compareCommand(
      ["--", "--agent", "demo", "--tests", testsDir, "--repeats", "1", "--out", out, ...args],
      { root: repo, env: {}, gateway: gateway ?? fakeModel(calls), calls, log: () => {} },
    );
  };

  it('compares the working tree with a ref, taking pnpm\'s "--", and writes the reports', async () => {
    const { code, comparison } = await run(["--base", "HEAD"]);
    expect(code).toBe(0);
    expect(comparison?.base?.version).toBeDefined();
    expect(comparison?.base?.version).not.toBe(comparison?.current.version);
    expect(readFileSync(path.join(out, "report.md"), "utf8")).toContain("▲ better");
    expect(readFileSync(path.join(out, "report.html"), "utf8")).toContain("<caption>");
  });

  it("refuses the demo model, which would score every version 100%", async () => {
    const demo: ModelGateway = {
      provider: "demo",
      model: "demo-recorded-answers",
      complete: () => Promise.reject(new Error("not called")),
    };
    const { code, comparison } = await run(["--base", "HEAD"], demo);
    expect(code).toBe(1);
    expect(comparison).toBeUndefined();
  });

  it("escapes whatever the model answers in the HTML report", async () => {
    const hostile: ModelGateway = {
      provider: "azure-openai",
      model: "fake",
      async complete() {
        const json = { term: "<script>alert(1)</script>", fees: null, parties: [] };
        return {
          text: JSON.stringify(json),
          json,
          inputTokens: 1,
          outputTokens: 1,
          provider: "azure-openai",
          model: "fake",
          durationMs: 1,
          costUsd: null,
        };
      },
    };
    const { code } = await run(["--base", "HEAD"], hostile);
    expect(code).toBe(0);
    const html = readFileSync(path.join(out, "report.html"), "utf8");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("fails on a mistyped ref instead of comparing with nothing", async () => {
    await expect(run(["--base", "orgin/main"])).rejects.toThrow(/Not a commit/);
  });

  it("says when the agent is unchanged at the ref, and runs only the current version", async () => {
    git("add", ".");
    git("commit", "-q", "-m", "version two");
    const { code, comparison } = await run(["--base", "HEAD"]);
    expect(code).toBe(0);
    expect(comparison?.base).toBeNull();
    expect(comparison?.sameVersion).toBe(true);
    const markdown = readFileSync(path.join(out, "report.md"), "utf8");
    expect(markdown).toContain("unchanged at HEAD, so only the current code was run");
    expect(markdown).not.toContain("no earlier version");
  });
});

describe("more scoring", () => {
  it("lets a fact ending in * match any word starting with it, and ends numbers where they end", () => {
    expect(containsPhrase("payable quarterly", "quarter*")).toBe(true);
    expect(containsPhrase("payable quarterly", "quarter")).toBe(false);
    expect(containsPhrase("costs £100.50", "£100")).toBe(false);
    expect(containsPhrase("costs £100.", "£100")).toBe(true);
    expect(containsPhrase("a non‑breaking hyphen", "non-breaking")).toBe(true);
  });

  it("finds the best list match, whatever order the answer gives", () => {
    expect(
      checkField(
        "parties",
        [{ name: "Acme Holdings Ltd" }, { name: "Acme Ltd" }],
        [{ name: "Acme" }, { name: "Acme Holdings" }],
      ),
    ).toEqual({ field: "parties", ok: true, precision: 1, recall: 1 });
  });

  it("refuses a check that is not one of the forms, naming the case and field", () => {
    expect(checkProblem(["24 months", ["a", "b"]])).toBeNull();
    expect(checkProblem([{ name: "Acme" }])).toBeNull();
    expect(checkProblem({ exact: 3 })).toBeNull();
    expect(checkProblem("24 months")).toMatch(/must be/);
    expect(checkProblem({ Exact: 3 })).toMatch(/must be/);
    expect(checkProblem([])).toMatch(/empty/);
    const dir = mkdtempSync(path.join(tmpdir(), "bad-tests-"));
    mkdirSync(path.join(dir, "expected"));
    writeFileSync(
      path.join(dir, "expected", "x.json"),
      JSON.stringify({ format: "pdf", answer: {}, check: { term: "24 months" } }),
    );
    expect(() => loadSamples(dir)).toThrow(/Test case x, field "term"/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("running a test set", () => {
  it("waits and tries again when the model is rate-limited, as the worker's jobs do", async () => {
    let refusals = 2;
    const waits: number[] = [];
    const calls: ModelCallRecord[] = [];
    const busy = fakeModel(calls);
    const gateway: ModelGateway = {
      ...busy,
      async complete(context, request) {
        if (refusals > 0) {
          refusals -= 1;
          throw new ModelError("model-rate-limited", 429);
        }
        return busy.complete(context, request);
      },
    };
    const agent = await loadAgent(path.join(repo, agentDir));
    const run = await runTestSet({
      agent,
      cases: cases.slice(0, 1),
      dir: testsDir,
      gateway,
      calls,
      repeats: 1,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    expect(waits).toEqual([10_000, 20_000]);
    expect(run.cases[0]?.runs[0]?.error).toBeUndefined();
  });
});
