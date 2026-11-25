// CSV for exports (task 13): RFC 4180 quoting, and no cell a spreadsheet would run as a
// formula. Audit details and email addresses come from people, so any cell may be hostile.

export type CsvValue = string | number | boolean | null | undefined | Date;

/** Characters that make Excel, Sheets and LibreOffice treat a cell as a formula. */
const FORMULA_START = /^[=+\-@\t\r]/;

function cell(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") {
    // Numbers we produce are never formulas, even negative ones.
    return Number.isFinite(value) ? String(value) : "";
  }
  let text = String(value);
  // A leading apostrophe makes the cell plain text in every common spreadsheet.
  if (FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) || text !== text.trim() ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One CSV line, with its CRLF. */
export function csvLine(row: CsvValue[]): string {
  return row.map(cell).join(",") + "\r\n";
}

/** A whole CSV file: a header row, then one line per row, CRLF line ends. */
export function toCsv(header: string[], rows: CsvValue[][]): string {
  return [header, ...rows].map(csvLine).join("");
}

const BOM = String.fromCharCode(0xfeff);

const SAFE_FILENAME = /^[a-z0-9][a-z0-9._-]*\.csv$/;

/** A download response. The filename is built by the caller from safe values only. */
export function csvResponse(filename: string, body: string): Response {
  if (!SAFE_FILENAME.test(filename)) throw new Error("unsafe CSV filename");
  // A byte order mark, so Excel reads the file as UTF-8 (names with accents, £ and €).
  return new Response(`${BOM}${body}`, { headers: csvHeaders(filename) });
}

/**
 * A download sent as it is made, from `chunks` of CSV text, so a large export is never
 * held in memory whole.
 */
export function csvStreamResponse(filename: string, chunks: AsyncIterable<string>): Response {
  if (!SAFE_FILENAME.test(filename)) throw new Error("unsafe CSV filename");
  const encoder = new TextEncoder();
  const iterator = chunks[Symbol.asyncIterator]();
  let started = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started) {
        started = true;
        controller.enqueue(encoder.encode(BOM));
      }
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(next.value));
      } catch (error) {
        console.error("CSV export failed:", error instanceof Error ? error.name : "unknown");
        controller.error(new Error("export failed"));
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
  return new Response(stream, { headers: csvHeaders(filename) });
}

function csvHeaders(filename: string): Record<string, string> {
  return {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="${filename}"`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
}
