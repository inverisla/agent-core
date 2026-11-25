// Scoring an agent's answer against a test case's checks, field by field (task 12).
//
// A field's check is one of:
//   - a list of facts the answer must contain, each a string or a list of ways to write
//     it (any one will do), matched as whole words, without case, curly quotes or
//     thousands commas; a fact ending in "*" matches any word starting with it
//     ("quarter*" matches "quarterly");
//   - { "exact": value }: the answer must be exactly this (strings compared as above);
//   - a list of objects ({ "name": …, "role": … }): a list matched item by item, each
//     expected item needing an answer item whose properties contain its values, with
//     precision and recall, so a missing item and an invented one both count;
//   - null: the document says nothing, so the answer must be null too;
//   - "any": not checked.

type Fact = string | string[];
export type FieldCheck = Fact[] | Record<string, string>[] | { exact: unknown } | null | "any";
export type CaseCheck = Record<string, FieldCheck>;

export interface FieldResult {
  field: string;
  ok: boolean;
  /** What was wrong, for the report. */
  problem?: string;
  /** For list checks: matched items over answer items, and over expected items. */
  precision?: number;
  recall?: number;
}

/** Lower case, plain quotes and dashes, no thousands commas, single spaces. */
export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/(\d),(?=\d{3}\b)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether `text` contains `phrase` as whole words: "3 months" is not found in
 * "13 months", nor "customer" in "customers". Both are normalised first.
 */
export function containsPhrase(text: string, phrase: string): boolean {
  const prefix = phrase.trimEnd().endsWith("*");
  const p = normalise(prefix ? phrase.trimEnd().slice(0, -1) : phrase);
  if (!p) return true;
  const before = /^[\p{L}\p{N}]/u.test(p) ? "(?<![\\p{L}\\p{N}])" : "";
  // A word must end where the fact ends, and a number too: "£100" is not "£100.50".
  const after = prefix
    ? ""
    : /\p{N}$/u.test(p)
      ? "(?![\\p{L}\\p{N}]|[.,]\\p{N})"
      : /\p{L}$/u.test(p)
        ? "(?![\\p{L}\\p{N}])"
        : "";
  return new RegExp(`${before}${escape(p)}${after}`, "u").test(normalise(text));
}

const isObjectList = (check: unknown): check is Record<string, string>[] =>
  Array.isArray(check) &&
  check.length > 0 &&
  check.every((c) => c !== null && typeof c === "object" && !Array.isArray(c));

const describe = (fact: Fact) => (Array.isArray(fact) ? fact.join(" or ") : fact);

function checkFacts(field: string, value: unknown, facts: Fact[]): FieldResult {
  if (typeof value !== "string" || value.trim() === "")
    return { field, ok: false, problem: "missing" };
  const missing = facts.filter(
    (fact) => !(Array.isArray(fact) ? fact : [fact]).some((way) => containsPhrase(value, way)),
  );
  return missing.length === 0
    ? { field, ok: true }
    : { field, ok: false, problem: `lacks ${missing.map(describe).join("; ")}` };
}

/** JSON with object keys sorted, so key order does not matter. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

function checkExact(field: string, value: unknown, exact: unknown): FieldResult {
  const same =
    typeof value === "string" && typeof exact === "string"
      ? normalise(value) === normalise(exact)
      : stable(value) === stable(exact);
  return same
    ? { field, ok: true }
    : { field, ok: false, problem: `is not ${JSON.stringify(exact)}` };
}

function checkList(field: string, value: unknown, expected: Record<string, string>[]): FieldResult {
  const items = Array.isArray(value)
    ? (value.filter((v) => v !== null && typeof v === "object") as Record<string, unknown>[])
    : [];
  const matches = (item: Record<string, unknown>, want: Record<string, string>) =>
    Object.entries(want).every(
      ([k, v]) => typeof item[k] === "string" && containsPhrase(item[k] as string, v),
    );
  // The largest matching of expected items to answer items, each used at most once
  // (augmenting paths: the lists are short), so "Acme" and "Acme Holdings" both find
  // their party whatever order the answer lists them in.
  const owner = new Map<number, number>(); // answer item -> expected item
  const assign = (w: number, seen: Set<number>): boolean => {
    const want = expected[w] as Record<string, string>;
    for (let i = 0; i < items.length; i++) {
      if (seen.has(i) || !matches(items[i] as Record<string, unknown>, want)) continue;
      seen.add(i);
      const holder = owner.get(i);
      if (holder === undefined || assign(holder, seen)) {
        owner.set(i, w);
        return true;
      }
    }
    return false;
  };
  const missing = expected.filter((_, w) => !assign(w, new Set()));
  const used = new Set(owner.keys());
  const precision = items.length === 0 ? (expected.length === 0 ? 1 : 0) : used.size / items.length;
  const recall = expected.length === 0 ? 1 : used.size / expected.length;
  const extra = items.length - used.size;
  const problems = [
    ...(missing.length > 0
      ? [
          `lacks ${missing.map((m) => Object.values(m).join(" (") + (Object.keys(m).length > 1 ? ")" : "")).join("; ")}`,
        ]
      : []),
    ...(extra > 0 ? [`${extra} item${extra === 1 ? "" : "s"} not expected`] : []),
  ];
  return problems.length === 0
    ? { field, ok: true, precision, recall }
    : { field, ok: false, problem: problems.join("; "), precision, recall };
}

/** One field's answer against its check. */
export function checkField(field: string, value: unknown, check: FieldCheck): FieldResult {
  if (check === "any") return { field, ok: true };
  if (check === null) {
    return value === null || value === undefined
      ? { field, ok: true }
      : { field, ok: false, problem: "expected null (the document does not say)" };
  }
  if (!Array.isArray(check)) return checkExact(field, value, check.exact);
  if (isObjectList(check)) return checkList(field, value, check);
  return checkFacts(field, value, check as Fact[]);
}

/** Every checked field of an answer, in the check's order. */
export function checkAnswer(answer: Record<string, unknown>, check: CaseCheck): FieldResult[] {
  return Object.entries(check).map(([field, c]) => checkField(field, answer[field], c));
}

const isFact = (f: unknown) =>
  typeof f === "string" ||
  (Array.isArray(f) && f.length > 0 && f.every((w) => typeof w === "string"));

/**
 * What is wrong with a field's check, or null if it is one of the forms above. Test sets
 * are written by hand, so loading one checks every check with this.
 */
export function checkProblem(check: unknown): string | null {
  if (check === null || check === "any") return null;
  if (Array.isArray(check)) {
    if (check.length === 0) return 'an empty list checks nothing: use "any"';
    if (check.every(isFact)) return null;
    const objects = check.every(
      (c) =>
        c !== null &&
        typeof c === "object" &&
        !Array.isArray(c) &&
        Object.values(c).every((v) => typeof v === "string"),
    );
    return objects
      ? null
      : "a list must hold facts (strings, or lists of strings) or objects of strings";
  }
  if (check && typeof check === "object" && Object.keys(check).join() === "exact") return null;
  return 'must be a list of facts, a list of objects, { "exact": value }, null or "any"';
}
