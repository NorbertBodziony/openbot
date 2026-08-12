import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import {
  type BrowserWindow,
  type Session,
  session,
  type WebContents,
  WebContentsView,
} from "electron";
import type {
  BrowserBounds,
  BrowserControlAction,
  BrowserControlSession,
  BrowserControlState,
  BrowserTab,
  BrowserVisibilityInput,
} from "../shared/ipc";
import type { DynamicToolCallParams, DynamicToolResult } from "./protocol";
import { isRecord } from "./protocol";

interface BrowserHostEvents {
  changed: [tabs: BrowserTab[], activeTabId: string | null];
  controlChanged: [state: BrowserControlState];
}

interface InternalTab {
  id: string;
  view: WebContentsView;
  ownerThreadId: string | null;
  revision: number;
  queue: Promise<unknown>;
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

export const INFELD_BROWSER_NAMESPACE = "infeld_browser";

export const BROWSER_DYNAMIC_TOOLS = [
  {
    type: "namespace",
    name: INFELD_BROWSER_NAMESPACE,
    description: "Operate Infeld's private, persistent local browser.",
    tools: [
      functionTool("open", "Open an HTTP(S) URL in a new tab.", {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
        additionalProperties: false,
      }),
      functionTool("list_tabs", "List the browser tabs.", emptySchema()),
      functionTool("snapshot", "Read a page and obtain current element references.", {
        type: "object",
        properties: { tabId: { type: "string" } },
        required: ["tabId"],
        additionalProperties: false,
      }),
      functionTool("act", "Click, type, press a key, scroll, navigate back/forward, or reload.", {
        type: "object",
        properties: {
          tabId: { type: "string" },
          revision: { type: "integer" },
          action: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: ["click", "type", "key", "scroll", "back", "forward", "reload"],
              },
              ref: { type: "string" },
              text: { type: "string" },
              submit: { type: "boolean" },
              key: { type: "string" },
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
        properties: { tabId: { type: "string" } },
        required: ["tabId"],
        additionalProperties: false,
      }),
      functionTool("close_tab", "Close a browser tab.", {
        type: "object",
        properties: { tabId: { type: "string" } },
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
  readonly #tabs = new Map<string, InternalTab>();
  readonly #listeners = new Set<(...args: BrowserHostEvents["changed"]) => void>();
  readonly #controlListeners = new Set<(...args: BrowserHostEvents["controlChanged"]) => void>();
  readonly #controlSessions = new Map<string, BrowserControlSession>();
  readonly #controlTimers = new Map<string, NodeJS.Timeout>();
  #activeTabId: string | null = null;
  #visible = false;
  #bounds: BrowserBounds | null = null;
  #attachedView: WebContentsView | null = null;

  constructor(window: BrowserWindow, downloadsRoot: string) {
    this.#window = window;
    this.#downloadsRoot = downloadsRoot;
    this.#session = session.fromPartition("persist:infeld-browser", { cache: true });
    this.#configureSession();
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

  async open(url: string, ownerThreadId: string | null = null): Promise<BrowserTab> {
    const normalizedUrl = normalizeBrowserUrl(url);
    const tab: InternalTab = {
      id: randomUUID(),
      view: this.#createView(),
      ownerThreadId,
      revision: 0,
      queue: Promise.resolve(),
    };

    this.#tabs.set(tab.id, tab);
    this.#bindTabEvents(tab);
    this.#activeTabId = tab.id;
    this.#syncAttachedView();
    this.#emitChanged();

    try {
      await tab.view.webContents.loadURL(normalizedUrl);
    } catch (error) {
      this.#emitChanged();
      throw new Error(`Unable to open ${normalizedUrl}: ${String(error)}`);
    }

    return toPublicTab(tab);
  }

  async activate(tabId: string): Promise<void> {
    this.#requireTab(tabId);
    this.#activeTabId = tabId;
    this.#syncAttachedView();
    this.#emitChanged();
  }

  async close(tabId: string): Promise<void> {
    const tab = this.#requireTab(tabId);
    if (this.#attachedView === tab.view) this.#detachView();
    this.#tabs.delete(tabId);
    tab.view.webContents.close();

    if (this.#activeTabId === tabId) {
      this.#activeTabId = this.#tabs.keys().next().value ?? null;
    }
    this.#syncAttachedView();
    this.#emitChanged();
  }

  async setVisible(input: BrowserVisibilityInput): Promise<void> {
    this.#visible = input.visible;
    if (input.bounds) this.#bounds = validateBounds(input.bounds);
    if (!input.visible && this.#attachedView) {
      this.#attachedView.setBounds({ x: -10_000, y: -10_000, width: 1, height: 1 });
    }
    this.#syncAttachedView();
  }

  async snapshot(tabId: string): Promise<BrowserSnapshot> {
    return this.#enqueue(tabId, async (tab) => {
      const revision = tab.revision + 1;
      const raw = await withTimeout(
        tab.view.webContents.executeJavaScript(snapshotScript(revision), true),
        10_000,
        "Browser snapshot timed out.",
      );
      if (!isRecord(raw)) throw new Error("Browser returned an invalid snapshot.");
      tab.revision = revision;

      const elements = Array.isArray(raw.elements)
        ? raw.elements.filter(isSnapshotElement).slice(0, 500)
        : [];
      return {
        tabId,
        revision,
        title: typeof raw.title === "string" ? raw.title.slice(0, 500) : "",
        url: typeof raw.url === "string" ? raw.url : tab.view.webContents.getURL(),
        text: typeof raw.text === "string" ? raw.text.slice(0, 100_000) : "",
        elements,
      };
    });
  }

  async act(tabId: string, revision: number, action: BrowserAction): Promise<BrowserSnapshot> {
    return this.#enqueue(tabId, async (tab) => {
      if (revision !== tab.revision) {
        throw new Error("Stale browser references. Take a fresh snapshot before acting.");
      }

      await performAction(tab.view.webContents, action);
      await delay(250);
      const nextRevision = tab.revision + 1;
      const raw = await tab.view.webContents.executeJavaScript(snapshotScript(nextRevision), true);
      if (!isRecord(raw)) throw new Error("Browser returned an invalid snapshot.");
      tab.revision = nextRevision;

      return {
        tabId,
        revision: nextRevision,
        title: typeof raw.title === "string" ? raw.title.slice(0, 500) : "",
        url: typeof raw.url === "string" ? raw.url : tab.view.webContents.getURL(),
        text: typeof raw.text === "string" ? raw.text.slice(0, 100_000) : "",
        elements: Array.isArray(raw.elements)
          ? raw.elements.filter(isSnapshotElement).slice(0, 500)
          : [],
      };
    });
  }

  async screenshot(tabId: string): Promise<string> {
    return this.#enqueue(tabId, async (tab) => {
      const image = await withTimeout(
        tab.view.webContents.capturePage(),
        10_000,
        "Browser screenshot timed out.",
      );
      return image.toDataURL();
    });
  }

  async handleDynamicTool(params: DynamicToolCallParams): Promise<DynamicToolResult> {
    const args = isRecord(params.arguments) ? params.arguments : {};
    this.#beginControl(params, args);
    try {
      switch (params.tool) {
        case "open": {
          const url = requiredString(args, "url");
          const tab = await this.open(url, params.threadId);
          this.#updateControlTab(params, tab.id);
          return textResult({ tab });
        }
        case "list_tabs":
          return textResult({ tabs: this.listTabs(), activeTabId: this.#activeTabId });
        case "snapshot": {
          const snapshot = await this.snapshot(requiredString(args, "tabId"));
          return textResult(snapshot);
        }
        case "act": {
          const tabId = requiredString(args, "tabId");
          const revision = requiredNumber(args, "revision");
          const action = parseAction(args.action);
          return textResult(await this.act(tabId, revision, action));
        }
        case "screenshot": {
          const imageUrl = await this.screenshot(requiredString(args, "tabId"));
          return { success: true, contentItems: [{ type: "inputImage", imageUrl }] };
        }
        case "close_tab": {
          await this.close(requiredString(args, "tabId"));
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

  destroy(): void {
    this.#detachView();
    for (const tab of this.#tabs.values()) tab.view.webContents.close();
    this.#tabs.clear();
    this.#listeners.clear();
    this.clearControls();
    this.#controlListeners.clear();
  }

  #createView(): WebContentsView {
    return new WebContentsView({
      webPreferences: {
        session: this.#session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    });
  }

  #configureSession(): void {
    this.#session.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false);
    });
    this.#session.setPermissionCheckHandler(() => false);
    this.#session.on("will-download", (_event, item) => {
      const safeName = basename(item.getFilename()).replace(/[^a-zA-Z0-9._ -]/g, "_");
      item.setSavePath(join(this.#downloadsRoot, safeName || `download-${Date.now()}`));
    });
  }

  #bindTabEvents(tab: InternalTab): void {
    const contents = tab.view.webContents;
    const changed = () => this.#emitChanged();
    contents.on("did-start-loading", changed);
    contents.on("did-stop-loading", changed);
    contents.on("page-title-updated", changed);
    contents.on("did-navigate", () => {
      tab.revision += 1;
      changed();
    });
    contents.on("did-navigate-in-page", () => {
      tab.revision += 1;
      changed();
    });
    contents.on("will-navigate", (event, url) => {
      if (!isAllowedMainUrl(url)) event.preventDefault();
    });
    contents.setWindowOpenHandler(({ url }) => {
      if (isAllowedMainUrl(url)) void this.open(url, tab.ownerThreadId);
      return { action: "deny" };
    });
  }

  #syncAttachedView(): void {
    const tab = this.#activeTabId ? this.#tabs.get(this.#activeTabId) : null;
    if (!this.#visible || !this.#bounds || !tab) {
      this.#detachView();
      return;
    }

    if (this.#attachedView !== tab.view) {
      this.#detachView();
      this.#window.contentView.addChildView(tab.view);
      this.#attachedView = tab.view;
    }
    tab.view.setBounds(this.#bounds);
  }

  #detachView(): void {
    if (!this.#attachedView) return;
    const view = this.#attachedView;
    // WebContentsView is native to the window and does not follow renderer CSS
    // transforms. Move it out of the viewport before detaching so hide remains
    // reliable even while the renderer panel is animating away.
    view.setBounds({ x: -10_000, y: -10_000, width: 1, height: 1 });
    this.#window.contentView.removeChildView(view);
    this.#attachedView = null;
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

  #beginControl(params: DynamicToolCallParams, args: Record<string, unknown>): void {
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
      tabId: typeof args.tabId === "string" ? args.tabId : null,
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
}

function controlSessionId(threadId: string, turnId: string): string {
  return `${threadId}:${turnId}`;
}

function browserControlAction(tool: string, args: Record<string, unknown>): BrowserControlAction {
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

function functionTool(name: string, description: string, inputSchema: Record<string, unknown>) {
  return { type: "function" as const, name, description, inputSchema };
}

function emptySchema() {
  return { type: "object", properties: {}, additionalProperties: false };
}

function normalizeBrowserUrl(input: string): string {
  const value = input.trim();
  if (!value) throw new Error("A browser URL is required.");
  const withProtocol = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  const url = new URL(withProtocol);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP(S) browser URLs are allowed.");
  }
  return url.toString();
}

function isAllowedMainUrl(value: string): boolean {
  if (value === "about:blank") return true;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function validateBounds(bounds: BrowserBounds): BrowserBounds {
  const normalized = {
    x: Math.max(0, Math.round(bounds.x)),
    y: Math.max(0, Math.round(bounds.y)),
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height)),
  };
  if (!Object.values(normalized).every(Number.isFinite)) throw new Error("Invalid browser bounds.");
  return normalized;
}

function toPublicTab(tab: InternalTab): BrowserTab {
  return {
    id: tab.id,
    title: tab.view.webContents.getTitle() || "New tab",
    url: tab.view.webContents.getURL() || "about:blank",
    loading: tab.view.webContents.isLoading(),
    ownerThreadId: tab.ownerThreadId,
  };
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
    document.querySelectorAll('[data-infeld-ref]').forEach((node) => node.removeAttribute('data-infeld-ref'));
    const elements = nodes.map((node, index) => {
      const ref = revision + ':' + index;
      node.setAttribute('data-infeld-ref', ref);
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
      await contents.executeJavaScript(
        `(() => {
          const node = document.querySelector('[data-infeld-ref=${JSON.stringify(action.ref)}]');
          if (!(node instanceof HTMLElement)) throw new Error('Element reference is no longer available.');
          node.focus();
          node.click();
        })()`,
        true,
      );
      return;
    }
    case "type": {
      await contents.executeJavaScript(
        `(() => {
          const node = document.querySelector('[data-infeld-ref=${JSON.stringify(action.ref)}]');
          if (!(node instanceof HTMLElement)) throw new Error('Element reference is no longer available.');
          node.focus();
          const text = ${JSON.stringify(action.text.slice(0, 50_000))};
          if ('value' in node) {
            const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), 'value')?.set;
            if (setter) setter.call(node, text); else node.value = text;
          } else if (node.isContentEditable) {
            node.textContent = text;
          } else {
            throw new Error('Element does not accept text.');
          }
          node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
          node.dispatchEvent(new Event('change', { bubbles: true }));
        })()`,
        true,
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

function pressKey(contents: WebContents, key: string): void {
  if (!/^[a-zA-Z0-9+_-]{1,32}$/.test(key)) throw new Error("Invalid browser key.");
  contents.sendInputEvent({ type: "keyDown", keyCode: key });
  contents.sendInputEvent({ type: "keyUp", keyCode: key });
}

function parseAction(value: unknown): BrowserAction {
  if (!isRecord(value) || typeof value.type !== "string")
    throw new Error("Invalid browser action.");
  switch (value.type) {
    case "click":
      return { type: "click", ref: requiredString(value, "ref") };
    case "type":
      return {
        type: "type",
        ref: requiredString(value, "ref"),
        text: requiredString(value, "text"),
        submit: value.submit === true,
      };
    case "key":
      return { type: "key", key: requiredString(value, "key") };
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

function requiredString(value: Record<string, unknown>, key: string): string {
  if (typeof value[key] !== "string" || !value[key].trim()) throw new Error(`${key} is required.`);
  return value[key];
}

function requiredNumber(value: Record<string, unknown>, key: string): number {
  if (typeof value[key] !== "number" || !Number.isFinite(value[key])) {
    throw new Error(`${key} must be a number.`);
  }
  return value[key];
}

function isSnapshotElement(value: unknown): value is BrowserSnapshot["elements"][number] {
  return (
    isRecord(value) &&
    typeof value.ref === "string" &&
    typeof value.tag === "string" &&
    (typeof value.role === "string" || value.role === null) &&
    typeof value.name === "string" &&
    typeof value.disabled === "boolean"
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

async function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string,
): Promise<T> {
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
