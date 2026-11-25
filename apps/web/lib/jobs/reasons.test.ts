import { describe, expect, it } from "vitest";
import { MODEL_ERROR_CODES } from "@agent-core/core/models";
import { failureMessage } from "./reasons.ts";

describe("failure messages", () => {
  it("explain every reason code the worker records in plain words", () => {
    const codes = [
      "no-text",
      "unreadable-document",
      "document-too-long",
      "document-too-large",
      "document-type-not-accepted",
      "document-not-found",
      "agent-version-changed",
      "no-model",
      "schema-mismatch",
      "template-error",
      ...MODEL_ERROR_CODES,
    ];
    const general = failureMessage("error");
    for (const code of codes) {
      expect(failureMessage(code), code).not.toBe(general);
      expect(failureMessage(code)).not.toContain(code);
    }
    expect(failureMessage("no-model")).toBe(
      "Processing is not set up yet. Contact your administrator.",
    );
  });

  it("give a general message for an unknown or missing code", () => {
    expect(failureMessage("something-new")).toBe(failureMessage(null));
    expect(failureMessage(undefined)).toMatch(/went wrong/);
  });
});
