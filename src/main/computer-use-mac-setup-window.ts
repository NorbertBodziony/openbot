import type { ComputerUseMacSetupState, MacPermissionId } from "@openbot/contracts/ipc";
import type { BrowserWindow, NativeImage, WebContents } from "electron";
import type { ComputerUseMacSetupService } from "./computer-use-mac-setup";

export const COMPUTER_USE_PERMISSION_URLS: Record<MacPermissionId, string> = {
  "screen-recording": "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_ScreenCapture",
  accessibility: "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Accessibility",
};

interface ComputerUseMacSetupWindowOptions {
  service: ComputerUseMacSetupService;
  createWindow: () => BrowserWindow;
  loadWindow: (window: BrowserWindow, permission: MacPermissionId) => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  revealPath: (path: string) => void;
  loadDragIcon: (path: string) => Promise<NativeImage | string>;
}

export class ComputerUseMacSetupWindowController {
  readonly #options: ComputerUseMacSetupWindowOptions;
  #window: BrowserWindow | null = null;
  #operationGeneration = 0;

  constructor(options: ComputerUseMacSetupWindowOptions) {
    this.#options = options;
  }

  get rendererId(): number | null {
    return this.#window && !this.#window.isDestroyed() ? this.#window.webContents.id : null;
  }

  getState(): Promise<ComputerUseMacSetupState> {
    return this.#options.service.getState();
  }

  async open(permission: MacPermissionId): Promise<ComputerUseMacSetupState> {
    const generation = ++this.#operationGeneration;
    const state = await this.#options.service.getState();
    if (generation !== this.#operationGeneration || state.status !== "available") return state;

    await this.#options.openExternal(COMPUTER_USE_PERMISSION_URLS[permission]);
    if (generation !== this.#operationGeneration) return state;
    const window = this.#ensureWindow();
    await this.#options.loadWindow(window, permission);
    if (generation === this.#operationGeneration && !window.isDestroyed()) {
      window.show();
      window.focus();
    }
    return state;
  }

  async startDrag(sender: WebContents): Promise<void> {
    if (sender.id !== this.rendererId) throw new Error("Computer Use drag must start from the setup window.");
    const helper = await this.#options.service.requireHelper();
    const icon = await this.#options.loadDragIcon(helper.path);
    sender.startDrag({ file: helper.path, icon });
  }

  async revealHelper(): Promise<void> {
    const helper = await this.#options.service.requireHelper();
    this.#options.revealPath(helper.path);
  }

  close(): void {
    this.#operationGeneration += 1;
    if (!this.#window || this.#window.isDestroyed()) return;
    this.#window.close();
  }

  #ensureWindow(): BrowserWindow {
    if (this.#window && !this.#window.isDestroyed()) return this.#window;
    const window = this.#options.createWindow();
    this.#window = window;
    window.on("closed", () => {
      if (this.#window === window) this.#window = null;
    });
    return window;
  }
}
