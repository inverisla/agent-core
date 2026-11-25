# Samples

Ten invented supplier contracts for the demo agent (`agents/contract-summary`). The
parties, people and places are made up; any likeness to a real organisation is chance.
They are public and may be shared with the rest of this repository (Apache 2.0).

| Folder | What |
| --- | --- |
| `sources/` | Each contract as plain text: `# ` a title, `## ` a heading, `\| a \| b \|` table rows, blank lines between paragraphs |
| `files/` | The same contracts as PDF or Word files, built from the sources. Do not edit these: change the source and run `pnpm samples:build` |
| `expected/` | One file per contract, written by hand: its format, an example answer (`answer`), and the facts a real answer must contain (`check`) |
| `out/` | What `pnpm samples:run` wrote last (not committed) |

The contracts differ on purpose: automatic and optional renewal, a fixed end date, a
rolling monthly contract, three parties, fees in a table, prices linked to inflation,
euros, a long contract with definitions and schedules, and contracts that leave out
renewal or notice (where the right answer is null).

A field's check (`packages/testing/src/scoring.ts`) is one of:

- a list of facts, each a string or a list of ways to write it (any one will do), matched
  as whole words without case, curly quotes or thousands commas; a fact ending in `*`
  matches any word starting with it (`quarter*` matches "quarterly");
- `{ "exact": value }`;
- a list of objects, such as the parties: matched item by item, so a missing item and an
  invented one both count (precision and recall);
- `null` when the contract says nothing (the answer must be null too), or `"any"`.

These samples are the demo agent's test set. Another agent keeps its test set in
`agents/<name>/tests/`, in the same form (`files/` and `expected/`; `sources/` only if
its files are built by code).

- `pnpm test` (the `testing` project) runs the demo agent on every sample end to end,
  with each example answer standing in for the model, and checks the files are up to date.
- `pnpm samples:run [ids…]` runs them with the model in `.env.local` and prints, per
  sample, what is missing, and per field how many were right.
- `pnpm agent:compare -- --agent contract-summary --base origin/main` runs the test set
  for the agent now and at `--base`, three times each by default, and writes a
  side-by-side report (accuracy per field, and the cases that changed) to
  `test-results/agent-compare/`. The "Test agent" workflow runs it on every branch that
  changes the agent, against the dev environment's model (`infra/azure/README.md`,
  step 8).
