import { defineConfig } from "vitest/config";

// One Vitest project per workspace package, plus "integration" for tests that
// need the local stack from `docker compose up` (infra/smoke and *.integration.test.ts).
const units = [
  "apps/web",
  "apps/worker",
  "packages/db",
  "packages/core",
  "packages/blocks",
  "packages/testing",
  // The repository's own scripts (the README quick start runner).
  "scripts",
];

export default defineConfig({
  test: {
    // `pnpm test:coverage`: what the tests reach, to find gaps (review section 5). A
    // report only: CI shows it and never fails on a percentage.
    coverage: {
      provider: "v8",
      include: ["apps/*/{app,lib,src,components}/**/*.{ts,tsx}", "packages/*/src/**/*.ts"],
      exclude: ["**/*.test.{ts,tsx}", "**/testing.ts", "**/test-files.ts", "**/fake-providers.ts"],
      reporter: ["text-summary", "json-summary", "html"],
      reportsDirectory: "coverage",
    },
    projects: [
      ...units.map((root) => ({
        test: {
          name: root.split("/")[1] ?? root,
          root,
          include: ["**/*.test.{ts,tsx}"],
          exclude: ["**/node_modules/**", "**/.next/**", "**/*.integration.test.ts"],
          environment: "node" as const,
        },
      })),
      {
        test: {
          name: "integration",
          include: ["infra/smoke/**/*.test.ts", "{apps,packages}/*/**/*.integration.test.ts"],
          environment: "node" as const,
          testTimeout: 20_000,
        },
      },
    ],
  },
});
