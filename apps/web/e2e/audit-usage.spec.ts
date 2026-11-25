// Task 13's done-when, second half: usage per tenant exports, through the operator
// console. (That audit rows cannot be edited is tested against the database itself, in
// packages/db/test/audit.integration.test.ts.) Also: a tenant admin sees their portal's
// activity, including refused sign-ins, and can download it.
import { randomUUID } from "node:crypto";
import {
  createTenantDatabase,
  createTenantWithAdmin,
  listTenantUsers,
  schema,
  type TenantDatabase,
} from "@agent-core/db";
import { expect, test, type Browser } from "@playwright/test";
import { personas, state } from "./matrix.ts";
import { sessionCookie } from "./sessions.ts";
import { BASE_URL } from "./state.ts";

test.describe.configure({ mode: "serial" });

const suffix = randomUUID().slice(0, 8);
const slug = `usage-${suffix}`;
const adminEmail = `admin-${suffix}@usage.example`;
const month = new Date().toISOString().slice(0, 7);
let db: TenantDatabase;
let tenantId = "";
let adminId = "";

test.beforeAll(async () => {
  db = createTenantDatabase(state.appUrl, {
    contextKey: Buffer.from(state.contextKeyBase64, "base64"),
    maxConnections: 1,
  });
  tenantId = await createTenantWithAdmin(
    db,
    { name: `Usage ${suffix} Ltd`, slug, adminEmail },
    { kind: "operator", oid: "e2e-operator", label: "op@client.example" },
  );
  adminId = (await listTenantUsers(db, tenantId))[0]?.userId ?? "";
  // Known work this month: 2 documents; one approved job with 2 model calls, one failed.
  await db.withTenant(tenantId, async (tx) => {
    for (const status of ["approved", "failed"] as const) {
      const [doc] = await tx
        .insert(schema.documents)
        .values({
          tenantId,
          filename: `${status}.pdf`,
          contentType: "application/pdf",
          sizeBytes: 1,
          blobPath: `p-${status}`,
          sha256: "s",
          uploadedBy: adminId,
        })
        .returning();
      const [job] = await tx
        .insert(schema.jobs)
        .values({
          tenantId,
          documentId: doc?.documentId ?? "",
          agentName: "contract-summary",
          agentVersion: "v",
          status,
        })
        .returning();
      if (status === "approved") {
        for (const [input, output, cost] of [
          [1200, 300, "0.0150"],
          [800, 100, "0.0075"],
        ] as const) {
          await tx.insert(schema.modelCalls).values({
            tenantId,
            jobId: job?.jobId ?? "",
            step: "fields",
            provider: "azure-openai",
            model: "m",
            outcome: "succeeded",
            inputTokens: input,
            outputTokens: output,
            costUsd: cost,
            durationMs: 1,
          });
        }
      }
    }
  });
});

test.afterAll(async () => {
  await db?.close();
});

async function as(browser: Browser, cookie: string) {
  const context = await browser.newContext();
  const at = cookie.indexOf("=");
  await context.addCookies([
    { name: cookie.slice(0, at), value: cookie.slice(at + 1), url: BASE_URL },
  ]);
  return context;
}

const adminCookie = () =>
  sessionCookie(
    {
      kind: "tenant",
      tenantId,
      slug,
      userId: adminId,
      role: "tenant_admin",
      expiresAt: Date.now() + 3_600_000,
    },
    state.authSecret,
  );

test("an operator sees each tenant's usage for a month, and exports it as CSV", async ({
  browser,
}) => {
  const context = await as(browser, (await personas.operator()) ?? "");
  const page = await context.newPage();
  await page.goto("/operator");
  await page.getByRole("link", { name: "Usage", exact: true }).click();
  await expect(page).toHaveURL(/\/operator\/usage$/);
  const row = page.getByRole("row").filter({ hasText: `Usage ${suffix} Ltd` });
  // Documents, jobs, approved, awaiting review, failed, in progress, model calls, failed
  // calls, input tokens, output tokens, cost.
  await expect(row.getByRole("cell")).toHaveText([
    `Usage ${suffix} Ltd`,
    "2",
    "2",
    "1",
    "0",
    "1",
    "0",
    "2",
    "0",
    "2,000",
    "400",
    "$0.02",
  ]);

  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download CSV" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe(`usage-${month}.csv`);
  const csv = (await (await file.createReadStream()).toArray()).join("");
  const lines = csv.replace(/^\uFEFF/, "").split("\r\n");
  expect(lines[0]).toBe(
    "Month,Tenant,Portal,Tenant ID,Documents,Jobs,Approved,Awaiting review,Failed,In progress,Model calls,Failed model calls,Input tokens,Output tokens,Estimated cost (USD)",
  );
  expect(lines).toContain(
    `${month},Usage ${suffix} Ltd,${slug},${tenantId},2,2,1,0,1,0,2,0,2000,400,0.0225`,
  );

  // A month with nothing in it, and a month that is not one.
  await page.goto("/operator/usage?month=2000-01");
  await expect(page.getByRole("row").filter({ hasText: `Usage ${suffix} Ltd` })).toContainText(
    "$0.00",
  );
  await page.goto("/operator/usage?month=nonsense");
  await expect(page.getByTestId("usage-month")).toContainText("YYYY-MM");
  const bad = await page.request.get("/api/operator/usage?month=2026-13");
  expect(bad.status()).toBe(400);
  await context.close();
});

test("a tenant admin sees who changed what, and refused sign-ins, and downloads the log", async ({
  browser,
}) => {
  // Someone tries a made-up sign-in link: refused, and counted.
  const stranger = await browser.newContext();
  const strangerPage = await stranger.newPage();
  await strangerPage.goto(
    `/t/${slug}/sign-in/verify?email=${encodeURIComponent(adminEmail)}&token=${"x".repeat(43)}`,
  );
  await strangerPage.getByRole("button", { name: "Sign in" }).click();
  await expect(strangerPage).toHaveURL(/sign-in/);
  await stranger.close();

  const context = await as(browser, await adminCookie());
  const page = await context.newPage();
  const member = `member-${suffix}@usage.example`;
  await page.goto(`/t/${slug}/admin/users`);
  await page.getByLabel("Email").fill(member);
  await page.getByRole("button", { name: "Add user" }).click();
  await expect(page.getByTestId("users-outcome")).toContainText("User added");

  await page.goto(`/t/${slug}/admin`);
  await page.getByRole("link", { name: "Activity" }).click();
  await expect(page).toHaveURL(new RegExp(`/t/${slug}/admin/activity$`));
  const rows = page.getByRole("row");
  await expect(rows.nth(1)).toContainText(adminEmail);
  await expect(rows.nth(1)).toContainText(`Added ${member} as User`);
  // The client's staff show as "Operator" to a tenant, never by name.
  const byOperator = page.getByRole("row").filter({ hasText: `Added ${adminEmail} as Admin` });
  await expect(byOperator.getByRole("cell").nth(1)).toHaveText("Operator");
  await expect(page.getByText("op@client.example")).toHaveCount(0);
  await expect(page.getByTestId("refused-sign-ins")).toContainText(
    "Email link: link not valid or expired: 1",
  );

  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download the whole log (CSV)" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe(`activity-${slug}.csv`);
  const csv = (await (await file.createReadStream()).toArray()).join("");
  const lines = csv.replace(/^\uFEFF/, "").split("\r\n");
  expect(lines[0]).toBe("Time (UTC),Who,Actor kind,Actor ID,Action,Description,Detail");
  // Oldest first: the tenant's creation, its admin, then the new user.
  expect(lines[1]).toContain("tenant.created");
  expect(lines[2]).toContain(`Added ${adminEmail} as Admin`);
  expect(csv).not.toContain("op@client.example");
  expect(csv).not.toContain("e2e-operator");
  expect(lines[3]).toContain(`Added ${member} as User`);
  await context.close();
});
