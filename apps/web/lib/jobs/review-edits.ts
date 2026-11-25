// Not a server action: kept apart from review-actions.ts, whose exports are all callable.
import type { FieldEdit } from "@agent-core/db";

/** The changed top-level fields, each with its value before and after. */
export function fieldEdits(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): FieldEdit[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return keys
    .filter((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null))
    .map((k) => ({ field: k, oldValue: before[k] ?? null, newValue: after[k] ?? null }));
}
