# contract-risk (demo agent)

Reviews a supplier contract against a purchasing policy and writes a one-page Word
report: one finding per rule (meets, falls short, missing or not applicable), and one
overall line.

## What it shows: facts, then judgement

It has two model steps, the second building on the first (`uses`, see `docs/agents.md`):

| Step | Block | Files | Gives |
| --- | --- | --- | --- |
| `text` | extract-text | | the contract's text |
| `clauses` | extract-to-schema | `prompts/clauses.md`, `clauses.schema.json` | what the contract says on each policy topic, copied close to its words, or null |
| `assessment` | extract-to-schema, `uses: ["clauses"]` | `prompts/assess.md`, `schema.json` | a finding per policy rule, plus one overall line |
| `report` | word-report (from `assessment`) | `template.docx` | the one-page risk review |

The first step only finds and copies; it makes no judgement. The second is given the
contract's text and, after it, the first step's answer in a marked block. It judges each
rule from the contract, using that answer as a guide to check against the contract,
never as a source in itself. Splitting the work this way makes each prompt shorter and
each step easier to test and review. Only the last step's fields (the findings) are
stored, reviewed and scored; the clauses step's answer is passed on and not stored
(its model call is recorded, with tokens and cost, as for every step).

## The policy, and swapping in your own

The five rules in `prompts/assess.md` are an invented sample, chosen so the sample
contracts test each result, including rules a contract fails by saying nothing:

1. Payment terms: payment due no sooner than 30 days after invoice.
2. Liability cap: the supplier's liability is limited to no less than the annual value.
3. Insurance: the supplier holds public liability insurance of a stated amount.
4. Automatic renewal: if it renews automatically, the customer can stop it with no more
   than three months' notice.
5. Data protection: if the supplier handles personal data, there is a clause on it.

To use your own policy:

1. Replace the rules under "The purchasing policy" in `prompts/assess.md`, and say when
   each one is `not applicable`, if ever.
2. Change the topics in `prompts/clauses.md` and `clauses.schema.json` to match, so the
   first step finds what your rules need.
3. Write your own test set in `tests/` (invented or public documents only, never a
   tenant's): one expected answer per document, with checks on each finding's `rule` and
   `result`. Then run `pnpm agent:compare -- --agent contract-risk --base origin/main`.

Any change to these files is a new agent version.

## Tests and the demo model

The test set in `tests/` is the ten contracts in `samples/` (`pnpm samples:build` copies
their files), with expected findings of its own. The checks match each finding by its
rule's name and check its result, and for most also a figure the contract states. Where
the result is a judgement (whether IT support for 40 users counts as handling personal
data, say) only the rule is checked.

The demo model answers each step with the answer recorded for that sample under the
step's schema title, in `samples/demo/`. The recorded risk review matches the test set's
answers, and a test keeps the two the same. The template is built by code
(`packages/testing/src/template.ts`, written by `pnpm samples:build`).
