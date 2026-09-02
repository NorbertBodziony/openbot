import { describe, expect, it } from "vitest";
import {
  isUpdateActivePhase,
  isUpdateBusyPhase,
  UPDATE_ACTIVE_PHASES,
  UPDATE_BUSY_PHASES,
  UPDATE_PHASES,
  type UpdatePhase,
} from "./ipc-app-auth";

describe("update phase classification", () => {
  it("lists every phase exactly once", () => {
    expect(new Set(UPDATE_PHASES).size).toBe(UPDATE_PHASES.length);
  });

  it("classifies only known phases", () => {
    for (const phase of [...UPDATE_BUSY_PHASES, ...UPDATE_ACTIVE_PHASES]) {
      expect(UPDATE_PHASES).toContain(phase);
    }
    expect(new Set(UPDATE_BUSY_PHASES).size).toBe(UPDATE_BUSY_PHASES.length);
    expect(new Set(UPDATE_ACTIVE_PHASES).size).toBe(UPDATE_ACTIVE_PHASES.length);
  });

  it("keeps the predicates in step with the lists", () => {
    const busy = new Set<UpdatePhase>(UPDATE_BUSY_PHASES);
    const active = new Set<UpdatePhase>(UPDATE_ACTIVE_PHASES);
    for (const phase of UPDATE_PHASES) {
      expect(isUpdateBusyPhase(phase)).toBe(busy.has(phase));
      expect(isUpdateActivePhase(phase)).toBe(active.has(phase));
    }
  });

  it("never treats a settled phase as busy", () => {
    // A settled phase renders an actionable control, so calling one busy would disable that control
    // with nothing left to resolve it.
    for (const phase of ["idle", "available", "ready", "up-to-date", "error", "unsupported"] as const) {
      expect(isUpdateBusyPhase(phase)).toBe(false);
    }
  });
});
