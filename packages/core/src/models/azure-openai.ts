// Azure OpenAI: the chat completions REST API of a deployment. Structured output uses the
// JSON-schema response format. It signs in with an Entra token: the worker's managed
// identity in Azure, or `az login` locally. An API key works only on accounts that allow
// keys (the Bicep turns them off).
import {
  errorForStatus,
  isRecord,
  parseJsonObject,
  postJson,
  safeName,
  tokens,
  usageOrNothing,
  type FetchLike,
} from "./http.ts";
import { ModelError, type ModelAdapter, type ModelAnswer, type ModelRequest } from "./types.ts";

export interface AzureOpenAiSettings {
  provider: "azure-openai";
  /** https://<resource>.openai.azure.com */
  endpoint: string;
  deployment: string;
  /** The deployed model's name, for prices and records. */
  model: string;
  /** "v1" (Azure's versionless API, which the newer models need) or a dated version. */
  apiVersion: string;
  /** Only for accounts that allow keys (ours do not). */
  apiKey?: string;
}

export const AZURE_OPENAI_API_VERSION = "v1";

/** Fetches a token, giving up when the call's time is up. */
async function tokenWithin(
  token: (signal: AbortSignal) => Promise<string>,
  signal: AbortSignal,
): Promise<string> {
  const aborted = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(new ModelError("model-timeout"));
    signal.addEventListener("abort", () => reject(new ModelError("model-timeout")), { once: true });
  });
  try {
    return await Promise.race([token(signal), aborted]);
  } catch {
    // No detail: a sign-in failure's message can name accounts and tenants.
    throw new ModelError(signal.aborted ? "model-timeout" : "model-error");
  }
}

export function azureOpenAiAdapter(
  settings: AzureOpenAiSettings,
  deps: { fetch: FetchLike; token: (signal: AbortSignal) => Promise<string> },
): ModelAdapter {
  const base = `${settings.endpoint.replace(/\/+$/, "")}/openai`;
  // v1 names the deployment in the body; a dated version names it in the path.
  const v1 = settings.apiVersion === "v1";
  const url = v1
    ? `${base}/v1/chat/completions`
    : `${base}/deployments/${encodeURIComponent(settings.deployment)}/chat/completions` +
      `?api-version=${encodeURIComponent(settings.apiVersion)}`;
  return {
    provider: "azure-openai",
    model: settings.model,
    async complete(request: ModelRequest, signal: AbortSignal): Promise<ModelAnswer> {
      const auth = settings.apiKey
        ? { "api-key": settings.apiKey }
        : { authorization: `Bearer ${await tokenWithin(deps.token, signal)}` };
      const body = {
        ...(v1 ? { model: settings.deployment } : {}),
        messages: [
          ...(request.system ? [{ role: "system", content: request.system }] : []),
          { role: "user", content: request.user },
        ],
        ...(request.maxOutputTokens ? { max_completion_tokens: request.maxOutputTokens } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.schema
          ? {
              response_format: {
                type: "json_schema",
                json_schema: {
                  name: safeName(request.schema.name),
                  schema: request.schema.jsonSchema,
                  strict: true,
                },
              },
            }
          : {}),
      };
      const res = await postJson(deps.fetch, url, auth, body, signal);
      if (res.status !== 200) {
        // Azure's content filter answers 400 with code "content_filter".
        const error = isRecord(res.body) && isRecord(res.body["error"]) ? res.body["error"] : {};
        if (res.status === 400 && error["code"] === "content_filter") {
          throw new ModelError("model-refused", res.status);
        }
        throw errorForStatus(res.status);
      }
      if (!isRecord(res.body)) throw new ModelError("model-bad-response");
      const usageBlock = isRecord(res.body["usage"]) ? res.body["usage"] : {};
      // From here the answer was billed: failures carry its tokens.
      const usage = usageOrNothing(usageBlock["prompt_tokens"], usageBlock["completion_tokens"]);
      const fail = (code: "model-refused" | "model-bad-response") =>
        new ModelError(code, undefined, usage);
      const choice = Array.isArray(res.body["choices"]) ? res.body["choices"][0] : undefined;
      const message = isRecord(choice) && isRecord(choice["message"]) ? choice["message"] : null;
      if (!isRecord(choice) || !message) throw fail("model-bad-response");
      if (choice["finish_reason"] === "content_filter" || typeof message["refusal"] === "string") {
        throw fail("model-refused");
      }
      const text = message["content"];
      if (typeof text !== "string") throw fail("model-bad-response");
      // Cut off by the token limit: a structured answer would be incomplete.
      if (request.schema && choice["finish_reason"] === "length") throw fail("model-bad-response");
      let json: Record<string, unknown> | undefined;
      if (request.schema) {
        try {
          json = parseJsonObject(text);
        } catch {
          throw fail("model-bad-response");
        }
      }
      return {
        text,
        ...(json ? { json } : {}),
        inputTokens: tokens(usageBlock["prompt_tokens"]),
        outputTokens: tokens(usageBlock["completion_tokens"]),
      };
    },
  };
}
