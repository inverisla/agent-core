import { describe, expect, it } from "vitest";
import { logEvent } from "./telemetry.ts";

const capture = (...args: Parameters<typeof logEvent>) => {
  const lines: string[] = [];
  logEvent(args[0], args[1], args[2], (l) => lines.push(l));
  return JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
};

describe("operational events", () => {
  it("writes one JSON line with the event, level and fields", () => {
    const e = capture(
      "job.failed",
      { jobId: "3f2c-1", reason: "model-timeout", attempts: 3 },
      "error",
    );
    expect(e).toMatchObject({
      level: "error",
      event: "job.failed",
      jobId: "3f2c-1",
      reason: "model-timeout",
      attempts: 3,
    });
    expect(typeof e["time"]).toBe("string");
  });

  it("never writes text that could be personal data or content", () => {
    const e = capture("job.failed", {
      email: "someone@example.com",
      note: "Supplier: Example Ltd",
      ok: "contract-summary",
      "bad key!": "x",
    });
    expect(e["email"]).toBe("[redacted]");
    expect(e["note"]).toBe("[redacted]");
    expect(e["ok"]).toBe("contract-summary");
    expect(e).not.toHaveProperty("bad key!");
  });

  it("replaces objects, arrays and other values that slip past the types (review S17)", () => {
    const fields = {
      nested: { email: "someone@example.com" },
      list: ["Supplier: Example Ltd"],
      when: new Date(0),
      big: 10n,
      gone: undefined,
      fn: () => "x",
      fine: 3,
    } as unknown as Record<string, string>;
    const e = capture("job.failed", fields);
    for (const key of ["nested", "list", "when", "big", "gone", "fn"]) {
      expect(e[key], key).toBe("[redacted]");
    }
    expect(e["fine"]).toBe(3);
    expect(JSON.stringify(e)).not.toContain("example");
  });
});
