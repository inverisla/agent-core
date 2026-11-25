// extract-to-schema: a model fills in the agent's schema from the text, through the
// gateway (so every call is recorded), and the answer is checked against the schema.
// One repair attempt tells the model what was wrong; a second miss fails the step.
import type { ModelCallContext, ModelGateway } from "@agent-core/core/models";
import { cleanFields } from "./clean-fields.ts";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { BlockError } from "./errors.ts";

export type Fields = Record<string, unknown>;

const compiled = new Map<string, ValidateFunction>();

/**
 * A validator per schema, each with its own Ajv: one shared instance would refuse a
 * second schema with the same "$id" (two agents can share one). allErrors gives a full
 * list to send back; verbose stays off, so errors carry paths and rules, not values.
 */
function validator(schema: Record<string, unknown>): ValidateFunction {
  const key = JSON.stringify(schema);
  let validate = compiled.get(key);
  if (!validate) {
    validate = new Ajv2020({ strict: false, allErrors: true }).compile(schema);
    compiled.set(key, validate);
  }
  return validate;
}

/** The schema's complaints as short lines, for the repair attempt. */
export function describeSchemaErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .slice(0, 20)
    .map((e) => {
      const extra =
        e.keyword === "additionalProperties"
          ? ` ("${String(e.params["additionalProperty"])}")`
          : "";
      return `- ${e.instancePath || "(the answer)"} ${e.message ?? "is not valid"}${extra}`;
    })
    .join("\n");
}

export async function extractToSchema(input: {
  gateway: ModelGateway | null;
  context: ModelCallContext;
  prompt: string;
  schema: Record<string, unknown>;
  text: string;
  maxOutputTokens?: number;
}): Promise<Fields> {
  if (!input.gateway) throw new BlockError("no-model");
  const validate = validator(input.schema);
  const ask = async (system: string) => {
    const answer = await input.gateway?.complete(input.context, {
      system,
      user: input.text,
      schema: { name: "fields", jsonSchema: input.schema },
      ...(input.maxOutputTokens ? { maxOutputTokens: input.maxOutputTokens } : {}),
    });
    // Cleaned before it is checked, so what is checked is what is saved (a value that was
    // only a page's form feed, say, must still match the schema once removed).
    return cleanFields(answer?.json);
  };
  const first = await ask(input.prompt);
  if (validate(first)) return first as Fields;
  const second = await ask(
    `${input.prompt}\n\nYour previous answer did not match the required form:\n` +
      `${describeSchemaErrors(validate.errors)}\nAnswer again, matching it exactly.`,
  );
  if (validate(second)) return second as Fields;
  throw new BlockError("schema-mismatch");
}
