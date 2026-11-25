// What a file really is, from its contents rather than its name or the browser's claim.
// Only PDF and Word (.docx) are accepted.
// Word files go through the same strict zip reader the worker reads them with, so a file
// that passes here is read exactly as it was checked.
import { readZipEntry, zipDirectory, type ZipEntry } from "@agent-core/blocks";

export const PDF = "application/pdf";
export const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export type AcceptedType = typeof PDF | typeof DOCX;

/** A known file kind that is refused with its own message. */
export type KnownRefusal = "protected-or-legacy";

const PDF_MAGIC = Buffer.from("%PDF-", "latin1");
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
// Old .doc files and password-protected .docx files are both OLE compound files.
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

const WORD_MAIN =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const MAX_CONTENT_TYPES_BYTES = 1024 * 1024;

/** [Content_Types].xml, unzipped, if it is no bigger than the cap; null otherwise. */
function contentTypes(bytes: Buffer, entry: ZipEntry): string | null {
  const part = readZipEntry(bytes, entry, MAX_CONTENT_TYPES_BYTES);
  return part && part !== "too-large" ? part.toString("utf8") : null;
}

/**
 * A Word document: a zip whose directory has [Content_Types].xml and word/document.xml,
 * whose content types declare the main part as a Word document (not macro-enabled or a
 * template), with no macro parts and nothing encrypted.
 */
function isDocx(bytes: Buffer): boolean {
  if (!bytes.subarray(0, 4).equals(ZIP_MAGIC)) return false;
  const entries = zipDirectory(bytes);
  if (!entries || entries.some((e) => e.encrypted)) return false;
  const names = new Set(entries.map((e) => e.name));
  if (!names.has("word/document.xml")) return false;
  if (entries.some((e) => /vbaproject|vbadata/i.test(e.name))) return false;
  const contentTypesEntry = entries.find((e) => e.name === "[Content_Types].xml");
  const types = contentTypesEntry ? contentTypes(bytes, contentTypesEntry) : null;
  if (!types || !types.includes(WORD_MAIN)) return false;
  return !/macroEnabled|vbaProject|template\.main\+xml/i.test(types);
}

export function detectType(bytes: Buffer): AcceptedType | KnownRefusal | null {
  if (bytes.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) return PDF;
  if (isDocx(bytes)) return DOCX;
  if (bytes.subarray(0, OLE_MAGIC.length).equals(OLE_MAGIC)) return "protected-or-legacy";
  return null;
}

/**
 * A display name: no path, no control or text-direction characters, at most 200
 * characters, and an extension that matches what the file really is.
 */
export function cleanFilename(name: string, type: AcceptedType): string {
  const extension = type === PDF ? ".pdf" : ".docx";
  const base = (name.split(/[\\/]/).pop() ?? "").replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
  const stem = base.replace(/\.[^.]*$/, "").trim() || "document";
  return (
    Array.from(stem)
      .slice(0, 200 - extension.length)
      .join("") + extension
  );
}
