// Runs a test set against one version of an agent (task 12): every case, several times
// (a model's answers vary from run to run), each answer scored field by field.
import { readFileSync } from "node:fs";
import path from "node:path";
import { BlockError, runAgent, type DocumentKind } from "@agent-core/blocks";
import type { LoadedAgent } from "@agent-core/core/agents";
import {
  describeModelError,
  ModelError,
  type ModelCallRecord,
  type ModelGateway,
} from "@agent-core/core/models";
import { checkAnswer, type CaseCheck, type FieldResult } from "./scoring.ts";

/** Waits after a rate limit: 10 s, 20 s, 40 s, then 60 s, up to 8 tries in all. */
export const RETRY_WAITS_MS = [10_000, 20_000, 40_000, 60_000, 60_000, 60_000, 60_000];

async function withRetries<T>(
  work: () => Promise<T>,
  sleep: (ms: number) => Promise<void>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      const wait = RETRY_WAITS_MS[attempt];
      const limited = error instanceof ModelError && error.code === "model-rate-limited";
      if (!limited || wait === undefined) throw error;
      await sleep(wait);
    }
  }
}

export interface TestCase {
  id: string;
  format: DocumentKind;
  check: CaseCheck;
  /** The document, relative to the test set's folder. */
  file: string;
}

export interface CaseRun {
  /** The fields the agent gave, or the reason code it failed with. */
  fields?: Record<string, unknown> | null;
  error?: string;
  checks: FieldResult[];
}

export interface TestRun {
  agent: string;
  version: string;
  repeats: number;
  cases: { id: string; runs: CaseRun[] }[];
  /** What the model calls cost. */
  usage: { calls: number; tokens: number; costUsd: number | null };
}

/**
 * Runs each case `repeats` times. A case whose run fails counts every checked field as
 * wrong. `calls` is the list the gateway's recorder adds to, for counting this run's
 * model calls.
 */
export async function runTestSet(input: {
  agent: LoadedAgent;
  cases: TestCase[];
  dir: string;
  gateway: ModelGateway;
  calls: ModelCallRecord[];
  repeats?: number;
  onCase?: (id: string, run: CaseRun) => void;
  /** Tests only: waiting between retries (default: really wait). */
  sleep?: (ms: number) => Promise<void>;
}): Promise<TestRun> {
  const repeats = input.repeats ?? 3;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const firstCall = input.calls.length;
  const cases: TestRun["cases"] = [];
  for (const testCase of input.cases) {
    const bytes = readFileSync(path.join(input.dir, testCase.file));
    const runs: CaseRun[] = [];
    for (let r = 0; r < repeats; r++) {
      let run: CaseRun;
      try {
        // A deployment's tokens-per-minute limit is easily reached by a test set run in a
        // row: a rate-limited run waits and tries again, as the worker's jobs do.
        const result = await withRetries(
          () =>
            runAgent({
              agent: input.agent,
              document: { bytes, kind: testCase.format },
              gateway: input.gateway,
              tenantId: "tests",
              jobId: `${testCase.id}-${r + 1}`,
            }),
          sleep,
        );
        run = { fields: result.fields, checks: checkAnswer(result.fields ?? {}, testCase.check) };
      } catch (error) {
        const code = error instanceof BlockError ? error.code : describeModelError(error);
        run = {
          error: code,
          checks: Object.keys(testCase.check).map((field) => ({ field, ok: false, problem: code })),
        };
      }
      runs.push(run);
      input.onCase?.(testCase.id, run);
    }
    cases.push({ id: testCase.id, runs });
  }
  const calls = input.calls.slice(firstCall);
  const priced = calls.every((c) => c.costUsd !== null);
  return {
    agent: input.agent.definition.name,
    version: input.agent.version,
    repeats,
    cases,
    usage: {
      calls: calls.length,
      tokens: calls.reduce((t, c) => t + c.inputTokens + c.outputTokens, 0),
      costUsd: priced ? calls.reduce((t, c) => t + (c.costUsd ?? 0), 0) : null,
    },
  };
}

export interface Accuracy {
  right: number;
  total: number;
  /** List fields only: mean precision and recall over every case and repeat. */
  precision?: number;
  recall?: number;
}

/** How often each field was right, over every case and repeat. */
export function fieldAccuracy(run: TestRun): Map<string, Accuracy> {
  const out = new Map<string, Accuracy & { lists: number; p: number; r: number }>();
  for (const c of run.cases) {
    for (const r of c.runs) {
      for (const check of r.checks) {
        const tally = out.get(check.field) ?? { right: 0, total: 0, lists: 0, p: 0, r: 0 };
        tally.total += 1;
        if (check.ok) tally.right += 1;
        if (check.precision !== undefined && check.recall !== undefined) {
          tally.lists += 1;
          tally.p += check.precision;
          tally.r += check.recall;
        }
        out.set(check.field, tally);
      }
    }
  }
  return new Map(
    [...out].map(([field, t]) => [
      field,
      {
        right: t.right,
        total: t.total,
        ...(t.lists > 0 ? { precision: t.p / t.lists, recall: t.r / t.lists } : {}),
      },
    ]),
  );
}

/** Right answers out of every checked field, over all cases and repeats (0 to 1). */
export function overallAccuracy(run: TestRun): number | null {
  let right = 0;
  let total = 0;
  for (const a of fieldAccuracy(run).values()) {
    right += a.right;
    total += a.total;
  }
  return total === 0 ? null : right / total;
}
