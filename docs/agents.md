# Defining an agent

An agent is a folder under `agents/`, named after the agent, holding `agent.json` and
the files it names. There is no agent editor: operators change these files and the
change is reviewed and deployed like any other code.

```json
{
  "name": "contract-summary",
  "title": "Supplier contract summary",
  "accepts": ["pdf", "docx"],
  "steps": [
    { "id": "text", "block": "extract-text" },
    { "id": "fields", "block": "extract-to-schema", "input": "text",
      "prompt": "prompts/extract.md", "schema": "schema.json" },
    { "id": "report", "block": "word-report", "input": "fields", "template": "template.docx" }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `name` | Lower-case letters, digits and hyphens; must match the folder name |
| `title` | What people see |
| `accepts` | Document types it takes: `pdf`, `docx` |
| `steps` | Run in order. Each has an `id` (unique), a `block`, and what that block needs |
| `uses` | `extract-to-schema` steps only, optional: earlier steps whose fields the model is also given (see below) |

Blocks (`packages/blocks`):

| Block | Takes | Needs | Gives | Does |
| --- | --- | --- | --- | --- |
| `extract-text` | the document | nothing | text | PDF text (unpdf), or a Word file's paragraphs, tables, headers and footers; pages separated by a blank line and a form feed |
| `extract-to-schema` | text, and the fields of the steps it `uses` | `prompt` (Markdown), `schema` (JSON Schema for an object) | fields | A model fills in the schema through the gateway; the answer is checked against the schema, with one repair attempt that tells the model what was wrong |
| `word-report` | fields | `template` (`.docx`) | report | Fills the template (docxtemplater: `{field}`, loops `{#items}…{/items}`, `{^field}Not stated{/field}` for a null field; a missing field is blank) |

`input` names an earlier step, whose output must be what the block takes (a `word-report`
cannot take text directly). For `extract-to-schema`, `input` is always the text step: the
document stays the source. File paths are relative to the agent's folder, use `/`,
and must stay inside it, even through a linked folder; a file or agent folder that is
itself a link is refused. Paths are case-sensitive on Linux (where the apps run), so
`Prompts/extract.md` and `prompts/extract.md` are different files.

A model step can build on another's answer with `uses`: a list of earlier
`extract-to-schema` steps, each named once. Splitting a job into "find the facts" and
then "judge them" makes each prompt shorter and each step easier to test and review
(`agents/contract-risk` does this):

```json
{ "id": "assessment", "block": "extract-to-schema", "input": "text",
  "uses": ["clauses"], "prompt": "prompts/assess.md", "schema": "schema.json" }
```

The model is given the document's text, then each used step's fields as JSON in a marked
block (`<step-output id="clauses">…</step-output>`), in the order `uses` lists them,
then any reviewer's note. Those fields are a model's answer drawn from the document, so
the prompt should treat them as a guide to check against the document, never as a source
in itself. The markers (`<step-output`, `<reviewer-note` and their closing forms) are
replaced, with U+FFFD, in the fields, and in the document's text for every model step, so
neither can close a block early or forge another step's answer or a reviewer's note.

## Checks

The worker loads every agent when it starts and will not start if one is not valid. The
web app loads them on the first upload or readiness check (`/api/ready`), which the
deploy calls, so a deploy with a broken agent fails its own check. What is refused:
unknown fields or blocks, missing or empty files, a step using a later step's output, a
`uses` that is empty, names a step twice, names a later or unknown step or one that does
not give fields, or is on a block other than `extract-to-schema`, a
schema that is not a JSON Schema for an object or breaks the structured-output rules
below, a template that is not a Word file, or
`AGENT_FOR_UPLOADS` naming no agent. The logs say which file and what is wrong.

Schemas follow the structured-output rules the providers apply (Azure OpenAI's strict
mode): every object sets `"additionalProperties": false` and lists all its properties
under `required`. A field that may be absent is required but nullable, for example
`{ "type": ["string", "null"] }`.

## Running

Each job runs its agent's steps in order on the uploaded document. The last
`extract-to-schema` step's fields are stored in `job_outputs` (row-level security, as
for every tenant table), and the last `word-report` step's file in the tenant's container
at `reports/{job_id}.docx`. Every model call is recorded in `model_calls` against the
job and the step. The fields of earlier `extract-to-schema` steps are passed on to the
steps that use them and are not stored, reviewed or scored: only the last step's are. A
job's steps all run in one attempt, so a failure in a later step runs the earlier ones
again on the retry.

Every job then waits for review (task 11). The review screen shows the document's text
beside the fields, as a form built from the schema, so it works for any agent (a text
field whose schema lists its values, an `enum`, is a choice of those values). A
reviewer may edit the fields (checked against the schema before saving), approve the
draft, which writes the report again from the reviewed fields, or send it back with a
reason, which runs the agent again, every step, with the reason added to each model
step's message (marked as the reviewer's note, with the document still the only source). A recorded
decision locks the draft: no more edits, and no second decision on it. Each edit and decision is logged in `review_events`.

A step fails with a fixed reason code, never the document's content. These are not
retried:

| Code | Meaning |
| --- | --- |
| `no-text` | No text in the document: an empty file, or a scanned PDF (there is no OCR) |
| `unreadable-document` | Damaged, encrypted, or not really a PDF or Word file; also a Word file whose zip directory does not match its end record (a part hidden from size checks), or one whose sizes need zip64 |
| `document-too-long` | More than 400,000 characters of text (about 100,000 tokens) |
| `document-too-large` | Reading it needs too much memory or time: a Word file whose parts read unzip to more than 25 MB each or 60 MB in all (a "zip bomb"), a PDF of more than 1,000 pages, a Word file with more than 64 headers and footers, or a reading thread that passes 192 MB (its heap and unpacked data together) or a minute |
| `document-not-found` | The document's record or file has gone |
| `document-type-not-accepted` | Not one of the agent's `accepts` types |
| `no-model` | No model configured (`MODEL_PROVIDER` unset) |
| `schema-mismatch` | The model's answer did not match the schema, twice |
| `template-error` | The Word template is broken |
| `model-refused` | The provider's content filter stopped it |
| `model-demo-unknown` | The demo model does not know the document (it only knows the sample contracts) |

The model's other failures (rate limits, timeouts, errors) and storage or database
problems are retried by Temporal.

## Versions

An agent's version is the first 12 hex digits of a SHA-256 over `agent.json` and every
file it names (their paths and contents; Windows line endings count as Unix ones). Any
change to those files is a new version; other files in the folder, such as a README,
are not part of it. Every job records the agent's name and version when it is created,
and the worker refuses to run a job whose version is not the one it has loaded
(reason code `agent-version-changed`), so a job's recorded version is always the one
that ran.

Two consequences of that rule:

- **During a deploy that changes an agent,** the web app and the worker briefly run
  different versions. A document uploaded in that window fails with
  `agent-version-changed` (the worker logs which versions); upload it again.
- **Locally,** the apps read agents once and keep them: after editing an agent, restart
  `pnpm dev` (both apps), or the web app and worker may disagree.

Operators choose which agents each tenant may use, on the tenant's page in the operator
console (`tenant_agents`). When a tenant has more than one, its users pick one at upload.
A tenant with none chosen uses the agent named by `AGENT_FOR_UPLOADS` (default
`contract-summary`). If every agent chosen for a tenant has gone from the deployment, its
uploads are refused until an operator chooses again: the console marks the missing ones.

## Testing a version

An agent's test set is a `tests/` folder beside `agent.json`, laid out like `samples/`
(`files/` and `expected/`, one expected answer and its checks per document); the contract
summary's test set is `samples/` itself, and the risk review's is its own `tests/` (copies
of the samples' files, with its own answers). **A test set must be invented or public documents, never a
tenant's**: its documents go into the repository and the worker image, and each run's
answers are kept in the operator schema, which has no tenant separation. Each case is run several times (a model's answers
vary) and each field scored against its checks.

- **Before merging**, `pnpm agent:compare -- --agent contract-summary --base origin/main`
  runs the test set through the version on your branch and the one on `main`, and writes
  a side-by-side report of accuracy per field to `test-results/agent-compare/`. The
  `Test agent` GitHub workflow does the same on every push that changes the agent, with
  the dev environment's model, and shows the table on the run's summary page.
- **Once deployed**, the worker runs each new version's test set once, when it starts:
  3 runs per case, with the deployment's own model (never the demo model, whose answers
  are recorded ones). The result is kept in the operator schema, which never holds tenant
  data, and these model calls are not counted as any tenant's usage. In the operator
  console, **Agents** shows each version's files, steps, test runs and their cost, and
  compares any two runs field by field. A version is run again only if the database has
  no result for it with the current model (after switching model, or a restore). Runs
  have a worker queue of their own and run one at a time, so they never take a slot from
  tenants' jobs, but they do share the model deployment's tokens-per-minute limit: jobs
  running at the same time may wait for it. A case the model could not answer (out of
  quota, unreachable) is not counted as wrong: the run tries again later, carrying on
  from the cases already done. Each failed attempt writes an `agent.test-failed` event
  line with a reason code; if the retries run out, the next worker start tries again.
