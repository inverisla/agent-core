// CI's job summary: the coverage totals from `pnpm test:coverage`, as a Markdown table.
// A report only; nothing here fails the build.
import { existsSync, readFileSync } from "node:fs";

const file = "coverage/coverage-summary.json";
if (!existsSync(file)) {
  console.log("No coverage report (the tests did not finish).");
} else {
  const { total } = JSON.parse(readFileSync(file, "utf8")) as {
    total: Record<string, { covered: number; total: number; pct: number }>;
  };
  console.log("### Test coverage\n\n| | Covered | Total | % |\n| --- | --- | --- | --- |");
  for (const key of ["lines", "statements", "functions", "branches"]) {
    const t = total[key];
    if (t) console.log(`| ${key} | ${t.covered} | ${t.total} | ${t.pct} |`);
  }
}
