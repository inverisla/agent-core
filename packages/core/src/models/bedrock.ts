// AWS Bedrock: the Converse API, signed in with a Bedrock API key (no AWS SDK). Structured
// output asks the model to answer through a tool whose input is the schema, and takes
// that tool call's input as the JSON.
import {
  errorForStatus,
  isRecord,
  postJson,
  safeName,
  tokens,
  usageOrNothing,
  type FetchLike,
} from "./http.ts";
import { ModelError, type ModelAdapter, type ModelAnswer, type ModelRequest } from "./types.ts";

export interface BedrockSettings {
  provider: "bedrock";
  /** A UK or EU region, for example eu-west-2. */
  region: string;
  /** A model or inference profile ID, as Bedrock lists it. */
  modelId: string;
  apiKey: string;
  /** Tests only: another base URL instead of https://bedrock-runtime.<region>.amazonaws.com. */
  endpoint?: string;
}

export function bedrockAdapter(
  settings: BedrockSettings,
  deps: { fetch: FetchLike },
): ModelAdapter {
  const base = (
    settings.endpoint ?? `https://bedrock-runtime.${settings.region}.amazonaws.com`
  ).replace(/\/+$/, "");
  const url = `${base}/model/${encodeURIComponent(settings.modelId)}/converse`;
  return {
    provider: "bedrock",
    model: settings.modelId,
    async complete(request: ModelRequest, signal: AbortSignal): Promise<ModelAnswer> {
      const tool = request.schema ? safeName(request.schema.name) : null;
      const inference = {
        ...(request.maxOutputTokens ? { maxTokens: request.maxOutputTokens } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      };
      const body = {
        messages: [{ role: "user", content: [{ text: request.user }] }],
        ...(request.system ? { system: [{ text: request.system }] } : {}),
        ...(Object.keys(inference).length > 0 ? { inferenceConfig: inference } : {}),
        ...(request.schema && tool
          ? {
              toolConfig: {
                tools: [
                  {
                    toolSpec: {
                      name: tool,
                      description: "Give the answer in this form.",
                      inputSchema: { json: request.schema.jsonSchema },
                    },
                  },
                ],
                toolChoice: { tool: { name: tool } },
              },
            }
          : {}),
      };
      const res = await postJson(
        deps.fetch,
        url,
        { authorization: `Bearer ${settings.apiKey}` },
        body,
        signal,
      );
      if (res.status !== 200) throw errorForStatus(res.status);
      if (!isRecord(res.body)) throw new ModelError("model-bad-response");
      const usageBlock = isRecord(res.body["usage"]) ? res.body["usage"] : {};
      // From here the answer was billed: failures carry its tokens.
      const usage = usageOrNothing(usageBlock["inputTokens"], usageBlock["outputTokens"]);
      const fail = (code: "model-refused" | "model-bad-response") =>
        new ModelError(code, undefined, usage);
      const stop = res.body["stopReason"];
      if (stop === "content_filtered" || stop === "guardrail_intervened")
        throw fail("model-refused");
      const output = isRecord(res.body["output"]) ? res.body["output"] : {};
      const message = isRecord(output["message"]) ? output["message"] : {};
      const content = Array.isArray(message["content"]) ? message["content"] : null;
      if (!content) throw fail("model-bad-response");
      const counts = {
        inputTokens: tokens(usageBlock["inputTokens"]),
        outputTokens: tokens(usageBlock["outputTokens"]),
      };
      if (request.schema) {
        if (stop === "max_tokens") throw fail("model-bad-response");
        const call = content.find(
          (block): block is { toolUse: Record<string, unknown> } =>
            isRecord(block) && isRecord(block["toolUse"]) && block["toolUse"]["name"] === tool,
        );
        const input = call?.toolUse["input"];
        if (!isRecord(input)) throw fail("model-bad-response");
        return { text: JSON.stringify(input), json: input, ...counts };
      }
      const text = content
        .map((block) => (isRecord(block) && typeof block["text"] === "string" ? block["text"] : ""))
        .join("");
      return { text, ...counts };
    },
  };
}
