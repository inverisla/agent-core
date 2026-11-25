// Task 3's done-when: each role reaches only its own pages and API routes.
import { expect, request, test } from "@playwright/test";
import { notSignedIn, personas, routes, state, type PersonaName } from "./matrix.ts";
import { BASE_URL } from "./state.ts";

const { a } = state;

for (const name of Object.keys(personas) as PersonaName[]) {
  test.describe(`as ${name}`, () => {
    for (const route of routes) {
      const allowed = route.allowed.includes(name);
      // A removed user's session is re-checked against the database on their own
      // tenant's routes and treated as signed out; elsewhere it has no access anyway.
      const signedOut =
        notSignedIn.has(name) ||
        ((name === "removedUserA" || name === "crossTenantUserA") &&
          route.path.includes(`/t/${a.slug}`));
      const expected = allowed ? "200" : signedOut ? (route.api ? "401" : "sign-in") : "403";
      test(`${route.path} -> ${expected}`, async () => {
        const cookie = await personas[name]();
        const ctx = await request.newContext({
          baseURL: BASE_URL,
          extraHTTPHeaders: cookie ? { cookie } : {},
        });
        const res = await ctx.get(route.path, { maxRedirects: 0 });
        if (expected === "sign-in") {
          expect([303, 307]).toContain(res.status());
          expect(new URL(res.headers()["location"] ?? "", BASE_URL).pathname).toBe(route.signIn);
        } else {
          expect(res.status()).toBe(Number(expected));
        }
        // Tenant data is never kept by a browser or a proxy on the way (review S16).
        if (route.api) expect(res.headers()["cache-control"]).toContain("no-store");
        await ctx.dispose();
      });
    }
  });
}

// Public on purpose: the deploy's own check calls /api/ready without signing in. It
// says only whether the app can use its database.
test("/api/ready answers anyone, with no details", async () => {
  const ctx = await request.newContext({ baseURL: BASE_URL });
  const res = await ctx.get("/api/ready", { maxRedirects: 0 });
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ status: "ready" });
  await ctx.dispose();
});

test("sign-in pages look the same for a real and an unknown tenant", async ({ page }) => {
  await page.goto(`/t/${a.slug}/sign-in`);
  const real = await page.locator("main").innerHTML();
  await page.goto("/t/no-such-tenant/sign-in");
  const unknown = await page.locator("main").innerHTML();
  expect(unknown).toBe(real.replaceAll(a.slug, "no-such-tenant"));
  expect(real).not.toContain("Tenant A");
});
