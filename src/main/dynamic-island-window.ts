import { isDeepStrictEqual } from "node:util";
import type { DynamicIslandAction, DynamicIslandPreference, DynamicIslandPresentation } from "@openbot/contracts/ipc";
import { IDLE_DYNAMIC_ISLAND_PRESENTATION, IPC_CHANNELS } from "@openbot/contracts/ipc";
import type { BrowserWindow, Display, Rectangle } from "electron";
import { readDynamicIslandPreference, writeDynamicIslandPreference } from "./dynamic-island-preference-store";

export const DYNAMIC_ISLAND_WINDOW_SIZE = { width: 614, height: 380 } as const;

export const EMPTY_DYNAMIC_ISLAND_PRESENTATION = IDLE_DYNAMIC_ISLAND_PRESENTATION;

export interface DynamicIslandWindowControllerOptions {
  platform: NodeJS.Platform;
  preferencePath: string;
  createWindow: (bounds: Rectangle, display: Display) => BrowserWindow;
  loadWindow: (window: BrowserWindow, display: Display) => Promise<void>;
  getDisplays: () => Display[];
  getMainWindow: () => BrowserWindow | null;
  performHaptic: () => void;
  performCriticalAction: (
    action: Extract<DynamicIslandAction, { type: "approve-attention" | "answer-prompt" }>,
  ) => Promise<void>;
}

export class DynamicIslandWindowController {
  readonly #options: DynamicIslandWindowControllerOptions;
  #preference: DynamicIslandPreference = {
    enabled: true,
    hapticsEnabled: true,
    idleVisible: true,
    additionalDisplaysEnabled: true,
  };
  #presentation = EMPTY_DYNAMIC_ISLAND_PRESENTATION;
  readonly #windows = new Map<number, BrowserWindow>();
  readonly #criticalActions = new Map<string, Promise<void>>();
  #preferenceMutation = Promise.resolve();

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
    this.#criticalActions.clear();
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
    const window = this.#options.getMainWindow();
    if (!window || window.isDestroyed()) return;
    if (action.type === "approve-attention" || action.type === "answer-prompt") {
      if (!this.matchesCriticalAction(action)) return;
      const key = criticalActionKey(action);
      const existing = this.#criticalActions.get(key);
      if (existing) return existing;
      const pending = this.#options.performCriticalAction(action).then(() => {
        if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.dynamicIslandAction, action);
      });
      this.#criticalActions.set(key, pending);
      try {
        await pending;
      } catch (error) {
        if (this.#criticalActions.get(key) === pending) this.#criticalActions.delete(key);
        throw error;
      }
      return;
    }
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    if (action.type !== "open-app") window.webContents.send(IPC_CHANNELS.dynamicIslandAction, action);
  }

  async reconcileWindow(): Promise<void> {
    if (this.#options.platform !== "darwin" || !this.#preference.enabled) {
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
      if (!window.isDestroyed()) window.destroy();
    }

    for (const display of displays) {
      const bounds = dynamicIslandWindowBounds(display);
      const current = this.#windows.get(display.id);
      if (current && !current.isDestroyed()) {
        current.setBounds(bounds, false);
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
    });
    window.on("blur", () => this.setInteractive(window.webContents.id, false));
    window.on("closed", () => {
      if (this.#windows.get(display.id) === window) this.#windows.delete(display.id);
    });
    try {
      await this.#options.loadWindow(window, display);
    } catch (error) {
      if (this.#windows.get(display.id) === window) this.#windows.delete(display.id);
      if (!window.isDestroyed()) window.destroy();
      throw error;
    }
  }

  destroy(): void {
    this.destroyWindows();
  }

  private publishPreference(): void {
    for (const window of this.#windows.values()) {
      if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.dynamicIslandPreference, this.#preference);
    }
  }

  private matchesCriticalAction(
    action: Extract<DynamicIslandAction, { type: "approve-attention" | "answer-prompt" }>,
  ): boolean {
    const presentation = this.#presentation;
    if (action.type === "approve-attention" && presentation.mode !== "approval") return false;
    if (action.type === "answer-prompt" && presentation.mode !== "question") return false;
    if (presentation.mode !== "approval" && presentation.mode !== "question") return false;
    return (
      presentation.serverId === action.serverId &&
      presentation.item.bot.id === action.botId &&
      String(presentation.item.requestId) === String(action.requestId)
    );
  }

  private destroyWindows(): void {
    const windows = [...this.#windows.values()];
    this.#windows.clear();
    for (const window of windows) {
      if (!window.isDestroyed()) window.destroy();
    }
  }
}

function criticalActionKey(
  action: Extract<DynamicIslandAction, { type: "approve-attention" | "answer-prompt" }>,
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

export function requireDynamicIslandSender(actualId: number, expectedIds: ReadonlySet<number>, name: string): void {
  if (!expectedIds.has(actualId)) {
    throw new Error(`Rejected Dynamic Island IPC request outside the ${name}.`);
  }
}
