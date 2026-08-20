import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type {
  BrowserBounds,
  BrowserControlAction,
  BrowserControlSession,
  BrowserControlState,
  BrowserTab,
  BrowserVisibilityInput,
} from "@openbot/contracts/ipc";
import { type DynamicRecord, isBoolean, isNumber, isString } from "@openbot/contracts/runtime-values";
import { app, type BrowserWindow, type Session, session, type WebContents, WebContentsView } from "electron";
import { isCloseBrowserTabShortcut, isGlobalSearchShortcut, isToggleDevToolsShortcut } from "./browser-shortcuts";
import { persistentBrowserUrl, xLoginUrlForLanding } from "./browser-state";
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
  xLoginRedirected: boolean;
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
  readonly #mountedViews = new Set<WebContentsView>();
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

  async open(url: string, ownerThreadId: string | null = null, ownerBotId: string | null = null): Promise<BrowserTab> {
    if (this.#tabs.size >= INPUT_LIMITS.browserTabs) {
      throw new Error(`The browser can have up to ${INPUT_LIMITS.browserTabs} open tabs.`);
    }
    const normalizedUrl = normalizeBrowserUrl(url);
    const tab = this.#createTab(randomUUID(), normalizedUrl, ownerThreadId, ownerBotId);

    this.#tabs.set(tab.id, tab);
    this.#bindTabEvents(tab);
    this.#activeTabId = tab.id;
    this.#syncAttachedView();
    this.#emitChanged();
    await this.#persistState();

    try {
      await tab.view.webContents.loadURL(normalizedUrl, browserLoadOptions());
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
      if (!wasVisible) {
        tab.view.setVisible(true);
        tab.view.webContents.invalidate();
      }
      tab.view.webContents.focus();
      try {
        if (!wasVisible) await delay(250);
        await withTimeout(performAction(tab.view.webContents, action), 10_000, "Browser action timed out.");
        await delay(50);
      } finally {
        if (!wasVisible) tab.view.setVisible(false);
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

  async handleDynamicTool(params: DynamicToolCallParams): Promise<DynamicToolResult> {
    const args = isRecord(params.arguments) ? params.arguments : {};
    this.#beginControl(params, args);
    try {
      switch (params.tool) {
        case "open": {
          const url = requiredString(args, "url", INPUT_LIMITS.browserUrl);
          const tab = await this.open(url, params.threadId);
          this.#updateControlTab(params, tab.id);
          return textResult({ tab });
        }
        case "list_tabs":
          return textResult({ tabs: this.listTabs(), activeTabId: this.#activeTabId });
        case "snapshot": {
          const snapshot = await this.snapshot(requiredString(args, "tabId", INPUT_LIMITS.identifier));
          return textResult(snapshot);
        }
        case "act": {
          const tabId = requiredString(args, "tabId", INPUT_LIMITS.identifier);
          const revision = requiredNumber(args, "revision");
          const action = parseAction(args.action);
          return textResult(await this.act(tabId, revision, action));
        }
        case "screenshot": {
          const imageUrl = await this.screenshot(requiredString(args, "tabId", INPUT_LIMITS.identifier));
          return { success: true, contentItems: [{ type: "inputImage", imageUrl }] };
        }
        case "close_tab": {
          await this.close(requiredString(args, "tabId", INPUT_LIMITS.identifier));
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

  async destroy(): Promise<void> {
    try {
      await this.#persistState();
    } finally {
      for (const tab of this.#tabs.values()) {
        this.#unmountView(tab.view);
        tab.view.webContents.close();
      }
      this.#tabs.clear();
      this.#listeners.clear();
      this.clearControls();
      this.#controlListeners.clear();
    }
  }

  #createTab(id: string, requestedUrl: string, ownerThreadId: string | null, ownerBotId: string | null): InternalTab {
    const view = this.#createView();
    this.#mountView(view);
    return {
      id,
      view,
      requestedUrl,
      ownerThreadId,
      ownerBotId,
      revision: 0,
      queue: Promise.resolve(),
      xLoginRedirected: false,
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
    const userAgent = browserUserAgent(this.#session.getUserAgent());
    this.#session.setUserAgent(userAgent, preferredBrowserLanguageCodes());
    this.#session.webRequest.onBeforeSendHeaders((details, callback) => {
      callback({
        requestHeaders: browserRequestHeaders(details.requestHeaders, userAgent),
      });
    });
    this.#session.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false);
    });
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
      void this.#redirectXLandingToLogin(tab);
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
      if (!isAllowedMainUrl(url)) event.preventDefault();
    });
    contents.setWindowOpenHandler(({ url }) => {
      if (isAllowedMainUrl(url)) void this.open(url, tab.ownerThreadId, tab.ownerBotId);
      return { action: "deny" };
    });
  }

  async #redirectXLandingToLogin(tab: InternalTab): Promise<void> {
    if (tab.xLoginRedirected) return;
    const currentUrl = tab.view.webContents.getURL();
    const loginUrl = xLoginUrlForLanding(currentUrl);
    if (!loginUrl) return;
    await delay(1_000);
    if (tab.xLoginRedirected || tab.view.webContents.getURL() !== currentUrl) return;
    tab.xLoginRedirected = true;
    tab.requestedUrl = loginUrl;
    await tab.view.webContents.loadURL(loginUrl, browserLoadOptions()).catch(() => undefined);
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
    if (!this.#visible || !this.#bounds || !tab) {
      this.#attachedView?.setVisible(false);
      return;
    }

    if (this.#attachedView !== tab.view) {
      this.#attachedView?.setVisible(false);
      this.#mountView(tab.view);
      this.#attachedView = tab.view;
    }
    tab.view.setBounds(this.#bounds);
    tab.view.setVisible(true);
    tab.view.webContents.invalidate();
  }

  #mountView(view: WebContentsView): void {
    if (this.#mountedViews.has(view)) return;
    view.setVisible(false);
    view.setBounds({ x: 0, y: 0, width: 1200, height: 800 });
    this.#window.contentView.addChildView(view);
    this.#mountedViews.add(view);
  }

  #unmountView(view: WebContentsView): void {
    view.setVisible(false);
    if (this.#mountedViews.delete(view)) this.#window.contentView.removeChildView(view);
    if (this.#attachedView === view) this.#attachedView = null;
  }

  #requireTab(tabId: string): InternalTab {
    const tab = this.#tabs.get(tabId);
    if (!tab) throw new Error(`Unknown browser tab: ${tabId}`);
    return tab;
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
      .then(() =>
        writeFile(this.#statePath, `${JSON.stringify(state)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        }),
      );
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

function browserRequestHeaders(
  requestHeaders: Record<string, string>,
  sessionUserAgent: string,
): Record<string, string> {
  const userAgent = browserUserAgent(sessionUserAgent);
  const headers = { ...requestHeaders };
  setRequestHeader(headers, "User-Agent", userAgent);
  setRequestHeader(headers, "Accept-Language", preferredBrowserLanguages());
  return headers;
}

function browserUserAgent(sessionUserAgent: string): string {
  return removeUserAgentProducts(sessionUserAgent, ["Electron", app.getName()]);
}

function removeUserAgentProducts(userAgent: string, products: string[]): string {
  return products
    .filter(Boolean)
    .reduce(
      (current, product) => current.replace(new RegExp(`\\s${escapeRegExp(product)}/[^\\s]+`, "g"), ""),
      userAgent,
    );
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
    const nodes = [...document.querySelectorAll('a,button,input,textarea,select,[role],[contenteditable="true"],[tabindex]')]
      .filter((node) => {
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
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

async function performAction(contents: WebContents, action: BrowserAction): Promise<void> {
  switch (action.type) {
    case "click": {
      const point = await contents.executeJavaScript(
        `(() => {
          const node = document.querySelector('[data-openbot-ref=${JSON.stringify(action.ref)}]');
          if (!(node instanceof HTMLElement)) throw new Error('Element reference is no longer available.');
          node.scrollIntoView({ block: 'center', inline: 'center' });
          node.focus();
          const rect = node.getBoundingClientRect();
          return {
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
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
      await withDevToolsDebugger(contents, async () => {
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
      await withDevToolsDebugger(contents, () =>
        contents.debugger.sendCommand("Input.insertText", {
          text: action.text,
        }),
      );
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
      if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
      return;
    case "forward":
      if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
      return;
    case "reload":
      contents.reload();
  }
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
