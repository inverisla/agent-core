# contract-summary (demo agent)

Summarises a supplier contract into a one-page Word report: parties, term, renewal, notice and fees.

Files:

- `agent.json`: the definition. Three steps: extract the text, extract the fields with the prompt and schema, write the report from the template.
- `prompts/extract.md`: what the model is told. It answers only from the contract, and gives null for anything the contract does not say.
- `schema.json`: the fields, each null when not stated (the strict rules in `docs/agents.md`).
- `template.docx`: the one-page report, with "Not stated" for a null field. It is built by code (`packages/testing/src/template.ts`, written by `pnpm samples:build`) so its content shows in review; your own agents can use templates made in Word.

It is tested on the invented contracts in `samples/` (see `samples/README.md`).

The agent's version is a hash of `agent.json` and the files it names (not this README), so any change to those is a new version. See `docs/agents.md` for the format.
