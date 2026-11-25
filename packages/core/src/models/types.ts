// The model gateway's contract (task 8). Blocks ask for a completion; which provider and
// model answer is configuration. Nothing here carries tenant data beyond the request.

export type ModelProviderName = "azure-openai" | "bedrock" | "demo";

export interface ModelRequest {
  /** Instructions for the model (the agent's prompt). */
  system?: string;
  /** The material to work on (for example a document's text). */
  user: string;
  /**
   * Ask for JSON matching this schema (an object schema). The answer's json is then the
   * parsed object; checking it against the schema is the caller's job (task 9).
   */
  schema?: { name: string; jsonSchema: Record<string, unknown> };
  maxOutputTokens?: number;
  temperature?: number;
}

/** What an adapter returns: the answer and the tokens it took. */
export interface ModelAnswer {
  text: string;
  /** Present when the request had a schema. */
  json?: unknown;
  inputTokens: number;
  outputTokens: number;
}

export interface ModelResponse extends ModelAnswer {
  provider: ModelProviderName;
  model: string;
  durationMs: number;
  /** Estimated from the price list; null if the model has no price. */
  costUsd: number | null;
}

/** One provider's API. Adapters turn every failure into a ModelError. */
export interface ModelAdapter {
  provider: ModelProviderName;
  /** The model's name, as priced and recorded (not the deployment's). */
  model: string;
  complete(request: ModelRequest, signal: AbortSignal): Promise<ModelAnswer>;
}

export const MODEL_ERROR_CODES = [
  "model-rate-limited",
  "model-timeout",
  "model-refused",
  "model-bad-response",
  "model-error",
  // The demo model (demo.ts) only knows the sample contracts.
  "model-demo-unknown",
] as const;
export type ModelErrorCode = (typeof MODEL_ERROR_CODES)[number];

/**
 * A model call that failed. Its message is fixed per code and never quotes the
 * provider's response, the prompt or the document, since it can reach logs and
 * Temporal's history.
 */
export class ModelError extends Error {
  readonly code: ModelErrorCode;
  /** HTTP status from the provider, if any (safe to log). */
  readonly status: number | undefined;
  /**
   * Tokens the provider counted (and bills) for an answer that could not be used, such
   * as one cut off, refused or malformed after a 200. Recorded with the failed call.
   */
  readonly usage: { inputTokens: number; outputTokens: number } | undefined;

  constructor(
    code: ModelErrorCode,
    status?: number,
    usage?: { inputTokens: number; outputTokens: number },
  ) {
    super(`model call failed: ${code}${status ? ` (HTTP ${status})` : ""}`);
    this.name = "ModelError";
    this.code = code;
    this.status = status;
    this.usage = usage;
  }
}

/** What to log for an error from the gateway: the code for model errors, else the name. */
export function describeModelError(error: unknown): string {
  if (error instanceof ModelError) return error.message;
  if (error instanceof Error && error.name === "ModelSettingsError") return error.message;
  return error instanceof Error ? error.name : "unknown error";
}
