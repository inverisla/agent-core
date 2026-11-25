import { describe, expect, it } from "vitest";
import { csvResponse, toCsv } from "./csv.ts";

describe("CSV export", () => {
  it("quotes commas, quotes and line breaks", () => {
    expect(
      toCsv(
        ["a", "b"],
        [
          ["x,y", 'say "hi"'],
          ["line\nbreak", ""],
        ],
      ),
    ).toBe('a,b\r\n"x,y","say ""hi"""\r\n"line\nbreak",\r\n');
  });

  it("never lets a cell start a formula", () => {
    const hostile = ["=1+1", "+cmd", "-2+3", "@SUM(A1)", "\t=x", "\r=x"];
    const lines = toCsv(
      ["v"],
      hostile.map((v) => [v]),
    )
      .split("\r\n")
      .slice(1, -1);
    // The CR case is quoted, so compare the parsed starts instead of whole lines.
    for (const line of lines) expect(line.replace(/^"/, "")).toMatch(/^'/);
  });

  it("writes numbers, dates and empty values plainly", () => {
    expect(toCsv(["n", "d", "e"], [[-5, new Date("2026-11-01T00:00:00Z"), null]])).toBe(
      "n,d,e\r\n-5,2026-11-01T00:00:00.000Z,\r\n",
    );
  });

  it("downloads as UTF-8 with a safe filename only", async () => {
    const res = csvResponse("usage-2026-11.csv", "a\r\n");
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="usage-2026-11.csv"');
    expect(new Uint8Array(await res.arrayBuffer()).slice(0, 3)).toEqual(
      new Uint8Array([0xef, 0xbb, 0xbf]),
    );
    expect(() => csvResponse('x"; y.csv', "")).toThrow();
    expect(() => csvResponse("../x.csv", "")).toThrow();
  });
});
