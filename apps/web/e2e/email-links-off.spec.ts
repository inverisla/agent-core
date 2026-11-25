// Task 3b's done-when, end to end: a tenant admin turns email links off, after which a
// link sent earlier is refused and asking for a link sends a note to use the work
// account instead.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type BrowserContext } from "@playwright/test";
import { SESSION_COOKIE, sessionCookie } from "./sessions.ts";
import { readState } from "./state.ts";

const state = readState();
const { a, g } = state;

interface Message {
  to: string;
  subject: string;
  text: string;
}
function messagesTo(address: string): Message[] {
  return readdirSync(state.outboxDir)
    .sort()
    .map((f) => JSON.parse(readFileSync(path.join(state.outboxDir, f), "utf8")) as Message)
    .filter((m) => m.to === address);
}

async function signInAs(context: BrowserContext, t: typeof a | typeof g, userId: string) {
  const cookie = await sessionCookie(
    {
      kind: "tenant",
      tenantId: t.tenantId,
      slug: t.slug,
      userId,
      role: "tenant_admin",
      expiresAt: Date.now() + 3_600_000,
    },
    state.authSecret,
  );
  await context.addCookies([
    {
      name: SESSION_COOKIE,
      value: cookie.slice(SESSION_COOKIE.length + 1),
      domain: "localhost",
      path: "/",
    },
  ]);
}

async function requestLink(context: BrowserContext, slug: string, email: string) {
  const page = await context.newPage();
  await page.goto(`/t/${slug}/sign-in`);
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("status")).toContainText("we have sent a sign-in link");
  await page.close();
}

test.describe.configure({ mode: "serial" });

test("a tenant admin turns email links off; old links stop working and new requests get a work-account note", async ({
  browser,
}) => {
  // Before: a user asks for a link and gets one.
  const visitor = await browser.newContext();
  await requestLink(visitor, g.slug, g.user.email);
  await expect.poll(() => messagesTo(g.user.email).length, { timeout: 15_000 }).toBe(1);
  const oldLink = /https?:\/\/\S+/.exec(messagesTo(g.user.email)[0]?.text ?? "")?.[0] ?? "";
  expect(oldLink).toContain("/sign-in/verify");

  // The tenant's admin turns email links off.
  const admin = await browser.newContext();
  await signInAs(admin, g, g.admin.userId);
  const settings = await admin.newPage();
  await settings.goto(`/t/${g.slug}/admin/sign-in`);
  await expect(settings.getByText("Google Workspace (lawfirm.example)")).toBeVisible();
  await settings.getByRole("button", { name: "Turn off email links" }).click();
  await expect(settings.getByText("Email sign-in links are off.")).toBeVisible();

  // The link sent earlier is now refused.
  const page = await visitor.newPage();
  await page.goto(oldLink);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(new RegExp(`/t/${g.slug}/sign-in\\?error=link`));

  // Asking again looks the same on screen, but the email says to use the work account.
  await requestLink(visitor, g.slug, g.user.email);
  await expect.poll(() => messagesTo(g.user.email).length, { timeout: 15_000 }).toBe(2);
  const note = messagesTo(g.user.email)[1];
  expect(note?.subject).toBe("How to sign in");
  expect(note?.text).not.toContain("/sign-in/verify");
  expect(note?.text).toContain("Sign in with your work account");

  // Turn them back on, as an admin would to undo it.
  await settings.getByRole("button", { name: "Turn on email links" }).click();
  await expect(settings.getByText("Email sign-in links are on.")).toBeVisible();
  await visitor.close();
  await admin.close();
});

test("an admin who has never signed in with the work account cannot turn links off", async ({
  browser,
}) => {
  const admin = await browser.newContext();
  await signInAs(admin, g, g.newAdmin.userId);
  const page = await admin.newPage();
  await page.goto(`/t/${g.slug}/admin/sign-in`);
  await expect(
    page.getByText("first sign out and sign in once with your work account"),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Turn off email links" })).toHaveCount(0);
  await admin.close();
});

test("a tenant with no SSO linked is not offered the switch", async ({ browser }) => {
  const admin = await browser.newContext();
  await signInAs(admin, a, a.admin.userId);
  const page = await admin.newPage();
  await page.goto(`/t/${a.slug}/admin/sign-in`);
  await expect(page.getByText("Email sign-in links are on.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Turn off email links" })).toHaveCount(0);
  // And is told why, and what would change it.
  await expect(page.getByTestId("email-links-why")).toContainText(
    "once work account sign-in is linked and you have signed in with it once",
  );
  await admin.close();
});
