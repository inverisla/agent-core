// The review form shows a field whose schema lists its values (enum) as a choice of those
// values (task 17), in rows of a list as well as on its own.
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { choices, ReviewForm } from "./review-form.tsx";

const RISK_SCHEMA = JSON.parse(
  readFileSync(
    path.join(import.meta.dirname, "..", "..", "..", "agents", "contract-risk", "schema.json"),
    "utf8",
  ),
) as { properties: Record<string, never> };
const RESULTS = ["meets", "falls short", "missing", "not applicable"];

const render = (
  schema: { properties?: Record<string, unknown> },
  fields: Record<string, unknown>,
) =>
  renderToStaticMarkup(
    <ReviewForm
      schema={schema as { properties: Record<string, never> }}
      fields={fields}
      revision={1}
      save={() => {}}
      approve={() => {}}
    />,
  );

/** Each select's label and its options' values, in order, with the selected one. */
function selects(html: string) {
  return [
    ...html.matchAll(
      /<label for="([^"]+)"[^>]*>([^<]*)<\/label>(?:<p[^>]*>[^<]*<\/p>)?<select([^>]*)>([\s\S]*?)<\/select>/g,
    ),
  ].map(([, , label, , body]) => ({
    label,
    options: [...(body ?? "").matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]),
    selected: /<option value="([^"]*)" selected=""/.exec(body ?? "")?.[1],
  }));
}

describe("the review form's choices", () => {
  it("shows each finding's result as a choice of the schema's values, other columns as text", () => {
    const html = render(RISK_SCHEMA, {
      overall: "It meets the policy.",
      findings: [
        { rule: "Payment terms", contract_says: "30 days", result: "meets", note: "Fine." },
        { rule: "Insurance", contract_says: null, result: "missing", note: "None." },
      ],
    });
    expect(selects(html)).toEqual([
      { label: "Result (findings 1)", options: RESULTS, selected: "meets" },
      { label: "Result (findings 2)", options: RESULTS, selected: "missing" },
    ]);
    // The rule and note stay text boxes, and the overall line a text area.
    expect(html).toContain('value="Payment terms"');
    expect(html).toMatch(/<textarea[^>]*>It meets the policy\.<\/textarea>/);
  });

  it("offers a value that is not listed (a new row's empty one) first, as it stands", () => {
    expect(choices({ enum: ["a", "b"] }, "")).toEqual([
      { value: "", label: "Choose one" },
      { value: "a", label: "a" },
      { value: "b", label: "b" },
    ]);
    expect(choices({ enum: ["a", "b"] }, "c")?.[0]).toEqual({ value: "c", label: "c" });
    expect(choices({ enum: ["a", "b"] }, "b")).toHaveLength(2);
    // No enum, or no text values in it: a text box as before.
    expect(choices({ type: "string" }, "x")).toBeNull();
    expect(choices({ enum: [null] }, null)).toBeNull();
  });

  it("shows a top-level field with an enum as a choice too, and no choice when not stated", () => {
    const schema = {
      properties: {
        verdict: { type: ["string", "null"], enum: ["yes", "no", null] },
      },
    };
    expect(selects(render(schema, { verdict: "no" }))).toEqual([
      { label: "Verdict", options: ["yes", "no"], selected: "no" },
    ]);
    const stated = render(schema, { verdict: null });
    expect(selects(stated)).toEqual([]);
    expect(stated).toContain("Verdict: not stated in the document");
  });
});
