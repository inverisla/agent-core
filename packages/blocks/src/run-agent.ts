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
        text: withReviewerNote((from(step.input) as { text: string }).text, input.reviewerNote),
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
 * The document's text, followed by a reviewer's reason for sending the last draft back.
 * It goes with the document (the user's turn), not the agent's instructions, marked as
 * the reviewer's note; the document stays the only source for the answer.
 */
export function withReviewerNote(text: string, note: string | null | undefined): string {
  let clean = note?.trim() ?? "";
  // Remove the markers until none are left, so a note cannot build one from pieces.
  for (let before = ""; before !== clean;) {
    before = clean;
    clean = clean.replace(/<\/?reviewer-note>/gi, "");
  }
  if (!clean) return text;
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
