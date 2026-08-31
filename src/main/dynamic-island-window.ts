import { isDeepStrictEqual } from "node:util";
import type {
  DynamicIslandAction,
  DynamicIslandNotchSize,
  DynamicIslandPreference,
  DynamicIslandPresentation,
} from "@openbot/contracts/ipc";
import {
  DEFAULT_DYNAMIC_ISLAND_PREFERENCE,
  IDLE_DYNAMIC_ISLAND_PRESENTATION,
  IPC_CHANNELS,
} from "@openbot/contracts/ipc";
import type { BrowserWindow, Display, Rectangle } from "electron";
import { readDynamicIslandPreference, writeDynamicIslandPreference } from "./dynamic-island-preference-store";

export const DYNAMIC_ISLAND_WINDOW_SIZE = { width: 614, height: 380 } as const;

const MACBOOK_NOTCH_REFERENCE = {
  displayWidth: 1512,
  notchWidth: 185,
  notchHeight: 32,
} as const;

export interface DynamicIslandWindowControllerOptions {
  platform: NodeJS.Platform;
  preferencePath: string;
  createWindow: (bounds: Rectangle, display: Display) => BrowserWindow;
  loadWindow: (window: BrowserWindow, display: Display) => Promise<void>;
  getDisplays: () => Display[];
  getMainWindow: () => BrowserWindow | null;
  ensureMainWindow?: () => Promise<BrowserWindow>;
  performHaptic: () => void;
  performCriticalAction: (
    action: Extract<DynamicIslandAction, { type: "answer-prompt" | "respond-approval" }>,
  ) => Promise<void>;
}

export class DynamicIslandWindowController {
  readonly #options: DynamicIslandWindowControllerOptions;
  #preference: DynamicIslandPreference = { ...DEFAULT_DYNAMIC_ISLAND_PREFERENCE };
  #presentation = IDLE_DYNAMIC_ISLAND_PRESENTATION;
  readonly #windows = new Map<number, BrowserWindow>();
  readonly #criticalActions = new Map<string, Promise<void>>();
  readonly #notchSizes = new Map<number, { width: number; height: number }>();
  #preferenceMutation = Promise.resolve();
  #windowReconciliation = Promise.resolve();
  #destroyed = false;

  constructor(options: DynamicIslandWindowControllerOptions) {
    this.#options = options;
  }

  async initialize(): Promise<void> {
    this.#preference = await readDynamicIslandPreference(this.#options.preferencePath);
    await this.reconcileWindow();
  }

  get preference(): DynamicIslandPreference {
    return { ...this.#preference };
  }

  get presentation(): DynamicIslandPresentation {
    return this.#presentation;
  }

  get mainRendererIds(): ReadonlySet<number> {
    const window = this.#options.getMainWindow();
    return new Set(window && !window.isDestroyed() ? [window.webContents.id] : []);
  }

  get overlayRendererIds(): ReadonlySet<number> {
    return new Set(
      [...this.#windows.values()].filter((window) => !window.isDestroyed()).map((window) => window.webContents.id),
    );
  }

  async setPreference(preference: DynamicIslandPreference): Promise<DynamicIslandPreference> {
    let savedPreference: DynamicIslandPreference | undefined;
    const mutation = this.#preferenceMutation.then(async () => {
      savedPreference = await writeDynamicIslandPreference(this.#options.preferencePath, preference);
      this.#preference = savedPreference;
      await this.reconcileWindow();
      this.publishPreference();
    });
    this.#preferenceMutation = mutation.catch(() => undefined);
    await mutation;
    return { ...(savedPreference ?? preference) };
  }

  performHaptic(): void {
    if (!this.#preference.enabled || !this.#preference.hapticsEnabled) return;
    this.#options.performHaptic();
  }

  publish(presentation: DynamicIslandPresentation): void {
    if (isDeepStrictEqual(this.#presentation, presentation)) return;
    this.#presentation = presentation;
    for (const window of this.#windows.values()) {
      if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.dynamicIslandPresentation, presentation);
    }
  }

  setInteractive(rendererId: number, interactive: boolean): void {
    const window = [...this.#windows.values()].find(
      (candidate) => !candidate.isDestroyed() && candidate.webContents.id === rendererId,
    );
    if (!window) return;
    window.setFocusable(interactive);
    window.setIgnoreMouseEvents(!interactive, { forward: true });
  }

  async performAction(action: DynamicIslandAction): Promise<void> {
    if (action.type === "answer-prompt" || action.type === "respond-approval") {
      const key = criticalActionKey(action);
      const existing = this.#criticalActions.get(key);
      if (existing) return existing;
      const pending = this.#ensureMainWindow().then(async (window) => {
        await this.#options.performCriticalAction(action);
        if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.dynamicIslandAction, action);
      });
      this.#criticalActions.set(key, pending);
      try {
        await pending;
      } finally {
        if (this.#criticalActions.get(key) === pending) this.#criticalActions.delete(key);
      }
      return;
    }
    const window = await this.#ensureMainWindow();
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    if (action.type !== "open-app") window.webContents.send(IPC_CHANNELS.dynamicIslandAction, action);
  }

  async #ensureMainWindow(): Promise<BrowserWindow> {
    const current = this.#options.getMainWindow();
    if (current && !current.isDestroyed()) return current;
    const created = await this.#options.ensureMainWindow?.();
    if (!created || created.isDestroyed()) throw new Error("The OpenBot window is unavailable.");
    return created;
  }

  reconcileWindow(): Promise<void> {
    const reconciliation = this.#windowReconciliation.then(() => this.#reconcileWindows());
    this.#windowReconciliation = reconciliation.catch(() => undefined);
    return reconciliation;
  }

  async #reconcileWindows(): Promise<void> {
    if (this.#destroyed || this.#options.platform !== "darwin" || !this.#preference.enabled) {
      this.destroyWindows();
      return;
    }

    const displays = this.#options
      .getDisplays()
      .filter((display) => this.#preference.additionalDisplaysEnabled || display.internal);
    const displayIds = new Set(displays.map((display) => display.id));
    for (const [displayId, window] of this.#windows) {
      if (displayIds.has(displayId) && !window.isDestroyed()) continue;
      this.#windows.delete(displayId);
      this.#notchSizes.delete(displayId);
      if (!window.isDestroyed()) window.destroy();
    }

    for (const display of displays) {
      if (this.#destroyed) return;
      const bounds = dynamicIslandWindowBounds(display);
      const notchSize = notchSizeForDisplay(display);
      const current = this.#windows.get(display.id);
      if (current && !current.isDestroyed()) {
        current.setBounds(bounds, false);
        if (notchSizeChanged(this.#notchSizes.get(display.id), notchSize)) {
          if (notchSize) current.webContents.send(IPC_CHANNELS.dynamicIslandGeometry, notchSize);
          if (notchSize) this.#notchSizes.set(display.id, notchSize);
          else this.#notchSizes.delete(display.id);
        }
        current.showInactive();
        continue;
      }
      try {
        await this.createDisplayWindow(display, bounds);
      } catch (error) {
        console.error(`Unable to load Dynamic Island on display ${display.id}:`, error);
      }
    }
  }

  private async createDisplayWindow(display: Display, bounds: Rectangle): Promise<void> {
    const window = this.#options.createWindow(bounds, display);
    this.#windows.set(display.id, window);
    window.setHasShadow(false);
    window.setWindowButtonVisibility(false);
    window.setAlwaysOnTop(true, "status");
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    window.setFocusable(false);
    window.setIgnoreMouseEvents(true, { forward: true });
    window.once("ready-to-show", () => {
      if (this.#windows.get(display.id) !== window || window.isDestroyed()) return;
      window.showInactive();
      window.webContents.send(IPC_CHANNELS.dynamicIslandPresentation, this.#presentation);
      window.webContents.send(IPC_CHANNELS.dynamicIslandPreference, this.#preference);
      const notchSize = notchSizeForDisplay(display);
      if (notchSize) window.webContents.send(IPC_CHANNELS.dynamicIslandGeometry, notchSize);
    });
    window.on("blur", () => this.setInteractive(window.webContents.id, false));
    window.on("closed", () => {
      if (this.#windows.get(display.id) === window) {
        this.#windows.delete(display.id);
        this.#notchSizes.delete(display.id);
      }
    });
    const notchSize = notchSizeForDisplay(display);
    if (notchSize) this.#notchSizes.set(display.id, notchSize);
    try {
      await this.#options.loadWindow(window, display);
    } catch (error) {
      if (this.#windows.get(display.id) === window) this.#windows.delete(display.id);
      this.#notchSizes.delete(display.id);
      if (!window.isDestroyed()) window.destroy();
      throw error;
    }
  }

  destroy(): void {
    this.#destroyed = true;
    this.destroyWindows();
  }

  private publishPreference(): void {
    for (const window of this.#windows.values()) {
      if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.dynamicIslandPreference, this.#preference);
    }
  }

  private destroyWindows(): void {
    const windows = [...this.#windows.values()];
    this.#windows.clear();
    this.#notchSizes.clear();
    for (const window of windows) {
      if (!window.isDestroyed()) window.destroy();
    }
  }
}

function notchSizeForDisplay(display: Pick<Display, "bounds" | "internal">): DynamicIslandNotchSize | undefined {
  return display.internal ? dynamicIslandNotchSize(display) : undefined;
}

function notchSizeChanged(
  previous: { width: number; height: number } | undefined,
  next: { width: number; height: number } | undefined,
): boolean {
  return previous?.width !== next?.width || previous?.height !== next?.height;
}

function criticalActionKey(
  action: Extract<DynamicIslandAction, { type: "answer-prompt" | "respond-approval" }>,
): string {
  return [action.type, action.serverId, action.botId, String(action.requestId)].join("\u0000");
}

export function dynamicIslandWindowBounds(display: Pick<Display, "bounds">): Rectangle {
  return {
    x: Math.round(display.bounds.x + (display.bounds.width - DYNAMIC_ISLAND_WINDOW_SIZE.width) / 2),
    y: display.bounds.y,
    ...DYNAMIC_ISLAND_WINDOW_SIZE,
  };
}

/**
 * Returns the notch size in Electron's display points.
 *
 * Apple keeps the camera housing proportional across notched MacBooks, while
 * the selected display scale changes the logical display width. Scaling the
 * measured 14-inch reference therefore covers the 13-inch Air, 14-inch Pro,
 * 15-inch Air, and 16-inch Pro without a model-name lookup.
 */
export function dynamicIslandNotchSize(display: Pick<Display, "bounds">): DynamicIslandNotchSize {
  const displayScale = display.bounds.width / MACBOOK_NOTCH_REFERENCE.displayWidth;
  return {
    width: Math.max(16, Math.round(MACBOOK_NOTCH_REFERENCE.notchWidth * displayScale)),
    height: Math.max(32, Math.round(MACBOOK_NOTCH_REFERENCE.notchHeight * displayScale)),
  };
}

export function requireDynamicIslandSender(actualId: number, expectedIds: ReadonlySet<number>, name: string): void {
  if (!expectedIds.has(actualId)) {
    throw new Error(`Rejected Dynamic Island IPC request outside the ${name}.`);
  }
}
