// The sample contracts in samples/ (task 10): each is written as plain text in
// samples/sources/, built into a PDF or Word file in samples/files/ by
// `pnpm samples:build`, and has a hand-written expected output in samples/expected/:
// an example answer (what CI gives the agent in place of a model) and the key facts a
// real model's answer must contain. Task 12 builds full scoring on top of this.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { makeDocx, makeTextPdf, wordParagraph, wordTable } from "@agent-core/blocks/testing";
import type { DocumentKind } from "@agent-core/blocks";
import { checkProblem, type CaseCheck } from "./scoring.ts";

export const SAMPLES_DIR = path.join(import.meta.dirname, "..", "..", "..", "samples");

export type { CaseCheck, FieldCheck, FieldResult } from "./scoring.ts";
export { checkAnswer, checkField, containsPhrase, normalise } from "./scoring.ts";

/** The demo agent's checks: its five fields, parties as a list of name and role. */
export interface SampleCheck extends CaseCheck {
  parties: { name: string; role: string }[];
}

export interface Sample {
  id: string;
  format: DocumentKind;
  source: string;
  answer: Record<string, unknown>;
  check: SampleCheck;
  /** The built file, relative to samples/. */
  file: string;
}

export function loadSamples(dir = SAMPLES_DIR): Sample[] {
  return readdirSync(path.join(dir, "expected"))
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const id = f.replace(/\.json$/, "");
      const expected = JSON.parse(readFileSync(path.join(dir, "expected", f), "utf8")) as {
        format: DocumentKind;
        answer: Record<string, unknown>;
        check: SampleCheck;
      };
      for (const [field, check] of Object.entries(expected.check ?? {})) {
        const problem = checkProblem(check);
        if (problem) throw new Error(`Test case ${id}, field "${field}": the check ${problem}.`);
      }
      return {
        id,
        format: expected.format,
        // A test set may hold only documents and expected outputs: sources are for samples
        // built by code.
        source: existsSync(path.join(dir, "sources", `${id}.txt`))
          ? readFileSync(path.join(dir, "sources", `${id}.txt`), "utf8")
          : "",
        answer: expected.answer,
        check: expected.check,
        file: path.join("files", `${id}.${expected.format}`),
      };
    });
}

type Block =
  { kind: "title" | "heading" | "paragraph"; text: string } | { kind: "table"; rows: string[][] };

/** "# " a title, "## " a heading, "| a | b |" table rows; blank lines separate paragraphs. */
export function parseSource(text: string): Block[] {
  const blocks: Block[] = [];
  for (const chunk of text.replace(/\r\n?/g, "\n").split(/\n\s*\n/)) {
    const lines = chunk.split("\n").filter((l) => l.trim() !== "");
    if (lines.length === 0) continue;
    if (lines.every((l) => l.trim().startsWith("|"))) {
      blocks.push({
        kind: "table",
        rows: lines.map((l) =>
          l
            .trim()
            .replace(/^\||\|$/g, "")
            .split("|")
            .map((c) => c.trim()),
        ),
      });
    } else if (lines[0]?.startsWith("# ")) {
      blocks.push({ kind: "title", text: lines.join(" ").slice(2) });
    } else if (lines[0]?.startsWith("## ")) {
      blocks.push({ kind: "heading", text: lines.join(" ").slice(3) });
    } else {
      blocks.push({ kind: "paragraph", text: lines.join(" ") });
    }
  }
  return blocks;
}

const LINE_CHARS = 85;
const PAGE_LINES = 48;

function wrap(text: string, width = LINE_CHARS): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

/** The sample as a PDF: wrapped lines, a blank line between blocks, pages of 48 lines. */
export function buildPdf(blocks: Block[]): Buffer {
  const lines: string[] = [];
  for (const block of blocks) {
    if (block.kind === "table") {
      for (const row of block.rows) lines.push(row.join("    "));
    } else lines.push(...wrap(block.text));
    lines.push("");
  }
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += PAGE_LINES) pages.push(lines.slice(i, i + PAGE_LINES));
  return makeTextPdf(pages);
}

/** The sample as a Word file, with a bold title and headings and real tables. */
export function buildDocx(blocks: Block[]): Buffer {
  const body = blocks
    .map((block) => {
      if (block.kind === "table") return wordTable(block.rows);
      if (block.kind === "title") return wordParagraph(block.text, { bold: true, sizePt: 14 });
      if (block.kind === "heading") return wordParagraph(block.text, { bold: true });
      return wordParagraph(block.text);
    })
    .join("");
  return makeDocx({ paragraphs: [], rawBody: body, a4: true });
}

export function buildSample(sample: Pick<Sample, "source" | "format">): Buffer {
  const blocks = parseSource(sample.source);
  return sample.format === "pdf" ? buildPdf(blocks) : buildDocx(blocks);
}
