// The one zip reader for Word files, used both by the upload check (apps/web
// lib/documents/file-type.ts) and to read them (extract-core.ts), so what is checked is
// what is read. Strict on purpose: a zip whose directory does not match its end record,
// values only zip64 can hold, or sizes that do not add up is refused rather than guessed at. Parts are unzipped
// one at a time, only when asked for, with a hard cap on the output (node:zlib's
// maxOutputLength), so a small file cannot unpack into gigabytes ("zip bomb").
import { inflateRawSync } from "node:zlib";

export interface ZipEntry {
  name: string;
  /** 0 stored, 8 deflate; anything else is not read. */
  method: number;
  encrypted: boolean;
  compressedSize: number;
  localHeaderOffset: number;
}

const END = 0x06054b50;
const DIRECTORY = 0x02014b50;
const LOCAL = 0x04034b50;

/**
 * The zip's directory, or null if it is not a zip this reader trusts: no end record,
 * values only zip64 can hold, a directory outside the file, or a directory holding more or fewer entries than
 * the end record declares (a part hidden from a reader that trusts the count).
 */
export function zipDirectory(bytes: Uint8Array): ZipEntry[] | null {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // End record: at the end, before an optional comment of up to 64 KB.
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === END) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  // Some Word writers add zip64 records even to small files; they are ignored, and the
  // file is read from the ordinary record as long as none of its fields is saturated
  // (which would mean the real values are only in the zip64 record).
  const diskEntries = buf.readUInt16LE(end + 8);
  const count = buf.readUInt16LE(end + 10);
  const size = buf.readUInt32LE(end + 12);
  const at = buf.readUInt32LE(end + 16);
  if (count === 0xffff || size === 0xffffffff || at === 0xffffffff) return null;
  if (diskEntries !== count || at + size > end) return null;
  const entries: ZipEntry[] = [];
  let p = at;
  while (p < at + size) {
    if (p + 46 > at + size || buf.readUInt32LE(p) !== DIRECTORY) return null;
    const nameLength = buf.readUInt16LE(p + 28);
    const next = p + 46 + nameLength + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    if (next > at + size) return null;
    const compressedSize = buf.readUInt32LE(p + 20);
    const localHeaderOffset = buf.readUInt32LE(p + 42);
    if (compressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) return null;
    entries.push({
      name: buf.toString("utf8", p + 46, p + 46 + nameLength),
      method: buf.readUInt16LE(p + 10),
      encrypted: (buf.readUInt16LE(p + 8) & 1) === 1,
      compressedSize,
      localHeaderOffset,
    });
    p = next;
  }
  // Exactly the entries the end record declares, filling the directory exactly.
  return entries.length === count && p === at + size ? entries : null;
}

/**
 * One part, unzipped: its bytes, "too-large" if it unzips to more than `maxBytes`, or
 * null if it cannot be read (damaged, encrypted, or an unknown method).
 */
export function readZipEntry(
  bytes: Uint8Array,
  entry: ZipEntry,
  maxBytes: number,
): Buffer | "too-large" | null {
  if (maxBytes < 1) return "too-large";
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = entry.localHeaderOffset;
  if (entry.encrypted || at + 30 > buf.length || buf.readUInt32LE(at) !== LOCAL) return null;
  const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
  const data = buf.subarray(start, start + entry.compressedSize);
  if (data.length !== entry.compressedSize) return null;
  if (entry.method === 0) return data.length > maxBytes ? "too-large" : Buffer.from(data);
  if (entry.method !== 8) return null;
  try {
    return inflateRawSync(data, { maxOutputLength: maxBytes });
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE" ? "too-large" : null;
  }
}
