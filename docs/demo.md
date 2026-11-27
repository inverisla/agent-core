# The demo

About eleven minutes, on your own machine, with nothing to sign up for. You play two
people: the admin of a tenant (one of the client's customers), who also reviews its
documents, and an operator (the client's own staff). `pnpm demo` also made a plain user,
`reviewer@demo-ltd.example`, if you want to sign in as someone who is not an admin.

Start with the quick start in the [README](../README.md): it ends with `pnpm demo` and
`pnpm dev`, and the web app at http://localhost:3000.

**The demo model.** Out of the box, `.env.example` sets `MODEL_PROVIDER=demo`. That is not
AI: it recognises the ten sample contracts in `samples/files/` and answers with the answers
recorded for each one (`samples/expected/` and `samples/demo/`, one per model step). Upload anything else and the job fails with a
message saying so. To see a real model read your own contracts, set up Azure OpenAI or
Bedrock instead ([models.md](models.md)); everything below works the same.

## 1. Sign in as the tenant's admin (1 minute)

`pnpm demo` made a tenant, Demo Ltd, whose portal is http://localhost:3000/t/demo-ltd.

1. Open http://localhost:3000/t/demo-ltd/sign-in, enter `admin@demo-ltd.example`, and
   choose **Email me a sign-in link**.
2. Locally, emails are written to files instead of sent: open the newest `.json` file in
   `apps/web/.dev-outbox/` and open the link in its `text`. Choose **Sign in**.

You are on the portal's home page, signed in as an admin.

## 2. Documents and their jobs (2 minutes)

Choose **Documents**. `pnpm demo` uploaded three sample contracts; with `pnpm dev`
running, the worker has already summarised each one, so each shows **awaiting review**.

Upload a fourth yourself. Demo Ltd may use two agents, so the form asks which: choose
**Supplier contract summary** as the **Agent**, a file from `samples/files/` (say
`03-cleaning.pdf`), and **Upload**. Its job appears, and moves to awaiting review within a
few seconds (refresh the page).

## 3. Review and approve (3 minutes)

Choose **View** beside a document. The review screen shows the contract's text on one
side and the fields the agent drew from it on the other: the parties and their roles,
the term, renewal, notice and fees.

1. Change a field, for example shorten **Fees**, and choose **Save changes**. The edit is
   recorded with who made it.
2. Choose **Approve**. The worker writes the Word report again from the reviewed fields.
3. Choose **Download the report (Word)** (refresh if it is not there yet) and open it.

(**Send back**, with a reason, would instead run the agent again, giving it that reason.)

## 4. Try the risk review (2 minutes)

The second agent, **Supplier contract risk review**, checks a contract against a sample
purchasing policy in two model steps: one finds what the contract says on each policy
topic, the next judges each rule from the contract, guided by the first step's answer.

1. Choose **Documents**, choose **Supplier contract risk review** as the **Agent**, then
   `samples/files/06-warehousing.pdf`, and **Upload**. Refresh until it is awaiting review.
2. Choose **View**. There is one finding per policy rule: what the contract says, the
   result (meets, falls short, missing or not applicable) and why. Each result is a
   choice: change one and choose **Save changes**.
3. Choose **Approve**, then **Download the report (Word)**: a one-page table of the
   findings.

How the agent is built, and how to put in your own policy: [`agents/contract-risk/README.md`](../agents/contract-risk/README.md).

## 5. The tenant admin's view (1 minute)

Choose **Admin**:

- **Users**: add someone (they are emailed the portal's address; again, see the outbox),
  change a role, remove someone. A tenant can never be left without an admin.
- **Activity**: who changed users and settings in this portal, and who signed in (your
  own sign-in is there), with a CSV of the whole log. Nobody can change or delete it.
  (Edits and decisions on documents are kept with each document's review.)
- **Sign-in settings**: work account sign-in (Microsoft or Google), which the operator
  links, and email links.

## 6. The operator console (2 minutes)

Sign out, then open http://localhost:3000/operator/sign-in and choose **Sign in as the
local operator**. (That button only exists on your own machine; on a deployment,
operators sign in with Microsoft. See [`infra/azure/README.md`](../infra/azure/README.md),
step 6.)

- **Tenants**: every tenant, with its users and how it signs in. Open Demo Ltd to add an
  admin, link Microsoft or Google sign-in, choose which agents its users may use, and see
  its activity. **New tenant** makes another, with its first admin.
- **Agents**: each demo agent's version, steps and files (its prompts and output schemas),
  which tenants use it, and how many jobs each version ran. With a real model the
  worker also runs each new version's test set once and shows the results here; the
  demo model does not, since it only repeats recorded answers.
- **Jobs**: every tenant's jobs, with status, attempts and reason codes only; find one by
  its ID (the review screen's address in the portal ends with it).
- **Usage**: each tenant's documents, jobs, model calls, tokens and estimated cost this
  month, and **Download CSV**. (The demo model costs nothing.)

## 7. Comparing agent versions (optional; needs a real model)

The demo model only repeats recorded answers, so `agent:compare` refuses it; set up a
real model first ([models.md](models.md)).

Agents are files under `agents/`. Change the demo agent's prompt
(`agents/contract-summary/prompts/extract.md`), then run

```bash
pnpm agent:compare -- --agent contract-summary --base origin/main
```

It runs the ten samples through both versions and writes a side-by-side report of
accuracy per field to `test-results/agent-compare/`. The same works for the risk review
(`--agent contract-risk`), with its own test set. See [agents.md](agents.md).

## Starting again

`docker compose down -v` deletes everything the demo made; then `docker compose up -d
--wait` and `pnpm demo` set it up afresh.

## On Azure

The same product runs on Azure, with real sign-in, email and monitoring:
[`infra/azure/README.md`](../infra/azure/README.md) sets up a dev environment, and
[operations.md](operations.md) covers alerts, backups and restores.
