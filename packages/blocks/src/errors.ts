// A block's failure: a fixed reason code, never the document's content or a library's
// raw message (CLAUDE.md: failures reach logs and Temporal's history).
export const BLOCK_ERROR_CODES = [
  "no-text",
  "unreadable-document",
  "document-too-long",
  "document-too-large",
  "document-type-not-accepted",
  "no-model",
  "schema-mismatch",
  "template-error",
] as const;
export type BlockErrorCode = (typeof BLOCK_ERROR_CODES)[number];

/** None of these is fixed by trying again. */
export class BlockError extends Error {
  readonly code: BlockErrorCode;

  constructor(code: BlockErrorCode) {
    super(`block failed: ${code}`);
    this.name = "BlockError";
    this.code = code;
  }
}
