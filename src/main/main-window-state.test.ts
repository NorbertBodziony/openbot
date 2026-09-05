// @vitest-environment node

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Rectangle } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMainWindowBoundsRecorder,
  ensureMacApplicationPresence,
  presentMainWindow,
  readMainWindowBounds,
  resolveMainWindowBounds,
  writeMainWindowBounds,
} from "./main-window-state";

const primary = { x: 0, y: 0, width: 1440, height: 900 };
const secondary = { x: 1440, y: 0, width: 1920, height: 1080 };

describe("main window state", () => {
  it("keeps the macOS application in the Dock and application switcher", async () => {
    const setActivationPolicy = vi.fn();
    const showDock = vi.fn(async () => undefined);

    await ensureMacApplicationPresence("darwin", setActivationPolicy, showDock);
    await ensureMacApplicationPresence("linux", setActivationPolicy, showDock);

    expect(setActivationPolicy).toHaveBeenCalledOnce();
    expect(setActivationPolicy).toHaveBeenCalledWith("regular");
    expect(showDock).toHaveBeenCalledOnce();
  });

  it("unhides the macOS application and restores a minimized main window", () => {
    const showApplication = vi.fn();
    const window = {
      isMinimized: vi.fn(() => true),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    };

    presentMainWindow(window, "darwin", showApplication);

    expect(showApplication).toHaveBeenCalledOnce();
    expect(window.restore).toHaveBeenCalledOnce();
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
  });

  it("does not use the macOS application API or restore an ordinary window", () => {
    const showApplication = vi.fn();
    const window = {
      isMinimized: vi.fn(() => false),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    };

    presentMainWindow(window, "win32", showApplication);

    expect(showApplication).not.toHaveBeenCalled();
    expect(window.restore).not.toHaveBeenCalled();
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
  });

  it("restores the last visible bounds", () => {
    expect(
      resolveMainWindowBounds(
        { x: 1700, y: 120, width: 1100, height: 760 },
        [primary, secondary],
        primary,
        { width: 1200, height: 820 },
        { width: 960, height: 640 },
      ),
    ).toEqual({ x: 1700, y: 120, width: 1100, height: 760 });
  });

  it("centers a new window on the work area selected by Electron", () => {
    expect(
      resolveMainWindowBounds(
        null,
        [primary, secondary],
        secondary,
        { width: 1200, height: 820 },
        { width: 960, height: 640 },
      ),
    ).toEqual({ x: 1800, y: 130, width: 1200, height: 820 });
  });

  it("moves stale off-screen bounds onto the current display", () => {
    expect(
      resolveMainWindowBounds(
        { x: 4000, y: 120, width: 1200, height: 820 },
        [primary],
        primary,
        { width: 1200, height: 820 },
        { width: 960, height: 640 },
      ),
    ).toEqual({ x: 120, y: 40, width: 1200, height: 820 });
  });

  it("persists valid bounds and ignores malformed state", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-main-window-state-"));
    const path = join(root, "state.json");
    const bounds = { x: 25, y: 30, width: 1200, height: 820 };

    await writeMainWindowBounds(path, bounds);
    await expect(readMainWindowBounds(path)).resolves.toEqual(bounds);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1, ...bounds });

    await writeFile(path, '{"version":1,"x":"bad"}\n');
    await expect(readMainWindowBounds(path)).resolves.toBeNull();
  });
});

describe("main window bounds recorder", () => {
  // The debounce the recorder is built around, spelled out here rather than imported so that
  // changing the constant has to be a decision about this contract.
  const debounceMs = 250;
  const moved = { x: 10, y: 20, width: 1100, height: 700 };
  const resized = { x: 10, y: 20, width: 1180, height: 700 };
  const quitting = { x: 60, y: 70, width: 1300, height: 880 };

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Records what the recorder actually persisted. The debounce exists to turn a burst of moves into
   * one write, and how often it wrote is not observable from the saved file - one write and three
   * writes leave the same bytes behind.
   */
  function recordWrites(): { written: Rectangle[]; writeBounds: (bounds: Rectangle) => Promise<void> } {
    const written: Rectangle[] = [];
    return {
      written,
      writeBounds: async (bounds) => {
        written.push(bounds);
      },
    };
  }

  it("coalesces a burst of window moves into one write", async () => {
    const { written, writeBounds } = recordWrites();
    const recorder = createMainWindowBoundsRecorder({
      getMainWindow: () => null,
      readBounds: async () => null,
      writeBounds,
      reportError: () => undefined,
    });

    recorder.rememberMainWindowBounds(moved);
    await vi.advanceTimersByTimeAsync(debounceMs - 1);
    recorder.rememberMainWindowBounds(resized);
    await vi.advanceTimersByTimeAsync(debounceMs - 1);
    recorder.rememberMainWindowBounds(quitting);
    await vi.advanceTimersByTimeAsync(debounceMs);

    expect(written).toEqual([quitting]);
  });

  it("reopens the window where the last one was left", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-main-window-recorder-"));
    const statePath = join(root, "state.json");
    // Wired to the real file the way the main process wires it, so this covers the round trip and
    // not just the recorder's half of it.
    const dependencies = {
      getMainWindow: () => null,
      readBounds: () => readMainWindowBounds(statePath),
      writeBounds: (bounds: Rectangle) => writeMainWindowBounds(statePath, bounds),
      reportError: () => undefined,
    };

    const recorder = createMainWindowBoundsRecorder(dependencies);
    recorder.rememberMainWindowBounds(moved);
    await recorder.flushMainWindowBounds();

    const relaunched = createMainWindowBoundsRecorder(dependencies);
    await relaunched.restoreMainWindowBounds();

    expect(relaunched.currentMainWindowBounds()).toEqual(moved);
  });

  it("cancels a pending write before it yields, and saves what the window shows now", async () => {
    const { written, writeBounds } = recordWrites();
    const recorder = createMainWindowBoundsRecorder({
      getMainWindow: () => ({ isDestroyed: () => false, getNormalBounds: () => quitting }),
      readBounds: async () => null,
      writeBounds,
      reportError: () => undefined,
    });

    recorder.rememberMainWindowBounds(moved);
    // Windows session-end calls the flush from a synchronous handler and never awaits it, so the
    // debounce has to be gone by the time the call returns - not by the time the promise settles.
    const settled = recorder.flushMainWindowBounds();
    vi.advanceTimersByTime(debounceMs);
    await settled;
    await vi.runAllTimersAsync();

    expect(written).toEqual([quitting]);
  });

  it("keeps saving after a write fails", async () => {
    const { written, writeBounds } = recordWrites();
    const reported: string[] = [];
    let firstWrite = true;
    const recorder = createMainWindowBoundsRecorder({
      getMainWindow: () => null,
      readBounds: async () => null,
      writeBounds: (bounds) => {
        if (!firstWrite) return writeBounds(bounds);
        firstWrite = false;
        return Promise.reject(new Error("disk full"));
      },
      reportError: (message) => {
        reported.push(message);
      },
    });

    recorder.rememberMainWindowBounds(moved);
    await vi.advanceTimersByTimeAsync(debounceMs);
    recorder.rememberMainWindowBounds(quitting);
    await recorder.flushMainWindowBounds();

    expect(written).toEqual([quitting]);
    expect(reported).toEqual([
      "Unable to save the main window position:",
      "Unable to save the previous main window position:",
    ]);
  });
});
