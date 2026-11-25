// Review Q9, T7: every page and API route in apps/web/app is covered. A route counts as
// covered when a path listed for it resolves to that route, as Next.js would route it
// (a static segment wins over [param], which wins over [...rest]):
// - every route: a path in the role matrix (matrix.ts, so access.spec.ts checks who may
//   reach it), or one on the short public list below;
// - every page also: a path in look.spec.ts's list (look-pages.ts: axe, brand, phone).
// A new route left out fails here.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { lookPages } from "./look-pages.ts";
import { routes } from "./matrix.ts";

const APP = path.join(import.meta.dirname, "..", "app");

/** Open to anyone on purpose; each says why. */
const PUBLIC = [
  "/", // the landing page
  "/operator/sign-in",
  "/t/[slug]/sign-in",
  "/t/[slug]/sign-in/verify", // where an email link lands
  "/sign-in/error",
  "/test/error", // tests only, and only on a local machine
  "/theme.css",
  "/api/auth/[...nextauth]", // Auth.js itself
  "/api/health", // liveness, says nothing
  "/api/ready", // readiness, for the deploy's own check
];

interface AppRoute {
  pattern: string;
  kind: "page" | "route";
}

/** Metadata routes Next.js serves from code (icon.tsx, robots.ts and the like). */
const METADATA =
  /^(icon|apple-icon|opengraph-image|twitter-image|robots|sitemap|manifest)\.[jt]sx?$/;
/** Where Next.js serves the ones whose address is not their file's name. */
const SERVED_AS: Record<string, string> = {
  robots: "robots.txt",
  sitemap: "sitemap.xml",
  manifest: "manifest.webmanifest",
};

/**
 * Every page, route and metadata-route file, as its URL pattern. Route groups `(x)` add
 * no segment; private `_x` folders and parallel `@slot` folders are not routes of their
 * own (a slot's pages are reached at its parent's path); intercepting `(.)x` folders show
 * another route's page, which that route covers.
 */
function appRoutes(dir = APP, prefix = ""): AppRoute[] {
  const found: AppRoute[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (/^(_|\(\.)/.test(entry.name)) continue;
      const segment = /^\(.*\)$|^@/.test(entry.name) ? "" : `/${entry.name}`;
      found.push(...appRoutes(path.join(dir, entry.name), prefix + segment));
    } else {
      const file = /^(page|route)\.[jt]sx?$/.exec(entry.name);
      if (file) found.push({ pattern: prefix || "/", kind: file[1] as "page" | "route" });
      else if (METADATA.test(entry.name)) {
        const name = entry.name.replace(/\.[jt]sx?$/, "");
        found.push({ pattern: `${prefix}/${SERVED_AS[name] ?? name}`, kind: "route" });
      }
    }
  }
  return found;
}

const segments = (p: string) => p.split("/").filter(Boolean);
const isRest = (s: string) => /^\[\.\.\..+\]$/.test(s);
/** [[...x]]: any number of segments, none included. */
const isOptionalRest = (s: string) => /^\[\[\.\.\..+\]\]$/.test(s);
const isParam = (s: string) => /^\[.+\]$/.test(s);

/** Whether a URL path matches a pattern. */
function matches(pattern: string, url: string): boolean {
  const ps = segments(pattern);
  const us = segments(url);
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i] ?? "";
    if (isOptionalRest(p)) return true;
    if (isRest(p)) return us.length > i;
    if (i >= us.length || (!isParam(p) && p !== us[i])) return false;
  }
  return ps.length === us.length;
}

/** How specific a pattern is, segment by segment: static 3, [param] 2, [...rest] 1, [[...rest]] 0. */
const rank = (pattern: string) =>
  segments(pattern).map((s) => (isOptionalRest(s) ? 0 : isRest(s) ? 1 : isParam(s) ? 2 : 3));

function moreSpecific(a: string, b: string): boolean {
  const ra = rank(a);
  const rb = rank(b);
  for (let i = 0; i < Math.max(ra.length, rb.length); i++) {
    const x = ra[i] ?? -1;
    const y = rb[i] ?? -1;
    if (x !== y) return x > y;
  }
  return false;
}

/** The route a URL path reaches, as Next.js would choose among the patterns. */
function resolve(url: string, candidates: AppRoute[]): string | null {
  let best: string | null = null;
  for (const { pattern } of candidates) {
    if (matches(pattern, url) && (best === null || moreSpecific(pattern, best))) best = pattern;
  }
  return best;
}

const all = appRoutes();
const pathOf = (p: string) => p.split("?")[0] ?? p;
const covered = (paths: string[]) => new Set(paths.map((p) => resolve(pathOf(p), all)));

test("every route is in the role matrix or on the public list", () => {
  const reached = covered(routes.map((r) => r.path));
  const missing = all.map((r) => r.pattern).filter((p) => !PUBLIC.includes(p) && !reached.has(p));
  expect(missing).toEqual([]);
});

test("every page is in the look checks", () => {
  const looked = covered(lookPages.map((p) => p.path));
  const missing = all.filter((r) => r.kind === "page" && !looked.has(r.pattern));
  expect(missing.map((r) => r.pattern)).toEqual([]);
});

test("the public list names only routes that exist", () => {
  const existing = new Set(all.map((r) => r.pattern));
  expect(PUBLIC.filter((p) => !existing.has(p))).toEqual([]);
});

test("resolving prefers static segments, as Next.js does", () => {
  const sample: AppRoute[] = [
    { pattern: "/api/operator/me", kind: "route" },
    { pattern: "/api/operator/[x]", kind: "route" },
    { pattern: "/t/[slug]/admin", kind: "page" },
    { pattern: "/t/[slug]/[x]", kind: "page" },
    { pattern: "/api/auth/[...all]", kind: "route" },
  ];
  expect(resolve("/api/operator/me", sample)).toBe("/api/operator/me");
  expect(resolve("/api/operator/other", sample)).toBe("/api/operator/[x]");
  expect(resolve("/t/a/admin", sample)).toBe("/t/[slug]/admin");
  expect(resolve("/api/auth/signin/google", sample)).toBe("/api/auth/[...all]");
  expect(resolve("/nowhere", sample)).toBeNull();
  const optional: AppRoute[] = [{ pattern: "/docs/[[...path]]", kind: "page" }];
  expect(resolve("/docs", optional)).toBe("/docs/[[...path]]");
  expect(resolve("/docs/a/b", optional)).toBe("/docs/[[...path]]");
});

test("reads the app folder as Next.js routes it", () => {
  const root = mkdtempSync(path.join(tmpdir(), "routes-"));
  const touch = (file: string) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), "");
  };
  try {
    for (const file of [
      "page.tsx",
      "(group)/inside/page.tsx",
      "_private/page.tsx",
      "docs/[[...path]]/page.tsx",
      "feed/@sidebar/page.tsx",
      "feed/(.)photo/page.tsx",
      "api/thing/route.ts",
      "robots.ts",
      "sitemap.ts",
      "icon.tsx",
      "page.module.css",
    ]) {
      touch(file);
    }
    expect(
      appRoutes(root)
        .map((r) => `${r.kind} ${r.pattern}`)
        .sort(),
    ).toEqual(
      [
        "page /",
        "page /inside",
        "page /docs/[[...path]]",
        "page /feed",
        "route /api/thing",
        "route /robots.txt",
        "route /sitemap.xml",
        "route /icon",
      ].sort(),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
