// The worker's model gateway: configured by the environment (see
// packages/core/src/models/settings.ts), with every call recorded in model_calls against
// the tenant, job and agent step, inside the tenant's context.
import {
  modelGatewayFromEnv,
  type ModelCallRecorder,
  type ModelGateway,
} from "@agent-core/core/models";
import { recordModelCall, type TenantDatabase } from "@agent-core/db";

export function modelCallRecorder(db: TenantDatabase): ModelCallRecorder {
  return (context, record) =>
    recordModelCall(db, context.tenantId, {
      jobId: context.jobId,
      step: context.step,
      ...record,
    });
}

/** The gateway, or null if no model is configured (MODEL_PROVIDER not set). */
export function workerModelGateway(
  db: TenantDatabase,
  env: NodeJS.ProcessEnv,
): ModelGateway | null {
  return modelGatewayFromEnv(env, modelCallRecorder(db));
}
