// Task 10b's done-when, in part: the theme passes WCAG AA contrast, and changing the theme
// file rebrands the app (the shell and the root layout read nothing else).
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { theme } from "../../theme.ts";
import { contrast, contrastPairs, themeCss, type Theme } from "./theme.ts";

const OTHER: Theme = {
  productName: "Example Contracts Hub",
  logo: { src: "/brand/example-logo.svg", width: 40, height: 24 },
  colors: {
    primary: "#7a1f5c",
    onPrimary: "#ffffff",
    background: "#fdf8f4",
    surface: "#ffffff",
    text: "#1f1a17",
    muted: "#5c524b",
    border: "#8c7f75",
    success: "#1b6e3a",
    warning: "#8a4b08",
    danger: "#a3122a",
  },
};

describe("the theme", () => {
  it("meets WCAG 2.2 AA contrast for every pair the components use", () => {
    const failing = contrastPairs(theme.colors).filter((p) => p.ratio < p.needs);
    expect(failing).toEqual([]);
  });

  it("computes contrast as WCAG defines it", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
  });

  it("would catch a client colour that is too light to read", () => {
    const pale = { ...theme.colors, primary: "#7dd3fc" };
    expect(
      contrastPairs(pale)
        .filter((p) => p.ratio < p.needs)
        .map((p) => p.name),
    ).toContain("button text on primary");
  });

  it("writes only hex colours into the page's CSS", () => {
    expect(themeCss(theme)).toContain("--brand-on-primary:#ffffff;");
    const bad = { ...theme, colors: { ...theme.colors, text: "red;}body{display:none" } };
    expect(() => themeCss(bad)).toThrow(/must be #rrggbb/);
  });
});

describe("changing the theme file", () => {
  it("rebrands the shell and the page's colours", async () => {
    vi.resetModules();
    vi.doMock("../../theme.ts", () => ({ theme: OTHER }));
    const { AppShell } = await import("../../components/ui/index.ts");
    const html = renderToStaticMarkup(
      <AppShell>
        <p>Body</p>
      </AppShell>,
    );
    expect(html).toContain("Example Contracts Hub");
    expect(html).toContain('src="/brand/example-logo.svg"');
    expect(html).not.toContain(theme.productName);
    // The colours come from the stylesheet route every page links (app/layout.tsx).
    const { GET } = await import("../../app/theme.css/route.ts");
    const css = await GET().text();
    expect(css).toContain("--brand-primary:#7a1f5c;");
    vi.doUnmock("../../theme.ts");
  });
});
