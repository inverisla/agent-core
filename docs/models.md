# The model gateway

Every model call goes through `@agent-core/core/models`. A lint rule refuses model SDKs,
other HTTP clients, `fetch()` and model API addresses anywhere else (tests may use
`fetch()` to call the app). It is a list of what to refuse, so it catches the usual ways
round the gateway, not every one: a new SDK or host has to be added to `eslint.config.mjs`. Blocks ask the gateway for a completion; which
provider and model answer is configuration only.

```ts
const answer = await gateway.complete(
  { tenantId, jobId, step: "fields" },            // recorded with the call
  { system: prompt, user: text, schema: { name: "fields", jsonSchema } },
);
answer.json;          // the parsed object, when a schema was given
answer.inputTokens;   // and outputTokens, costUsd, durationMs, provider, model
```

## Providers

| `MODEL_PROVIDER` | Settings | Signs in with |
| --- | --- | --- |
| `azure-openai` | `AZURE_OPENAI_ENDPOINT` (an Azure OpenAI address, `https://…openai.azure.com` or `…cognitiveservices.azure.com`; other hosts, such as an Azure AI Foundry project or an API Management gateway in front, are refused. The host does not say which region answers: that is the deployment's own setting, so make it an EU data zone (or an EU region) deployment, as `infra/azure` does), `AZURE_OPENAI_DEPLOYMENT`, `AZURE_OPENAI_MODEL` (the model's name, for prices and records), optionally `AZURE_OPENAI_API_VERSION` (default `v1`, Azure's versionless API, which newer models such as gpt-5.4-mini need; or a dated version such as `2024-10-21`) | The worker's managed identity in Azure; `az login` locally (the account allows no keys; `AZURE_OPENAI_API_KEY` is only for accounts that do) |
| `bedrock` | `BEDROCK_REGION` (a UK or EU region: `eu-west-1`, `eu-west-2`, `eu-west-3`, `eu-central-1`, `eu-north-1`, `eu-south-1` or `eu-south-2`; not Zurich, `eu-central-2`), `BEDROCK_MODEL_ID` (a model, `provider.name`, or an EU inference profile `eu.provider.name`, also as an ARN in one of those regions; any other profile, such as `us.` or `global.`, anything else with three parts, application inference profiles and other regions are refused), `BEDROCK_API_KEY`; `BEDROCK_ENDPOINT` only for tests, and only a local address | A Bedrock API key (in Key Vault when deployed) |
| `demo` | None. Optionally `DEMO_SAMPLES_DIR` (default: the `samples` folder found above the current directory) | Nothing: it is not a model. It recognises the ten sample contracts (their title and first party) and answers with the answer recorded for it under the requested schema's title (`samples/demo/`), or, for a title not recorded there, its example answer from `samples/expected/` (the contract summary's); anything else fails with `model-demo-unknown`. Refused unless `DATABASE_URL` is local and the app is not in Container Apps (an app or a job). For the demo ([demo.md](demo.md)); `.env.example` sets it |

With `MODEL_PROVIDER` unset there is no model, and the worker says so when it starts; jobs whose agent has an `extract-to-schema` step (both demo agents do) then fail with `no-model`.

Structured output uses each provider's own mechanism: Azure OpenAI's JSON-schema response
format (strict, so schemas need `additionalProperties: false` and every property in
`required`), and a forced tool call on Bedrock. The gateway parses the answer; checking it
against the schema is the caller's job (task 9).

## Errors

Every failure is a `ModelError` with one of these codes, and a fixed message that never
quotes the provider, the prompt or the document (it can reach logs and Temporal's
history):

| Code | When |
| --- | --- |
| `model-rate-limited` | The provider answered 429 |
| `model-timeout` | No answer within the timeout (2 minutes by default) |
| `model-refused` | A content filter or guardrail stopped it |
| `model-bad-response` | An answer that cannot be used: malformed, cut off, bad token counts |
| `model-error` | Anything else, including an unreachable provider |
| `model-demo-unknown` | The demo model was given a document that is not one of the sample contracts |

The gateway does not retry: Temporal retries the job's attempt.

A call is recorded whatever happens. If recording a failed call fails, the model's
reason code still wins. If recording a successful call fails, that error propagates: the
attempt fails and Temporal retries it, calling (and paying for) the model again rather
than leaving a call unrecorded.

The request shapes are as the providers document them; the tests use local fakes that
refuse anything else, but only a real call shows a provider accepts them. Run
`pnpm model:smoke` once after setting up a provider.

## Usage and cost

Every call, successful or not, is a row in `model_calls`: tenant, job, agent step,
provider, model, tokens, estimated cost in US dollars, duration and outcome. A failed call
that the provider still billed (an answer refused, cut off or malformed) keeps its tokens
and cost. No prompt,
document or answer text is stored. Row-level security keeps each tenant's rows apart,
and the app can add and read rows but not change or delete them.
`modelUsageForJob` and `modelUsageForTenant` (`@agent-core/db`) give totals.

Cost comes from `packages/core/src/models/prices.json`: US dollars per million input
and output tokens, keyed `"<provider>/<model>"`. It ships empty, because prices change
and depend on region and deployment type: copy them from the provider's price page. A
successful call to a model with no price keeps its tokens and has no cost, and the
totals count such calls separately (`unpricedCalls`).

## Trying it

`pnpm model:smoke` makes one short call with the settings in `.env.local` and prints
the model, tokens and cost. Setting up Azure OpenAI is step 7 of `infra/azure/README.md`.
