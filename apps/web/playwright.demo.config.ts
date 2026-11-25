import { defineConfig } from "@playwright/test";

// Task 15's done-when, second half: follows docs/demo.md against the demo as the README's
// quick start leaves it (pnpm demo, then pnpm dev on port 3000). Unlike the main e2e
// suite, it starts nothing itself. Run by CI after scripts/run-quickstart.ts.
const executablePath = process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"];

export default defineConfig({
  testDir: "e2e-demo",
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  reporter: process.env["CI"] ? "list" : "line",
  use: {
    baseURL: "http://localhost:3000",
    trace: "off",
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
});
