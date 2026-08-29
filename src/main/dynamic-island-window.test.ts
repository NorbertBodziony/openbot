// @vitest-environment node

import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DynamicIslandAction } from "@openbot/contracts/ipc";
import type { BrowserWindow, Display, Rectangle } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DynamicIslandWindowController,
  dynamicIslandWindowBounds,
  requireDynamicIslandSender,
} from "./dynamic-island-window";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function display(overrides: Partial<Display>): Display {
  return {
    accelerometerSupport: "unknown",
    bounds: { x: 0, y: 0, width: 1512, height: 982 },
    colorDepth: 30,
    colorSpace: "srgb",
    depthPerComponent: 10,
    detected: true,
    displayFrequency: 60,
    id: 1,
    internal: true,
    label: "Built-in Retina Display",
    maximumCursorSize: { width: 64, height: 64 },
    monochrome: false,
    nativeOrigin: { x: 0, y: 0 },
    rotation: 0,
    scaleFactor: 2,
    size: { width: 1512, height: 982 },
    touchSupport: "unknown",
    workArea: { x: 0, y: 32, width: 1512, height: 950 },
    workAreaSize: { width: 1512, height: 950 },
    ...overrides,
  };
}

describe("dynamic island window geometry", () => {
  it("centers the overlay at each display top edge", () => {
    expect(dynamicIslandWindowBounds(display({ bounds: { x: 200, y: -20, width: 1512, height: 982 } }))).toEqual({
      x: 649,
      y: -20,
      width: 614,
      height: 380,
    });
  });

  it("creates, updates, and removes one window per connected display", async () => {
    const root = await temporaryRoot();
    const windows: FakeWindow[] = [];
    let displays = [
      display({ id: 1 }),
      display({
        id: 2,
        internal: false,
        label: "Studio Display",
        bounds: { x: 1512, y: -120, width: 1920, height: 1080 },
      }),
    ];
    const controller = new DynamicIslandWindowController({
      platform: "darwin",
      preferencePath: join(root, "preference.json"),
      createWindow: (bounds) => {
        const window = new FakeWindow(42 + windows.length, bounds);
        windows.push(window);
        // biome-ignore lint/nursery/noUnsafeTypeAssertion: the test double implements the controller's BrowserWindow surface.
        return window as unknown as BrowserWindow;
      },
      loadWindow: async () => undefined,
      getDisplays: () => displays,
      getMainWindow: () => null,
    });

    await controller.initialize();
    expect(windows).toHaveLength(2);
    expect(controller.overlayRendererIds).toEqual(new Set([42, 43]));

    controller.publish({ ...controller.presentation, activeCount: 2, mode: "working" });
    expect(windows[0]?.webContents.send).toHaveBeenCalledOnce();
    expect(windows[1]?.webContents.send).toHaveBeenCalledOnce();

    controller.setInteractive(43, true);
    expect(windows[0]?.setFocusable).not.toHaveBeenCalledWith(true);
    expect(windows[1]?.setFocusable).toHaveBeenCalledWith(true);

    displays = [
      display({
        id: 2,
        internal: false,
        label: "Studio Display",
        bounds: { x: 1200, y: 20, width: 1800, height: 1169 },
      }),
    ];
    await controller.reconcileWindow();
    expect(windows[0]?.destroy).toHaveBeenCalledOnce();
    expect(windows[1]?.setBounds).toHaveBeenCalledWith({ x: 1793, y: 20, width: 614, height: 380 }, false);
  });

  it("destroys and recreates all display windows with the preference", async () => {
    const root = await temporaryRoot();
    const windows: FakeWindow[] = [];
    const controller = new DynamicIslandWindowController({
      platform: "darwin",
      preferencePath: join(root, "preference.json"),
      createWindow: (bounds) => {
        const window = new FakeWindow(50 + windows.length, bounds);
        windows.push(window);
        // biome-ignore lint/nursery/noUnsafeTypeAssertion: the test double implements the controller's BrowserWindow surface.
        return window as unknown as BrowserWindow;
      },
      loadWindow: async () => undefined,
      getDisplays: () => [display({ id: 1 }), display({ id: 2, internal: false })],
      getMainWindow: () => null,
    });

    await controller.initialize();
    await controller.setPreference(false);
    expect(windows[0]?.destroy).toHaveBeenCalledOnce();
    expect(windows[1]?.destroy).toHaveBeenCalledOnce();
    await controller.setPreference(true);
    expect(windows).toHaveLength(4);
  });

  it("does not create a window outside macOS", async () => {
    const root = await temporaryRoot();
    const createWindow = vi.fn();
    const controller = new DynamicIslandWindowController({
      platform: "linux",
      preferencePath: join(root, "preference.json"),
      createWindow,
      loadWindow: async () => undefined,
      getDisplays: () => [display({})],
      getMainWindow: () => null,
    });
    await controller.initialize();
    expect(createWindow).not.toHaveBeenCalled();
  });

  it("forwards a direct approval without showing or focusing the main window", () => {
    const mainWindow = new FakeWindow(70, { x: 0, y: 0, width: 1200, height: 800 });
    const controller = new DynamicIslandWindowController({
      platform: "darwin",
      preferencePath: "/tmp/dynamic-island-preference.json",
      createWindow: () => {
        throw new Error("An overlay window is not needed for this test.");
      },
      loadWindow: async () => undefined,
      getDisplays: () => [],
      // biome-ignore lint/nursery/noUnsafeTypeAssertion: the test double implements the controller's BrowserWindow surface.
      getMainWindow: () => mainWindow as unknown as BrowserWindow,
    });
    const action: DynamicIslandAction = {
      type: "approve-attention",
      serverId: "local",
      botId: "chief",
      requestId: "approval-1",
    };

    controller.performAction(action);

    expect(mainWindow.webContents.send).toHaveBeenCalledWith("dynamic-island:action", action);
    expect(mainWindow.show).not.toHaveBeenCalled();
    expect(mainWindow.focus).not.toHaveBeenCalled();
  });

  it("forwards a prompt answer without showing or focusing the main window", () => {
    const mainWindow = new FakeWindow(71, { x: 0, y: 0, width: 1200, height: 800 });
    const controller = new DynamicIslandWindowController({
      platform: "darwin",
      preferencePath: "/tmp/dynamic-island-preference.json",
      createWindow: () => {
        throw new Error("An overlay window is not needed for this test.");
      },
      loadWindow: async () => undefined,
      getDisplays: () => [],
      // biome-ignore lint/nursery/noUnsafeTypeAssertion: the test double implements the controller's BrowserWindow surface.
      getMainWindow: () => mainWindow as unknown as BrowserWindow,
    });
    const action: DynamicIslandAction = {
      type: "answer-prompt",
      serverId: "local",
      botId: "research",
      requestId: "prompt-1",
      answers: { source: ["Official data"] },
    };

    controller.performAction(action);

    expect(mainWindow.webContents.send).toHaveBeenCalledWith("dynamic-island:action", action);
    expect(mainWindow.show).not.toHaveBeenCalled();
    expect(mainWindow.focus).not.toHaveBeenCalled();
  });

  it("accepts every overlay renderer and rejects unrelated senders", () => {
    expect(() => requireDynamicIslandSender(10, new Set([10]), "main renderer")).not.toThrow();
    expect(() => requireDynamicIslandSender(12, new Set([11, 12]), "Dynamic Island renderer")).not.toThrow();
    expect(() => requireDynamicIslandSender(13, new Set([11, 12]), "Dynamic Island renderer")).toThrow(
      "outside the Dynamic Island renderer",
    );
    expect(() => requireDynamicIslandSender(10, new Set(), "Dynamic Island renderer")).toThrow(
      "outside the Dynamic Island renderer",
    );
  });
});

class FakeWindow extends EventEmitter {
  readonly webContents: { id: number; send: ReturnType<typeof vi.fn> };
  readonly setBounds = vi.fn();
  readonly showInactive = vi.fn();
  readonly destroy = vi.fn(() => this.emit("closed"));
  readonly setHasShadow = vi.fn();
  readonly setWindowButtonVisibility = vi.fn();
  readonly setAlwaysOnTop = vi.fn();
  readonly setVisibleOnAllWorkspaces = vi.fn();
  readonly setFocusable = vi.fn();
  readonly setIgnoreMouseEvents = vi.fn();
  readonly isMinimized = vi.fn(() => false);
  readonly restore = vi.fn();
  readonly show = vi.fn();
  readonly focus = vi.fn();
  readonly isDestroyed = vi.fn(() => false);

  constructor(
    id: number,
    readonly bounds: Rectangle,
  ) {
    super();
    this.webContents = { id, send: vi.fn() };
  }
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openbot-dynamic-island-window-"));
  roots.push(root);
  return root;
}
