// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { type HapticProcess, MacHapticFeedback } from "./mac-haptic-feedback";

describe("MacHapticFeedback", () => {
  it("prewarms one macOS helper without performing feedback", () => {
    const process = fakeHapticProcess();
    const spawnProcess = vi.fn(() => process.api);
    const feedback = new MacHapticFeedback({ platform: "darwin", spawnProcess });

    feedback.prepare();
    feedback.prepare();

    expect(spawnProcess).toHaveBeenCalledOnce();
    expect(process.writes).toEqual([]);
  });

  it("keeps one macOS helper alive and throttles alignment feedback", () => {
    let now = 1_000;
    const process = fakeHapticProcess();
    const spawnProcess = vi.fn(() => process.api);
    const feedback = new MacHapticFeedback({ platform: "darwin", now: () => now, spawnProcess });

    feedback.performAlignment();
    now = 1_299;
    feedback.performAlignment();
    now = 1_300;
    feedback.performAlignment();

    expect(spawnProcess).toHaveBeenCalledOnce();
    expect(process.writes).toEqual(["alignment\n", "alignment\n"]);
  });

  it("is a no-op outside macOS", () => {
    const spawnProcess = vi.fn(() => fakeHapticProcess().api);
    const feedback = new MacHapticFeedback({ platform: "linux", spawnProcess });

    feedback.prepare();
    feedback.performAlignment();

    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("recovers silently when the helper exits", () => {
    let now = 1_000;
    const first = fakeHapticProcess();
    const second = fakeHapticProcess();
    const spawnProcess = vi.fn().mockReturnValueOnce(first.api).mockReturnValueOnce(second.api);
    const feedback = new MacHapticFeedback({ platform: "darwin", now: () => now, spawnProcess });

    feedback.performAlignment();
    first.exit();
    now += 300;
    feedback.performAlignment();

    expect(first.writes).toEqual(["alignment\n"]);
    expect(second.writes).toEqual(["alignment\n"]);
  });

  it("ignores helper startup failures", () => {
    const feedback = new MacHapticFeedback({
      platform: "darwin",
      spawnProcess: () => {
        throw new Error("osascript is unavailable");
      },
    });

    expect(() => feedback.performAlignment()).not.toThrow();
  });

  it("ends the helper during shutdown", () => {
    const process = fakeHapticProcess();
    const feedback = new MacHapticFeedback({ platform: "darwin", spawnProcess: () => process.api });

    feedback.performAlignment();
    feedback.destroy();

    expect(process.end).toHaveBeenCalledOnce();
    expect(process.kill).toHaveBeenCalledOnce();
  });
});

function fakeHapticProcess(): {
  api: HapticProcess;
  writes: string[];
  end: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  exit: () => void;
} {
  const writes: string[] = [];
  let running = true;
  let exitListener: () => void = () => undefined;
  const end = vi.fn();
  const kill = vi.fn(() => {
    running = false;
  });
  return {
    api: {
      write: (command) => {
        writes.push(command);
        return true;
      },
      end,
      canWrite: () => running,
      isRunning: () => running,
      kill,
      onError: () => undefined,
      onExit: (listener) => {
        exitListener = listener;
      },
    },
    writes,
    end,
    kill,
    exit: () => {
      running = false;
      exitListener();
    },
  };
}
