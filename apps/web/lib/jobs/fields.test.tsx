import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Fields } from "./fields.tsx";

describe("a job's fields", () => {
  it("follow the agent schema's order, then any others, with Not stated for null", () => {
    const html = renderToStaticMarkup(
      <Fields
        fields={{
          fees: "£10",
          extra: "x",
          term: null,
          parties: [{ name: "A Ltd", role: "Supplier" }],
        }}
        order={["parties", "term", "fees"]}
      />,
    );
    const labels = [...html.matchAll(/<dt[^>]*>([^<]*)<\/dt>/g)].map((m) => m[1]);
    expect(labels).toEqual(["Parties", "Term", "Fees", "Extra"]);
    expect(html).toContain("Not stated");
    expect(html).toContain("A Ltd");
  });
});
