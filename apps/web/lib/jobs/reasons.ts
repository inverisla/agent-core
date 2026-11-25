// What a failed job's reason code means, for the people who uploaded the document. Fixed
// sentences only: the code comes from the worker's fixed list (docs/agents.md), and
// nothing from the original error ever reaches the page.
const REASONS: Record<string, string> = {
  "no-text":
    "This document has no text we can read. It may be a scan; scanned documents cannot be read yet.",
  "unreadable-document":
    "This document could not be opened. It may be damaged or password-protected. Save a fresh copy and upload it again.",
  "document-too-long": "This document is too long to process.",
  "document-too-large": "This document is too large or complex to read.",
  "document-type-not-accepted": "This kind of document is not one this agent accepts.",
  "document-not-found": "The uploaded file could no longer be found. Upload it again.",
  "agent-version-changed":
    "The agent was updated after this document was uploaded. Upload the document again.",
  "no-model": "Processing is not set up yet. Contact your administrator.",
  "schema-mismatch": "The summary could not be completed. Try uploading the document again.",
  "template-error": "The report could not be written. Contact your administrator.",
  "model-refused": "The document could not be processed because of its content.",
  "model-demo-unknown":
    "The demo model only knows the sample contracts in samples/files. Upload one of those, or set up a real model (docs/models.md).",
  "model-rate-limited": "The service was too busy to process this document. Try again later.",
  "model-timeout": "The service took too long to answer. Try again later.",
  "model-bad-response": "The summary could not be completed. Try uploading the document again.",
  "model-error": "The service could not be reached. Try again later.",
};

const GENERAL = "Something went wrong while processing this document. Try uploading it again.";

/** A plain message for a failed job's reason code (a general one for unknown codes). */
export function failureMessage(code: string | null | undefined): string {
  return (code && REASONS[code]) || GENERAL;
}
