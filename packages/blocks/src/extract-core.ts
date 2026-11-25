// The reading itself, run in a worker thread with memory and time limits (see
// extract-text.ts), since a small file can expand into a huge one: a Word file's zipped
// XML, or a PDF's compressed streams. Plain functions with no shared state.
import { extractText as pdfText, getDocumentProxy } from "unpdf";
import { readZipEntry, zipDirectory } from "./zip.ts";

export type DocumentKind = "pdf" | "docx";

export interface ExtractedText {
  text: string;
  /** PDFs only. */
  pages?: number;
}

/** A failure the caller turns into a BlockError (threads pass plain values). */
export class ExtractFailure extends Error {
  readonly code: "unreadable-document" | "document-too-large";
  constructor(code: "unreadable-document" | "document-too-large" = "unreadable-document") {
    super(code);
    this.code = code;
  }
}

/** How much a document may unpack to, checked while it is read. */
export interface ReadLimits {
  /** One part of a Word file, unzipped. */
  maxPartBytes: number;
  /** All the Word parts read, together. */
  maxTotalBytes: number;
  /** A PDF's pages. */
  maxPages: number;
}

export async function readDocument(
  bytes: Uint8Array,
  kind: DocumentKind,
  limits: ReadLimits,
): Promise<ExtractedText> {
  const result = kind === "pdf" ? await fromPdf(bytes, limits) : fromDocx(bytes, limits);
  return { ...result, text: tidy(result.text) };
}

/** Pages are separated by a blank line and a form feed, so later steps can tell. */
async function fromPdf(bytes: Uint8Array, limits: ReadLimits): Promise<ExtractedText> {
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;
  try {
    // A copy: pdf.js takes ownership of the buffer. No warnings on the console: they can
    // quote names from the document.
    pdf = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
    if (pdf.numPages > limits.maxPages) throw new ExtractFailure("document-too-large");
    const { totalPages, text } = await pdfText(pdf, { mergePages: false });
    return { text: text.map((page) => page.trim()).join("\n\n\f\n\n"), pages: totalPages };
  } catch (error) {
    if (error instanceof ExtractFailure) throw error;
    // Damaged, encrypted, or not a PDF at all.
    throw new ExtractFailure();
  } finally {
    await pdf?.loadingTask.destroy().catch(() => {});
  }
}

/** Headers and footers together that a Word file may have. */
export const MAX_HEADER_FOOTER_PARTS = 64;

/** Natural order, so header10 comes after header2. */
const partNumber = (name: string) => Number(/(\d+)\.xml$/.exec(name)?.[1] ?? 0);

/**
 * The body, headers and footers of a Word file, read through the strict zip reader: only
 * these parts are ever unzipped, each and all of them within the limits.
 */
function fromDocx(bytes: Uint8Array, limits: ReadLimits): ExtractedText {
  const entries = zipDirectory(bytes);
  if (!entries) throw new ExtractFailure();
  // The first entry of each name, as the upload check takes it.
  const byName = new Map<string, (typeof entries)[number]>();
  for (const e of entries) if (!byName.has(e.name)) byName.set(e.name, e);
  let total = 0;
  const read = (name: string): string => {
    const entry = byName.get(name);
    if (!entry) throw new ExtractFailure();
    const part = readZipEntry(
      bytes,
      entry,
      Math.min(limits.maxPartBytes, limits.maxTotalBytes - total),
    );
    if (part === "too-large") throw new ExtractFailure("document-too-large");
    if (!part) throw new ExtractFailure();
    total += part.length;
    return wordXmlText(part.toString("utf8"));
  };
  const names = [...byName.keys()];
  const byNumber = (re: RegExp) =>
    names.filter((n) => re.test(n)).sort((a, b) => partNumber(a) - partNumber(b));
  const headers = byNumber(/^word\/header\d*\.xml$/);
  const footers = byNumber(/^word\/footer\d*\.xml$/);
  // Word writes at most three of each per section; thousands are an attack on time.
  if (headers.length + footers.length > MAX_HEADER_FOOTER_PARTS) {
    throw new ExtractFailure("document-too-large");
  }
  const body = read("word/document.xml");
  return {
    text: [...headers.map(read), body, ...footers.map(read)]
      .filter((t) => t.trim() !== "")
      .join("\n\n"),
  };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** A character XML allows, or U+FFFD for one it does not (or a reference out of range). */
function xmlChar(code: number): string {
  const ok =
    code === 0x9 ||
    code === 0xa ||
    code === 0xd ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff);
  return ok ? String.fromCodePoint(code) : "�";
}

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, entity: string) => {
    if (entity.startsWith("#x")) return xmlChar(parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return xmlChar(parseInt(entity.slice(1), 10));
    return ENTITIES[entity] ?? whole;
  });
}

/**
 * Elements whose content is not the document's current text: the VML copy Word saves
 * beside each text box (mc:Fallback, read once via mc:Choice), the old place of moved
 * text, and deleted text.
 */
const SKIPPED = new Set(["mc:Fallback", "w:moveFrom", "w:del"]);

/**
 * The text of a WordprocessingML part: the runs' text (w:t, not deleted text or field
 * codes), with tabs and breaks, a line per paragraph and table row, and a tab between
 * table cells.
 */
export function wordXmlText(xml: string): string {
  let out = "";
  let inText = false;
  let inRun = 0;
  let skipped = 0;
  const tokens = /<(\/?)([A-Za-z][\w:.-]*)([^>]*?)(\/?)>|([^<]+)/g;
  for (const m of xml.matchAll(tokens)) {
    const [, closing, name, , selfClosing, text] = m;
    if (text !== undefined) {
      if (inText && skipped === 0) out += decode(text);
      continue;
    }
    if (name && SKIPPED.has(name) && !selfClosing) {
      skipped += closing ? -1 : 1;
      continue;
    }
    if (skipped > 0) continue;
    if (name === "w:r" && !selfClosing) inRun += closing ? -1 : 1;
    else if (name === "w:t") inText = !closing && !selfClosing;
    // In a run only: in paragraph settings, w:tab is a tab stop, not a tab.
    else if (name === "w:tab" && !closing && inRun > 0) out += "\t";
    else if (name === "w:noBreakHyphen" && !closing && inRun > 0) out += "-";
    else if ((name === "w:br" || name === "w:cr") && !closing && inRun > 0) out += "\n";
    else if (name === "w:p" && (closing || selfClosing)) out += "\n";
    // A cell's last paragraph ends with the cell, and a row's last cell with the row.
    else if (name === "w:tc" && closing) out = `${out.replace(/\n$/, "")}\t`;
    else if (name === "w:tr" && closing) out = `${out.replace(/\t$/, "")}\n`;
  }
  return out;
}

/**
 * Line endings and spacing made regular, and control characters removed (keeping tab,
 * line feed and the page marker): Postgres cannot store NUL, and models do not need them.
 */
export function tidy(text: string): string {
  return (
    text
      .replace(/\r\n?/g, "\n")
      // eslint-disable-next-line no-control-regex -- removing control characters is the point
      .replace(/[\u0000-\u0008\u000B\u000E-\u001F\u007F]/g, "")
      .split("\n")
      .map((line) => line.replace(/[ \t]+$/g, ""))
      .join("\n")
      .replace(/\n{3,}(?!\f)/g, "\n\n")
      .trim()
  );
}
