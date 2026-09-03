// @vitest-environment node

import { describe, expect, it } from "vitest";
import { appendDeltaText, deltaKey, shouldFlushDeltaText } from "./delta-buffer";
import { routineTimerDelayMs } from "./routine-scheduler";
import { clampTimerMs, computeRestartDelayMs, computeRoutineDelayMs } from "./scheduler";

describe("agent scheduler", () => {
  it("clamps routine delays to the timer range", () => {
    expect(computeRoutineDelayMs(null)).toBeNull();
    expect(computeRoutineDelayMs("not-a-date")).toBeNull();
    expect(computeRoutineDelayMs(new Date(1_000).toISOString(), 5_000)).toBe(0);
    expect(computeRoutineDelayMs(new Date(10_000).toISOString(), 1_000)).toBe(9_000);
    expect(computeRoutineDelayMs(new Date(9_999_999_999_999).toISOString(), 0)).toBe(2_147_000_000);
    expect(routineTimerDelayMs(new Date(10_000).toISOString(), 1_000)).toBe(9_000);
  });

  it("backs restart delays off exponentially", () => {
    expect(computeRestartDelayMs(0)).toBe(500);
    expect(computeRestartDelayMs(1)).toBe(1_000);
    expect(computeRestartDelayMs(2)).toBe(2_000);
    expect(clampTimerMs(Number.NaN)).toBe(0);
  });

  it("buffers deltas until the flush threshold", () => {
    expect(deltaKey({ externalThreadId: "thread", turnId: "turn", messageId: "msg" })).toBe("thread:turn:msg");
    expect(shouldFlushDeltaText("small")).toBe(false);
    expect(shouldFlushDeltaText("x".repeat(8 * 1024))).toBe(true);
    expect(appendDeltaText("a", "b")).toEqual({ text: "ab", shouldFlush: false });
  });
});
