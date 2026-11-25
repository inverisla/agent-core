// Starting SSO sign-in where there is nowhere to go: an unknown tenant, a tenant that
// has linked no SSO, and the operator console with no operator organisation. All three
// must look the same and never reach Microsoft or Google.
import { expect, test } from "@playwright/test";
import { readState } from "./state.ts";

const { b } = readState();

const cases = [
  {
    name: "unknown tenant",
    start: "/t/no-such-tenant/sign-in",
    refused: "/t/no-such-tenant/sign-in?error=refused",
    button: "Sign in with your work account",
  },
  {
    name: "tenant with no linked SSO",
    start: `/t/${b.slug}/sign-in`,
    refused: `/t/${b.slug}/sign-in?error=refused`,
    button: "Sign in with your work account",
  },
  {
    name: "operator console with no operator organisation",
    start: "/operator/sign-in",
    refused: "/operator/sign-in?error=refused",
    button: "Sign in with Microsoft",
  },
];

for (const { name, start, refused, button } of cases) {
  test(`${name}: refused on our own page, without contacting Microsoft or Google`, async ({
    page,
  }) => {
    const external: string[] = [];
    page.on("request", (r) => {
      if (!r.url().startsWith("http://localhost:3100")) external.push(r.url());
    });
    await page.goto(start);
    await page.getByRole("button", { name: button }).click();
    await expect(page).toHaveURL((u) => u.pathname + u.search === refused);
    await expect(page.locator("main").getByRole("alert")).toHaveText("Sign-in was refused.");
    expect(external).toEqual([]);
  });
}
