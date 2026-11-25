// Tests only: a local stand-in for both providers' APIs (Azure OpenAI chat completions
// and Bedrock Converse), answering in each one's own format. The test picks what the
// next answer is: a normal answer, an error, a refusal, a malformed body or a delay.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type FakeScenario =
  | "ok"
  | "rate-limited"
  | "refused"
  | "refused-in-answer"
  | "malformed"
  | "bad-tokens"
  | "truncated"
  | "no-structured-answer"
  | "server-error"
  | "slow"
  | "stalled-body";

export interface FakeRequest {
  path: string;
  /** Why the real API would refuse this request, or null. */
  problem: string | null;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
}

/** What the fake model "says": the text, or for a schema request the object. */
export const FAKE_TEXT = "Hello from the fake model.";
export const FAKE_JSON = { term: "12 months", notice: "3 months" };
export const FAKE_TOKENS = { input: 120, output: 30 };
/** Put in error bodies, so tests can check it never leaks into errors. */
export const PROVIDER_SECRET = "provider-said-SECRET-detail";

export interface FakeProviders {
  url: string;
  scenario: FakeScenario;
  /** What a request with a schema gets back (FAKE_JSON unless a test sets it). */
  structuredAnswer: Record<string, unknown>;
  /** If set, the scenario applies to this many more requests, then it is back to "ok". */
  scenarioRequests?: number;
  requests: FakeRequest[];
  close(): Promise<void>;
}

const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** What the real Azure API would refuse with a 400, or null. */
function azureProblem(
  path: string,
  headers: IncomingMessage["headers"],
  body: Record<string, unknown>,
) {
  const v1 = path === "/openai/v1/chat/completions";
  if (
    !v1 &&
    !/^\/openai\/deployments\/[^/]+\/chat\/completions\?api-version=\d{4}-\d{2}-\d{2}/.test(path)
  )
    return "path";
  // v1 names the deployment in the body; a dated version must not.
  if (v1 !== (typeof body["model"] === "string" && body["model"] !== "")) return "model";
  if (!headers["api-key"] && !/^Bearer \S+$/.test(String(headers["authorization"] ?? "")))
    return "auth";
  const messages = body["messages"];
  if (!Array.isArray(messages) || messages.length === 0) return "messages";
  for (const m of messages) {
    if (
      !isObj(m) ||
      !["system", "user"].includes(String(m["role"])) ||
      typeof m["content"] !== "string"
    )
      return "message";
  }
  if ("max_tokens" in body) return "max_tokens is not used with these models";
  for (const key of Object.keys(body)) {
    if (
      !["model", "messages", "max_completion_tokens", "temperature", "response_format"].includes(
        key,
      )
    )
      return `field ${key}`;
  }
  const format = body["response_format"];
  if (format !== undefined) {
    const schema = isObj(format) ? format["json_schema"] : undefined;
    if (!isObj(format) || format["type"] !== "json_schema" || !isObj(schema))
      return "response_format";
    if (!NAME.test(String(schema["name"])) || schema["strict"] !== true || !isObj(schema["schema"]))
      return "json_schema";
  }
  return null;
}

function azureAnswer(
  body: Record<string, unknown>,
  scenario: FakeScenario,
  structured: Record<string, unknown>,
) {
  const schema = body["response_format"] !== undefined;
  if (scenario === "rate-limited")
    return [429, { error: { code: "429", message: PROVIDER_SECRET } }];
  if (scenario === "refused")
    return [400, { error: { code: "content_filter", message: PROVIDER_SECRET } }];
  if (scenario === "server-error") return [500, { error: { message: PROVIDER_SECRET } }];
  if (scenario === "malformed") return [200, { choices: "nope" }];
  const usage = {
    prompt_tokens: scenario === "bad-tokens" ? -1 : FAKE_TOKENS.input,
    completion_tokens: FAKE_TOKENS.output,
  };
  if (scenario === "refused-in-answer") {
    return [
      200,
      {
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: null, refusal: PROVIDER_SECRET },
          },
        ],
        usage,
      },
    ];
  }
  const finish = scenario === "truncated" ? "length" : "stop";
  const content =
    scenario === "no-structured-answer"
      ? "not json"
      : schema
        ? JSON.stringify(structured)
        : FAKE_TEXT;
  return [
    200,
    {
      choices: [{ index: 0, finish_reason: finish, message: { role: "assistant", content } }],
      usage,
    },
  ];
}

/** What the real Bedrock API would refuse with a 400, or null. */
function bedrockProblem(
  path: string,
  headers: IncomingMessage["headers"],
  body: Record<string, unknown>,
) {
  // The model ID is one path segment: ":" and "/" in it must be encoded.
  if (!/^\/model\/[^/:]+\/converse$/.test(path)) return "path";
  if (!/^Bearer \S+$/.test(String(headers["authorization"] ?? ""))) return "auth";
  const messages = body["messages"];
  if (!Array.isArray(messages) || messages.length !== 1) return "messages";
  const m = messages[0];
  if (
    !isObj(m) ||
    m["role"] !== "user" ||
    !Array.isArray(m["content"]) ||
    typeof (m["content"][0] as Record<string, unknown>)?.["text"] !== "string"
  )
    return "message";
  const system = body["system"];
  if (
    system !== undefined &&
    (!Array.isArray(system) || !system.every((b) => isObj(b) && typeof b["text"] === "string"))
  )
    return "system";
  const inference = body["inferenceConfig"];
  if (
    inference !== undefined &&
    (!isObj(inference) ||
      Object.keys(inference).some((k) => !["maxTokens", "temperature"].includes(k)))
  )
    return "inferenceConfig";
  for (const key of Object.keys(body)) {
    if (!["messages", "system", "inferenceConfig", "toolConfig"].includes(key))
      return `field ${key}`;
  }
  const tools = body["toolConfig"];
  if (tools !== undefined) {
    const list = isObj(tools) && Array.isArray(tools["tools"]) ? tools["tools"] : [];
    const names = list.map((t) =>
      isObj(t) && isObj(t["toolSpec"]) ? String(t["toolSpec"]["name"]) : "",
    );
    const chosen =
      isObj(tools) && isObj(tools["toolChoice"]) && isObj(tools["toolChoice"]["tool"])
        ? String(tools["toolChoice"]["tool"]["name"])
        : "";
    if (names.length === 0 || !names.every((n) => NAME.test(n)) || !names.includes(chosen))
      return "toolConfig";
    const spec = (list[0] as { toolSpec: Record<string, unknown> }).toolSpec;
    if (!isObj(spec["inputSchema"]) || !isObj(spec["inputSchema"]["json"])) return "inputSchema";
  }
  return null;
}

function bedrockAnswer(
  body: Record<string, unknown>,
  scenario: FakeScenario,
  structured: Record<string, unknown>,
) {
  const toolConfig = body["toolConfig"] as { toolChoice: { tool: { name: string } } } | undefined;
  if (scenario === "rate-limited") return [429, { message: PROVIDER_SECRET }];
  if (scenario === "server-error") return [500, { message: PROVIDER_SECRET }];
  if (scenario === "malformed") return [200, { output: "nope", stopReason: "end_turn" }];
  const usage = {
    inputTokens: scenario === "bad-tokens" ? -1 : FAKE_TOKENS.input,
    outputTokens: FAKE_TOKENS.output,
  };
  const empty = { output: { message: { role: "assistant", content: [] } }, usage };
  if (scenario === "refused") return [200, { ...empty, stopReason: "content_filtered" }];
  if (scenario === "refused-in-answer")
    return [200, { ...empty, stopReason: "guardrail_intervened" }];
  const content =
    toolConfig && scenario !== "no-structured-answer"
      ? [{ toolUse: { toolUseId: "t1", name: toolConfig.toolChoice.tool.name, input: structured } }]
      : [{ text: FAKE_TEXT }];
  return [
    200,
    {
      output: { message: { role: "assistant", content } },
      stopReason: scenario === "truncated" ? "max_tokens" : toolConfig ? "tool_use" : "end_turn",
      usage,
    },
  ];
}

export async function startFakeProviders(): Promise<FakeProviders> {
  const state: FakeProviders = {
    url: "",
    scenario: "ok",
    structuredAnswer: FAKE_JSON,
    requests: [],
    close: async () => {},
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<
        string,
        unknown
      >;
      const path = req.url ?? "";
      const azure = path.includes("/chat/completions");
      const problem = azure
        ? azureProblem(path, req.headers, body)
        : bedrockProblem(path, req.headers, body);
      state.requests.push({ path, problem, headers: req.headers, body });
      const scenario = state.scenario;
      if (state.scenarioRequests !== undefined && --state.scenarioRequests <= 0) {
        state.scenario = "ok";
        delete state.scenarioRequests;
      }
      const respond = () => {
        const [status, answer] = problem
          ? [400, { message: `invalid request: ${problem}` }]
          : azure
            ? azureAnswer(body, scenario, state.structuredAnswer)
            : bedrockAnswer(body, scenario, state.structuredAnswer);
        res.writeHead(status as number, { "content-type": "application/json" });
        if (scenario === "stalled-body" && !problem) {
          res.write(JSON.stringify(answer).slice(0, 10)); // then nothing more
          return;
        }
        res.end(JSON.stringify(answer));
      };
      if (scenario === "slow") setTimeout(respond, 500);
      else respond();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return state;
}
