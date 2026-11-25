// The gateway: every model call goes through here (CLAUDE.md). It times each call, prices
// it and records it against the tenant, job and agent step, whatever the outcome.
import { costUsd, type ModelPrices } from "./prices.ts";
import {
  ModelError,
  type ModelAdapter,
  type ModelProviderName,
  type ModelRequest,
  type ModelResponse,
} from "./types.ts";

/** Who a call is for: recorded with it. */
export interface ModelCallContext {
  tenantId: string;
  jobId: string;
  /** The agent step making the call. */
  step: string;
}

export interface ModelCallRecord {
  provider: ModelProviderName;
  model: string;
  outcome: "succeeded" | "failed";
  errorCode: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  durationMs: number;
}

/** Stores a call's record (the worker writes it to model_calls). */
export type ModelCallRecorder = (
  context: ModelCallContext,
  record: ModelCallRecord,
) => Promise<void>;

export interface ModelGateway {
  provider: ModelProviderName;
  model: string;
  complete(context: ModelCallContext, request: ModelRequest): Promise<ModelResponse>;
}

export const DEFAULT_MODEL_TIMEOUT_MS = 120_000;

export function createModelGateway(options: {
  adapter: ModelAdapter;
  prices: ModelPrices;
  recorder: ModelCallRecorder;
  timeoutMs?: number;
  now?: () => number;
}): ModelGateway {
  const { adapter, prices, recorder } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS;
  const now = options.now ?? (() => performance.now());
  return {
    provider: adapter.provider,
    model: adapter.model,
    async complete(context, request) {
      const started = now();
      const signal = AbortSignal.timeout(timeoutMs);
      const base = { provider: adapter.provider, model: adapter.model };
      let answer;
      try {
        answer = await adapter.complete(request, signal);
      } catch (error) {
        const failure =
          error instanceof ModelError
            ? error
            : new ModelError(signal.aborted ? "model-timeout" : "model-error");
        // A failed call that was still billed (a 200 refused, cut off or malformed) is
        // recorded with its tokens and cost. One refused or never reached (rate-limited,
        // unreachable) cost nothing: $0, not unknown, so a test run's total still adds up
        // after a rate limit. A timed-out call stays unknown: we stopped waiting, but the
        // provider may have finished it and billed it.
        const usage = failure.usage ?? { inputTokens: 0, outputTokens: 0 };
        try {
          await recorder(context, {
            ...base,
            outcome: "failed",
            errorCode: failure.code,
            ...usage,
            costUsd: failure.usage
              ? costUsd(prices, adapter.provider, adapter.model, usage)
              : failure.code === "model-timeout"
                ? null
                : 0,
            durationMs: now() - started,
          });
        } catch {
          // The model's reason code matters more than the record: keep it, and never let
          // a database error (which can quote values) replace it.
        }
        throw failure;
      }
      const durationMs = now() - started;
      const cost = costUsd(prices, adapter.provider, adapter.model, answer);
      // A failure to record a successful call is not a model error, so it propagates: the
      // attempt fails and Temporal retries it, calling (and paying for) the model again,
      // rather than leaving a call unrecorded.
      await recorder(context, {
        ...base,
        outcome: "succeeded",
        errorCode: null,
        inputTokens: answer.inputTokens,
        outputTokens: answer.outputTokens,
        costUsd: cost,
        durationMs,
      });
      return { ...answer, ...base, durationMs, costUsd: cost };
    },
  };
}
