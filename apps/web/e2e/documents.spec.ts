// Document intake through the portal and the API (task 4).
import { readFile } from "node:fs/promises";
import { docxBodyText, makeTextPdf, SAMPLE_CONTRACT_PAGES } from "@agent-core/blocks/testing";
import { agentForUploads, agentRegistry } from "@agent-core/core/agents";
import { expect, request, test, type BrowserContext } from "@playwright/test";
import { makeDocx, makeExe, makePdf } from "../lib/documents/test-files.ts";
import { SESSION_COOKIE, sessionCookie } from "./sessions.ts";
import { BASE_URL, readState } from "./state.ts";

const state = readState();
const { a, b } = state;

const identity = (t: typeof a | typeof b, userId: string) => ({
  kind: "tenant" as const,
  tenantId: t.tenantId,
  slug: t.slug,
  userId,
  role: "tenant_user" as const,
  expiresAt: Date.now() + 3_600_000,
});

async function signIn(context: BrowserContext, t: typeof a | typeof b, userId: string) {
  const cookie = await sessionCookie(identity(t, userId), state.authSecret);
  await context.addCookies([
    {
      name: SESSION_COOKIE,
      value: cookie.slice(SESSION_COOKIE.length + 1),
      domain: "localhost",
      path: "/",
    },
  ]);
}

test.describe.configure({ mode: "serial" });

test("a tenant user uploads a PDF and a Word file, and sees them listed", async ({ browser }) => {
  const context = await browser.newContext();
  await signIn(context, a, a.user.userId);
  const page = await context.newPage();
  await page.goto(`/t/${a.slug}/documents`);

  await page.getByLabel(/File \(PDF or Word/).setInputFiles({
    name: "Supplier Agreement.pdf",
    mimeType: "application/pdf",
    buffer: makePdf(),
  });
  await page.getByRole("button", { name: "Upload" }).click();
  await expect(page.locator("main").getByRole("status")).toHaveText("Uploaded.");
  await expect(
    page.getByRole("cell", { name: "Supplier Agreement.pdf", exact: true }),
  ).toBeVisible();

  await page.getByLabel(/File \(PDF or Word/).setInputFiles({
    name: "terms.docx",
    mimeType: "application/octet-stream",
    buffer: makeDocx(),
  });
  await page.getByRole("button", { name: "Upload" }).click();
  await expect(page.getByRole("cell", { name: "terms.docx", exact: true })).toBeVisible();
  await context.close();
});

test("a renamed executable is rejected with a clear message", async ({ browser }) => {
  const context = await browser.newContext();
  await signIn(context, a, a.user.userId);
  const page = await context.newPage();
  await page.goto(`/t/${a.slug}/documents`);
  await page
    .getByLabel(/File \(PDF or Word/)
    .setInputFiles({ name: "invoice.pdf", mimeType: "application/pdf", buffer: makeExe() });
  await page.getByRole("button", { name: "Upload" }).click();
  await expect(page.locator("main").getByRole("alert")).toHaveText(
    "Only PDF and Word (.docx) files can be uploaded.",
  );
  await expect(page.getByRole("cell", { name: "invoice.pdf", exact: true })).toHaveCount(0);
  await context.close();
});

test("the API takes uploads, refuses oversize files, and lists only the caller's tenant", async () => {
  const cookieFor = async (t: typeof a | typeof b, userId: string) =>
    request.newContext({
      baseURL: BASE_URL,
      extraHTTPHeaders: {
        cookie: await sessionCookie(identity(t, userId), state.authSecret),
        accept: "application/json",
      },
    });
  const asA = await cookieFor(a, a.user.userId);
  const ok = await asA.post(`/api/t/${a.slug}/documents`, {
    multipart: { file: { name: "api.pdf", mimeType: "application/pdf", buffer: makePdf() } },
  });
  expect(ok.status()).toBe(201);
  const { documentId } = (await ok.json()) as { documentId: string };

  // The e2e server's limit is 1 MB.
  const big = await asA.post(`/api/t/${a.slug}/documents`, {
    multipart: {
      file: { name: "big.pdf", mimeType: "application/pdf", buffer: makePdf(2 * 1024 * 1024) },
    },
  });
  expect(big.status()).toBe(413);
  expect(await big.json()).toMatchObject({ error: "too-large" });

  const listA = (await (await asA.get(`/api/t/${a.slug}/documents`)).json()) as {
    documents: { documentId: string }[];
  };
  expect(listA.documents.map((d) => d.documentId)).toContain(documentId);

  const asB = await cookieFor(b, b.user.userId);
  const listB = (await (await asB.get(`/api/t/${b.slug}/documents`)).json()) as {
    documents: { documentId: string }[];
  };
  expect(listB.documents.map((d) => d.documentId)).not.toContain(documentId);
  // And B cannot upload into A's portal.
  const intoA = await asB.post(`/api/t/${a.slug}/documents`, {
    multipart: { file: { name: "x.pdf", mimeType: "application/pdf", buffer: makePdf() } },
  });
  expect(intoA.status()).toBe(403);
  await asA.dispose();
  await asB.dispose();
});

test("a cross-site upload is refused", async () => {
  const ctx = await request.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: {
      cookie: await sessionCookie(identity(a, a.user.userId), state.authSecret),
      origin: "https://evil.example",
    },
  });
  const res = await ctx.post(`/api/t/${a.slug}/documents`, {
    multipart: { file: { name: "x.pdf", mimeType: "application/pdf", buffer: makePdf() } },
  });
  expect(res.status()).toBe(403);
  await ctx.dispose();
});

test("a chunked upload with no declared length is cut off at the limit", async () => {
  const cookie = await sessionCookie(identity(a, a.user.userId), state.authSecret);
  // 512 MB of a "PDF" in 64 KB chunks, with no Content-Length; the e2e limit is 1 MB.
  // Far more than the client's send buffer and the server's receive buffer can hold
  // between them (8 MB fitted in them on some CI runners), so a server that stops reading
  // leaves most of it unsent. Chunks are only made as they are read, so this costs
  // nothing when the server works. upload-body.test.ts checks the exact stopping point.
  const total = 512 * 1024 * 1024;
  const chunk = makePdf(64 * 1024);
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= total) return controller.close();
      sent += chunk.length;
      controller.enqueue(new Uint8Array(chunk));
    },
  });
  const boundary = "----e2e";
  const res = await fetch(`${BASE_URL}/api/t/${a.slug}/documents`, {
    method: "POST",
    headers: {
      cookie,
      accept: "application/json",
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    body,
    duplex: "half",
  } as RequestInit).catch(() => null);
  // The server answers 413 and stops reading the rest. If the connection is dropped
  // before the client sees the answer, that also counts as refused.
  if (res) expect(res.status).toBe(413);
  expect(sent).toBeLessThan(total);
  // And it is still serving.
  const health = await fetch(`${BASE_URL}/api/health`);
  expect(health.status).toBe(200);
});

test("uploads need a tenant member's session", async () => {
  const post = async (cookie?: string) => {
    const ctx = await request.newContext({
      baseURL: BASE_URL,
      extraHTTPHeaders: { accept: "application/json", ...(cookie ? { cookie } : {}) },
    });
    const res = await ctx.post(`/api/t/${a.slug}/documents`, {
      multipart: { file: { name: "x.pdf", mimeType: "application/pdf", buffer: makePdf() } },
    });
    await ctx.dispose();
    return res.status();
  };
  expect(await post()).toBe(401);
  const operator = await sessionCookie(
    {
      kind: "operator",
      oid: "00000000-0000-0000-0000-000000000001",
      name: "Op",
      email: null,
      expiresAt: Date.now() + 3_600_000,
    },
    state.authSecret,
  );
  expect(await post(operator)).toBe(403);
});

test("a crafted error link does not break the documents page", async ({ browser }) => {
  const context = await browser.newContext();
  await signIn(context, a, a.user.userId);
  const page = await context.newPage();
  for (const error of ["constructor", "__proto__", "toString"]) {
    const res = await page.goto(`/t/${a.slug}/documents?error=${error}`);
    expect(res?.status()).toBe(200);
    await expect(page.locator("main").getByRole("alert")).toHaveText(
      "That file could not be uploaded.",
    );
  }
  await context.close();
});

test("an upload runs its agent, and a reviewer edits, sends back and approves the draft", async ({
  browser,
}) => {
  const context = await browser.newContext();
  await signIn(context, a, a.user.userId);
  const page = await context.newPage();
  await page.goto(`/t/${a.slug}/documents`);
  await page.getByLabel(/File \(PDF or Word/).setInputFiles({
    name: "Job Test.pdf",
    mimeType: "application/pdf",
    // A real contract's worth of text, for the agent's steps to work on.
    buffer: makeTextPdf(SAMPLE_CONTRACT_PAGES),
  });
  await page.getByRole("button", { name: "Upload" }).click();
  const row = page.getByRole("row").filter({ hasText: "Job Test.pdf" });
  await row.getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/t/${a.slug}/jobs/[0-9a-f-]{36}$`));
  const status = page.getByTestId("job-status");
  await expect(async () => {
    await page.reload();
    await expect(status).toHaveText("awaiting review");
  }).toPass({ timeout: 30_000 });
  // Task 7's done-when: the job records the agent and the version computed from its files.
  const agent = agentForUploads(await agentRegistry(process.env), process.env);
  await expect(page.getByText(`${agent.definition.name} (${agent.version})`)).toBeVisible();

  // Task 11: the document's text beside the draft, which can be edited.
  await expect(page.getByTestId("source-text")).toContainText("Example Widgets Ltd (the Supplier)");
  const form = page.getByTestId("review-form");
  await expect(form.getByLabel("Term", { exact: true })).toHaveValue("24 months");

  // Send it back with a reason: the agent runs again, and the new draft comes back.
  await page.getByLabel("Why are you sending it back?").fill("Give the start date too.");
  await page.getByRole("button", { name: "Send back" }).click();
  await expect(page.getByTestId("review-outcome")).toContainText("Sent back");
  await expect(async () => {
    await page.reload();
    await expect(status).toHaveText("awaiting review");
    await expect(page.getByText("run 2", { exact: false }).first()).toBeVisible();
  }).toPass({ timeout: 30_000 });

  // Edit a field, save, then approve.
  await form.getByLabel("Term", { exact: true }).fill("36 months from 1 April 2026");
  await form.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByTestId("review-outcome")).toHaveText("Your changes are saved.");
  await expect(form.getByLabel("Term", { exact: true })).toHaveValue("36 months from 1 April 2026");
  await form.getByRole("button", { name: "Approve" }).click();
  await expect(async () => {
    await page.reload();
    await expect(status).toHaveText("approved");
  }).toPass({ timeout: 30_000 });

  // Every edit and decision is in the history.
  const history = page.getByRole("region", { name: "Review history" });
  await expect(history).toContainText("Sent back: Give the start date too.");
  await expect(history).toContainText("Edited term: 24 months → 36 months from 1 April 2026");
  await expect(history).toContainText("Approved");
  // Both runs' attempts are listed: a header and one attempt per run.
  await expect(page.getByRole("region", { name: "Attempts" }).getByRole("row")).toHaveCount(3);

  // The approved fields, and the report written from them.
  const fields = page.getByTestId("job-fields");
  await expect(fields).toContainText("36 months from 1 April 2026");
  const download = page.waitForEvent("download");
  await page.getByTestId("job-report").click();
  const report = await download;
  expect(report.suggestedFilename()).toMatch(/^report-[0-9a-f-]{36}\.docx$/);
  const bytes = await readFile((await report.path()) ?? "");
  expect(docxBodyText(bytes)).toContain("36 months from 1 April 2026");
  await context.close();
});

test("a job that fails says why, in plain words", async ({ browser }) => {
  const context = await browser.newContext();
  await signIn(context, a, a.user.userId);
  const page = await context.newPage();
  await page.goto(`/t/${a.slug}/documents`);
  await page.getByLabel(/File \(PDF or Word/).setInputFiles({
    name: "Scanned.pdf",
    mimeType: "application/pdf",
    buffer: makeTextPdf([[]]), // no text, as a scan has
  });
  await page.getByRole("button", { name: "Upload" }).click();
  const row = page.getByRole("row").filter({ hasText: "Scanned.pdf" });
  const message = "This document has no text we can read.";
  await expect(async () => {
    await page.reload();
    await expect(row).toContainText(message);
  }).toPass({ timeout: 30_000 });
  await row.getByRole("link").click();
  await expect(page.getByTestId("job-status")).toHaveText("failed");
  await expect(page.getByTestId("job-failure")).toContainText(message);
  await expect(page.getByTestId("job-report")).toHaveCount(0);
  await context.close();
});

test("another tenant cannot download a job's report", async () => {
  const ctx = await request.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { cookie: await sessionCookie(identity(b, b.user.userId), state.authSecret) },
  });
  const res = await ctx.get(`/api/t/${b.slug}/jobs/${state.aJobId}/report`);
  expect(res.status()).toBe(404);
  await ctx.dispose();
});

test("another tenant's job is not found", async () => {
  const ctx = await request.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { cookie: await sessionCookie(identity(b, b.user.userId), state.authSecret) },
  });
  const res = await ctx.get(`/api/t/${b.slug}/jobs/${state.aJobId}`);
  expect(res.status()).toBe(404);
  await ctx.dispose();
});
