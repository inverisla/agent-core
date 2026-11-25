import { latestJobsByDocument } from "@agent-core/db";
import { PortalShell } from "../../../../../components/shells.tsx";
import {
  Alert,
  Button,
  ButtonLink,
  Card,
  EmptyState,
  Field,
  FormStack,
  PageHeader,
  Select,
  StatusBadge,
  Table,
  Td,
  Th,
  Tr,
} from "../../../../../components/ui/index.ts";
import { requireTenantPage } from "../../../../../lib/auth/guards.ts";
import { maxUploadBytes } from "../../../../../lib/documents/intake.ts";
import { documentPage } from "../../../../../lib/documents/list.ts";
import { failureMessage } from "../../../../../lib/jobs/reasons.ts";
import { uploadAgents } from "../../../../../lib/jobs/start.ts";
import { db } from "../../../../../lib/server/db.ts";

// The browser tab's title (WCAG 2.4.2): "Documents · <product name>".
export const metadata = { title: "Documents" };

const ERRORS: Record<string, string> = {
  "no-file": "Choose a file to upload.",
  empty: "That file is empty.",
  "too-large": "That file is too large.",
  "unsupported-type": "Only PDF and Word (.docx) files can be uploaded.",
  "protected-or-legacy":
    "Password-protected and old-format (.doc) Word files cannot be uploaded. Save it as an unprotected .docx and try again.",
  busy: "Too many uploads are in progress. Try again in a moment.",
  "too-slow": "The upload took too long. Try again.",
  "daily-limit":
    "This portal has reached its uploads for today. Try again tomorrow, or ask your operator.",
  agent: "Choose one of the agents offered.",
  "no-agent": "No agent is set up for this tenant's uploads. Ask your operator.",
  failed: "The upload failed. Try again.",
};

function size(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export default async function DocumentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ uploaded?: string; error?: string; before?: string | string[] }>;
}) {
  const { slug } = await params;
  const { uploaded, error, before } = await searchParams;
  const me = await requireTenantPage(slug);
  // A repeated ?before= arrives as a list: use the first.
  const cursor = (Array.isArray(before) ? before[0] : before) ?? null;
  const { documents, older } = await documentPage(db(), me.tenantId, cursor);
  const jobs = await latestJobsByDocument(
    db(),
    me.tenantId,
    documents.map((d) => d.documentId),
  );
  const limitMb = Math.round(maxUploadBytes() / 1024 / 1024);
  // A choice of agent only when the tenant has more than one (task 12b).
  const agents = await uploadAgents(db(), me.tenantId).catch((error: unknown) => {
    // The upload itself refuses with its own message; the page still shows the documents.
    console.error("agents for uploads:", error instanceof Error ? error.name : "unknown error");
    return [];
  });

  return (
    <PortalShell slug={slug} me={me} current="documents">
      <PageHeader title="Documents" description="Upload a contract to have it summarised." />
      {uploaded ? <Alert tone="success">Uploaded.</Alert> : null}
      {error ? (
        <Alert tone="danger">
          {Object.hasOwn(ERRORS, error) ? ERRORS[error] : "That file could not be uploaded."}
        </Alert>
      ) : null}
      <Card title="Upload">
        {agents.length === 0 ? (
          <Alert tone="warning" testId="no-agent">
            {ERRORS["no-agent"]}
          </Alert>
        ) : (
          <form action={`/api/t/${slug}/documents`} method="post" encType="multipart/form-data">
            <FormStack>
              {agents.length > 1 ? (
                <Select
                  label="Agent"
                  hint="What to do with the document."
                  name="agent"
                  required
                  options={agents.map((a) => ({
                    value: a.definition.name,
                    label: a.definition.title,
                  }))}
                />
              ) : null}
              <Field
                label={`File (PDF or Word, up to ${limitMb} MB)`}
                type="file"
                name="file"
                accept=".pdf,.docx,application/pdf"
                required
              />
              <div>
                <Button>Upload</Button>
              </div>
            </FormStack>
          </form>
        )}
      </Card>
      {documents.length === 0 ? (
        <EmptyState title="No documents yet.">
          Uploaded documents and their jobs show here.
        </EmptyState>
      ) : (
        <Table caption="Uploaded documents">
          <thead>
            <tr>
              <Th>File</Th>
              <Th>Size</Th>
              <Th>Uploaded</Th>
              <Th>Job</Th>
            </tr>
          </thead>
          <tbody>
            {documents.map((d) => {
              const job = jobs.get(d.documentId);
              return (
                <Tr key={d.documentId}>
                  <Td>{d.filename}</Td>
                  <Td>{size(d.sizeBytes)}</Td>
                  <Td>{d.createdAt.toISOString().slice(0, 16).replace("T", " ")} UTC</Td>
                  <Td>
                    {job ? (
                      <div className="space-y-1">
                        <a
                          href={`/t/${slug}/jobs/${job.jobId}`}
                          className="group inline-flex min-h-6 items-center gap-2 no-underline"
                        >
                          <StatusBadge status={job.status} />
                          <span className="underline underline-offset-2 group-hover:no-underline">
                            View
                          </span>
                          <span className="sr-only"> job for {d.filename}</span>
                          {job.attempts > 1 ? (
                            <span className="text-xs">({job.attempts} attempts)</span>
                          ) : null}
                        </a>
                        {job.status === "failed" ? (
                          <p className="text-sm text-muted">{failureMessage(job.errorCode)}</p>
                        ) : null}
                      </div>
                    ) : (
                      "none"
                    )}
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      )}
      {older || before ? (
        <nav aria-label="Pages of documents" className="mt-4 flex flex-wrap gap-3">
          {before ? <ButtonLink href={`/t/${slug}/documents`}>Newest documents</ButtonLink> : null}
          {older ? (
            <ButtonLink href={`/t/${slug}/documents?before=${encodeURIComponent(older)}`}>
              Older documents
            </ButtonLink>
          ) : null}
        </nav>
      ) : null}
    </PortalShell>
  );
}
