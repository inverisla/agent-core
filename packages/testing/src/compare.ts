// Two versions of an agent side by side (task 12): accuracy per field for each, and the
// cases where a field did better or worse, as Markdown (for the GitHub run summary and
// the terminal) and as a standalone HTML page.
import { fieldAccuracy, type Accuracy, type TestRun } from "./run-tests.ts";

export interface FieldComparison {
  field: string;
  base: Accuracy | null;
  current: Accuracy;
}

export interface CaseChange {
  id: string;
  field: string;
  /** Right out of the repeats, for each version. */
  base: number;
  current: number;
  repeats: number;
  /** A problem the current version had with it, if any. */
  problem?: string;
}

export interface Comparison {
  agent: string;
  /** The ref compared with, and whether the agent was the same version there. */
  baseRef?: string;
  sameVersion?: boolean;
  base: TestRun | null;
  current: TestRun;
  fields: FieldComparison[];
  changes: CaseChange[];
}

/** Compares a run of the current version with a run of the base version (if there is one). */
export function compareRuns(
  base: TestRun | null,
  current: TestRun,
  at: { baseRef?: string; sameVersion?: boolean } = {},
): Comparison {
  const now = fieldAccuracy(current);
  const before = base ? fieldAccuracy(base) : new Map();
  const fields = [...new Set([...now.keys(), ...before.keys()])].map((field) => ({
    field,
    base: before.get(field) ?? null,
    current: now.get(field) ?? { right: 0, total: 0 },
  }));
  const changes: CaseChange[] = [];
  if (base) {
    for (const c of current.cases) {
      const old = base.cases.find((b) => b.id === c.id);
      if (!old) continue;
      for (const { field } of fields) {
        const score = (runs: typeof c.runs) =>
          runs.filter((r) => r.checks.find((x) => x.field === field)?.ok).length;
        const was = score(old.runs);
        const is = score(c.runs);
        if (was === is) continue;
        const problem = c.runs
          .flatMap((r) => r.checks)
          .find((x) => x.field === field && !x.ok)?.problem;
        changes.push({
          id: c.id,
          field,
          base: was,
          current: is,
          repeats: c.runs.length,
          ...(problem ? { problem } : {}),
        });
      }
    }
  }
  return { agent: current.agent, ...at, base, current, fields, changes };
}

const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);

/** "97% (29/30)", never rounded up to 100% unless every answer was right; lists add P and R. */
const pct = (t: Accuracy | null) => {
  if (!t || t.total === 0) return "–";
  const share = Math.floor((100 * t.right) / t.total);
  const pr =
    t.precision !== undefined && t.recall !== undefined
      ? `, precision ${t.precision.toFixed(2)}, recall ${t.recall.toFixed(2)}`
      : "";
  return `${share}% (${t.right}/${t.total}${pr})`;
};

/** A Markdown table cell: no pipes or line breaks from case names or problems. */
const cell = (s: string) => s.replaceAll("|", "\\|").replace(/\s+/g, " ");

/** The heading line saying what was compared with what. */
const subject = (c: Comparison) =>
  c.base
    ? `${c.base.version} → ${c.current.version}`
    : c.sameVersion
      ? `${c.current.version}, unchanged at ${c.baseRef ?? "the earlier ref"}, so only the current code was run`
      : `${c.current.version} (no earlier version to compare with)`;

const arrow = (f: FieldComparison) => {
  if (!f.base || f.base.total === 0 || f.current.total === 0) return "";
  const a = f.base.right / f.base.total;
  const b = f.current.right / f.current.total;
  return b > a ? "▲ better" : b < a ? "▼ worse" : "same";
};

const cost = (run: TestRun) =>
  `${run.usage.calls} model calls, ${run.usage.tokens} tokens${
    run.usage.costUsd === null ? "" : `, $${run.usage.costUsd.toFixed(4)}`
  }`;

/** The comparison as Markdown. */
export function comparisonMarkdown(c: Comparison): string {
  const head = `### ${cell(c.agent)}: ${subject(c)}`;
  const lines = [
    head,
    "",
    `Each case run ${times(c.current.repeats)}.`,
    "",
    c.base
      ? `| Field | Before (${c.base.version}) | Now (${c.current.version}) | Change |`
      : `| Field | Now (${c.current.version}) |`,
    c.base ? "| --- | --- | --- | --- |" : "| --- | --- |",
    ...c.fields.map((f) =>
      c.base
        ? `| ${cell(f.field)} | ${pct(f.base)} | ${pct(f.current)} | ${arrow(f)} |`
        : `| ${cell(f.field)} | ${pct(f.current)} |`,
    ),
    "",
  ];
  if (c.base) {
    if (c.changes.length === 0) lines.push("No case changed.", "");
    else {
      lines.push("Cases that changed (right out of the repeats):", "");
      lines.push(
        "| Case | Field | Before | Now | Problem now |",
        "| --- | --- | --- | --- | --- |",
      );
      for (const ch of c.changes) {
        lines.push(
          `| ${cell(ch.id)} | ${cell(ch.field)} | ${ch.base}/${ch.repeats} | ${ch.current}/${ch.repeats} | ${cell(ch.problem ?? "")} |`,
        );
      }
      lines.push("");
    }
    lines.push(`Before: ${cost(c.base)}. Now: ${cost(c.current)}.`, "");
  } else {
    lines.push(cost(c.current), "");
  }
  return lines.join("\n");
}

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string,
  );

/** The comparison as a standalone HTML page (no scripts, no external files). */
export function comparisonHtml(c: Comparison): string {
  const row = (cells: string[], tag = "td") =>
    `<tr>${cells.map((x) => `<${tag}>${esc(x)}</${tag}>`).join("")}</tr>`;
  const fieldsTable = `<table><caption>Accuracy per field</caption><thead>${row(
    c.base
      ? ["Field", `Before (${c.base.version})`, `Now (${c.current.version})`, "Change"]
      : ["Field", `Now (${c.current.version})`],
    "th",
  )}</thead><tbody>${c.fields
    .map((f) =>
      row(c.base ? [f.field, pct(f.base), pct(f.current), arrow(f)] : [f.field, pct(f.current)]),
    )
    .join("")}</tbody></table>`;
  const changes =
    c.base && c.changes.length > 0
      ? `<table><caption>Cases that changed (right out of the repeats)</caption><thead>${row(["Case", "Field", "Before", "Now", "Problem now"], "th")}</thead><tbody>${c.changes
          .map((ch) =>
            row([
              ch.id,
              ch.field,
              `${ch.base}/${ch.repeats}`,
              `${ch.current}/${ch.repeats}`,
              ch.problem ?? "",
            ]),
          )
          .join("")}</tbody></table>`
      : c.base
        ? "<p>No case changed.</p>"
        : "";
  const answers = c.current.cases
    .map(
      (k) =>
        `<details><summary>${esc(k.id)}</summary>${k.runs
          .map(
            (r, i) =>
              `<h3>Run ${i + 1}</h3><pre>${esc(r.error ?? JSON.stringify(r.fields, null, 2))}</pre>${r.checks
                .filter((x) => !x.ok)
                .map((x) => `<p>${esc(`${x.field}: ${x.problem ?? "wrong"}`)}</p>`)
                .join("")}`,
          )
          .join("")}</details>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(c.agent)}: agent comparison</title>
<style>body{font-family:system-ui,sans-serif;margin:2rem auto;max-width:60rem;padding:0 1rem;color:#0f172a}
table{border-collapse:collapse;width:100%;margin:1rem 0}th,td{border:1px solid #64748b;padding:.4rem .6rem;text-align:left}
caption{text-align:left;font-weight:600;margin-bottom:.4rem}pre{white-space:pre-wrap;background:#f8fafc;padding:.6rem}</style>
</head><body><h1>${esc(c.agent)}</h1><p>${esc(
    `${subject(c)}; each case run ${times(c.current.repeats)}.`,
  )}</p>${fieldsTable}${changes}<p>${esc(c.base ? `Before: ${cost(c.base)}. Now: ${cost(c.current)}.` : cost(c.current))}</p>
<h2>Answers (now)</h2>${answers}</body></html>
`;
}
