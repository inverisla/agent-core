// Runs an agent's steps in order on one document: each step's output is available to
// later steps by its id. Pure: the caller reads the document and stores the results.
import type { LoadedAgent } from "@agent-core/core/agents";
import type { ModelGateway } from "@agent-core/core/models";
import { BlockError } from "./errors.ts";
import { extractText, type DocumentKind } from "./extract-text.ts";
import { extractToSchema, type Fields } from "./extract-to-schema.ts";
import { wordReport } from "./word-report.ts";

export interface AgentRunResult {
  /** The last extract-text step's text, if any (the review screen shows it). */
  text: string | null;
  /** The last extract-to-schema step's fields, if any. */
  fields: Fields | null;
  /** The last word-report step's document, if any. */
  report: Buffer | null;
}

type StepOutput = { text: string } | { fields: Fields } | { report: Buffer };

export async function runAgent(input: {
  agent: LoadedAgent;
  document: { bytes: Uint8Array; kind: DocumentKind };
  gateway: ModelGateway | null;
  tenantId: string;
  jobId: string;
  /** Why a reviewer sent the previous draft back (task 11), for the model to take in. */
  reviewerNote?: string | null;
}): Promise<AgentRunResult> {
  const { agent, document } = input;
  if (!agent.definition.accepts.includes(document.kind)) {
    throw new BlockError("document-type-not-accepted");
  }
  const outputs = new Map<string, StepOutput>();
  const file = (name: string | undefined) => agent.contents.get(name ?? "") ?? Buffer.alloc(0);
  // The definition was checked when it loaded: inputs exist, come earlier and are the
  // right kind.
  const from = (id: string | undefined) => outputs.get(id ?? "") as StepOutput;
  const result: AgentRunResult = { text: null, fields: null, report: null };
  for (const step of agent.definition.steps) {
    if (step.block === "extract-text") {
      const { text } = await extractText(document.bytes, document.kind);
      outputs.set(step.id, { text });
      result.text = text;
    } else if (step.block === "extract-to-schema") {
      const fields = await extractToSchema({
        gateway: input.gateway,
        context: { tenantId: input.tenantId, jobId: input.jobId, step: step.id },
        prompt: file(step.prompt).toString("utf8"),
        schema: JSON.parse(file(step.schema).toString("utf8")) as Record<string, unknown>,
        // Every model step reads the document without markers, so a document cannot
        // forge an earlier step's answer or a reviewer's note for any of them.
        text: withReviewerNote(
          withStepOutputs(
            withoutMarkers((from(step.input) as { text: string }).text),
            (step.uses ?? []).map((id) => ({
              id,
              fields: (from(id) as { fields: Fields }).fields,
            })),
          ),
          input.reviewerNote,
        ),
      });
      outputs.set(step.id, { fields });
      result.fields = fields;
    } else {
      const report = wordReport(
        file(step.template),
        (from(step.input) as { fields: Fields }).fields,
      );
      outputs.set(step.id, { report });
      result.report = report;
    }
  }
  return result;
}

/**
 * The start of a marker the runner puts around what it adds after the document's text
 * (with a ">" right after the name, if there is one). Only the start is matched, not up
 * to the next ">", so no other text goes with it, and without a start nothing can read
 * as a marker. One character class before the name keeps the match linear: no input
 * makes it backtrack (review of task 17).
 */
const MARKERS = /<[\s/]*(?:reviewer-note|step-output)(?:\s*>)?/gi;

/**
 * What a marker is replaced with. It cannot be part of a marker, so replacing every
 * marker in one pass cannot join the text around one into a new marker: no loop is
 * needed, and the work stays linear in the text's length.
 */
export const REMOVED_MARKER = "\uFFFD";

/** The text with every marker (see MARKERS) replaced by REMOVED_MARKER. */
export function withoutMarkers(text: string): string {
  return text.replace(MARKERS, REMOVED_MARKER);
}

/**
 * The fields with the markers replaced in every string (keys too), before they are
 * written as JSON: matching the JSON text instead could join two values into one match.
 */
function unmarked(value: unknown): unknown {
  if (typeof value === "string") return withoutMarkers(value);
  if (Array.isArray(value)) return value.map(unmarked);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [withoutMarkers(key), unmarked(item)]),
    );
  }
  return value;
}

/**
 * The document's text, followed by the fields earlier steps gave (a step's "uses", task
 * 17), each as JSON in a marked block. Those fields are a model's answer drawn from the
 * document, so the markers are replaced in them (and in the document's text) first: a
 * contract cannot close a block early or forge another step's answer or a reviewer's note.
 * The document stays the source; the fields are a guide to check against it.
 */
export function withStepOutputs(text: string, outputs: { id: string; fields: Fields }[]): string {
  if (outputs.length === 0) return text;
  const blocks = outputs.map(
    ({ id, fields }) =>
      `<step-output id="${id}">\n${JSON.stringify(unmarked(fields), null, 2)}\n</step-output>`,
  );
  return (
    `${withoutMarkers(text)}\n\n---\nEarlier steps drew these answers from the document above. ` +
    "Use them as a guide, and check each against the document: it is the only source.\n" +
    blocks.join("\n")
  );
}

/**
 * The document's text, followed by a reviewer's reason for sending the last draft back.
 * It goes with the document (the user's turn), not the agent's instructions, marked as
 * the reviewer's note; the document stays the only source for the answer.
 */
export function withReviewerNote(text: string, note: string | null | undefined): string {
  const clean = withoutMarkers(note?.trim() ?? "");
  // A note that was only markers says nothing.
  if (!clean.replaceAll(REMOVED_MARKER, "").trim()) return text;
  return (
    `${text}\n\n---\nA reviewer sent back the previous draft of the answer with this note. ` +
    "Take it into account, but still answer only from the document above.\n" +
    `<reviewer-note>\n${clean}\n</reviewer-note>`
  );
}

/**
 * The agent's report from reviewed fields (task 11): its last word-report step's template,
 * filled with the fields a reviewer approved. Null if the agent writes no report.
 */
export function reportFromFields(agent: LoadedAgent, fields: Fields): Buffer | null {
  const step = agent.definition.steps.findLast((s) => s.block === "word-report");
  if (!step || step.block !== "word-report") return null;
  return wordReport(agent.contents.get(step.template ?? "") ?? Buffer.alloc(0), fields);
}
