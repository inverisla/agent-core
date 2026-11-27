# contract-risk (demo agent)

Reviews a supplier contract against a purchasing policy and writes a one-page Word
report: one finding per rule (meets, falls short, missing or not applicable), and one
overall line.

The policy is in `prompts/assess.md`. It is a sample, invented for this demo.

It is tested on the invented contracts in `samples/`, with its own expected answers in
`tests/` (see `samples/README.md`).
