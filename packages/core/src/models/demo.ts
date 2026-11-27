// The demo model (task 15): for running the demo locally without a model account. It is
// not AI. It recognises the ten sample contracts in samples/ (by their title and first
// party) and answers with an answer recorded for that sample; any other document is
// refused with model-demo-unknown. Answers are found by the title of the schema asked
// for (task 17), so each model step of an agent gets its own: samples/demo/<sample>.json
// maps schema titles to answers, and a title no sample records there gets the sample's
// example answer from samples/expected/ (the contract summary's). It goes through the gateway
// like a real model, so jobs record it as provider "demo". settings.ts refuses it
// anywhere but a local machine.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { ModelError, type ModelAdapter, type ModelAnswer, type ModelRequest } from "./types.ts";

export interface DemoSettings {
  provider: "demo";
  /** The samples folder: sources/*.txt and expected/*.json. */
  samplesDir: string;
}

export const DEMO_MODEL_NAME = "demo-recorded-answers";

interface Sample {
  id: string;
  title: string;
  firstParty: string;
  answer: unknown;
  /** Answers recorded for other schemas, by the schema's title. */
  byTitle: ReadonlyMap<string, unknown>;
}

/** Lower case, letters and digits only, single spaces: PDF and Word text compare alike. */
const normalise = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export function loadDemoSamples(samplesDir: string): Sample[] {
  const expected = path.join(samplesDir, "expected");
  return readdirSync(expected)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => {
      const id = file.replace(/\.json$/, "");
      const { answer } = JSON.parse(readFileSync(path.join(expected, file), "utf8")) as {
        answer: { parties?: { name?: string }[] };
      };
      const source = readFileSync(path.join(samplesDir, "sources", `${id}.txt`), "utf8");
      const title = source.split("\n")[0]?.replace(/^#\s*/, "") ?? "";
      const recorded = path.join(samplesDir, "demo", `${id}.json`);
      const byTitle = new Map<string, unknown>(
        existsSync(recorded)
          ? Object.entries(JSON.parse(readFileSync(recorded, "utf8")) as Record<string, unknown>)
          : [],
      );
      return { id, title, firstParty: answer.parties?.[0]?.name ?? "", answer, byTitle };
    });
}

/**
 * The sample's answer for a schema: the one recorded under its title, or, for a title no
 * sample records, the sample's example answer. A title some sample records but this one
 * does not gets nothing, rather than an answer of the wrong shape.
 */
export function demoAnswer(samples: Sample[], sample: Sample, schemaTitle: unknown): unknown {
  if (typeof schemaTitle === "string" && sample.byTitle.has(schemaTitle)) {
    return sample.byTitle.get(schemaTitle);
  }
  const recordedElsewhere =
    typeof schemaTitle === "string" && samples.some((s) => s.byTitle.has(schemaTitle));
  return recordedElsewhere ? undefined : sample.answer;
}

/** The sample this document is, or undefined: its title and first party must both appear. */
export function recogniseSample(samples: Sample[], documentText: string): Sample | undefined {
  const text = normalise(documentText);
  return samples.find(
    (s) =>
      s.title &&
      s.firstParty &&
      text.includes(normalise(s.title)) &&
      text.includes(normalise(s.firstParty)),
  );
}

export function demoAdapter(settings: DemoSettings): ModelAdapter {
  let samples: Sample[] | undefined;
  return {
    provider: "demo",
    model: DEMO_MODEL_NAME,
    async complete(request: ModelRequest): Promise<ModelAnswer> {
      samples ??= loadDemoSamples(settings.samplesDir);
      const sample = recogniseSample(samples, request.user);
      if (!sample || !request.schema) throw new ModelError("model-demo-unknown");
      const answer = demoAnswer(samples, sample, request.schema.jsonSchema["title"]);
      if (answer === undefined) throw new ModelError("model-demo-unknown");
      const text = JSON.stringify(answer);
      // Rough token counts, so usage pages show something; the demo model costs nothing.
      return {
        text,
        json: answer,
        inputTokens: Math.ceil(((request.system ?? "").length + request.user.length) / 4),
        outputTokens: Math.ceil(text.length / 4),
      };
    },
  };
}
