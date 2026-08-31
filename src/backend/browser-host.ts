import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type {
  BrowserBounds,
  BrowserControlAction,
  BrowserControlSession,
  BrowserControlState,
  BrowserNavigationDirection,
  BrowserPreview,
  BrowserTab,
  BrowserViewTarget,
  BrowserVisibilityInput,
} from "@openbot/contracts/ipc";
import { type DynamicRecord, isBoolean, isNumber, isString } from "@openbot/contracts/runtime-values";
import { app, type BrowserWindow, type Session, session, type WebContents, WebContentsView } from "electron";
import { embeddedBrowserUserAgent, embeddedBrowserUserAgentForUrl } from "./browser-identity";
import { isCloseBrowserTabShortcut, isGlobalSearchShortcut, isToggleDevToolsShortcut } from "./browser-shortcuts";
import { persistentBrowserUrl } from "./browser-state";
import type { DynamicToolCallParams, DynamicToolResult } from "./protocol";
import { isRecord } from "./protocol";

interface BrowserHostEvents {
  changed: [tabs: BrowserTab[], activeTabId: string | null];
  controlChanged: [state: BrowserControlState];
}

interface InternalTab {
  id: string;
  view: WebContentsView;
  requestedUrl: string;
  ownerThreadId: string | null;
  ownerBotId: string | null;
  revision: number;
  queue: Promise<unknown>;
  focusOnVisible: boolean;
}

interface StoredBrowserState {
  version: 1;
  activeTabId: string | null;
  tabs: Array<{
    id: string;
    url: string;
    ownerThreadId: string | null;
    ownerBotId: string | null;
  }>;
}

interface BrowserSnapshot {
  tabId: string;
  revision: number;
  title: string;
  url: string;
  text: string;
  elements: Array<{
    ref: string;
    tag: string;
    role: string | null;
    name: string;
    disabled: boolean;
  }>;
}

type BrowserAction =
  | { type: "click"; ref: string }
  | { type: "type"; ref: string; text: string; submit?: boolean }
  | { type: "key"; key: string }
  | { type: "scroll"; deltaY: number }
  | { type: "back" }
  | { type: "forward" }
  | { type: "reload" };

export const OPENBOT_BROWSER_NAMESPACE = "openbot_browser";

export const BROWSER_DYNAMIC_TOOLS = [
  {
    type: "namespace",
    name: OPENBOT_BROWSER_NAMESPACE,
    description: "Operate OpenBot's private, persistent local browser.",
    tools: [
      functionTool("open", "Open an HTTP(S) URL in a new tab.", {
        type: "object",
        properties: { url: { type: "string", maxLength: INPUT_LIMITS.browserUrl } },
        required: ["url"],
        additionalProperties: false,
      }),
      functionTool("list_tabs", "List the browser tabs.", emptySchema()),
      functionTool("snapshot", "Read a page and obtain current element references.", {
        type: "object",
        properties: { tabId: { type: "string", maxLength: INPUT_LIMITS.identifier } },
        required: ["tabId"],
        additionalProperties: false,
      }),
      functionTool(
        "request_takeover",
        "Pause and ask the user to take over the current browser tab for login, consent, CAPTCHA, passkey, two-factor authentication, or another authorization step. The call waits until the user finishes or cancels.",
        {
          type: "object",
          properties: { tabId: { type: "string", maxLength: INPUT_LIMITS.identifier } },
          required: ["tabId"],
          additionalProperties: false,
        },
      ),
      functionTool("act", "Click, type, press a key, scroll, navigate back/forward, or reload.", {
        type: "object",
        properties: {
          tabId: { type: "string", maxLength: INPUT_LIMITS.identifier },
          revision: { type: "integer" },
          action: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: ["click", "type", "key", "scroll", "back", "forward", "reload"],
              },
              ref: { type: "string", maxLength: INPUT_LIMITS.identifier },
              text: { type: "string", maxLength: INPUT_LIMITS.browserActionText },
              submit: { type: "boolean" },
              key: { type: "string", maxLength: 32 },
              deltaY: { type: "number" },
            },
            required: ["type"],
            additionalProperties: false,
          },
        },
        required: ["tabId", "revision", "action"],
        additionalProperties: false,
      }),
      functionTool("screenshot", "Capture the visible page as an image.", {
        type: "object",
        properties: { tabId: { type: "string", maxLength: INPUT_LIMITS.identifier } },
        required: ["tabId"],
        additionalProperties: false,
      }),
      functionTool("close_tab", "Close a browser tab.", {
        type: "object",
        properties: { tabId: { type: "string", maxLength: INPUT_LIMITS.identifier } },
        required: ["tabId"],
        additionalProperties: false,
      }),
    ],
  },
] as const;

export class BrowserHost {
  static readonly CONTROL_IDLE_GRACE_MS = 1_200;
  readonly #window: BrowserWindow;
  readonly #session: Session;
  readonly #downloadsRoot: string;
  readonly #statePath: string;
  readonly #tabs = new Map<string, InternalTab>();
  readonly #listeners = new Set<(...args: BrowserHostEvents["changed"]) => void>();
  readonly #controlListeners = new Set<(...args: BrowserHostEvents["controlChanged"]) => void>();
  readonly #controlSessions = new Map<string, BrowserControlSession>();
  readonly #controlTimers = new Map<string, NodeJS.Timeout>();
  readonly #reservedDownloadPaths = new Set<string>();
  #activeTabId: string | null = null;
  #visible = false;
  #bounds: BrowserBounds | null = null;
  #attachedView: WebContentsView | null = null;
  #pictureInPictureWindow: BrowserWindow | null = null;
  #pictureInPictureOverlayView: WebContentsView | null = null;
  #target: BrowserViewTarget = "main";
  readonly #mountedViews = new Map<WebContentsView, BrowserWindow>();
  #persistQueue: Promise<void> = Promise.resolve();

  constructor(window: BrowserWindow, downloadsRoot: string, statePath: string) {
    this.#window = window;
    this.#downloadsRoot = downloadsRoot;
    this.#statePath = statePath;
    this.#session = session.fromPartition("persist:openbot-browser", { cache: true });
    this.#configureSession();
  }

  async restore(): Promise<void> {
    const state = await readBrowserState(this.#statePath);
    if (state.tabs.length === 0) return;

    const tabs = state.tabs.slice(0, INPUT_LIMITS.browserTabs).map((stored) => {
      const tab = this.#createTab(stored.id, stored.url, stored.ownerThreadId, stored.ownerBotId);
      this.#tabs.set(tab.id, tab);
      this.#bindTabEvents(tab);
      return tab;
    });
    this.#activeTabId = this.#tabs.has(state.activeTabId ?? "") ? state.activeTabId : (tabs[0]?.id ?? null);
    this.#syncAttachedView();
    this.#emitChanged();

    for (const tab of tabs) {
      void tab.view.webContents.loadURL(tab.requestedUrl, browserLoadOptions()).catch(() => undefined);
    }
  }

  onChanged(listener: (...args: BrowserHostEvents["changed"]) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onControlChanged(listener: (...args: BrowserHostEvents["controlChanged"]) => void): () => void {
    this.#controlListeners.add(listener);
    return () => this.#controlListeners.delete(listener);
  }

  getControlState(): BrowserControlState {
    return {
      sessions: [...this.#controlSessions.values()]
        .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
        .map((session) => ({ ...session })),
    };
  }

  endControl(threadId: string, turnId: string): void {
    const id = controlSessionId(threadId, turnId);
    const timer = this.#controlTimers.get(id);
    if (timer) clearTimeout(timer);
    this.#controlTimers.delete(id);
    if (!this.#controlSessions.delete(id)) return;
    this.#emitControlChanged();
  }

  clearControls(): void {
    for (const timer of this.#controlTimers.values()) clearTimeout(timer);
    this.#controlTimers.clear();
    if (this.#controlSessions.size === 0) return;
    this.#controlSessions.clear();
    this.#emitControlChanged();
  }

  listTabs(): BrowserTab[] {
    return [...this.#tabs.values()].map((tab) => toPublicTab(tab));
  }

  get activeTabId(): string | null {
    return this.#activeTabId;
  }

  get visible(): boolean {
    return this.#visible;
  }

  getDisplayState(): { tabs: BrowserTab[]; activeTabId: string | null } {
    return { tabs: this.listTabs(), activeTabId: this.#activeTabId };
  }

  setPictureInPictureWindow(window: BrowserWindow | null): void {
    this.#pictureInPictureWindow = window;
    if (!window && this.#target === "picture-in-picture") {
      this.#visible = false;
      this.#target = "main";
      if (this.#attachedView) this.#mountView(this.#attachedView, this.#window);
    }
    this.#syncAttachedView();
  }

  setPictureInPictureOverlayView(view: WebContentsView | null): void {
    const previous = this.#pictureInPictureOverlayView;
    const window = this.#pictureInPictureWindow;
    if (previous && window && !window.isDestroyed()) window.contentView.removeChildView(previous);
    this.#pictureInPictureOverlayView = view;
    if (view && window && !window.isDestroyed()) window.contentView.addChildView(view);
  }

  async open(
    url: string,
    ownerThreadId: string | null = null,
    ownerBotId: string | null = null,
    focus = false,
  ): Promise<BrowserTab> {
    if (this.#tabs.size >= INPUT_LIMITS.browserTabs) {
      throw new Error(`The browser can have up to ${INPUT_LIMITS.browserTabs} open tabs.`);
    }
    const normalizedUrl = normalizeBrowserUrl(url);
    const tab = this.#createTab(randomUUID(), normalizedUrl, ownerThreadId, ownerBotId);

    this.#tabs.set(tab.id, tab);
    this.#bindTabEvents(tab);
    this.#activeTabId = tab.id;
    tab.focusOnVisible = focus;
    this.#syncAttachedView();
    this.#emitChanged();
    await this.#persistState();

    try {
      await tab.view.webContents.loadURL(normalizedUrl, browserLoadOptions());
      if (focus) {
        this.#focusTab(tab);
        setImmediate(() => this.#focusTab(tab));
      }
    } catch (error) {
      if (this.#tabs.get(tab.id) === tab) {
        this.#unmountView(tab.view);
        this.#tabs.delete(tab.id);
        tab.view.webContents.close();
        if (this.#activeTabId === tab.id) {
          this.#activeTabId = this.#tabs.keys().next().value ?? null;
        }
        this.#syncAttachedView();
      }
      this.#emitChanged();
      await this.#persistState();
      throw new Error(`Unable to open ${normalizedUrl}: ${String(error)}`);
    }

    return toPublicTab(tab);
  }

  async activate(tabId: string): Promise<void> {
    this.#requireTab(tabId);
    this.#activeTabId = tabId;
    this.#syncAttachedView();
    this.#emitChanged();
    await this.#persistState();
  }

  async navigate(tabId: string, direction: BrowserNavigationDirection): Promise<void> {
    await this.#enqueue(tabId, async (tab) => {
      navigateHistory(tab.view.webContents, direction, this.#session.getUserAgent());
    });
  }

  async reload(tabId: string): Promise<void> {
    await this.#enqueue(tabId, async (tab) => tab.view.webContents.reload());
  }

  async close(tabId: string): Promise<void> {
    const tab = this.#requireTab(tabId);
    const tabIds = [...this.#tabs.keys()];
    const closedIndex = tabIds.indexOf(tabId);
    this.#unmountView(tab.view);
    this.#tabs.delete(tabId);
    tab.view.webContents.close();

    if (this.#activeTabId === tabId) {
      this.#activeTabId = tabIds[closedIndex + 1] ?? tabIds[closedIndex - 1] ?? null;
    }
    this.#syncAttachedView();
    this.#emitChanged();
    await this.#persistState();
  }

  async setVisible(input: BrowserVisibilityInput): Promise<void> {
    this.#visible = input.visible;
    if (input.bounds) this.#bounds = validateBounds(input.bounds);
    if (input.target) this.#target = input.target;
    this.#syncAttachedView();
  }

  async snapshot(tabId: string): Promise<BrowserSnapshot> {
    return this.#enqueue(tabId, async (tab) => {
      const revision = tab.revision + 1;
      return this.#readSnapshot(tab, revision);
    });
  }

  async act(tabId: string, revision: number, action: BrowserAction): Promise<BrowserSnapshot> {
    return this.#enqueue(tabId, async (tab) => {
      if (revision !== tab.revision) {
        throw new Error("Stale browser references. Take a fresh snapshot before acting.");
      }

      const wasVisible = tab.view.getVisible();
      const previousBounds = tab.view.getBounds();
      const restoreRendererFocus = !wasVisible && this.#window.webContents.isFocused();
      if (!wasVisible) {
        tab.view.setBounds({
          ...previousBounds,
          x: 1 - previousBounds.width,
          y: 1 - previousBounds.height,
        });
        tab.view.setVisible(true);
        tab.view.webContents.invalidate();
      }
      tab.view.webContents.focus();
      try {
        if (!wasVisible) await delay(250);
        await withTimeout(
          performAction(tab.view.webContents, action, this.#session.getUserAgent()),
          10_000,
          "Browser action timed out.",
        );
        await delay(50);
      } finally {
        if (!wasVisible) {
          tab.view.setVisible(false);
          tab.view.setBounds(previousBounds);
          this.#syncAttachedView();
          if (restoreRendererFocus) this.#window.webContents.focus();
        }
      }
      await delay(250);
      const nextRevision = tab.revision + 1;
      return this.#readSnapshot(tab, nextRevision);
    });
  }

  async screenshot(tabId: string): Promise<string> {
    return this.#enqueue(tabId, async (tab) => {
      const image = await withTimeout(tab.view.webContents.capturePage(), 10_000, "Browser screenshot timed out.");
      return image.toDataURL();
    });
  }

  async capturePreview(tabId: string): Promise<BrowserPreview> {
    return this.#enqueue(tabId, async (tab) => {
      const image = await withTimeout(tab.view.webContents.capturePage(), 10_000, "Browser preview timed out.");
      const size = image.getSize();
      if (size.width <= 0 || size.height <= 0) throw new Error("Browser preview is empty.");

      const targetAspectRatio = 16 / 10;
      let cropWidth = size.width;
      let cropHeight = Math.round(cropWidth / targetAspectRatio);
      if (cropHeight > size.height) {
        cropHeight = size.height;
        cropWidth = Math.round(cropHeight * targetAspectRatio);
      }
      const cropped = image.crop({
        x: Math.max(0, Math.floor((size.width - cropWidth) / 2)),
        y: 0,
        width: cropWidth,
        height: cropHeight,
      });
      const preview = cropped.resize({ width: 960, height: 600, quality: "good" });
      const dataUrl = `data:image/jpeg;base64,${preview.toJPEG(72).toString("base64")}`;
      return { dataUrl, width: 960, height: 600 };
    });
  }

  async handleDynamicTool(params: DynamicToolCallParams): Promise<DynamicToolResult> {
    const args = isRecord(params.arguments) ? params.arguments : {};
    this.#beginControl(params, args);
    try {
      switch (params.tool) {
        case "open": {
          const url = requiredString(args, "url", INPUT_LIMITS.browserUrl);
          const tab = await this.open(url, params.threadId, params.ownerBotId ?? null);
          this.#updateControlTab(params, tab.id);
          return textResult({ tab });
        }
        case "list_tabs": {
          const tabs = this.listTabs().filter((tab) => this.#canUseToolTab(params, tab));
          const activeTabId = tabs.some((tab) => tab.id === this.#activeTabId)
            ? this.#activeTabId
            : (tabs.at(-1)?.id ?? null);
          return textResult({ tabs, activeTabId });
        }
        case "snapshot": {
          const tabId = requiredString(args, "tabId", INPUT_LIMITS.identifier);
          this.#requireToolTab(params, tabId);
          const snapshot = await this.snapshot(tabId);
          return textResult(snapshot);
        }
        case "act": {
          const tabId = requiredString(args, "tabId", INPUT_LIMITS.identifier);
          this.#requireToolTab(params, tabId);
          const revision = requiredNumber(args, "revision");
          const action = parseAction(args.action);
          return textResult(await this.act(tabId, revision, action));
        }
        case "screenshot": {
          const tabId = requiredString(args, "tabId", INPUT_LIMITS.identifier);
          this.#requireToolTab(params, tabId);
          const imageUrl = await this.screenshot(tabId);
          return { success: true, contentItems: [{ type: "inputImage", imageUrl }] };
        }
        case "close_tab": {
          const tabId = requiredString(args, "tabId", INPUT_LIMITS.identifier);
          this.#requireToolTab(params, tabId);
          await this.close(tabId);
          return textResult({ closed: true });
        }
        default:
          throw new Error(`Unknown browser tool: ${params.tool}`);
      }
    } catch (error) {
      return {
        success: false,
        contentItems: [{ type: "inputText", text: String(error) }],
      };
    } finally {
      this.#finishControl(params);
    }
  }

  async destroy(options: { storageAlreadyFlushed?: boolean } = {}): Promise<void> {
    if (!options.storageAlreadyFlushed) await this.flushPersistentStorage();
    for (const tab of this.#tabs.values()) {
      this.#unmountView(tab.view);
      tab.view.webContents.close();
    }
    this.#tabs.clear();
    this.#listeners.clear();
    this.clearControls();
    this.#controlListeners.clear();
  }

  async flushPersistentStorage(): Promise<void> {
    this.#session.flushStorageData();
    await this.#session.cookies.flushStore();
    await this.#persistState();
  }

  #createTab(id: string, requestedUrl: string, ownerThreadId: string | null, ownerBotId: string | null): InternalTab {
    const view = this.#createView();
    view.webContents.setUserAgent(embeddedBrowserUserAgentForUrl(this.#session.getUserAgent(), requestedUrl));
    this.#mountView(view);
    return {
      id,
      view,
      requestedUrl,
      ownerThreadId,
      ownerBotId,
      revision: 0,
      queue: Promise.resolve(),
      focusOnVisible: false,
    };
  }

  #createView(): WebContentsView {
    const view = new WebContentsView({
      webPreferences: {
        session: this.#session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    });
    view.setBackgroundColor("#0b0b0b");
    return view;
  }

  #configureSession(): void {
    const userAgent = embeddedBrowserUserAgent(this.#session.getUserAgent());
    this.#session.setUserAgent(userAgent, preferredBrowserLanguageCodes());
    this.#session.webRequest.onBeforeSendHeaders((details, callback) => {
      callback({
        requestHeaders: browserRequestHeaders(details.requestHeaders),
      });
    });
    this.#session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    this.#session.setPermissionCheckHandler(() => false);
    this.#session.on("will-download", (_event, item) => {
      const safeName = basename(item.getFilename()).replace(/[^a-zA-Z0-9._ -]/g, "_");
      const downloadPath = uniqueDownloadPath(
        this.#downloadsRoot,
        safeName || `download-${Date.now()}`,
        this.#reservedDownloadPaths,
      );
      this.#reservedDownloadPaths.add(downloadPath);
      item.setSavePath(downloadPath);
      item.once("done", () => this.#reservedDownloadPaths.delete(downloadPath));
    });
  }

  #bindTabEvents(tab: InternalTab): void {
    const contents = tab.view.webContents;
    const changed = () => this.#emitChanged();
    contents.on("before-input-event", (event, input) => {
      if (isToggleDevToolsShortcut(input)) {
        event.preventDefault();
        this.#window.webContents.toggleDevTools();
        return;
      }
      if (isGlobalSearchShortcut(input)) {
        event.preventDefault();
        this.#window.webContents.focus();
        const modifiers: Array<"meta" | "control"> = [input.meta ? "meta" : "control"];
        this.#window.webContents.sendInputEvent({ type: "keyDown", keyCode: "K", modifiers });
        this.#window.webContents.sendInputEvent({ type: "keyUp", keyCode: "K", modifiers });
        return;
      }
      if (!isCloseBrowserTabShortcut(input)) return;
      event.preventDefault();
      setImmediate(() => void this.close(tab.id).catch(() => undefined));
    });
    contents.on("did-start-loading", changed);
    contents.on("did-stop-loading", () => {
      changed();
      void this.#syncViewBackground(tab);
    });
    contents.on("page-title-updated", changed);
    contents.on("did-navigate", (_event, url) => {
      if (isPersistableBrowserUrl(url)) tab.requestedUrl = persistentBrowserUrl(url);
      tab.revision += 1;
      changed();
      this.#schedulePersist();
    });
    contents.on("did-navigate-in-page", (_event, url) => {
      if (isPersistableBrowserUrl(url)) tab.requestedUrl = persistentBrowserUrl(url);
      tab.revision += 1;
      changed();
      this.#schedulePersist();
    });
    contents.on("will-navigate", (event, url) => {
      if (!isAllowedMainUrl(url)) {
        event.preventDefault();
        return;
      }
      contents.setUserAgent(embeddedBrowserUserAgentForUrl(this.#session.getUserAgent(), url));
    });
    contents.on("will-redirect", (event) => {
      if (!event.isMainFrame) return;
      if (!isAllowedMainUrl(event.url)) {
        event.preventDefault();
        return;
      }
      contents.setUserAgent(embeddedBrowserUserAgentForUrl(this.#session.getUserAgent(), event.url));
    });
    contents.setWindowOpenHandler(({ url }) => {
      if (isAllowedMainUrl(url)) void this.open(url, tab.ownerThreadId, tab.ownerBotId);
      return { action: "deny" };
    });
  }

  async #syncViewBackground(tab: InternalTab): Promise<void> {
    try {
      const background = await tab.view.webContents.executeJavaScript(
        `(() => {
          const transparent = "rgba(0, 0, 0, 0)";
          const body = document.body ? getComputedStyle(document.body).backgroundColor : transparent;
          if (body !== transparent) return body;
          const root = getComputedStyle(document.documentElement).backgroundColor;
          return root !== transparent ? root : "#0b0b0b";
        })()`,
        true,
      );
      if (isString(background)) tab.view.setBackgroundColor(background);
    } catch {
      // Navigation can replace the document before its background is read.
    }
  }

  async #readSnapshot(tab: InternalTab, revision: number): Promise<BrowserSnapshot> {
    const raw = await withTimeout(
      tab.view.webContents.executeJavaScript(snapshotScript(revision), true),
      10_000,
      "Browser snapshot timed out.",
    );
    if (!isRecord(raw)) throw new Error("Browser returned an invalid snapshot.");
    tab.revision = revision;
    return {
      tabId: tab.id,
      revision,
      title: isString(raw.title) ? raw.title.slice(0, 500) : "",
      url: isString(raw.url) ? raw.url : tab.view.webContents.getURL(),
      text: isString(raw.text) ? raw.text.slice(0, 100_000) : "",
      elements: Array.isArray(raw.elements) ? raw.elements.filter(isSnapshotElement).slice(0, 500) : [],
    };
  }

  #syncAttachedView(): void {
    const tab = this.#activeTabId ? this.#tabs.get(this.#activeTabId) : null;
    const targetWindow = this.#target === "picture-in-picture" ? this.#pictureInPictureWindow : this.#window;
    if (!this.#visible || !this.#bounds || !tab || !targetWindow || targetWindow.isDestroyed()) {
      this.#attachedView?.setVisible(false);
      return;
    }

    if (this.#attachedView !== tab.view) {
      this.#attachedView?.setVisible(false);
      this.#mountView(tab.view, targetWindow);
      this.#attachedView = tab.view;
    } else {
      this.#mountView(tab.view, targetWindow);
    }
    tab.view.setBounds(this.#bounds);
    tab.view.setVisible(true);
    tab.view.webContents.invalidate();
    this.#raisePictureInPictureOverlay();
    if (tab.focusOnVisible) {
      tab.focusOnVisible = false;
      tab.view.webContents.focus();
    }
  }

  #raisePictureInPictureOverlay(): void {
    const overlay = this.#pictureInPictureOverlayView;
    const window = this.#pictureInPictureWindow;
    if (this.#target !== "picture-in-picture" || !overlay || !window || window.isDestroyed()) return;
    window.contentView.removeChildView(overlay);
    window.contentView.addChildView(overlay);
  }

  #focusTab(tab: InternalTab): void {
    if (
      this.#tabs.get(tab.id) !== tab ||
      this.#activeTabId !== tab.id ||
      !tab.view.getVisible() ||
      tab.view.webContents.isDestroyed()
    ) {
      return;
    }
    tab.view.webContents.focus();
  }

  #mountView(view: WebContentsView, window = this.#window): void {
    const currentWindow = this.#mountedViews.get(view);
    if (currentWindow === window) {
      window.contentView.addChildView(view);
      return;
    }
    view.setVisible(false);
    if (currentWindow && !currentWindow.isDestroyed()) currentWindow.contentView.removeChildView(view);
    view.setBounds({ x: 0, y: 0, width: 1200, height: 800 });
    window.contentView.addChildView(view);
    this.#mountedViews.set(view, window);
  }

  #unmountView(view: WebContentsView): void {
    view.setVisible(false);
    const window = this.#mountedViews.get(view);
    if (window && !window.isDestroyed()) window.contentView.removeChildView(view);
    this.#mountedViews.delete(view);
    if (this.#attachedView === view) this.#attachedView = null;
  }

  #requireTab(tabId: string): InternalTab {
    const tab = this.#tabs.get(tabId);
    if (!tab) throw new Error(`Unknown browser tab: ${tabId}`);
    return tab;
  }

  #requireToolTab(params: DynamicToolCallParams, tabId: string): void {
    const tab = this.listTabs().find((candidate) => candidate.id === tabId);
    if (!tab || !this.#canUseToolTab(params, tab)) throw new Error(`Unknown browser tab: ${tabId}`);
  }

  #canUseToolTab(params: DynamicToolCallParams, tab: BrowserTab): boolean {
    return (
      tab.ownerThreadId === params.threadId &&
      (tab.ownerBotId === null || tab.ownerBotId === (params.ownerBotId ?? null))
    );
  }

  #enqueue<T>(tabId: string, operation: (tab: InternalTab) => Promise<T>): Promise<T> {
    const tab = this.#requireTab(tabId);
    const result = tab.queue.then(() => operation(tab));
    tab.queue = result.catch(() => undefined);
    return result;
  }

  #emitChanged(): void {
    const tabs = this.listTabs();
    for (const listener of this.#listeners) listener(tabs, this.#activeTabId);
  }

  #beginControl(params: DynamicToolCallParams, args: DynamicRecord): void {
    const id = controlSessionId(params.threadId, params.turnId);
    const timer = this.#controlTimers.get(id);
    if (timer) clearTimeout(timer);
    this.#controlTimers.delete(id);
    const previous = this.#controlSessions.get(id);
    this.#controlSessions.set(id, {
      id,
      threadId: params.threadId,
      turnId: params.turnId,
      callId: params.callId,
      tabId: isString(args.tabId) ? args.tabId : null,
      action: browserControlAction(params.tool, args),
      phase: "acting",
      startedAt: previous?.startedAt ?? new Date().toISOString(),
    });
    this.#emitControlChanged();
  }

  #finishControl(params: DynamicToolCallParams): void {
    const id = controlSessionId(params.threadId, params.turnId);
    const current = this.#controlSessions.get(id);
    if (!current || current.callId !== params.callId) return;
    this.#controlSessions.set(id, { ...current, phase: "waiting" });
    this.#emitControlChanged();
    const timer = setTimeout(() => {
      this.#controlTimers.delete(id);
      const latest = this.#controlSessions.get(id);
      if (!latest || latest.callId !== params.callId || latest.phase !== "waiting") return;
      this.#controlSessions.delete(id);
      this.#emitControlChanged();
    }, BrowserHost.CONTROL_IDLE_GRACE_MS);
    timer.unref();
    this.#controlTimers.set(id, timer);
  }

  #updateControlTab(params: DynamicToolCallParams, tabId: string): void {
    const id = controlSessionId(params.threadId, params.turnId);
    const current = this.#controlSessions.get(id);
    if (!current || current.callId !== params.callId) return;
    this.#controlSessions.set(id, { ...current, tabId });
    this.#emitControlChanged();
  }

  #emitControlChanged(): void {
    const state = this.getControlState();
    for (const listener of this.#controlListeners) listener(state);
  }

  #schedulePersist(): void {
    void this.#persistState().catch((error) => {
      console.error("Unable to persist browser tabs:", error);
    });
  }

  #persistState(): Promise<void> {
    const state: StoredBrowserState = {
      version: 1,
      activeTabId: this.#activeTabId,
      tabs: [...this.#tabs.values()].map((tab) => ({
        id: tab.id,
        url: persistentBrowserUrl(currentTabUrl(tab)),
        ownerThreadId: tab.ownerThreadId,
        ownerBotId: tab.ownerBotId,
      })),
    };
    this.#persistQueue = this.#persistQueue
      .catch(() => undefined)
      .then(async () => {
        const temporaryPath = `${this.#statePath}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, {
            encoding: "utf8",
            mode: 0o600,
          });
          await rename(temporaryPath, this.#statePath);
        } finally {
          await rm(temporaryPath, { force: true }).catch(() => undefined);
        }
      });
    return this.#persistQueue;
  }
}

function controlSessionId(threadId: string, turnId: string): string {
  return `${threadId}:${turnId}`;
}

function browserControlAction(tool: string, args: DynamicRecord): BrowserControlAction {
  switch (tool) {
    case "open":
      return "open";
    case "list_tabs":
      return "list-tabs";
    case "snapshot":
      return "snapshot";
    case "screenshot":
      return "screenshot";
    case "close_tab":
      return "close-tab";
    case "act": {
      const action = isRecord(args.action) ? args.action.type : null;
      if (
        action === "click" ||
        action === "type" ||
        action === "key" ||
        action === "scroll" ||
        action === "back" ||
        action === "forward" ||
        action === "reload"
      ) {
        return action;
      }
      return "snapshot";
    }
    default:
      return "snapshot";
  }
}

function functionTool(name: string, description: string, inputSchema: DynamicRecord) {
  return { type: "function" as const, name, description, inputSchema };
}

function emptySchema() {
  return { type: "object", properties: {}, additionalProperties: false };
}

function normalizeBrowserUrl(input: string): string {
  const value = input.trim();
  if (!value) throw new Error("A browser URL is required.");
  if (value.length > INPUT_LIMITS.browserUrl) throw new Error("The browser URL is too long.");
  const withProtocol = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  const url = new URL(withProtocol);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP(S) browser URLs are allowed.");
  }
  return url.toString();
}

function browserLoadOptions(): { extraHeaders: string } {
  return { extraHeaders: "Cache-Control: no-cache\nPragma: no-cache" };
}

function browserRequestHeaders(requestHeaders: Record<string, string>): Record<string, string> {
  const headers = { ...requestHeaders };
  setRequestHeader(headers, "Accept-Language", preferredBrowserLanguages());
  return headers;
}

function preferredBrowserLanguages(): string {
  return preferredBrowserLanguageCodes()
    .split(",")
    .map((language, index) => (index === 0 ? language : `${language};q=${Math.max(1 - index * 0.1, 0.1).toFixed(1)}`))
    .join(",");
}

function preferredBrowserLanguageCodes(): string {
  const languages = app.getPreferredSystemLanguages();
  return (languages.length > 0 ? languages : [app.getLocale()]).join(",");
}

function setRequestHeader(headers: Record<string, string>, name: string, value: string): void {
  const existingName = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  if (existingName && existingName !== name) delete headers[existingName];
  headers[name] = value;
}

async function readBrowserState(path: string): Promise<StoredBrowserState> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(parsed) || parsed.version !== 1) {
      return { version: 1, activeTabId: null, tabs: [] };
    }
    const tabs = Array.isArray(parsed.tabs)
      ? parsed.tabs.filter(isStoredBrowserTab).map((tab) => ({ ...tab, url: persistentBrowserUrl(tab.url) }))
      : [];
    return {
      version: 1,
      activeTabId: isString(parsed.activeTabId) ? parsed.activeTabId : null,
      tabs: tabs.filter((tab, index) => tabs.findIndex((candidate) => candidate.id === tab.id) === index),
    };
  } catch (error) {
    if (isMissingFile(error) || error instanceof SyntaxError) {
      return { version: 1, activeTabId: null, tabs: [] };
    }
    throw error;
  }
}

function isStoredBrowserTab(value: unknown): value is StoredBrowserState["tabs"][number] {
  if (
    !isRecord(value) ||
    !isString(value.id) ||
    !value.id ||
    value.id.length > INPUT_LIMITS.identifier ||
    !isString(value.url) ||
    value.url.length > INPUT_LIMITS.browserUrl
  ) {
    return false;
  }
  if (
    value.ownerThreadId !== null &&
    (!isString(value.ownerThreadId) || value.ownerThreadId.length > INPUT_LIMITS.identifier)
  ) {
    return false;
  }
  if (value.ownerBotId !== null && (!isString(value.ownerBotId) || value.ownerBotId.length > INPUT_LIMITS.identifier)) {
    return false;
  }
  return isPersistableBrowserUrl(value.url);
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isAllowedMainUrl(value: string): boolean {
  return value === "about:blank" || isPersistableBrowserUrl(value);
}

function isPersistableBrowserUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function validateBounds(bounds: BrowserBounds): BrowserBounds {
  if (!Object.values(bounds).every(Number.isFinite)) throw new Error("Invalid browser bounds.");
  return {
    x: Math.max(0, Math.min(INPUT_LIMITS.browserCoordinate, Math.floor(bounds.x))),
    y: Math.max(0, Math.min(INPUT_LIMITS.browserCoordinate, Math.floor(bounds.y))),
    width: Math.max(1, Math.min(INPUT_LIMITS.browserDimension, Math.ceil(bounds.width))),
    height: Math.max(1, Math.min(INPUT_LIMITS.browserDimension, Math.ceil(bounds.height))),
  };
}

function toPublicTab(tab: InternalTab): BrowserTab {
  return {
    id: tab.id,
    title: tab.view.webContents.getTitle() || "New tab",
    url: currentTabUrl(tab),
    loading: tab.view.webContents.isLoading(),
    ownerThreadId: tab.ownerThreadId,
    ownerBotId: tab.ownerBotId,
  };
}

function currentTabUrl(tab: InternalTab): string {
  const currentUrl = tab.view.webContents.getURL();
  return isPersistableBrowserUrl(currentUrl) ? currentUrl : tab.requestedUrl;
}

function snapshotScript(revision: number): string {
  return `(() => {
    const revision = ${revision};
    const isHitTestVisible = (node, rect) => {
      const left = Math.max(0, rect.left);
      const right = Math.min(innerWidth, rect.right);
      const top = Math.max(0, rect.top);
      const bottom = Math.min(innerHeight, rect.bottom);
      if (left >= right || top >= bottom) return true;
      const insetX = Math.min(4, (right - left) / 4);
      const insetY = Math.min(4, (bottom - top) / 4);
      const points = [
        [(left + right) / 2, (top + bottom) / 2],
        [left + insetX, top + insetY],
        [right - insetX, top + insetY],
        [left + insetX, bottom - insetY],
        [right - insetX, bottom - insetY],
      ];
      return points.some(([x, y]) => {
        const hit = document.elementFromPoint(x, y);
        return hit === node || (hit instanceof Node && node.contains(hit));
      });
    };
    const nodes = [...document.querySelectorAll('a,button,input,textarea,select,[role],[contenteditable="true"],[tabindex]')]
      .filter((node) => {
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0 && isHitTestVisible(node, rect);
      })
      .slice(0, 500);
    document.querySelectorAll('[data-openbot-ref]').forEach((node) => node.removeAttribute('data-openbot-ref'));
    const elements = nodes.map((node, index) => {
      const ref = revision + ':' + index;
      node.setAttribute('data-openbot-ref', ref);
      const name = (node.getAttribute('aria-label') || node.getAttribute('title') || node.getAttribute('placeholder') || node.innerText || node.value || '').trim().slice(0, 500);
      return {
        ref,
        tag: node.tagName.toLowerCase(),
        role: node.getAttribute('role'),
        name,
        disabled: Boolean(node.disabled || node.getAttribute('aria-disabled') === 'true'),
      };
    });
    return {
      title: document.title,
      url: location.href,
      text: (document.body?.innerText || '').slice(0, 100000),
      elements,
    };
  })()`;
}

async function performAction(contents: WebContents, action: BrowserAction, sessionUserAgent: string): Promise<void> {
  switch (action.type) {
    case "click": {
      await withDevToolsDebugger(contents, async () => {
        const point = await contents.executeJavaScript(
          `(() => {
            const node = document.querySelector('[data-openbot-ref=${JSON.stringify(action.ref)}]');
            if (!(node instanceof HTMLElement)) throw new Error('Element reference is no longer available.');
            node.scrollIntoView({ block: 'center', inline: 'center' });
            node.focus();
            const rect = node.getBoundingClientRect();
            const left = Math.max(0, rect.left);
            const right = Math.min(innerWidth, rect.right);
            const top = Math.max(0, rect.top);
            const bottom = Math.min(innerHeight, rect.bottom);
            if (left >= right || top >= bottom) throw new Error('Element is outside the visible page.');
            const insetX = Math.min(4, (right - left) / 4);
            const insetY = Math.min(4, (bottom - top) / 4);
            const points = [
              [(left + right) / 2, (top + bottom) / 2],
              [left + insetX, top + insetY],
              [right - insetX, top + insetY],
              [left + insetX, bottom - insetY],
              [right - insetX, bottom - insetY],
            ];
            const point = points.find(([x, y]) => {
              const hit = document.elementFromPoint(x, y);
              return hit === node || (hit instanceof Node && node.contains(hit));
            });
            if (!point) throw new Error('Element is covered by another page layer. Take a fresh snapshot.');
            return {
              x: Math.round(point[0]),
              y: Math.round(point[1]),
              direct: node instanceof HTMLAnchorElement && node.hasAttribute('download'),
            };
          })()`,
          true,
        );
        if (!isInputPoint(point)) throw new Error("Element does not have a clickable position.");
        if (point.direct === true) {
          await contents.executeJavaScript(
            `document.querySelector('[data-openbot-ref=${JSON.stringify(action.ref)}]')?.click()`,
            true,
          );
          return;
        }
        await contents.debugger.sendCommand("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: point.x,
          y: point.y,
        });
        await contents.debugger.sendCommand("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x: point.x,
          y: point.y,
          button: "left",
          clickCount: 1,
        });
        await contents.debugger.sendCommand("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: point.x,
          y: point.y,
          button: "left",
          clickCount: 1,
        });
      });
      return;
    }
    case "type": {
      await withDevToolsDebugger(contents, async () => {
        await contents.executeJavaScript(
          `(() => {
            const node = document.querySelector('[data-openbot-ref=${JSON.stringify(action.ref)}]');
            if (!(node instanceof HTMLElement)) throw new Error('Element reference is no longer available.');
            node.focus();
            if ('value' in node) {
              if (typeof node.select === 'function') node.select();
            } else if (node.isContentEditable) {
              const selection = getSelection();
              const range = document.createRange();
              range.selectNodeContents(node);
              selection?.removeAllRanges();
              selection?.addRange(range);
            } else {
              throw new Error('Element does not accept text.');
            }
          })()`,
          true,
        );
        await contents.debugger.sendCommand("Input.insertText", {
          text: action.text,
        });
      });
      if (action.submit) pressKey(contents, "Enter");
      return;
    }
    case "key":
      pressKey(contents, action.key);
      return;
    case "scroll":
      await contents.executeJavaScript(
        `window.scrollBy({ top: ${Math.max(-10_000, Math.min(10_000, action.deltaY))}, behavior: 'instant' })`,
        true,
      );
      return;
    case "back":
      navigateHistory(contents, "back", sessionUserAgent);
      return;
    case "forward":
      navigateHistory(contents, "forward", sessionUserAgent);
      return;
    case "reload":
      contents.reload();
  }
}

function navigateHistory(contents: WebContents, direction: BrowserNavigationDirection, sessionUserAgent: string): void {
  const history = contents.navigationHistory;
  const offset = direction === "back" ? -1 : 1;
  if (!history.canGoToOffset(offset)) return;
  const entry = history.getEntryAtIndex(history.getActiveIndex() + offset);
  if (!entry?.url) return;
  contents.setUserAgent(embeddedBrowserUserAgentForUrl(sessionUserAgent, entry.url));
  history.goToOffset(offset);
}

function isInputPoint(value: unknown): value is { x: number; y: number; direct?: boolean } {
  return (
    isRecord(value) && isNumber(value.x) && Number.isFinite(value.x) && isNumber(value.y) && Number.isFinite(value.y)
  );
}

async function withDevToolsDebugger<T>(contents: WebContents, operation: () => Promise<T>): Promise<T> {
  const attachedHere = !contents.debugger.isAttached();
  if (attachedHere) {
    contents.debugger.attach("1.3");
    // Native input must also work while OpenBot is not the foreground application.
    await contents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
  }
  try {
    return await operation();
  } finally {
    if (attachedHere && contents.debugger.isAttached()) contents.debugger.detach();
  }
}

function pressKey(contents: WebContents, key: string): void {
  if (!/^[a-zA-Z0-9+_-]{1,32}$/.test(key)) throw new Error("Invalid browser key.");
  contents.sendInputEvent({ type: "keyDown", keyCode: key });
  contents.sendInputEvent({ type: "keyUp", keyCode: key });
}

function parseAction(value: unknown): BrowserAction {
  if (!isRecord(value) || !isString(value.type)) throw new Error("Invalid browser action.");
  switch (value.type) {
    case "click":
      return { type: "click", ref: requiredString(value, "ref", INPUT_LIMITS.identifier) };
    case "type":
      return {
        type: "type",
        ref: requiredString(value, "ref", INPUT_LIMITS.identifier),
        text: requiredString(value, "text", INPUT_LIMITS.browserActionText),
        submit: value.submit === true,
      };
    case "key":
      return { type: "key", key: requiredString(value, "key", 32) };
    case "scroll":
      return { type: "scroll", deltaY: requiredNumber(value, "deltaY") };
    case "back":
    case "forward":
    case "reload":
      return { type: value.type };
    default:
      throw new Error(`Unknown browser action: ${value.type}`);
  }
}

function requiredString(value: DynamicRecord, key: string, maxLength: number): string {
  if (!isString(value[key]) || !value[key].trim()) throw new Error(`${key} is required.`);
  if (value[key].length > maxLength) throw new Error(`${key} is too long.`);
  return value[key];
}

function requiredNumber(value: DynamicRecord, key: string): number {
  if (!isNumber(value[key]) || !Number.isFinite(value[key])) {
    throw new Error(`${key} must be a number.`);
  }
  return value[key];
}

function isSnapshotElement(value: unknown): value is BrowserSnapshot["elements"][number] {
  return (
    isRecord(value) &&
    isString(value.ref) &&
    isString(value.tag) &&
    (isString(value.role) || value.role === null) &&
    isString(value.name) &&
    isBoolean(value.disabled)
  );
}

function textResult(value: unknown): DynamicToolResult {
  return {
    success: true,
    contentItems: [{ type: "inputText", text: JSON.stringify(value) }],
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function uniqueDownloadPath(root: string, name: string, reserved: Set<string>): string {
  const extension = extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  for (let suffix = 1; ; suffix += 1) {
    const candidate = join(root, suffix === 1 ? name : `${stem} (${suffix})${extension}`);
    if (!reserved.has(candidate) && !existsSync(candidate)) return candidate;
  }
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
