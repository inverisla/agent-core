import { cleanFields } from "@agent-core/blocks";
import { describe, expect, it, vi } from "vitest";
import { RUN_JOB_HEARTBEAT_MS, startHeartbeat } from "./activities.ts";

describe("job outputs", () => {
  it("lose characters Postgres or a Word report cannot hold, in values and keys", () => {
    expect(cleanFields({ a: "x\0y\f", "b\0": [{ c: "\0" }, 1, null], d: true })).toEqual({
      a: "xy",
      b: [{ c: "" }, 1, null],
      d: true,
    });
  });
});

describe("an attempt's heartbeat", () => {
  it("beats every 15 s until stopped, then never again", () => {
    vi.useFakeTimers();
    try {
      const beat = vi.fn();
      const stop = startHeartbeat(beat);
      vi.advanceTimersByTime(RUN_JOB_HEARTBEAT_MS * 3);
      expect(beat).toHaveBeenCalledTimes(3);
      stop();
      vi.advanceTimersByTime(RUN_JOB_HEARTBEAT_MS * 10);
      expect(beat).toHaveBeenCalledTimes(3);
      // Well inside the workflow's one-minute heartbeat timeout.
      expect(RUN_JOB_HEARTBEAT_MS * 2).toBeLessThan(60_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
