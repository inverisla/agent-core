// Small real files for tests: a minimal PDF, and Word files built as uncompressed zips.
import { crc32, deflateRawSync } from "node:zlib";

export function makePdf(padToBytes = 0): Buffer {
  const body = "%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n";
  return Buffer.concat([
    Buffer.from(body, "latin1"),
    Buffer.alloc(Math.max(0, padToBytes - body.length), 0x20),
  ]);
}

/** A zip, stored or deflated, optionally with a zip comment. */
export function makeZip(
  entries: Record<string, string>,
  options: { deflate?: boolean; comment?: string } = {},
): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const nameBuf = Buffer.from(name, "utf8");
    const raw = Buffer.from(content, "utf8");
    const crc = crc32(raw);
    const method = options.deflate ? 8 : 0;
    const data = options.deflate ? deflateRawSync(raw) : raw;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const comment = Buffer.from(options.comment ?? "", "utf8");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...locals, ...centrals, end, comment]);
}

const contentTypes = (main: string, extra = "") =>
  `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${main}"/>${extra}</Types>`;
const DOC_MAIN = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const documentXml = (text: string) =>
  `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`;

/** A Word file, deflated like the ones Word saves. */
export function makeDocx(
  text = "Supplier agreement",
  options: { deflate?: boolean } = { deflate: true },
): Buffer {
  return makeZip(
    { "[Content_Types].xml": contentTypes(DOC_MAIN), "word/document.xml": documentXml(text) },
    options,
  );
}

/** A macro-enabled Word file (.docm), which is refused. */
export function makeDocm(): Buffer {
  return makeZip({
    "[Content_Types].xml": contentTypes("application/vnd.ms-word.document.macroEnabled.main+xml"),
    "word/document.xml": documentXml("x"),
    "word/vbaProject.bin": "macros",
  });
}

/** Macros under another part name, declared in the content types. */
export function makeDocxWithHiddenMacros(): Buffer {
  return makeZip({
    "[Content_Types].xml": contentTypes(
      DOC_MAIN,
      '<Override PartName="/word/macros.bin" ContentType="application/vnd.ms-office.vbaProject"/>',
    ),
    "word/document.xml": documentXml("x"),
    "word/macros.bin": "macros",
  });
}

/** A Word template (.dotx), which is refused. */
export function makeDotx(): Buffer {
  return makeZip({
    "[Content_Types].xml": contentTypes(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml",
    ),
    "word/document.xml": documentXml("x"),
  });
}

/** A zip that only mentions Word's part names: in its comment, or inside another file. */
export function makeFakeDocxZips(): Buffer[] {
  return [
    makeZip({ "payload.exe": "MZ" }, { comment: "[Content_Types].xml word/document.xml" }),
    makeZip({ "xl/workbook.xml": "<x>[Content_Types].xml word/document.xml</x>" }),
  ];
}

/** Old .doc, and password-protected .docx: both OLE compound files. */
export function makeOleFile(): Buffer {
  return Buffer.concat([
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    Buffer.alloc(504),
  ]);
}

/** An executable's header, as in a renamed .exe. */
export function makeExe(): Buffer {
  return Buffer.concat([Buffer.from("MZ", "latin1"), Buffer.alloc(200, 0x90)]);
}
