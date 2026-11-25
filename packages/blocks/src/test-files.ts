// Small synthetic documents, made by code so every case is explicit: for tests, and for
// building the sample contracts in samples/ (packages/testing). The parties are invented.
import { crc32, deflateRawSync, deflateSync } from "node:zlib";
import PizZip from "pizzip";

/** WinAnsi codes for the characters it has beyond Latin-1. */
const WIN_ANSI: Record<string, number> = {
  "€": 0x80,
  "‚": 0x82,
  "„": 0x84,
  "…": 0x85,
  "‘": 0x91,
  "’": 0x92,
  "“": 0x93,
  "”": 0x94,
  "•": 0x95,
  "–": 0x96,
  "—": 0x97,
  "™": 0x99,
};

/**
 * Text for a PDF string: escaped, in WinAnsi (written out as Latin-1 bytes), so é, £, €
 * and curly quotes work.
 */
function pdfString(text: string): string {
  const escaped = text.replace(/[\\()]/g, (c) => `\\${c}`);
  return `(${[...escaped]
    .map((c) => {
      if (c.charCodeAt(0) <= 0xff) return c;
      const code = WIN_ANSI[c];
      // Helvetica's WinAnsi has no other characters: refuse, rather than write a wrong one.
      if (code === undefined) throw new Error(`No WinAnsi code for ${JSON.stringify(c)}`);
      return String.fromCharCode(code);
    })
    .join("")})`;
}

/** A real PDF with one or more pages of text lines (Helvetica). No pages of text: no text. */
export function makeTextPdf(pages: string[][]): Buffer {
  const objects: string[] = [];
  const add = (body: string) => objects.push(body) - 1 + 1; // object number
  const catalog = add("");
  const pagesObj = add("");
  const font = add(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  );
  const kids: number[] = [];
  for (const lines of pages) {
    const ops = lines.length
      ? `BT /F1 11 Tf 14 TL 72 760 Td ${lines.map((l) => `${pdfString(l)} Tj T*`).join(" ")} ET`
      : "";
    const stream = Buffer.from(ops, "latin1");
    const content = add(`<< /Length ${stream.length} >>\nstream\n${ops}\nendstream`);
    kids.push(
      add(
        `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] ` +
          `/Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`,
      ),
    );
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] =
    `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

const escapeXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
/** One paragraph of plain text, in a single run (so a template placeholder stays whole). */
export function wordParagraph(text: string, style: { bold?: boolean; sizePt?: number } = {}) {
  const props =
    style.bold || style.sizePt
      ? `<w:rPr>${style.bold ? "<w:b/>" : ""}${style.sizePt ? `<w:sz w:val="${style.sizePt * 2}"/>` : ""}</w:rPr>`
      : "";
  return `<w:p><w:r>${props}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}
const para = (text: string) => wordParagraph(text);

/** A table with borders; the first row in bold. */
export function wordTable(rows: string[][]): string {
  const border =
    '<w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/>';
  return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${border}</w:tblBorders></w:tblPr>${rows
    .map(
      (row, i) =>
        `<w:tr>${row.map((cell) => `<w:tc>${wordParagraph(cell, { bold: i === 0 })}</w:tc>`).join("")}</w:tr>`,
    )
    .join("")}</w:tbl>`;
}

const A4 =
  '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr>';

/** Zip entries carry a fixed date, so the same content always gives the same bytes. */
const FIXED_DATE = { date: new Date("2026-01-01T00:00:00Z") };

/** A Word document: paragraphs, and optionally a table, a header and a footer. */
export function makeDocx(content: {
  paragraphs: string[];
  table?: string[][];
  header?: string;
  footer?: string;
  /** Raw WordprocessingML added to the body, for special cases. */
  rawBody?: string;
  /** An A4 page with 2 cm margins (otherwise Word's default page). */
  a4?: boolean;
}): Buffer {
  const table = content.table
    ? `<w:tbl>${content.table
        .map((row) => `<w:tr>${row.map((cell) => `<w:tc>${para(cell)}</w:tc>`).join("")}</w:tr>`)
        .join("")}</w:tbl>`
    : "";
  // A body that ends in a table needs a paragraph after it, as Word itself writes.
  const tail = table || content.rawBody ? "<w:p/>" : "";
  const zip = new PizZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    FIXED_DATE,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    FIXED_DATE,
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${content.paragraphs.map(para).join("")}${table}${content.rawBody ?? ""}${tail}${content.a4 ? A4 : ""}</w:body></w:document>`,
    FIXED_DATE,
  );
  if (content.header)
    zip.file("word/header1.xml", `<w:hdr ${W}>${para(content.header)}</w:hdr>`, FIXED_DATE);
  if (content.footer)
    zip.file("word/footer1.xml", `<w:ftr ${W}>${para(content.footer)}</w:ftr>`, FIXED_DATE);
  return zip.generate({ type: "nodebuffer", compression: "DEFLATE" });
}

/** A zip with exactly these parts, for damaged or hostile Word files. */
export function makeZip(parts: Record<string, string>): Buffer {
  const zip = new PizZip();
  for (const [name, content] of Object.entries(parts)) zip.file(name, content);
  return zip.generate({ type: "nodebuffer", compression: "DEFLATE" });
}

/**
 * A "zip bomb": a small Word file whose body unzips to `megabytes` MB. With `lie`, its
 * zip headers claim each part is tiny.
 */
export function makeZipBomb(megabytes: number, lie = false): Buffer {
  const filler = `<w:p><w:r><w:t>${"A".repeat(1024 * 1024)}</w:t></w:r></w:p>`;
  const zip = makeDocx({ paragraphs: [], rawBody: filler.repeat(megabytes) });
  if (!lie) return zip;
  // Uncompressed sizes: offset 22 of each local header (PK\x03\x04), 24 of each
  // central directory entry (PK\x01\x02).
  for (const [signature, offset] of [
    ["PK\x03\x04", 22],
    ["PK\x01\x02", 24],
  ] as const) {
    for (let at = zip.indexOf(signature); at >= 0; at = zip.indexOf(signature, at + 4)) {
      zip.writeUInt32LE(1000, at + offset);
    }
  }
  return zip;
}

/**
 * A Word file with a part its zip end record does not count: the directory lists one more
 * part than the record declares, `megabytes` MB unzipped. A reader that takes the count
 * from the record skips it; one that walks the whole directory unzips it.
 */
export function makeHiddenPartDocx(megabytes: number): Buffer {
  const zip = makeDocx({ paragraphs: ["Visible text."] });
  const end = zip.lastIndexOf("PK\x05\x06");
  const directoryAt = zip.readUInt32LE(end + 16);
  const directorySize = zip.readUInt32LE(end + 12);
  // A header part, so a Word reader reads it.
  const name = Buffer.from("word/header9.xml");
  const size = megabytes * 1024 * 1024;
  const data = deflateRawSync(Buffer.alloc(size, 0x20));
  const crc = crc32(Buffer.alloc(size, 0x20));
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(size, 22);
  local.writeUInt16LE(name.length, 26);
  const entry = Buffer.alloc(46);
  entry.writeUInt32LE(0x02014b50, 0);
  entry.writeUInt16LE(20, 4);
  entry.writeUInt16LE(20, 6);
  entry.writeUInt16LE(8, 10);
  entry.writeUInt32LE(crc, 16);
  entry.writeUInt32LE(data.length, 20);
  entry.writeUInt32LE(size, 24);
  entry.writeUInt16LE(name.length, 28);
  entry.writeUInt32LE(directoryAt, 42);
  const hidden = Buffer.concat([local, name, data]);
  const directory = zip.subarray(directoryAt, directoryAt + directorySize);
  const record = Buffer.from(zip.subarray(end));
  // The end record keeps its count; the directory's offset and size cover the new entry.
  record.writeUInt32LE(directorySize + entry.length + name.length, 12);
  record.writeUInt32LE(directoryAt + hidden.length, 16);
  return Buffer.concat([zip.subarray(0, directoryAt), hidden, directory, entry, name, record]);
}

/**
 * The zip with a zip64 end record and locator added before its ordinary end record, as
 * some Word writers produce even for small files; the ordinary record stays valid.
 */
export function withZip64Records(zip: Buffer): Buffer {
  const end = zip.lastIndexOf("PK\x05\x06");
  const count = zip.readUInt16LE(end + 10);
  const size = zip.readUInt32LE(end + 12);
  const at = zip.readUInt32LE(end + 16);
  const record = Buffer.alloc(56);
  record.writeUInt32LE(0x06064b50, 0);
  record.writeBigUInt64LE(44n, 4);
  record.writeUInt16LE(45, 12);
  record.writeUInt16LE(45, 14);
  record.writeBigUInt64LE(BigInt(count), 24);
  record.writeBigUInt64LE(BigInt(count), 32);
  record.writeBigUInt64LE(BigInt(size), 40);
  record.writeBigUInt64LE(BigInt(at), 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(end), 8);
  locator.writeUInt32LE(1, 16);
  return Buffer.concat([zip.subarray(0, end), record, locator, zip.subarray(end)]);
}

/**
 * A PDF whose one page has a compressed content stream (spaces, so no text) that unpacks
 * to `megabytes` MB: a few hundred KB on disk.
 */
export function makePdfBomb(megabytes: number): Buffer {
  const stream = deflateSync(Buffer.alloc(megabytes * 1024 * 1024, 0x20), { level: 9 });
  const parts: Buffer[] = [];
  const offsets: number[] = [];
  let length = 0;
  const add = (b: Buffer | string) => {
    const buf = typeof b === "string" ? Buffer.from(b, "latin1") : b;
    parts.push(buf);
    length += buf.length;
  };
  add("%PDF-1.4\n");
  offsets[1] = length;
  add("1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n");
  offsets[2] = length;
  add("2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n");
  offsets[3] = length;
  add("3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R>>endobj\n");
  offsets[4] = length;
  add(`4 0 obj<</Length ${stream.length}/Filter/FlateDecode>>stream\n`);
  add(stream);
  add("\nendstream endobj\n");
  const xref = length;
  const rows = [1, 2, 3, 4].map((i) => `${String(offsets[i]).padStart(10, "0")} 00000 n \n`);
  add(`xref\n0 5\n0000000000 65535 f \n${rows.join("")}trailer<</Size 5/Root 1 0 R>>\n`);
  add(`startxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(parts);
}

/** A Word template whose paragraphs hold placeholders such as {term} or {#parties}{name}{/parties}. */
export function makeTemplate(paragraphs: string[]): Buffer {
  return makeDocx({ paragraphs });
}

/** The text of a generated Word file's body, for checking a report. */
export function docxBodyText(docx: Uint8Array): string {
  const xml = new PizZip(docx).file("word/document.xml")?.asText() ?? "";
  return [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join("|");
}

/** An invented supplier contract, as text lines per page. */
export const SAMPLE_CONTRACT_PAGES: string[][] = [
  [
    "SUPPLY AGREEMENT",
    "Between Example Widgets Ltd (the Supplier) and Sample Retail plc (the Customer).",
    "1. Term. This agreement starts on 1 March 2026 and lasts 24 months.",
  ],
  [
    "2. Renewal. It renews for 12 months at a time unless either party gives notice.",
    "3. Notice. Either party may end it with 90 days' written notice.",
    "4. Fees. £4,500 per month, payable within 30 days of invoice; café supplies extra.",
  ],
];
