import { describe, expect, it } from "vitest";
import { slugFromName, slugProblem } from "./tenant-slug.ts";

describe("slugFromName", () => {
  it("makes a URL-safe default from a name", () => {
    expect(slugFromName("Northwind Traders")).toBe("northwind-traders");
    expect(slugFromName("  Café & Co. (UK)  ")).toBe("cafe-co-uk");
    expect(slugFromName("x".repeat(60))).toHaveLength(40);
  });
});

describe("slugProblem", () => {
  it("accepts well-formed slugs", () => {
    expect(slugProblem("northwind-traders")).toBeNull();
    expect(slugProblem("a1b")).toBeNull();
  });

  it("rejects bad shapes and reserved words", () => {
    for (const bad of ["ab", "-abc", "abc-", "ABC", "a_b_c", "a--b", "x".repeat(41)]) {
      expect(slugProblem(bad), bad).not.toBeNull();
    }
    expect(slugProblem("operator")).toMatch(/reserved/);
  });
});
