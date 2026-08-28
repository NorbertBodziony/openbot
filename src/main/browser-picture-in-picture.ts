import type { BrowserBounds, BrowserPictureInPictureEvent } from "@openbot/contracts/ipc";
import { BrowserWindow, screen, WebContentsView } from "electron";
import type { BrowserHost } from "../backend/browser-host";
import {
  BROWSER_PIP_MIN_HEIGHT,
  BROWSER_PIP_MIN_WIDTH,
  constrainBrowserPictureInPictureBounds,
} from "./browser-picture-in-picture-bounds";
import { isTrustedRendererUrl } from "./trusted-renderer";

interface BrowserPictureInPictureOptions {
  mainWindow: BrowserWindow;
  browser: BrowserHost;
  preloadPath: string;
  iconPath: string;
  developmentUrl?: string;
  onEvent: (event: BrowserPictureInPictureEvent) => void;
}

export class BrowserPictureInPicture {
  readonly #options: BrowserPictureInPictureOptions;
  #window: BrowserWindow | null = null;
  #controlsView: WebContentsView | null = null;
  #hoverTimer: NodeJS.Timeout | null = null;
  #controlsVisible = false;
  #closing = false;

  constructor(options: BrowserPictureInPictureOptions) {
    this.#options = options;
  }

  async open(savedBounds?: BrowserBounds): Promise<BrowserBounds> {
    const existing = this.#window;
    if (existing && !existing.isDestroyed()) {
      existing.showInactive();
      existing.moveTop();
      return existing.getBounds();
    }

    const bounds = constrainBrowserPictureInPictureBounds(
      savedBounds,
      this.#options.mainWindow.getBounds(),
      screen.getAllDisplays().map((display) => display.workArea),
    );
    const window = new BrowserWindow({
      ...bounds,
      minWidth: BROWSER_PIP_MIN_WIDTH,
      minHeight: BROWSER_PIP_MIN_HEIGHT,
      frame: false,
      show: false,
      resizable: true,
      fullscreenable: false,
      maximizable: false,
      skipTaskbar: true,
      backgroundColor: "#111415",
      title: "OpenBot Browser",
      icon: this.#options.iconPath,
      webPreferences: {
        preload: this.#options.preloadPath,
        contextIsolation: true,
        devTools: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    this.#window = window;
    this.#closing = false;
    this.#options.browser.setPictureInPictureWindow(window);
    const controlsView = new WebContentsView({
      webPreferences: {
        preload: this.#options.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    this.#controlsView = controlsView;
    controlsView.setBackgroundColor("#00000000");
    this.#options.browser.setPictureInPictureOverlayView(controlsView);
    const positionControls = () => {
      if (window.isDestroyed() || controlsView.webContents.isDestroyed()) return;
      const { width } = window.getContentBounds();
      controlsView.setBounds({ x: 0, y: 0, width, height: 30 });
    };
    positionControls();
    window.setAlwaysOnTop(true, process.platform === "darwin" ? "floating" : "normal");
    if (process.platform === "darwin") {
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
    }
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, targetUrl) => {
      if (!isTrustedRendererUrl(targetUrl)) event.preventDefault();
    });
    controlsView.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    controlsView.webContents.on("will-navigate", (event, targetUrl) => {
      if (!isTrustedRendererUrl(targetUrl)) event.preventDefault();
    });
    const sendBounds = () => {
      if (window.isDestroyed()) return;
      this.#options.onEvent({ type: "bounds-changed", bounds: window.getBounds() });
    };
    window.on("move", sendBounds);
    window.on("resize", () => {
      sendBounds();
      positionControls();
    });
    window.on("closed", () => {
      if (this.#window !== window) return;
      this.#stopHoverTracking();
      this.#window = null;
      this.#controlsView = null;
      this.#options.browser.setPictureInPictureOverlayView(null);
      this.#options.browser.setPictureInPictureWindow(null);
      if (!this.#closing) this.#options.onEvent({ type: "hide" });
      this.#closing = false;
    });

    const developmentUrl = this.#options.developmentUrl;
    await (developmentUrl
      ? window.loadURL(new URL("browser-pip.html", `${developmentUrl}/`).toString())
      : window.loadURL("openbot-app://app/browser-pip.html"));
    await (developmentUrl
      ? controlsView.webContents.loadURL(new URL("browser-pip-controls.html", `${developmentUrl}/`).toString())
      : controlsView.webContents.loadURL("openbot-app://app/browser-pip-controls.html"));
    if (!window.isDestroyed()) {
      this.#startHoverTracking(window, controlsView);
      window.showInactive();
      window.moveTop();
    }
    return window.isDestroyed() ? bounds : window.getBounds();
  }

  dock(): void {
    this.#close("dock");
  }

  close(): void {
    const window = this.#window;
    if (!window || window.isDestroyed()) return;
    this.#closing = true;
    this.#stopHoverTracking();
    this.#options.browser.setPictureInPictureOverlayView(null);
    this.#controlsView?.webContents.close();
    this.#controlsView = null;
    this.#options.browser.setPictureInPictureWindow(null);
    window.destroy();
    this.#window = null;
  }

  hide(): void {
    this.#close("hide");
  }

  destroy(): void {
    this.close();
  }

  #close(type: "dock" | "hide"): void {
    const window = this.#window;
    if (!window || window.isDestroyed()) {
      this.#options.onEvent({ type });
      return;
    }
    this.#closing = true;
    this.#stopHoverTracking();
    this.#options.browser.setPictureInPictureOverlayView(null);
    this.#controlsView?.webContents.close();
    this.#controlsView = null;
    this.#options.browser.setPictureInPictureWindow(null);
    window.destroy();
    this.#window = null;
    this.#options.onEvent({ type });
  }

  #startHoverTracking(window: BrowserWindow, controlsView: WebContentsView): void {
    this.#stopHoverTracking();
    const update = () => {
      if (window.isDestroyed() || controlsView.webContents.isDestroyed()) {
        this.#stopHoverTracking();
        return;
      }
      const cursor = screen.getCursorScreenPoint();
      const bounds = window.getBounds();
      const visible =
        cursor.x >= bounds.x &&
        cursor.x < bounds.x + bounds.width &&
        cursor.y >= bounds.y &&
        cursor.y < bounds.y + bounds.height;
      if (visible === this.#controlsVisible) return;
      this.#controlsVisible = visible;
      void controlsView.webContents
        .executeJavaScript(
          `document.documentElement.classList.toggle("browser-pip-window-hover", ${visible ? "true" : "false"})`,
          true,
        )
        .catch(() => undefined);
    };
    update();
    this.#hoverTimer = setInterval(update, 75);
  }

  #stopHoverTracking(): void {
    if (this.#hoverTimer) clearInterval(this.#hoverTimer);
    this.#hoverTimer = null;
    this.#controlsVisible = false;
  }
}
