import { describe, expect, it } from "vitest";
import { isUpdateBusyPhase } from "./ipc-app-auth";

describe("update phase classification", () => {
  it("never treats a settled phase as busy", () => {
    // A settled phase renders an actionable control, so calling one busy would disable that control
    // with nothing left to resolve it.
    for (const phase of ["idle", "available", "ready", "up-to-date", "error", "unsupported"] as const) {
      expect(isUpdateBusyPhase(phase)).toBe(false);
    }
  });
});
