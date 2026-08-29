// @vitest-environment node

import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DynamicIslandAction, DynamicIslandPreference, DynamicIslandPresentation } from "@openbot/contracts/ipc";
import type { BrowserWindow, Display, Rectangle } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as preferenceStore from "./dynamic-island-preference-store";
import {
  DynamicIslandWindowController,
  dynamicIslandWindowBounds,
  requireDynamicIslandSender,
} from "./dynamic-island-window";

const roots: string[] = [];

function preference(overrides: Partial<DynamicIslandPreference> = {}): DynamicIslandPreference {
  return {
    enabled: true,
    hapticsEnabled: true,
    idleVisible: true,
    additionalDisplaysEnabled: true,
    ...overrides,
  };
}

function criticalPresentation(
  mode: "approval" | "question",
  requestId: string,
  serverId = "local",
  botId = "chief",
): DynamicIslandPresentation {
  const bot = { id: botId, name: "Chief", avatarSeed: botId, avatarHue: 215 as const, avatarUrl: null };
  if (mode === "approval") {
    return {
      serverId,
      mode,
      remainingCount: 0,
      item: {
        requestId,
        bot,
        title: "Approve",
        detail: "Review the request.",
        approval: {
          kind: "command",
          command: "bun test",
          cwd: null,
          reason: null,
          grantRoot: null,
          permissions: null,
        },
      },
    };
  }
  return {
    serverId,
    mode,
    remainingCount: 0,
    item: {
      requestId,
      bot,
      title: "Choose",
      detail: "Choose an option.",
      questions: [{ id: "choice", header: "Choose", question: "Choose an option.", isSecret: false, options: null }],
    },
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
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
      performHaptic: () => undefined,
      performCriticalAction: async () => undefined,
    });

    await controller.initialize();
    expect(windows).toHaveLength(2);
    expect(controller.overlayRendererIds).toEqual(new Set([42, 43]));

    controller.publish({ serverId: "local", mode: "working", working: [] });
    controller.publish({ serverId: "local", mode: "working", working: [] });
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

  it("continues loading other displays when one overlay fails", async () => {
    const root = await temporaryRoot();
    const windows: FakeWindow[] = [];
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const controller = new DynamicIslandWindowController({
      platform: "darwin",
      preferencePath: join(root, "preference.json"),
      createWindow: (bounds) => {
        const window = new FakeWindow(80 + windows.length, bounds);
        windows.push(window);
        // biome-ignore lint/nursery/noUnsafeTypeAssertion: the test double implements the controller's BrowserWindow surface.
        return window as unknown as BrowserWindow;
      },
      loadWindow: async (_window, targetDisplay) => {
        if (targetDisplay.id === 1) throw new Error("overlay failed");
      },
      getDisplays: () => [display({ id: 1 }), display({ id: 2, internal: false })],
      getMainWindow: () => null,
      performHaptic: () => undefined,
      performCriticalAction: async () => undefined,
    });

    await expect(controller.initialize()).resolves.toBeUndefined();

    expect(windows).toHaveLength(2);
    expect(windows[0]?.destroy).toHaveBeenCalledOnce();
    expect(controller.overlayRendererIds).toEqual(new Set([81]));
    expect(error).toHaveBeenCalledWith("Unable to load Dynamic Island on display 1:", expect.any(Error));
  });

  it("serializes preference writes in invocation order", async () => {
    const root = await temporaryRoot();
    const writes: Array<{
      preference: DynamicIslandPreference;
      resolve: (preference: DynamicIslandPreference) => void;
    }> = [];
    vi.spyOn(preferenceStore, "writeDynamicIslandPreference").mockImplementation(
      async (_path, nextPreference) => new Promise((resolve) => writes.push({ preference: nextPreference, resolve })),
    );
    const controller = new DynamicIslandWindowController({
      platform: "linux",
      preferencePath: join(root, "preference.json"),
      createWindow: () => {
        throw new Error("An overlay window is not expected.");
      },
      loadWindow: async () => undefined,
      getDisplays: () => [],
      getMainWindow: () => null,
      performHaptic: () => undefined,
      performCriticalAction: async () => undefined,
    });
    const firstPreference = preference({ hapticsEnabled: false });
    const latestPreference = preference({ idleVisible: false });

    const first = controller.setPreference(firstPreference);
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    const second = controller.setPreference(latestPreference);
    await Promise.resolve();
    expect(writes).toHaveLength(1);

    writes[0]?.resolve(firstPreference);
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    writes[1]?.resolve(latestPreference);
    await expect(Promise.all([first, second])).resolves.toEqual([firstPreference, latestPreference]);
    expect(controller.preference).toEqual(latestPreference);
  });

  it("applies the window and haptic preferences independently", async () => {
    const root = await temporaryRoot();
    const windows: FakeWindow[] = [];
    const performHaptic = vi.fn();
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
      performHaptic,
      performCriticalAction: async () => undefined,
    });

    await controller.initialize();
    controller.performHaptic();
    expect(performHaptic).toHaveBeenCalledOnce();
    await controller.setPreference(preference({ enabled: false }));
    expect(windows[0]?.destroy).toHaveBeenCalledOnce();
    expect(windows[1]?.destroy).toHaveBeenCalledOnce();
    controller.performHaptic();
    expect(performHaptic).toHaveBeenCalledOnce();
    await controller.setPreference(preference({ hapticsEnabled: false }));
    expect(windows).toHaveLength(4);
    controller.performHaptic();
    expect(performHaptic).toHaveBeenCalledOnce();
    await controller.setPreference(preference());
    controller.performHaptic();
    expect(performHaptic).toHaveBeenCalledTimes(2);
  });

  it("removes external display overlays independently of the built-in display", async () => {
    const root = await temporaryRoot();
    const windows: FakeWindow[] = [];
    const controller = new DynamicIslandWindowController({
      platform: "darwin",
      preferencePath: join(root, "preference.json"),
      createWindow: (bounds) => {
        const window = new FakeWindow(60 + windows.length, bounds);
        windows.push(window);
        // biome-ignore lint/nursery/noUnsafeTypeAssertion: the test double implements the controller's BrowserWindow surface.
        return window as unknown as BrowserWindow;
      },
      loadWindow: async () => undefined,
      getDisplays: () => [display({ id: 1 }), display({ id: 2, internal: false })],
      getMainWindow: () => null,
      performHaptic: () => undefined,
      performCriticalAction: async () => undefined,
    });

    await controller.initialize();
    await controller.setPreference(preference({ additionalDisplaysEnabled: false }));

    expect(windows[0]?.destroy).not.toHaveBeenCalled();
    expect(windows[1]?.destroy).toHaveBeenCalledOnce();
    expect(controller.overlayRendererIds).toEqual(new Set([60]));
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
      performHaptic: () => undefined,
      performCriticalAction: async () => undefined,
    });
    await controller.initialize();
    expect(createWindow).not.toHaveBeenCalled();
  });

  it("executes and forwards a direct approval without showing or focusing the main window", async () => {
    const mainWindow = new FakeWindow(70, { x: 0, y: 0, width: 1200, height: 800 });
    const performCriticalAction = vi.fn(async () => undefined);
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
      performHaptic: () => undefined,
      performCriticalAction,
    });
    const action: DynamicIslandAction = {
      type: "approve-attention",
      serverId: "local",
      botId: "chief",
      requestId: "approval-1",
    };
    controller.publish(criticalPresentation("approval", "approval-1"));

    await controller.performAction(action);

    expect(performCriticalAction).toHaveBeenCalledWith(action);
    expect(mainWindow.webContents.send).toHaveBeenCalledWith("dynamic-island:action", action);
    expect(mainWindow.show).not.toHaveBeenCalled();
    expect(mainWindow.focus).not.toHaveBeenCalled();
  });

  it("executes and forwards a prompt answer without showing or focusing the main window", async () => {
    const mainWindow = new FakeWindow(71, { x: 0, y: 0, width: 1200, height: 800 });
    const performCriticalAction = vi.fn(async () => undefined);
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
      performHaptic: () => undefined,
      performCriticalAction,
    });
    const action: DynamicIslandAction = {
      type: "answer-prompt",
      serverId: "local",
      botId: "research",
      requestId: "prompt-1",
      answers: { source: ["Official data"] },
    };
    controller.publish(criticalPresentation("question", "prompt-1", "local", "research"));

    await controller.performAction(action);

    expect(performCriticalAction).toHaveBeenCalledWith(action);
    expect(mainWindow.webContents.send).toHaveBeenCalledWith("dynamic-island:action", action);
    expect(mainWindow.show).not.toHaveBeenCalled();
    expect(mainWindow.focus).not.toHaveBeenCalled();
  });

  it("deduplicates the same critical action across overlay displays", async () => {
    const mainWindow = new FakeWindow(73, { x: 0, y: 0, width: 1200, height: 800 });
    let completeAction: () => void = () => undefined;
    const performCriticalAction = vi.fn(
      async () =>
        new Promise<void>((resolve) => {
          completeAction = resolve;
        }),
    );
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
      performHaptic: () => undefined,
      performCriticalAction,
    });
    const action = {
      type: "approve-attention",
      serverId: "local",
      botId: "chief",
      requestId: "approval-shared",
    } satisfies DynamicIslandAction;
    controller.publish(criticalPresentation("approval", "approval-shared"));

    const first = controller.performAction(action);
    const second = controller.performAction(action);
    await vi.waitFor(() => expect(performCriticalAction).toHaveBeenCalledOnce());
    completeAction();
    await Promise.all([first, second]);

    expect(mainWindow.webContents.send).toHaveBeenCalledOnce();
  });

  it("ignores a critical action that does not match the published request", async () => {
    const mainWindow = new FakeWindow(74, { x: 0, y: 0, width: 1200, height: 800 });
    const performCriticalAction = vi.fn(async () => undefined);
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
      performHaptic: () => undefined,
      performCriticalAction,
    });
    controller.publish(criticalPresentation("approval", "approval-current"));

    await controller.performAction({
      type: "approve-attention",
      serverId: "local",
      botId: "chief",
      requestId: "approval-stale",
    });

    expect(performCriticalAction).not.toHaveBeenCalled();
    expect(mainWindow.webContents.send).not.toHaveBeenCalled();
  });

  it("does not dismiss a critical action when execution fails", async () => {
    const mainWindow = new FakeWindow(72, { x: 0, y: 0, width: 1200, height: 800 });
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
      performHaptic: () => undefined,
      performCriticalAction: async () => {
        throw new Error("The request is no longer active.");
      },
    });
    const action: DynamicIslandAction = {
      type: "approve-attention",
      serverId: "remote",
      botId: "research",
      requestId: "approval-stale",
    };
    controller.publish(criticalPresentation("approval", "approval-stale", "remote", "research"));

    await expect(controller.performAction(action)).rejects.toThrow("no longer active");
    expect(mainWindow.webContents.send).not.toHaveBeenCalled();
    expect(mainWindow.show).not.toHaveBeenCalled();
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
