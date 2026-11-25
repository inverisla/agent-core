import { describe, expect, it } from "vitest";
import { migrationMismatch } from "./migrate.ts";

const local = [
  { tag: "0000_a", hash: "a", createdAt: 100 },
  { tag: "0001_b", hash: "b", createdAt: 200 },
  { tag: "0002_c", hash: "c", createdAt: 300 },
];
const applied = (n: number) =>
  local.slice(0, n).map(({ hash, createdAt }) => ({ hash, createdAt }));

describe("migrationMismatch (review Q4)", () => {
  it("agrees when the applied migrations are the repository's first ones, unchanged", () => {
    for (const n of [0, 1, 2, 3]) expect(migrationMismatch(applied(n), local)).toBeNull();
  });

  it("refuses a migration changed after it was applied", () => {
    const changed = [
      { hash: "a", createdAt: 100 },
      { hash: "edited", createdAt: 200 },
    ];
    expect(migrationMismatch(changed, local)).toContain("0001_b has changed");
  });

  it("refuses a migration older than one already applied, which Drizzle would skip", () => {
    // 0001 was merged from upstream after 0002 had been applied.
    const skipping = applied(3).filter((m) => m.createdAt !== 200);
    expect(migrationMismatch(skipping, local)).toContain("0001_b is older");
  });

  it("refuses an applied migration that is not in the repository", () => {
    expect(migrationMismatch([...applied(3), { hash: "x", createdAt: 400 }], local)).toContain(
      "not in packages/db/migrations",
    );
  });
});
