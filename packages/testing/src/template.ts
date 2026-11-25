// The demo agent's Word template (agents/contract-summary/template.docx), made by code so
// its content shows in review; `pnpm samples:build` writes it. A client's own agents use
// templates made in Word: see docs/agents.md for the placeholders.
import path from "node:path";
import { makeDocx, wordParagraph, wordTable } from "@agent-core/blocks/testing";

export const TEMPLATE_PATH = path.join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "agents",
  "contract-summary",
  "template.docx",
);

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
