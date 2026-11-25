// pnpm agent:compare -- --agent contract-summary [--base origin/main] [--tests samples]
//   [--repeats 3] [--out test-results/agent-compare]
//
// Runs an agent's test set with the model in .env.local (docs/models.md), for the agent
// as it is now and as it was at --base (read from git), and shows the two side by side:
// accuracy per field, and the cases that changed. Writes report.md, report.html and
// results.json to --out, and the table to the GitHub run summary when run in Actions.
// Fails only if a run could not be made (a setup or model fault), not if a field got
// worse: the report says so, and people decide.
import path from "node:path";
import { compareCommand } from "./compare-command.ts";

const { code } = await compareCommand(process.argv.slice(2), {
  root: path.join(import.meta.dirname, "..", "..", ".."),
  env: process.env,
});
process.exitCode = code;
