// Email sign-in end to end, with the local outbox standing in for email.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { readState } from "./state.ts";

const state = readState();
const { a } = state;

function messagesTo(address: string): { to: string; text: string }[] {
  return readdirSync(state.outboxDir)
    .sort()
    .map(
      (f) =>
        JSON.parse(readFileSync(path.join(state.outboxDir, f), "utf8")) as {
          to: string;
          text: string;
        },
    )
    .filter((m) => m.to === address);
}

async function waitForMessage(address: string, count: number) {
  await expect.poll(() => messagesTo(address).length, { timeout: 15_000 }).toBe(count);
  const message = messagesTo(address).at(-1);
  const url = /https?:\/\/\S+/.exec(message?.text ?? "")?.[0];
  if (!url) throw new Error("No link in the email.");
  return url;
}

test.describe.configure({ mode: "serial" });

test("a tenant user signs in with an email link, which then stops working", async ({
  page,
  browser,
}) => {
  await page.goto(`/t/${a.slug}/sign-in`);
  await page.getByLabel("Email address").fill("User@A.example");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("status")).toContainText("we have sent a sign-in link");

  const link = await waitForMessage(a.user.email, 1);
  await page.goto(link);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(new RegExp(`/t/${a.slug}$`));
  await expect(page.getByText(`Signed in as ${a.user.email} (user)`)).toBeVisible();

  // The same link in a fresh browser is refused.
  const other = await browser.newContext();
  const page2 = await other.newPage();
  await page2.goto(link);
  await page2.getByRole("button", { name: "Sign in" }).click();
  await expect(page2).toHaveURL(new RegExp(`/t/${a.slug}/sign-in\\?error=link`));
  await other.close();
});

test("an unknown address gets the same answer and no email", async ({ page }) => {
  await page.goto(`/t/${a.slug}/sign-in`);
  await page.getByLabel("Email address").fill("stranger@a.example");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("status")).toContainText("we have sent a sign-in link");
  await page.waitForTimeout(2000);
  expect(messagesTo("stranger@a.example")).toHaveLength(0);
});

test("a link for tenant A does not work on tenant B's portal", async ({ page }) => {
  await page.goto(`/t/${a.slug}/sign-in`);
  await page.getByLabel("Email address").fill(a.admin.email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  const link = new URL(await waitForMessage(a.admin.email, 1));
  link.pathname = link.pathname.replace(`/t/${a.slug}/`, `/t/${state.b.slug}/`);
  await page.goto(link.toString());
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(new RegExp(`/t/${state.b.slug}/sign-in\\?error=link`));
});
