// Which provider and model answer is configuration only: MODEL_PROVIDER and the settings
// for that provider. Switching provider never needs a code change (task 8's done-when).
import {
  AZURE_OPENAI_API_VERSION,
  azureOpenAiAdapter,
  type AzureOpenAiSettings,
} from "./azure-openai.ts";
import { bedrockAdapter, type BedrockSettings } from "./bedrock.ts";
import { demoAdapter, type DemoSettings } from "./demo.ts";
import { notLocalReason } from "../local.ts";
import { existsSync } from "node:fs";
import path from "node:path";
import { createModelGateway, type ModelCallRecorder, type ModelGateway } from "./gateway.ts";
import type { FetchLike } from "./http.ts";
import { defaultPrices, type ModelPrices } from "./prices.ts";
import type { ModelAdapter } from "./types.ts";

export type ModelSettings = AzureOpenAiSettings | BedrockSettings | DemoSettings;

export class ModelSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelSettingsError";
  }
}

/** https, or plain http to this machine only (the tests' fake providers). */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The URL, parsed, or null. Host names are compared parsed, never as text prefixes. */
function parsed(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** A test fake on this machine (http or https), with nothing hidden before the host. */
function isLocal(url: URL): boolean {
  return (
    LOCAL_HOSTS.has(url.hostname) &&
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.username === "" &&
    url.password === ""
  );
}

/** Azure OpenAI's own hosts. Which region answers is the account's setting (data zone EU). */
const AZURE_OPENAI_HOSTS = [".openai.azure.com", ".cognitiveservices.azure.com"];

/**
 * AWS's UK and EU regions (CLAUDE.md: data stays in the UK or EU). Not every "eu-" region:
 * eu-central-2 is Zurich, outside both.
 */
export const BEDROCK_REGIONS = new Set([
  "eu-west-1", // Ireland
  "eu-west-2", // London
  "eu-west-3", // Paris
  "eu-central-1", // Frankfurt
  "eu-north-1", // Stockholm
  "eu-south-1", // Milan
  "eu-south-2", // Spain
]);

/**
 * Whether a Bedrock model ID keeps data in the EU: a plain model, an "eu." inference
 * profile, or an ARN in an allowed region for one of those. Anything else is refused,
 * including application inference profiles, whose regions cannot be told from the ID.
 */
function bedrockModelInEu(modelId: string): boolean {
  const arn = /^arn:aws:bedrock:([a-z0-9-]+):\d*:(foundation-model|inference-profile)\/(.+)$/.exec(
    modelId,
  );
  if (modelId.startsWith("arn:") && !arn) return false;
  const region = arn?.[1];
  if (region !== undefined && !BEDROCK_REGIONS.has(region)) return false;
  const id = arn ? (arn[3] ?? "") : modelId;
  // A model is "provider.name" (with an optional ":version"); a cross-region inference
  // profile puts its area in front ("eu.provider.name"). So anything with a third part
  // is taken for a profile and must start with exactly "eu.": fails closed for an area
  // spelt in a way this check does not know ("EU.", "us1.").
  const parts = (id.split(":")[0] ?? "").split(".");
  if (parts.length >= 3 || arn?.[2] === "inference-profile") return parts[0] === "eu";
  return true;
}

function required(env: NodeJS.ProcessEnv, name: string, provider: string): string {
  const value = env[name]?.trim();
  if (!value)
    throw new ModelSettingsError(`MODEL_PROVIDER is ${provider}, so ${name} must be set.`);
  return value;
}

/** The model settings, or null if MODEL_PROVIDER is not set (no model configured). */
export function modelSettings(env: NodeJS.ProcessEnv): ModelSettings | null {
  const provider = env["MODEL_PROVIDER"]?.trim();
  if (!provider) return null;
  if (provider === "azure-openai") {
    const endpoint = required(env, "AZURE_OPENAI_ENDPOINT", provider);
    const url = parsed(endpoint);
    const azureHost =
      url?.protocol === "https:" &&
      url.username === "" &&
      AZURE_OPENAI_HOSTS.some((h) => url.hostname.endsWith(h));
    if (!url || !(azureHost || isLocal(url))) {
      throw new ModelSettingsError(
        "AZURE_OPENAI_ENDPOINT must be an Azure OpenAI https:// address (…openai.azure.com).",
      );
    }
    const deployment = required(env, "AZURE_OPENAI_DEPLOYMENT", provider);
    const apiKey = env["AZURE_OPENAI_API_KEY"]?.trim();
    return {
      provider,
      endpoint,
      deployment,
      model: env["AZURE_OPENAI_MODEL"]?.trim() || deployment,
      apiVersion: env["AZURE_OPENAI_API_VERSION"]?.trim() || AZURE_OPENAI_API_VERSION,
      ...(apiKey ? { apiKey } : {}),
    };
  }
  if (provider === "bedrock") {
    const region = required(env, "BEDROCK_REGION", provider);
    const modelId = required(env, "BEDROCK_MODEL_ID", provider);
    // Data stays in the UK or EU (CLAUDE.md).
    if (!BEDROCK_REGIONS.has(region)) {
      throw new ModelSettingsError("BEDROCK_REGION must be a UK or EU region, such as eu-west-2.");
    }
    if (!bedrockModelInEu(modelId)) {
      throw new ModelSettingsError(
        "BEDROCK_MODEL_ID must be a model or an EU inference profile (eu.…), so data stays in the EU.",
      );
    }
    // Tests only: a fake on this machine. Bedrock's own address comes from the region.
    const endpoint = env["BEDROCK_ENDPOINT"]?.trim();
    const endpointUrl = endpoint ? parsed(endpoint) : null;
    if (endpoint && !(endpointUrl && isLocal(endpointUrl))) {
      throw new ModelSettingsError(
        "BEDROCK_ENDPOINT is for tests only and must be a local address; leave it unset.",
      );
    }
    return {
      provider,
      region,
      modelId,
      apiKey: required(env, "BEDROCK_API_KEY", provider),
      ...(endpoint ? { endpoint } : {}),
    };
  }
  if (provider === "demo") return demoSettings(env);
  throw new ModelSettingsError(
    `MODEL_PROVIDER must be azure-openai, bedrock or demo, not "${provider}".`,
  );
}

/**
 * The demo model (task 15): only on a developer's own machine (notLocalReason: no hosting
 * platform, and the database, Temporal and the app's address all local).
 */
function demoSettings(env: NodeJS.ProcessEnv): DemoSettings {
  const reason = notLocalReason(env);
  if (reason) {
    throw new ModelSettingsError(
      `MODEL_PROVIDER=demo is only for running the demo on your own machine (${reason}).`,
    );
  }
  return { provider: "demo", samplesDir: findSamplesDir(env) };
}

/** DEMO_SAMPLES_DIR, or the samples folder at or above the current directory. */
function findSamplesDir(env: NodeJS.ProcessEnv): string {
  const configured = env["DEMO_SAMPLES_DIR"];
  if (configured) return path.resolve(/*turbopackIgnore: true*/ configured);
  for (let dir = process.cwd(); ; dir = path.dirname(dir)) {
    const candidate = path.join(/*turbopackIgnore: true*/ dir, "samples");
    if (existsSync(path.join(candidate, "expected"))) return candidate;
    if (path.dirname(dir) === dir) break;
  }
  throw new ModelSettingsError(
    "MODEL_PROVIDER=demo needs the samples folder. Set DEMO_SAMPLES_DIR.",
  );
}

export interface ModelDeps {
  fetch?: FetchLike;
  /** An Entra token for Azure OpenAI (default: the managed identity, or az login locally). */
  azureToken?: (signal: AbortSignal) => Promise<string>;
}

const COGNITIVE_SERVICES_SCOPE = "https://cognitiveservices.azure.com/.default";

/**
 * An Entra token for Azure OpenAI: the managed identity in Azure (AZURE_CLIENT_ID, as the
 * storage client uses), or locally the account signed in with `az login`. A token is kept
 * until five minutes before it expires.
 */
function entraToken(env: NodeJS.ProcessEnv): (signal: AbortSignal) => Promise<string> {
  type Credential = {
    getToken(
      scope: string,
      options: { abortSignal: AbortSignal },
    ): Promise<{ token: string; expiresOnTimestamp: number } | null>;
  };
  let credential: Promise<Credential> | undefined;
  let cached: { token: string; expiresOnTimestamp: number } | undefined;
  return async (signal) => {
    if (cached && cached.expiresOnTimestamp - Date.now() > 5 * 60_000) return cached.token;
    const clientId = env["AZURE_CLIENT_ID"];
    credential ??= import("@azure/identity").then(
      ({ ManagedIdentityCredential, AzureCliCredential }) =>
        clientId ? new ManagedIdentityCredential({ clientId }) : new AzureCliCredential(),
    );
    const token = await (
      await credential
    ).getToken(COGNITIVE_SERVICES_SCOPE, { abortSignal: signal });
    if (!token) {
      throw new ModelSettingsError(
        "No Entra token for Azure OpenAI (managed identity or az login).",
      );
    }
    cached = token;
    return token.token;
  };
}

function createModelAdapter(
  settings: ModelSettings,
  env: NodeJS.ProcessEnv,
  deps: ModelDeps = {},
): ModelAdapter {
  const fetchFn = deps.fetch ?? ((url, init) => fetch(url, init));
  if (settings.provider === "azure-openai") {
    return azureOpenAiAdapter(settings, {
      fetch: fetchFn,
      token: deps.azureToken ?? entraToken(env),
    });
  }
  if (settings.provider === "demo") return demoAdapter(settings);
  return bedrockAdapter(settings, { fetch: fetchFn });
}

/** The gateway as configured by the environment, or null if no model is configured. */
export function modelGatewayFromEnv(
  env: NodeJS.ProcessEnv,
  recorder: ModelCallRecorder,
  options: ModelDeps & { prices?: ModelPrices; timeoutMs?: number } = {},
): ModelGateway | null {
  const settings = modelSettings(env);
  if (!settings) return null;
  return createModelGateway({
    adapter: createModelAdapter(settings, env, options),
    prices: options.prices ?? defaultPrices(),
    recorder,
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  });
}
