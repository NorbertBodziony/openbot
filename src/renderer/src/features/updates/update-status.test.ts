import type { UpdateFailureCode, UpdateStatus } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { presentUpdateStatus } from "./update-status";

function status(patch: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    phase: "idle",
    currentVersion: "0.4.2",
    availableVersion: null,
    progress: null,
    checkedAt: null,
    message: null,
    errorCode: null,
    ...patch,
  };
}

describe("presentUpdateStatus", () => {
  it.each([
    ["idle", "Check for updates", false],
    ["checking", "Checking for updates…", true],
    ["available", "Download update", false],
    ["downloading", "Downloading update…", true],
    ["ready", "Restart to update", false],
    ["installing", "Restarting…", true],
    ["up-to-date", "Check for updates", false],
  ] as const)("labels the %s phase", (phase, actionLabel, busy) => {
    const presentation = presentUpdateStatus(status({ phase }));
    expect(presentation.actionLabel).toBe(actionLabel);
    expect(presentation.busy).toBe(busy);
  });

  it("never leaves a phase waiting on preparation", () => {
    const phases: UpdateStatus["phase"][] = [
      "idle",
      "checking",
      "available",
      "downloading",
      "ready",
      "installing",
      "up-to-date",
      "error",
      "unsupported",
    ];
    for (const phase of phases) {
      expect(presentUpdateStatus(status({ phase })).actionLabel).not.toMatch(/preparing/iu);
    }
  });

  it.each([
    // A download is retryable in place. An install is not: shutdown preparation has already run, so
    // the message asks for a relaunch and the action falls back to checking rather than inviting a
    // second teardown.
    ["download_failed", "Retry download"],
    ["install_failed", "Check for updates"],
    ["check_failed", "Check for updates"],
  ] as const satisfies readonly (readonly [UpdateFailureCode, string])[])(
    "offers the right action after %s",
    (errorCode, actionLabel) => {
      const presentation = presentUpdateStatus(status({ phase: "error", errorCode }));
      expect(presentation.actionLabel).toBe(actionLabel);
      expect(presentation.busy).toBe(false);
      expect(presentation.supported).toBe(true);
    },
  );

  it("reports an unsupported build as unsupported", () => {
    expect(presentUpdateStatus(status({ phase: "unsupported" })).supported).toBe(false);
  });

  it("shows download progress and otherwise the relevant version", () => {
    expect(presentUpdateStatus(status({ phase: "downloading", progress: 42.4 })).detail).toBe("42%");
    expect(presentUpdateStatus(status({ phase: "available", availableVersion: "0.4.3" })).detail).toBe("v0.4.3");
    expect(presentUpdateStatus(status({ phase: "up-to-date" })).detail).toBe("Up to date");
    expect(presentUpdateStatus(status({ phase: "idle" })).detail).toBe("v0.4.2");
  });
});
