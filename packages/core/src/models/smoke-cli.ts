// pnpm model:smoke: one short call to the configured model, to check the settings and
// sign-in work. Prints the provider, model, tokens and cost; records nothing.
import { describeModelError, modelGatewayFromEnv, modelSettings } from "./index.ts";

if (!modelSettings(process.env)) {
  console.error(
    "No model configured: set MODEL_PROVIDER and its settings in .env.local (docs/models.md).",
  );
  process.exit(1);
}
const gateway = modelGatewayFromEnv(process.env, async () => {});
try {
  const answer = await gateway?.complete(
    { tenantId: "smoke", jobId: "smoke", step: "smoke" },
    { user: "Reply with the single word: ready", maxOutputTokens: 20 },
  );
  console.log(
    `${answer?.provider} ${answer?.model}: "${answer?.text.trim()}" ` +
      `(${answer?.inputTokens} in, ${answer?.outputTokens} out, ` +
      `${answer?.costUsd === null ? "no price in prices.json" : `$${answer?.costUsd.toFixed(6)}`}, ` +
      `${Math.round(answer?.durationMs ?? 0)} ms)`,
  );
} catch (error) {
  console.error(`smoke test failed: ${describeModelError(error)}`);
  process.exit(1);
}
