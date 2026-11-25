import { defineConfig } from "@playwright/test";

// End-to-end tests run against the production build (`pnpm build` first). Global
// setup creates a throwaway database, seeds two tenants and starts the app on it.
const executablePath = process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"];

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env["CI"]),
  reporter: process.env["CI"] ? "list" : "line",
  use: {
    baseURL: "http://localhost:3100",
    trace: "off",
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
});
