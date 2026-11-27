// The model gateway (task 8): "@agent-core/core/models". Every model call goes through it.
export * from "./types.ts";
export * from "./gateway.ts";
export * from "./prices.ts";
export * from "./settings.ts";
export { AZURE_OPENAI_API_VERSION, type AzureOpenAiSettings } from "./azure-openai.ts";
export type { BedrockSettings } from "./bedrock.ts";
export {
  DEMO_MODEL_NAME,
  demoAdapter,
  demoAnswer,
  loadDemoSamples,
  recogniseSample,
  type DemoSettings,
} from "./demo.ts";
