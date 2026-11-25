// extract-text: an uploaded document's text. PDF with unpdf; Word (.docx) by reading the
// document's own XML (body, tables, headers and footers) through the strict zip reader
// (zip.ts). Scanned PDFs have no text and fail with "no-text" (no OCR).
//
// A small file can expand hugely (a "zip bomb", or a PDF's compressed streams), so the
// reading runs in a worker thread with a memory budget and a time limit: a hostile file
// ends that thread, not the worker. The budget counts the thread's heap and the buffers
// outside it (where unzipped and decoded data lives, which the heap limit does not
// cover), checked every 50 ms. Word files are read through the strict zip reader
// (zip.ts), which unzips only the parts it needs, each within a cap.
import { Worker } from "node:worker_threads";
import { BlockError } from "./errors.ts";
import type { DocumentKind, ExtractedText } from "./extract-core.ts";

export type { DocumentKind, ExtractedText } from "./extract-core.ts";
export { tidy, wordXmlText } from "./extract-core.ts";

const KINDS: Record<string, DocumentKind> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};

/** The kind of a stored document, from the content type intake recorded. */
export function documentKind(contentType: string): DocumentKind | null {
  return KINDS[contentType] ?? null;
}

/** About 100,000 tokens: longer documents are refused rather than cut short. */
export const MAX_TEXT_CHARS = 400_000;

export interface ExtractLimits {
  maxChars?: number;
  /** One part of a Word file, unzipped. */
  maxPartBytes?: number;
  /** All the Word parts read, together, unzipped. */
  maxTotalBytes?: number;
  /** A PDF's pages. */
  maxPages?: number;
  /**
   * The extraction thread's memory: its heap and the buffers outside it together. Four
   * jobs run at once (apps/worker JOBS_AT_ONCE), so four of these must fit in the
   * worker's memory (1 GiB in infra/azure/main.bicep) with room for the worker itself.
   */
  maxMemoryMb?: number;
  timeoutMs?: number;
}

export const DEFAULT_LIMITS: Required<ExtractLimits> = {
  maxChars: MAX_TEXT_CHARS,
  maxPartBytes: 25 * 1024 * 1024,
  maxTotalBytes: 60 * 1024 * 1024,
  maxPages: 1000,
  maxMemoryMb: 192,
  timeoutMs: 60_000,
};

/** How often the thread's memory is checked. */
const MEMORY_CHECK_MS = 50;

/**
 * Extraction threads running at once in this process, whatever the number of jobs: each
 * can reach its budget plus about 40 MB of its own (pdf.js and the thread), and the worker
 * itself needs about 320 MB, so two fit in its 1 GiB with room to spare. The others wait.
 */
export const EXTRACTIONS_AT_ONCE = 2;
let running = 0;
const waiting: (() => void)[] = [];

async function slot(): Promise<() => void> {
  if (running >= EXTRACTIONS_AT_ONCE) await new Promise<void>((go) => waiting.push(go));
  else running += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = waiting.shift();
    // The slot passes straight to the next in line, so the count never drops between.
    if (next) next();
    else running -= 1;
  };
}

export async function extractText(
  bytes: Uint8Array,
  kind: DocumentKind,
  limits: ExtractLimits = {},
): Promise<ExtractedText> {
  const l = { ...DEFAULT_LIMITS, ...limits };
  const release = await slot();
  let result: ExtractedText;
  try {
    result = await inThread(bytes, kind, l);
  } finally {
    release();
  }
  if (result.text === "") throw new BlockError("no-text");
  if (result.text.length > l.maxChars) throw new BlockError("document-too-long");
  return result;
}

function inThread(
  bytes: Uint8Array,
  kind: DocumentKind,
  limits: Required<ExtractLimits>,
): Promise<ExtractedText> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./extract-thread.ts", import.meta.url), {
      workerData: {
        bytes,
        kind,
        limits: {
          maxPartBytes: limits.maxPartBytes,
          maxTotalBytes: limits.maxTotalBytes,
          maxPages: limits.maxPages,
        },
      },
      resourceLimits: { maxOldGenerationSizeMb: limits.maxMemoryMb, maxYoungGenerationSizeMb: 32 },
      // The thread writes nothing; anything a library prints is dropped.
      stdout: true,
      stderr: true,
    });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(memory);
      void worker.terminate();
      fn();
    };
    const tooLarge = () => finish(() => reject(new BlockError("document-too-large")));
    const timer = setTimeout(tooLarge, limits.timeoutMs);
    // The heap limit above does not cover buffers (unzipped or decoded data), so the
    // thread's whole use is checked here, while it works, and the thread is stopped once
    // it passes the budget.
    const budget = limits.maxMemoryMb * 1024 * 1024;
    const memory = setInterval(() => {
      worker.getHeapStatistics().then(
        (stats) => {
          if (stats.used_heap_size + stats.external_memory > budget) tooLarge();
        },
        () => {}, // The thread has just ended; its own message or exit settles this.
      );
    }, MEMORY_CHECK_MS);
    // Only the thread's own answer counts: Node's watch mode (`node --watch`, as `pnpm dev`
    // runs the worker) also posts its own messages, such as {"watch:import": [...]}.
    worker.on("message", (message: unknown) => {
      if (typeof message !== "object" || message === null || !("ok" in message)) return;
      const answer = message as { ok: boolean; result?: ExtractedText; code?: string };
      finish(() =>
        answer.ok && answer.result
          ? resolve(answer.result)
          : reject(
              new BlockError(
                answer.code === "document-too-large" ? "document-too-large" : "unreadable-document",
              ),
            ),
      );
    });
    // Out of memory (ERR_WORKER_OUT_OF_MEMORY) or any other end of the thread.
    worker.once("error", (error: NodeJS.ErrnoException) =>
      finish(() =>
        reject(
          new BlockError(
            error.code === "ERR_WORKER_OUT_OF_MEMORY"
              ? "document-too-large"
              : "unreadable-document",
          ),
        ),
      ),
    );
    worker.once("exit", () => finish(() => reject(new BlockError("unreadable-document"))));
  });
}
