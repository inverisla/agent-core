// The demo agents' Word templates (agents/contract-summary/template.docx and
// agents/contract-risk/template.docx), made by code so their content shows in review;
// `pnpm samples:build` writes them. A client's own agents use
// templates made in Word: see docs/agents.md for the placeholders.
import path from "node:path";
import { makeDocx, wordParagraph, wordTable } from "@agent-core/blocks/testing";

const AGENTS_DIR = path.join(import.meta.dirname, "..", "..", "..", "agents");
export const TEMPLATE_PATH = path.join(AGENTS_DIR, "contract-summary", "template.docx");
export const RISK_TEMPLATE_PATH = path.join(AGENTS_DIR, "contract-risk", "template.docx");

/** "Not stated" where the agent found nothing (a null field). */
const field = (name: string) => `{${name}}{^${name}}Not stated{/${name}}`;

export function buildContractSummaryTemplate(): Buffer {
  const section = (heading: string, name: string) =>
    wordParagraph(heading, { bold: true, sizePt: 12 }) + wordParagraph(field(name));
  return makeDocx({
    a4: true,
    paragraphs: [],
    rawBody: [
      wordParagraph("Contract summary", { bold: true, sizePt: 18 }),
      wordParagraph("Parties", { bold: true, sizePt: 12 }),
      // One row per party: the loop opens in the row's first cell and closes in its last.
      wordTable([
        ["Party", "Role"],
        ["{#parties}{name}", "{role}{/parties}"],
      ]),
      section("Term", "term"),
      section("Renewal", "renewal"),
      section("Notice", "notice"),
      section("Fees", "fees"),
      wordParagraph(
        "Drafted automatically from the contract's text. Check it against the contract before relying on it.",
        { sizePt: 9 },
      ),
    ].join(""),
  });
}

/** The risk review (task 17): the overall line, then one table row per policy rule. */
export function buildContractRiskTemplate(): Buffer {
  return makeDocx({
    a4: true,
    paragraphs: [],
    rawBody: [
      wordParagraph("Contract risk review", { bold: true, sizePt: 18 }),
      wordParagraph("{overall}"),
      wordParagraph("Findings against the purchasing policy", { bold: true, sizePt: 12 }),
      // One row per finding: the loop opens in the row's first cell and closes in its last.
      wordTable([
        ["Rule", "Result", "What the contract says", "Why"],
        ["{#findings}{rule}", "{result}", field("contract_says"), "{note}{/findings}"],
      ]),
      wordParagraph(
        "Drafted automatically from the contract's text and a sample purchasing policy. Check it against the contract before relying on it.",
        { sizePt: 9 },
      ),
    ].join(""),
  });
}
