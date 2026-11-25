// The alert rules match event names written by the code: a renamed event would silently
// stop its alert. This checks every name in infra/azure/modules/monitoring.bicep is one
// logEvent can write.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EVENT_NAMES } from "./telemetry.ts";

const bicep = readFileSync(
  path.join(import.meta.dirname, "../../../infra/azure/modules/monitoring.bicep"),
  "utf8",
);

describe("alert rules", () => {
  it("only match event names the code writes", () => {
    const used = [
      ...[...bicep.matchAll(/eventQuery\(\w+, '([^']+)'\)/g)].map((m) => m[1]),
      ...[...bicep.matchAll(/tostring\(e\.event\) == "([^"$]+)"/g)].map((m) => m[1]),
    ];
    expect(used.length).toBeGreaterThanOrEqual(5);
    for (const name of used) expect(EVENT_NAMES as readonly string[]).toContain(name);
    expect(used).toContain("job.failed");
    expect(used).toContain("sign-in.refused");
  });

  it("match event names only, never free text a reworded log line would break (review T17)", () => {
    expect(bicep).not.toMatch(/Log_s has/);
  });
});
