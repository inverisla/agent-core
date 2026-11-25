// Prices per model, in US dollars per million tokens, from prices.json. Each call's cost
// is worked out when it is made and stored with it, so later price changes do not alter
// past records. A model with no price is recorded with no cost (tokens are still kept).
import type { ModelAnswer, ModelProviderName } from "./types.ts";
import pricesFile from "./prices.json" with { type: "json" };

export interface ModelPrice {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
}

/** Keyed by "<provider>/<model>", for example "azure-openai/<model name>". */
export type ModelPrices = Record<string, ModelPrice>;

export function priceKey(provider: ModelProviderName, model: string): string {
  return `${provider}/${model}`;
}

/** The checked-in price list. Fill it from the providers' price pages. */
export function defaultPrices(): ModelPrices {
  return checkPrices((pricesFile as { prices: unknown }).prices);
}

/** A price list, checked: "<provider>/<model>" keys and two prices of zero or more. */
export function checkPrices(raw: unknown): ModelPrices {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error('prices.json: "prices" must be an object');
  }
  const prices = raw as ModelPrices;
  for (const [key, price] of Object.entries(prices)) {
    const ok = [price?.inputPerMillionUsd, price?.outputPerMillionUsd].every(
      (n) => typeof n === "number" && Number.isFinite(n) && n >= 0,
    );
    if (!ok || !/^(azure-openai|bedrock)\/.+/.test(key)) {
      throw new Error(`prices.json: "${key}" needs a provider prefix and two prices >= 0`);
    }
  }
  return prices;
}

export function costUsd(
  prices: ModelPrices,
  provider: ModelProviderName,
  model: string,
  answer: Pick<ModelAnswer, "inputTokens" | "outputTokens">,
): number | null {
  const price = prices[priceKey(provider, model)];
  if (!price) return null;
  return (
    (answer.inputTokens * price.inputPerMillionUsd +
      answer.outputTokens * price.outputPerMillionUsd) /
    1_000_000
  );
}
