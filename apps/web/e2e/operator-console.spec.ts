// Task 16's done-when: an operator sees each agent's version, steps and latest test
// results, compares two recorded versions per field, and finds a failed job from any
// tenant by its ID, with status and reason codes only (no file name, no fields).
import { agentRegistry } from "@agent-core/core/agents";
import {
  createJob,
  createTenantDatabase,
  finishAttempt,
  recordAgentTestRun,
  recordAgentVersion,
  schema,
  setJobStatus,
  startAttempt,
  type TenantDatabase,
} from "@agent-core/db";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext } from "@playwright/test";
import { personas, state } from "./matrix.ts";
import { BASE_URL } from "./state.ts";

test.describe.configure({ mode: "serial" });

const SECRET_FILENAME = "board-minutes-confidential.pdf";
let db: TenantDatabase;

async function asOperator(context: BrowserContext) {
  const cookie = await personas.operator();
  if (!cookie) throw new Error("no operator session");
  const at = cookie.indexOf("=");
  await context.addCookies([
    { name: cookie.slice(0, at), value: cookie.slice(at + 1), url: BASE_URL },
  ]);
}

/** A test run's result, with `right` of each case's single run right on every field. */
function result(version: string, right: number) {
  return {
    agent: "contract-summary",
    version,
    repeats: 1,
    cases: ["01", "02", "03", "04"].map((id, i) => ({
      id,
      runs: [
        {
          fields: {},
          checks: ["parties", "fees"].map((field) => ({
            field,
            ok: i < right || field === "parties",
            ...(i < right || field === "parties" ? {} : { problem: "missing: the monthly fee" }),
          })),
        },
      ],
    })),
    usage: { calls: 4, tokens: 400, costUsd: 0.01 },
  };
}

test.beforeAll(async () => {
  db = createTenantDatabase(state.appUrl, {
    contextKey: Buffer.from(state.contextKeyBase64, "base64"),
    maxConnections: 1,
  });
});

test.afterAll(async () => {
  await db?.close();
});

test("an operator sees each agent, its version, steps and the worker's test run", async ({
  page,
  context,
}) => {
  await asOperator(context);
  const loaded = (await agentRegistry({ ...process.env, AGENTS_DIR: state.agentsDir })).get(
    "contract-summary",
  );
  if (!loaded) throw new Error("no demo agent");

  await page.goto("/operator");
  await page.getByRole("navigation").getByRole("link", { name: "Agents" }).click();
  const row = page.getByRole("row").filter({ hasText: "Supplier contract summary" });
  await expect(row).toContainText(loaded.version);
  await expect(row).toContainText("extract-text, extract-to-schema, word-report");

  // The e2e worker runs the new version's test set once, against the fake model, at start.
  await expect
    .poll(
      async () => {
        await page.reload();
        return row.textContent();
      },
      { timeout: 60_000 },
    )
    .toMatch(/\d+% right/);

  await row.getByRole("link", { name: "Supplier contract summary" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Supplier contract summary");
  await expect(page.getByText(`version ${loaded.version} running now`)).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "extract-to-schema" })).toContainText(
    "prompts/extract.md",
  );
  // The prompt itself, as the version ran it.
  const file = page
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: "prompts/extract.md" }) });
  await file.getByText("prompts/extract.md", { exact: true }).click();
  const prompt = loaded.contents.get("prompts/extract.md")?.toString("utf8") ?? "";
  await expect(file.locator("pre")).toContainText(prompt.split("\n")[0] ?? "");
  // With a file open, the page still passes the accessibility check (look.spec.ts checks
  // it closed): its scrolling text can be reached from the keyboard.
  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(axe.violations.map((v) => v.id)).toEqual([]);
  const runs = page.getByRole("table", { name: "Test runs of this agent" });
  await expect(runs.getByRole("row").filter({ hasText: loaded.version })).toContainText(
    "bedrock e2e-model",
  );
});

test("an operator compares two recorded versions field by field", async ({ page, context }) => {
  await asOperator(context);
  const snapshot = { definition: { accepts: ["pdf"], steps: [] }, files: [] };
  for (const version of ["0000000000a1", "0000000000a2"]) {
    await recordAgentVersion(db, { agentName: "contract-summary", version, snapshot });
  }
  const common = {
    agentName: "contract-summary",
    provider: "azure-openai",
    model: "gpt-5.4-mini",
    repeats: 1,
    cases: 4,
    calls: 4,
    tokens: 400,
    costUsd: 0.01,
  };
  await recordAgentTestRun(db, {
    ...common,
    version: "0000000000a1",
    accuracy: 5 / 8,
    result: result("0000000000a1", 1),
    startedAt: new Date("2026-11-01T10:00:00Z"),
  });
  await recordAgentTestRun(db, {
    ...common,
    version: "0000000000a2",
    accuracy: 7 / 8,
    result: result("0000000000a2", 3),
    startedAt: new Date("2026-11-02T10:00:00Z"),
  });

  await page.goto("/operator/agents/contract-summary");
  await page.getByRole("link", { name: "0000000000a1" }).click();
  await expect(page.getByRole("heading", { name: "Version 0000000000a1" })).toBeVisible();

  const option = (version: string) =>
    page.getByLabel("Compare").locator("option").filter({ hasText: version });
  await page
    .getByLabel("Compare")
    .selectOption((await option("0000000000a1").getAttribute("value")) ?? "");
  await page
    .getByLabel("with")
    .selectOption(
      (await page
        .getByLabel("with")
        .locator("option")
        .filter({ hasText: "0000000000a2" })
        .getAttribute("value")) ?? "",
    );
  await page.getByRole("button", { name: "Compare" }).click();

  const fields = page.getByRole("table", { name: "Right answers per field" });
  await expect(fields.getByRole("row").filter({ hasText: "fees" })).toContainText("25% (1/4)");
  await expect(fields.getByRole("row").filter({ hasText: "fees" })).toContainText("75% (3/4)");
  await expect(fields.getByRole("row").filter({ hasText: "parties" })).toContainText("100% (4/4)");
  const changes = page.getByRole("table", { name: /Cases that changed/ });
  await expect(changes.getByRole("row")).toHaveCount(3); // the header, cases 02 and 03
});

test("an operator finds a failed job from any tenant, with status and reason codes only", async ({
  page,
  context,
}) => {
  await asOperator(context);
  const { tenantId } = state.b;
  const [doc] = await db.withTenant(tenantId, (tx) =>
    tx
      .insert(schema.documents)
      .values({
        tenantId,
        filename: SECRET_FILENAME,
        contentType: "application/pdf",
        sizeBytes: 1,
        blobPath: "documents/e2e",
        sha256: "s",
        uploadedBy: state.b.user.userId,
      })
      .returning({ id: schema.documents.documentId }),
  );
  const jobId = await createJob(db, tenantId, {
    documentId: doc?.id ?? "",
    agentName: "contract-summary",
    agentVersion: "0000000000a2",
  });
  await startAttempt(db, tenantId, jobId, 1);
  await finishAttempt(db, tenantId, jobId, 1, "failed", "no-text");
  await setJobStatus(db, tenantId, jobId, "failed");

  await page.goto("/operator");
  await page.getByRole("navigation").getByRole("link", { name: "Jobs" }).click();
  await page.getByLabel("Show").selectOption("failed");
  await page.getByRole("button", { name: "Show" }).click();
  const row = page.getByRole("row").filter({ hasText: jobId.slice(0, 8) });
  await expect(row).toContainText("no-text");
  await expect(row).toContainText("failed");

  // As from an alert email: the job ID.
  await page.getByLabel("Job ID").fill(jobId);
  await page.getByRole("button", { name: "Find" }).click();
  const found = page.getByTestId("found-job");
  await expect(found).toContainText("no-text");
  await expect(found.getByRole("link", { name: "Tenant B" })).toBeVisible();
  // Never the document's name, its ID or its fields.
  await expect(page.locator("body")).not.toContainText(SECRET_FILENAME);
  await expect(page.locator("body")).not.toContainText(doc?.id ?? "no-such-id");

  await page.getByLabel("Job ID").fill("00000000-0000-4000-8000-000000000000");
  await page.getByRole("button", { name: "Find" }).click();
  await expect(page.getByTestId("job-not-found")).toBeVisible();
});
