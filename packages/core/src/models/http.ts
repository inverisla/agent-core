// Shared HTTP handling for the adapters. Provider responses are read only for the fields
// the adapters need; nothing from them reaches an error message.
import { ModelError } from "./types.ts";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export async function postJson(
  fetchFn: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
): Promise<{ status: number; body: unknown }> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch {
    throw new ModelError(signal.aborted ? "model-timeout" : "model-error");
  }
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    if (signal.aborted) throw new ModelError("model-timeout");
  }
  return { status: res.status, body: parsed };
}

/** The code for an HTTP failure the adapter has no more specific reading of. */
export function errorForStatus(status: number): ModelError {
  if (status === 429) return new ModelError("model-rate-limited", status);
  if (status === 408 || status === 504) return new ModelError("model-timeout", status);
  return new ModelError("model-error", status);
}

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A token count from a provider: a whole number of zero or more, or the answer is bad. */
export function tokens(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  throw new ModelError("model-bad-response");
}

/** Parses a JSON answer to a request with a schema; it must be an object. */
export function parseJsonObject(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ModelError("model-bad-response");
  }
  if (!isRecord(value)) throw new ModelError("model-bad-response");
  return value;
}

/** A name the providers accept for a schema or tool: letters, digits, _ and -, 1 to 64. */
export function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "answer";
}

/** Token counts, or undefined if the provider gave none we can trust. */
export function usageOrNothing(
  input: unknown,
  output: unknown,
): { inputTokens: number; outputTokens: number } | undefined {
  try {
    return { inputTokens: tokens(input), outputTokens: tokens(output) };
  } catch {
    return undefined;
  }
}
