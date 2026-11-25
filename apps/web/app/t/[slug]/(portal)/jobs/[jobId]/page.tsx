import { MAX_NOTE_CHARS, type ReviewEvent } from "@agent-core/db";
import { notFound } from "next/navigation";
import { ReviewForm } from "../../../../../../components/review-form.tsx";
import { PortalShell } from "../../../../../../components/shells.tsx";
import {
  Alert,
  Button,
  ButtonLink,
  Card,
  HiddenField,
  PageHeader,
  StatusBadge,
  Table,
  Td,
  TextArea,
  Th,
  Tr,
} from "../../../../../../components/ui/index.ts";
import { requireTenantPage } from "../../../../../../lib/auth/guards.ts";
import { Fields } from "../../../../../../lib/jobs/fields.tsx";
import { failureMessage } from "../../../../../../lib/jobs/reasons.ts";
import {
  approveAction,
  resendDecisionAction,
  saveReviewAction,
  sendBackAction,
} from "../../../../../../lib/jobs/review-actions.ts";
import {
  fieldOrder,
  jobFieldsSchema,
  jobText,
  tenantJob,
  tenantJobOutput,
  tenantReviewHistory,
} from "../../../../../../lib/jobs/view.ts";

// The browser tab's title (WCAG 2.4.2): "Job · <product name>".
export const metadata = { title: "Job" };

const time = (d: Date | null) => (d ? `${d.toISOString().slice(0, 19).replace("T", " ")} UTC` : "");

/** What the last review action did, from the page's ?review= parameter. */
const OUTCOMES: Record<string, { tone: "success" | "danger" | "info"; text: string }> = {
  saved: { tone: "success", text: "Your changes are saved." },
  approved: {
    tone: "success",
    text: "Approved. The report is being written from the reviewed fields.",
  },
  "sent-back": { tone: "success", text: "Sent back. The agent is running again with your reason." },
  stale: {
    tone: "danger",
    text: "Someone else changed this draft since you opened it, or the agent produced a new one. Your changes were not saved: reload the page and make them again.",
  },
  invalid: {
    tone: "danger",
    text: "Those values do not fit the summary's fields. Nothing was saved.",
  },
  note: {
    tone: "danger",
    text: `Say why you are sending it back (up to ${MAX_NOTE_CHARS} characters).`,
  },
  "not-awaiting-review": { tone: "info", text: "This job is not waiting for review any more." },
  decided: {
    tone: "info",
    text: "A decision on this draft was already made, so it cannot be changed or decided again.",
  },
  "agent-changed": {
    tone: "danger",
    text: "The agent has changed since this job ran, so its fields cannot be edited. You can still approve it or send it back.",
  },
  "not-delivered": {
    tone: "danger",
    text: "Your decision is recorded, but the job could not be told yet. Try sending it again.",
  },
};

const KIND: Record<ReviewEvent["kind"], string> = {
  edit: "Edited",
  approve: "Approved",
  send_back: "Sent back",
};

const show = (v: unknown) =>
  v === null || v === undefined ? "Not stated" : typeof v === "string" ? v : JSON.stringify(v);

export default async function JobPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; jobId: string }>;
  searchParams: Promise<{ review?: string }>;
}) {
  const { slug, jobId } = await params;
  const { review } = await searchParams;
  const me = await requireTenantPage(slug);
  const job = await tenantJob(me.tenantId, jobId);
  if (!job) notFound();
  const reviewing = job.status === "awaiting_review";
  const done = job.status === "approved" || job.status === "succeeded";
  const output = reviewing || done ? await tenantJobOutput(me.tenantId, jobId) : null;
  const history = await tenantReviewHistory(me.tenantId, jobId);
  const lastAttempt = job.attempts.at(-1);
  const schema = output ? await jobFieldsSchema(job.agentName, job.agentVersion) : null;
  const order = output ? await fieldOrder(job.agentName, job.agentVersion) : [];
  const text = reviewing ? await jobText(me.tenantId, jobId) : null;
  // A decision on this run that the workflow has not acted on yet.
  const pending = reviewing
    ? history.filter((e) => e.run === job.run).findLast((e) => e.kind !== "edit")
    : undefined;
  const outcome = review && Object.hasOwn(OUTCOMES, review) ? OUTCOMES[review] : undefined;
  const fields = output?.reviewedFields ?? output?.fields ?? null;
  const bind = (action: (s: string, j: string, formData: FormData) => Promise<void>) =>
    action.bind(null, slug, job.jobId);

  return (
    <PortalShell slug={slug} me={me} current="documents" inside>
      <PageHeader
        title={reviewing ? "Review" : "Job"}
        description={
          <>
            Agent: {job.agentName} ({job.agentVersion}){job.run > 1 ? `, run ${job.run}` : ""}
          </>
        }
        actions={<ButtonLink href={`/t/${slug}/documents`}>Back to documents</ButtonLink>}
      />
      <p className="flex items-center gap-2">
        <span className="font-semibold">Status</span>
        <StatusBadge status={job.status} testId="job-status" />
      </p>
      {outcome ? (
        <Alert tone={outcome.tone} testId="review-outcome">
          {outcome.text}
        </Alert>
      ) : null}
      {job.status === "failed" ? (
        <Alert tone="danger" testId="job-failure">
          {failureMessage(lastAttempt?.errorCode)}
        </Alert>
      ) : null}

      {reviewing && pending ? (
        <Card title="Decision recorded">
          <p>
            {pending.kind === "approve" ? "This draft was approved" : "This draft was sent back"} by{" "}
            {pending.userName ?? "a former user"}. The job picks it up in a moment; refresh to see
            it. If nothing happens, send the decision again.
          </p>
          <form action={resendDecisionAction.bind(null, slug, job.jobId)}>
            <Button variant="secondary">Send the decision again</Button>
          </form>
        </Card>
      ) : null}

      {reviewing && output && fields && !pending ? (
        <div className="grid gap-6 lg:grid-cols-2">
          <section className="space-y-3" aria-labelledby="source-heading">
            <h2 id="source-heading" className="text-lg font-semibold">
              The document
            </h2>
            {text ? (
              <div
                className="max-h-[70vh] overflow-y-auto rounded-lg border border-line bg-surface p-4 text-sm leading-relaxed whitespace-pre-wrap"
                tabIndex={0}
                role="region"
                aria-label="The document's text"
                data-testid="source-text"
              >
                {text}
              </div>
            ) : (
              <Alert>The document&apos;s text is not available for this job.</Alert>
            )}
          </section>
          <section className="space-y-6" aria-labelledby="draft-heading">
            <h2 id="draft-heading" className="text-lg font-semibold">
              The draft
            </h2>
            {schema ? (
              <ReviewForm
                // A new revision or run starts the form again from the server's values, so a
                // refused save cannot be resent with the newer revision.
                key={`${job.run}-${output.revision}`}
                schema={schema}
                fields={fields}
                revision={output.revision}
                save={bind(saveReviewAction)}
                approve={bind(approveAction)}
              />
            ) : (
              <Card>
                <Alert>
                  The agent has changed since this job ran, so these fields cannot be edited.
                </Alert>
                <Fields fields={fields} order={order} />
                <form action={bind(approveAction)}>
                  <HiddenField name="revision" value={output.revision} />
                  <Button>Approve</Button>
                </form>
              </Card>
            )}
            <Card title="Send back">
              <form action={bind(sendBackAction)} className="space-y-3">
                <HiddenField name="revision" value={output.revision} />
                <TextArea
                  label="Why are you sending it back?"
                  hint="The agent runs again with your reason, and its new draft comes back for review. The new draft replaces this one, edits included (they stay in the history)."
                  name="note"
                  required
                  maxLength={MAX_NOTE_CHARS}
                />
                <Button variant="danger">Send back</Button>
              </form>
            </Card>
          </section>
        </div>
      ) : null}

      {done && output && fields ? (
        <Card title="Summary">
          {output.hasReport ? (
            <ButtonLink href={`/api/t/${slug}/jobs/${job.jobId}/report`} variant="primary">
              <span data-testid="job-report">Download the report (Word)</span>
            </ButtonLink>
          ) : null}
          <Fields fields={fields} order={order} />
        </Card>
      ) : null}

      {history.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Review history</h2>
          <Table caption="Review history">
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Who</Th>
                <Th>What</Th>
              </tr>
            </thead>
            <tbody>
              {history.map((e) => (
                <Tr key={e.eventId}>
                  <Td>{time(e.createdAt)}</Td>
                  <Td>{e.userName ?? "A former user"}</Td>
                  <Td>
                    <span className="font-semibold">{KIND[e.kind]}</span>
                    {e.kind === "edit" ? (
                      <>
                        {" "}
                        {e.field}: <s>{show(e.oldValue)}</s> → {show(e.newValue)}
                      </>
                    ) : null}
                    {e.kind === "send_back" ? <>: {e.note}</> : null}
                    {job.run > 1 ? <span className="text-muted"> (run {e.run})</span> : null}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </section>
      ) : null}

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Attempts</h2>
        {job.attempts.length === 0 ? (
          <p className="text-muted">Not started yet.</p>
        ) : (
          <Table caption="Attempts">
            <thead>
              <tr>
                <Th>Run</Th>
                <Th>Attempt</Th>
                <Th>Outcome</Th>
                <Th>Reason</Th>
                <Th>Started</Th>
                <Th>Finished</Th>
              </tr>
            </thead>
            <tbody>
              {job.attempts.map((a) => (
                <Tr key={`${a.run}-${a.attempt}`}>
                  <Td>{a.run}</Td>
                  <Td>{a.attempt}</Td>
                  <Td>{a.outcome}</Td>
                  <Td>{a.outcome === "failed" ? failureMessage(a.errorCode) : ""}</Td>
                  <Td>{time(a.startedAt)}</Td>
                  <Td>{time(a.finishedAt)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>
    </PortalShell>
  );
}
