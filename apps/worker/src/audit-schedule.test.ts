import { describe, expect, it } from "vitest";
import { scheduleIdFor } from "./audit-schedule.ts";

describe("scheduleIdFor", () => {
  it("names the schedules plainly on the deployment's own queue, and apart on any other", () => {
    expect(scheduleIdFor("job-sweep", "documents")).toBe("job-sweep");
    expect(scheduleIdFor("job-sweep", "e2e-1")).toBe("job-sweep-e2e-1");
  });
});
