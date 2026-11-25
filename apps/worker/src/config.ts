import { jobTaskQueue, temporalSettings } from "@agent-core/core";
import { notLocalReason } from "@agent-core/core/local";
import { modelSettings, type ModelSettings } from "@agent-core/core/models";

export interface WorkerConfig {
  temporalAddress: string;
  temporalNamespace: string;
  /** Temporal Cloud only. */
  temporalApiKey?: string;
  taskQueue: string;
  /** Lets jobs ask the placeholder agent to fail on purpose. Tests only. */
  allowTestFaults: boolean;
  /** The model settings, checked at start; null if no model is configured. */
  model: ModelSettings | null;
}

export function readConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  const temporal = temporalSettings(env);
  const config: WorkerConfig = {
    temporalAddress: temporal.address,
    temporalNamespace: temporal.namespace,
    ...(temporal.apiKey ? { temporalApiKey: temporal.apiKey } : {}),
    taskQueue: jobTaskQueue(env),
    allowTestFaults: env["ALLOW_TEST_FAULTS"] === "true",
    // Bad model settings stop the worker here, before it connects to anything.
    model: modelSettings(env),
  };
  if (config.allowTestFaults) {
    const reason = notLocalReason({ ...env, TEMPORAL_ADDRESS: config.temporalAddress });
    if (reason)
      throw new Error(`ALLOW_TEST_FAULTS is only allowed on your own machine (${reason}).`);
  }
  return config;
}
