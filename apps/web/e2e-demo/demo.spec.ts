// docs/demo.md, step by step, against the demo the README's quick start sets up: the
// sample contracts are summarised by the demo model, a person reviews and approves one
// and gets its Word report, and the operator sees the tenant and its usage.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const SLUG = "demo-ltd";
const ADMIN = "admin@demo-ltd.example";
const OUTBOX = path.join(import.meta.dirname, "..", ".dev-outbox");
const SAMPLE = path.join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "samples",
  "files",
  "03-cleaning.pdf",
);

/** The link in the newest email to `to`, after `since` (ms). */
async function newestLink(to: string, since: number): Promise<string> {
  let link: string | undefined;
  await expect
    .poll(
      () => {
        // The outbox folder appears with the first email.
        if (!existsSync(OUTBOX)) return false;
        const files = readdirSync(OUTBOX)
          .map((f) => path.join(OUTBOX, f))
          .filter((f) => statSync(f).mtimeMs >= since)
          .map((f) => JSON.parse(readFileSync(f, "utf8")) as { to: string; text: string })
          .filter((m) => m.to === to);
        link = /https?:\/\/\S+/.exec(files.at(-1)?.text ?? "")?.[0];
        return Boolean(link);
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  return link ?? "";
}

/** Reloads until every document's job shows this status (jobs run in the background). */
async function allJobs(page: Page, status: string, count: number) {
  await expect
    .poll(
      async () => {
        await page.reload();
        return page.getByRole("row").filter({ hasText: status }).count();
      },
      { timeout: 120_000, intervals: [2000] },
    )
    .toBe(count);
}

test("the demo, as docs/demo.md describes it", async ({ page }) => {
  // 1. Sign in as the tenant's admin, with the link from the outbox.
  const since = Date.now() - 1000;
  await page.goto(`/t/${SLUG}/sign-in`);
  await page.getByLabel("Email address").fill(ADMIN);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await page.goto(await newestLink(ADMIN, since));
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(new RegExp(`/t/${SLUG}$`));

  // 2. The three seeded contracts, summarised by the demo model; then one more.
  const nav = page.getByRole("navigation", { name: "Main" });
  await nav.getByRole("link", { name: "Documents" }).click();
  await allJobs(page, "awaiting review", 3);
  await page.getByLabel(/File \(PDF or Word/).setInputFiles(SAMPLE);
  await page.getByRole("button", { name: "Upload" }).click();
  await expect(page.getByRole("cell", { name: "03-cleaning.pdf", exact: true })).toBeVisible();
  await allJobs(page, "awaiting review", 4);

  // 3. Review: edit a field, save, approve, and download the Word report.
  await page
    .getByRole("row")
    .filter({ hasText: "03-cleaning.pdf" })
    .getByRole("link", { name: /View/ })
    .click();
  // In development mode the form becomes interactive a moment after it appears.
  await page.waitForLoadState("networkidle");
  const fees = page.getByLabel("Fees", { exact: true });
  await fees.fill("Monthly fee as stated in the schedule (edited in the demo).");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Your changes are saved.")).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect(fees).toHaveValue("Monthly fee as stated in the schedule (edited in the demo).");
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("Approved. The report is being written")).toBeVisible();
  const download = page.getByRole("link", { name: "Download the report (Word)" });
  await expect
    .poll(
      async () => {
        await page.reload();
        return download.count();
      },
      { timeout: 60_000, intervals: [2000] },
    )
    .toBe(1);
  const report = await page.request.get((await download.getAttribute("href")) ?? "");
  expect(report.status()).toBe(200);
  expect((await report.body()).subarray(0, 2).toString()).toBe("PK");

  // 4. The tenant admin's activity: their own sign-in is there.
  await page.goto(`/t/${SLUG}/admin/activity`);
  await expect(page.getByRole("row").filter({ hasText: ADMIN }).first()).toContainText(
    "Signed in with an email link",
  );

  // 5. The operator console, with the local operator sign-in.
  await page.goto("/operator/sign-in");
  await page.getByRole("button", { name: "Sign in as the local operator" }).click();
  await expect(page).toHaveURL(/\/operator$/);
  await expect(page.getByRole("row").filter({ hasText: "Demo Ltd" })).toBeVisible();
  await nav.getByRole("link", { name: "Usage", exact: true }).click();
  // Four documents and four jobs this month, from the demo model.
  await expect(
    page.getByRole("row").filter({ hasText: "Demo Ltd" }).getByRole("cell").nth(1),
  ).toHaveText("4");
});
