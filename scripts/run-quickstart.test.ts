import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { quickstartCommands } from "./run-quickstart.ts";

describe("the README's quick start", () => {
  it("is the commands CI runs: set up, start the services, seed the demo, run the app", () => {
    const readme = readFileSync(path.join(import.meta.dirname, "..", "README.md"), "utf8");
    expect(quickstartCommands(readme)).toEqual([
      "corepack enable",
      "pnpm install",
      "cp .env.example .env.local",
      "docker compose up -d --wait",
      "pnpm demo",
      "pnpm dev",
    ]);
  });

  it("needs the markers and a bash block", () => {
    expect(() => quickstartCommands("no markers")).toThrow(/markers/);
    expect(() =>
      quickstartCommands("<!-- quickstart:start -->\ntext\n<!-- quickstart:end -->"),
    ).toThrow(/bash block/);
  });
});
