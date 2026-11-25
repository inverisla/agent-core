// Runs one extraction in a worker thread (started by extract-text.ts). It answers once,
// with the text, "document-too-large" (past a size limit while reading) or
// "unreadable-document"; running out of memory or time ends the thread, which the
// caller also reports as "document-too-large".
import { parentPort, workerData } from "node:worker_threads";
import {
  ExtractFailure,
  readDocument,
  type DocumentKind,
  type ReadLimits,
} from "./extract-core.ts";

const { bytes, kind, limits } = workerData as {
  bytes: Uint8Array;
  kind: DocumentKind;
  limits: ReadLimits;
};
readDocument(bytes, kind, limits).then(
  (result) => parentPort?.postMessage({ ok: true, result }),
  (error: unknown) =>
    parentPort?.postMessage({
      ok: false,
      code: error instanceof ExtractFailure ? error.code : "unreadable-document",
    }),
);
