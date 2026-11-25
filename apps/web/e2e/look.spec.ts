// Task 10b's done-when: every page passes an automated accessibility check (axe, WCAG 2.2
// A and AA), shows the theme's brand, and works at phone width without sideways scrolling.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser } from "@playwright/test";
import { theme } from "../theme.ts";
import { lookPages as pages, type LookPage as Page } from "./look-pages.ts";
import { personas, state } from "./matrix.ts";
import { BASE_URL } from "./state.ts";

const { a } = state;

/**
 * What does not fit the screen, by name: anything outside a scrollable box that reaches
 * past its edge, and any control (button, field, drop-down) not wholly on screen, even
 * inside a scrollable box. A wide table of text may scroll sideways; a control someone
 * must scroll sideways to find is as good as missing on a phone.
 */
function offScreen(): string[] {
  const width = document.documentElement.clientWidth;
  const overflowing =
    document.documentElement.scrollWidth <= width
      ? []
      : [...document.querySelectorAll("body *")]
          .filter((e) => !e.parentElement?.closest("[role=region]"))
          .filter((e) => e.getBoundingClientRect().right > width + 1);
  const controls = [
    ...document.querySelectorAll("button, select, textarea, input:not([type=hidden])"),
  ].filter((e) => {
    const box = e.getBoundingClientRect();
    // Not shown, such as a visually hidden field.
    if (box.width <= 1 || box.height <= 1) return false;
    return box.right > width + 1 || box.left < -1;
  });
  return [...overflowing, ...controls]
    .map(
      (e) =>
        `${e.tagName.toLowerCase()} "${(e.getAttribute("aria-label") ?? e.textContent ?? "").trim().slice(0, 40)}"`,
    )
    .slice(0, 5);
}

async function open(browser: Browser, page: Page, viewport?: { width: number; height: number }) {
  const cookie = await personas[page.persona]();
  const context = await browser.newContext(viewport ? { viewport } : {});
  if (cookie) {
    const at = cookie.indexOf("=");
    await context.addCookies([
      { name: cookie.slice(0, at), value: cookie.slice(at + 1), url: BASE_URL },
    ]);
  }
  const tab = await context.newPage();
  await tab.goto(page.path);
  return { context, tab };
}

for (const page of pages) {
  test(`${page.name}: no accessibility violations, and the theme's brand`, async ({ browser }) => {
    const { context, tab } = await open(browser, page);
    await expect(tab.locator("h1")).toBeVisible();
    const results = await new AxeBuilder({ page: tab })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(
      results.violations.map(
        (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
      ),
    ).toEqual([]);
    await expect(tab.getByTestId("brand")).toContainText(theme.productName);
    // Each page has its own title (WCAG 2.4.2); only the landing page is the bare name.
    const title = await tab.title();
    if (page.path === "/") expect(title).toBe(theme.productName);
    else expect(title).not.toBe(theme.productName);
    const primary = await tab.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--brand-primary").trim(),
    );
    expect(primary).toBe(theme.colors.primary.toLowerCase());
    await context.close();
  });

  // Review S2: security headers, and a Content Security Policy the page keeps to (its
  // scripts carry the nonce and run; nothing is refused).
  test(`${page.name}: security headers, and nothing the Content Security Policy refuses`, async ({
    browser,
  }) => {
    const cookie = await personas[page.persona]();
    const context = await browser.newContext();
    if (cookie) {
      const at = cookie.indexOf("=");
      await context.addCookies([
        { name: cookie.slice(0, at), value: cookie.slice(at + 1), url: BASE_URL },
      ]);
    }
    const tab = await context.newPage();
    const refused: string[] = [];
    tab.on("console", (m) => {
      if (/Content Security Policy|Refused to/i.test(m.text())) refused.push(m.text());
    });
    const response = await tab.goto(page.path);
    await expect(tab.locator("h1")).toBeVisible();
    const headers = response?.headers() ?? {};
    expect(headers["content-security-policy"]).toMatch(/script-src 'self' 'nonce-[^']+'/);
    expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("same-origin");
    // An http test address: no HSTS (lib/security/headers.test.ts covers https).
    expect(headers["strict-transport-security"]).toBeUndefined();
    // Next.js's own inline scripts ran, so they carried the nonce.
    expect(await tab.evaluate(() => "__next_f" in window)).toBe(true);
    expect(refused).toEqual([]);
    await context.close();
  });

  test(`${page.name}: fits a 320 px wide screen`, async ({ browser }) => {
    const { context, tab } = await open(browser, page, { width: 320, height: 640 });
    await expect(tab.locator("h1")).toBeVisible();
    expect(await tab.evaluate(offScreen)).toEqual([]);
    // The navigation and sign-out stay reachable.
    for (const link of await tab
      .getByRole("navigation", { name: "Main" })
      .getByRole("link")
      .all()) {
      await expect(link).toBeVisible();
    }
    await context.close();
  });
}

test("keyboard users can skip to the content", async ({ page }) => {
  await page.goto(`/t/${a.slug}/sign-in`);
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();
  await skip.press("Enter");
  await expect(page.locator("#main")).toBeFocused();
});

test("the accessibility check is live: it catches unreadable text", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  // Added after the page has loaded. React can still replace the page's content while it
  // hydrates, which would take the added text with it, so add it again until the check
  // has seen it.
  await expect(async () => {
    await page.evaluate(() => {
      if (document.getElementById("too-pale")) return;
      const p = document.createElement("p");
      p.id = "too-pale";
      p.textContent = "Too pale to read";
      p.style.color = "#eeeeee";
      document.querySelector("main")?.append(p);
    });
    const results = await new AxeBuilder({ page }).withTags(["wcag2aa"]).analyze();
    expect(results.violations.map((v) => v.id)).toContain("color-contrast");
  }).toPass({ timeout: 15_000 });
});

test("the phone check is live: it catches a control hidden in a sideways-scrolling table", async ({
  browser,
}) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 640 } });
  const page = await context.newPage();
  await page.goto("/");
  expect(await page.evaluate(offScreen)).toEqual([]);
  await page.evaluate(() => {
    const region = document.createElement("div");
    region.setAttribute("role", "region");
    region.style.overflowX = "auto";
    // Set through the DOM: the Content Security Policy refuses inline style attributes.
    region.innerHTML =
      "<table><tr><td>A long cell</td><td><button>Hidden</button></td></tr></table>";
    const cell = region.querySelector("td");
    if (cell) cell.style.minWidth = "400px";
    document.querySelector("main")?.append(region);
  });
  expect(await page.evaluate(offScreen)).toEqual(['button "Hidden"']);
  await context.close();
});
