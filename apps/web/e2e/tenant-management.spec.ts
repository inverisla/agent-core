// Task 12b's done-when: an operator creates a tenant whose admin then signs in and adds a
// user, all through the UI. Also: the guards on users, removal, and agent choice on upload.
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { makeTextPdf, SAMPLE_CONTRACT_PAGES } from "@agent-core/blocks/testing";
import {
  addTenantUser,
  createTenantDatabase,
  getJob,
  latestJobsByDocument,
  setAllowEmailLinks,
  setTenantAgents,
  SETUP_ACTOR,
} from "@agent-core/db";
import { expect, request, test, type BrowserContext, type Page } from "@playwright/test";
import { listDocuments } from "../lib/documents/list.ts";
import { personas, state } from "./matrix.ts";
import { sessionCookie } from "./sessions.ts";
import { BASE_URL, E2E_SECOND_AGENT } from "./state.ts";

test.describe.configure({ mode: "serial" });

function messagesTo(address: string): { to: string; subject: string; text: string }[] {
  return readdirSync(state.outboxDir)
    .sort()
    .map(
      (f) =>
        JSON.parse(readFileSync(path.join(state.outboxDir, f), "utf8")) as {
          to: string;
          subject: string;
          text: string;
        },
    )
    .filter((m) => m.to === address);
}

async function lastLink(address: string, count: number): Promise<string> {
  await expect.poll(() => messagesTo(address).length, { timeout: 15_000 }).toBe(count);
  const url = /https?:\/\/\S+/.exec(messagesTo(address).at(-1)?.text ?? "")?.[0];
  if (!url) throw new Error("No link in the email.");
  return url;
}

async function asPersona(context: BrowserContext, persona: keyof typeof personas) {
  const cookie = await personas[persona]();
  if (!cookie) return;
  const at = cookie.indexOf("=");
  await context.addCookies([
    { name: cookie.slice(0, at), value: cookie.slice(at + 1), url: BASE_URL },
  ]);
}

/** Signs in through the portal with an email link, as a real user would. */
async function signInByEmail(page: Page, slug: string, email: string, linksBefore: number) {
  await page.goto(`/t/${slug}/sign-in`);
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("status")).toContainText("we have sent a sign-in link");
  await page.goto(await lastLink(email, linksBefore + 1));
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(new RegExp(`/t/${slug}$`));
}

const suffix = randomUUID().slice(0, 8);
const slug = `new-${suffix}`;
const admin = `admin-${suffix}@new.example`;
const member = `member-${suffix}@new.example`;

test("an operator creates a tenant, whose admin signs in and adds a user, all in the UI", async ({
  browser,
}) => {
  // The operator creates the tenant and its first admin.
  const operator = await browser.newContext();
  await asPersona(operator, "operator");
  const op = await operator.newPage();
  await op.goto("/operator");
  await op.getByRole("link", { name: "New tenant" }).click();
  await op.getByLabel("Name").fill("New Example Ltd");
  await op.getByLabel("Portal address").fill(slug);
  await op.getByLabel("First admin's email").fill(admin);
  await op.getByRole("button", { name: "Create tenant" }).click();
  await expect(op.getByTestId("tenant-outcome")).toContainText("Tenant created");
  await op.goto("/operator");
  await expect(op.getByRole("row").filter({ hasText: "New Example Ltd" })).toContainText(
    `/t/${slug}`,
  );
  await operator.close();

  // The admin is told where to sign in, and signs in.
  await expect.poll(() => messagesTo(admin).length, { timeout: 15_000 }).toBe(1);
  expect(messagesTo(admin)[0]?.text).toContain(`/t/${slug}/sign-in`);
  const adminContext = await browser.newContext();
  const page = await adminContext.newPage();
  await signInByEmail(page, slug, admin, 1);

  // The admin adds a user.
  await page.goto(`/t/${slug}/admin/users`);
  await page.getByLabel("Email").fill(member);
  await page.getByRole("button", { name: "Add user" }).click();
  await expect(page.getByTestId("users-outcome")).toHaveText(
    "User added, and sent the sign-in address.",
  );
  await expect(page.getByTestId("user").filter({ hasText: member })).toContainText("User");
  await adminContext.close();

  // The new user is told, and can sign in.
  await expect.poll(() => messagesTo(member).length, { timeout: 15_000 }).toBe(1);
  const memberContext = await browser.newContext();
  const memberPage = await memberContext.newPage();
  await signInByEmail(memberPage, slug, member, 1);
  await expect(memberPage.getByText(`(user)`)).toBeVisible();

  // Signing out ends the session for good (review S15): a copy of the cookie taken
  // before is refused afterwards.
  const copied = await memberContext.cookies();
  await memberPage.getByRole("button", { name: "Sign out" }).click();
  await expect(memberPage).toHaveURL(new RegExp(`/t/${slug}/sign-in`));
  const thief = await browser.newContext();
  await thief.addCookies(copied);
  const thiefPage = await thief.newPage();
  await thiefPage.goto(`/t/${slug}/documents`);
  await expect(thiefPage).toHaveURL(new RegExp(`/t/${slug}/sign-in`));
  await thief.close();
  await memberContext.close();
});

test("the portal sends at most five sign-in emails an hour to one address (review S1, T12)", async ({
  page,
}) => {
  const db = createTenantDatabase(state.appUrl, {
    contextKey: Buffer.from(state.contextKeyBase64, "base64"),
    maxConnections: 1,
  });
  const flood = `flood-${suffix}@new.example`;
  const tenantId = await db.tenantIdForSlug(slug);
  if (!tenantId) throw new Error("The first test makes the tenant.");
  await addTenantUser(db, tenantId, { email: flood, role: "tenant_user" }, SETUP_ACTOR);
  await db.close();
  for (let n = 0; n < 7; n++) {
    await page.goto(`/t/${slug}/sign-in`);
    await page.getByLabel("Email address").fill(flood);
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();
    // The same page every time, past the limit too.
    await expect(page.getByRole("status")).toContainText("we have sent a sign-in link");
  }
  await expect.poll(() => messagesTo(flood).length, { timeout: 15_000 }).toBe(5);
  await page.waitForTimeout(1500);
  expect(messagesTo(flood)).toHaveLength(5);
});

test("adding and removing someone again and again sends at most five welcome emails (review S14)", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signInByEmail(page, slug, admin, messagesTo(admin).length);
  const again = `again-${suffix}@new.example`;
  for (let n = 1; n <= 6; n++) {
    await page.goto(`/t/${slug}/admin/users`);
    await page.getByLabel("Email").fill(again);
    await page.getByRole("button", { name: "Add user" }).click();
    await expect(page.getByTestId("users-outcome")).toContainText(
      n <= 5 ? "User added, and sent the sign-in address." : "no email could be sent",
    );
    await page.getByRole("button", { name: `Remove ${again}` }).click();
    await expect(page.getByTestId("users-outcome")).toContainText("User removed");
  }
  await expect.poll(() => messagesTo(again).length, { timeout: 15_000 }).toBe(5);
  await page.waitForTimeout(1500);
  expect(messagesTo(again)).toHaveLength(5);
  await context.close();
});

test("an admin cannot remove themselves or the last admin, and a removed user is locked out", async ({
  browser,
}) => {
  const adminContext = await browser.newContext();
  const page = await adminContext.newPage();
  await signInByEmail(page, slug, admin, messagesTo(admin).length);
  await page.goto(`/t/${slug}/admin/users`);
  // No remove button for yourself; demoting the only admin is refused.
  await expect(page.getByRole("button", { name: `Remove ${admin}` })).toHaveCount(0);
  await page.getByLabel(`Role for ${admin}`, { exact: true }).selectOption("tenant_user");
  await page.getByRole("button", { name: `Change role for ${admin}` }).click();
  await expect(page.getByTestId("users-outcome")).toContainText("no admin");

  // The member signs in, then is removed: their session stops working at once.
  const memberContext = await browser.newContext();
  const memberPage = await memberContext.newPage();
  await signInByEmail(memberPage, slug, member, messagesTo(member).length);
  await page.goto(`/t/${slug}/admin/users`);
  await page.getByRole("button", { name: `Remove ${member}` }).click();
  await expect(page.getByTestId("users-outcome")).toContainText("User removed");
  await expect(page.getByTestId("user").filter({ hasText: member })).toContainText("Removed");
  await memberPage.goto(`/t/${slug}/documents`);
  await expect(memberPage).toHaveURL(new RegExp(`/t/${slug}/sign-in`));
  // And no new sign-in link is sent to them.
  const before = messagesTo(member).length;
  await memberPage.getByLabel("Email address").fill(member);
  await memberPage.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(memberPage.getByRole("status")).toContainText("we have sent a sign-in link");
  await memberPage.waitForTimeout(1500);
  expect(messagesTo(member).length).toBe(before);
  await memberContext.close();
  await adminContext.close();
});

test("an upload must use one of the tenant's agents", async () => {
  const { a } = state;
  const ctx = await request.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: {
      cookie: await sessionCookie(
        {
          kind: "tenant",
          tenantId: a.tenantId,
          slug: a.slug,
          userId: a.user.userId,
          role: "tenant_user",
          expiresAt: Date.now() + 3_600_000,
        },
        state.authSecret,
      ),
    },
  });
  const res = await ctx.post(`/api/t/${a.slug}/documents`, {
    multipart: {
      agent: "no-such-agent",
      file: {
        name: "x.pdf",
        mimeType: "application/pdf",
        buffer: Buffer.from("%PDF-1.4\n%%EOF\n"),
      },
    },
    headers: { accept: "application/json" },
  });
  expect(res.status()).toBe(400);
  expect(await res.json()).toMatchObject({ error: "agent" });
  await ctx.dispose();
});

test("an operator promotes a user, links work accounts, turns email links on and chooses agents", async ({
  browser,
}) => {
  const db = createTenantDatabase(state.appUrl, {
    contextKey: Buffer.from(state.contextKeyBase64, "base64"),
    maxConnections: 1,
  });
  const tenantId = (await db.tenantIdForSlug(slug)) ?? "";
  const fourth = `fourth-${suffix}@new.example`;

  // The tenant's admin adds a user, for the operator to promote.
  const adminContext = await browser.newContext();
  const page = await adminContext.newPage();
  await signInByEmail(page, slug, admin, messagesTo(admin).length);
  await page.goto(`/t/${slug}/admin/users`);
  await page.getByLabel("Email").fill(fourth);
  await page.getByRole("button", { name: "Add user" }).click();
  await expect(page.getByTestId("users-outcome")).toContainText("User added");

  const operator = await browser.newContext();
  await asPersona(operator, "operator");
  const op = await operator.newPage();
  await op.goto("/operator");
  await op.getByRole("link", { name: "New Example Ltd" }).click();
  await expect(op).toHaveURL(new RegExp(`/operator/tenants/${tenantId}$`));
  const addAdmin = async (email: string) => {
    await op.getByLabel("Add an admin (email)").fill(email);
    await op.getByRole("button", { name: "Add admin" }).click();
  };
  // Rows of the Users table (the activity log below names users too).
  const userRow = (email: string) =>
    op.getByRole("region", { name: "Users" }).getByRole("row").filter({ hasText: email });
  // An existing admin; a current user, promoted without a second welcome; a removed user,
  // restored as an admin and told.
  await addAdmin(admin);
  await expect(op.getByTestId("tenant-outcome")).toContainText("already an admin");
  const welcomes = messagesTo(fourth).length;
  await addAdmin(fourth.toUpperCase());
  await expect(op.getByTestId("tenant-outcome")).toHaveText("That user is now an admin.");
  await expect(userRow(fourth)).toContainText("Admin");
  expect(messagesTo(fourth).length).toBe(welcomes);
  const memberWelcomes = messagesTo(member).length;
  await addAdmin(member);
  await expect(op.getByTestId("tenant-outcome")).toContainText("Admin added");
  await expect(userRow(member)).toContainText("Current");
  await expect.poll(() => messagesTo(member).length, { timeout: 15_000 }).toBe(memberWelcomes + 1);

  // Work account sign-in: a bad value is refused, a Google domain is linked.
  await op.getByLabel("Provider").selectOption("microsoft");
  await op.getByLabel("Organisation").fill("not-a-guid");
  await op.getByRole("button", { name: "Link" }).click();
  await expect(op.getByTestId("tenant-outcome")).toContainText("Entra tenant ID");
  await op.getByLabel("Provider").selectOption("google");
  await op.getByLabel("Organisation").fill("new.example");
  await op.getByRole("button", { name: "Link" }).click();
  await expect(op.getByTestId("tenant-outcome")).toHaveText("Work account sign-in linked.");
  await expect(op.getByText("Linked to Google Workspace (new.example).")).toBeVisible();

  // The tenant's admins turned email links off; the operator turns them back on.
  await setAllowEmailLinks(db, tenantId, false, SETUP_ACTOR);
  await op.reload();
  await op.getByRole("button", { name: "Turn email links back on" }).click();
  await expect(op.getByTestId("tenant-outcome")).toHaveText("Email sign-in links are on.");
  await expect(op.getByRole("button", { name: "Turn email links back on" })).toHaveCount(0);

  // An agent assigned earlier has gone from the deployment: uploads are refused, not
  // quietly sent to the default agent, and the console says so.
  await setTenantAgents(db, tenantId, ["gone-agent"], SETUP_ACTOR);
  await op.reload();
  await expect(op.getByTestId("agents-missing")).toContainText("gone-agent");
  await page.goto(`/t/${slug}/documents`);
  await expect(page.getByTestId("no-agent")).toContainText("No agent is set up");

  // The operator chooses two agents; the admin picks one at upload.
  await op.getByLabel(/Supplier contract summary/).check();
  await op.getByLabel(/Second agent/).check();
  await op.getByRole("button", { name: "Save agents" }).click();
  await expect(op.getByTestId("tenant-outcome")).toHaveText("Agents saved.");
  await expect(op.getByTestId("agents-missing")).toHaveCount(0);
  await operator.close();

  await page.goto(`/t/${slug}/documents`);
  await page.getByLabel("Agent").selectOption(E2E_SECOND_AGENT);
  await page.getByLabel(/File \(PDF or Word/).setInputFiles({
    name: "two-agents.pdf",
    mimeType: "application/pdf",
    buffer: makeTextPdf(SAMPLE_CONTRACT_PAGES),
  });
  await page.getByRole("button", { name: "Upload" }).click();
  await expect(page.locator("main").getByRole("status")).toHaveText("Uploaded.");
  const doc = (await listDocuments(db, tenantId)).find((d) => d.filename === "two-agents.pdf");
  const latest = (await latestJobsByDocument(db, tenantId, [doc?.documentId ?? ""])).get(
    doc?.documentId ?? "",
  );
  expect((await getJob(db, tenantId, latest?.jobId ?? ""))?.agentName).toBe(E2E_SECOND_AGENT);
  await adminContext.close();
  await db.close();
});
