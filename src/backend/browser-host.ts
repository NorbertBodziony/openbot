import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type {
  BrowserBounds,
  BrowserControlAction,
  BrowserControlDetailAction,
  BrowserControlSession,
  BrowserControlState,
  BrowserEnvironment,
  BrowserImageMode,
  BrowserNavigationDirection,
  BrowserPreview,
  BrowserSnapshot,
  BrowserTab,
  BrowserTarget,
  BrowserViewTarget,
  BrowserVisibilityInput,
} from "@openbot/contracts/ipc";
import { type DynamicRecord, isBoolean, isNumber, isString } from "@openbot/contracts/runtime-values";
import {
  app,
  BrowserWindow,
  type NativeImage,
  type Session,
  session,
  type WebContents,
  WebContentsView,
  webContents,
} from "electron";
import { BrowserCdpEngine, type BrowserUploadAssignment, type SnapshotReadResult } from "./browser-cdp";
import { BrowserDiagnostics } from "./browser-diagnostics";
import { embeddedBrowserUserAgent, embeddedBrowserUserAgentForUrl } from "./browser-identity";
import { BrowserRecorder } from "./browser-recorder";
import { isCloseBrowserTabShortcut, isGlobalSearchShortcut, isToggleDevToolsShortcut } from "./browser-shortcuts";
import { persistentBrowserUrl } from "./browser-state";
import { browserTargetSchema, parseBrowserToolArguments } from "./browser-tools";
import type { DynamicToolCallParams, DynamicToolResult } from "./protocol";
import { isRecord } from "./protocol";

interface BrowserHostEvents {
  changed: [tabs: BrowserTab[], activeTabId: string | null];
  controlChanged: [state: BrowserControlState];
  documentChanged: [tabId: string, documentIds: ReadonlySet<string>];
}

interface BrowserDynamicToolHooks {
  onUploadTargetResolved?: (inputId: string, documentId: string) => void;
  onUploadAssigned?: (inputId: string, documentId: string) => void;
  onUploadOperationStarted?: (completion: Promise<void>) => void;
}

type KeepQueueBlocked = (promise: Promise<unknown>) => void;

const MAX_PHYSICAL_VIEWPORT_PIXELS = 8_388_608;
const MAX_ENCODED_CAPTURE_PIXELS = 4_194_304;
const ACTION_POST_DISPATCH_TIMEOUT_MS = 10_000;

interface BrowserConsoleMessageDetails {
  level: "info" | "warning" | "error" | "debug";
  message: string;
  sourceId: string;
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
  environment: BrowserEnvironment;
  engine: BrowserCdpEngine;
  diagnostics: BrowserDiagnostics;
  recording: boolean;
}

interface StoredBrowserStateV1 {
  version: 1;
  activeTabId: string | null;
  tabs: Array<{
    id: string;
    url: string;
    ownerThreadId: string | null;
    ownerBotId: string | null;
  }>;
}

interface StoredBrowserStateV2 {
  version: 2;
  activeTabId: string | null;
  tabs: Array<{
    id: string;
    url: string;
    ownerThreadId: string | null;
    ownerBotId: string | null;
    environment: BrowserEnvironment;
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

export { BROWSER_DYNAMIC_TOOLS, OPENBOT_BROWSER_NAMESPACE } from "./browser-tools";

export class BrowserHost {
  static readonly CONTROL_IDLE_GRACE_MS = 1_200;
  readonly #window: BrowserWindow;
  readonly #session: Session;
  readonly #downloadsRoot: string;
  readonly #statePath: string;
  readonly #tabs = new Map<string, InternalTab>();
  readonly #closingTabDrains = new Map<string, Promise<void>>();
  readonly #listeners = new Set<(...args: BrowserHostEvents["changed"]) => void>();
  readonly #controlListeners = new Set<(...args: BrowserHostEvents["controlChanged"]) => void>();
  readonly #documentListeners = new Set<(...args: BrowserHostEvents["documentChanged"]) => void>();
  readonly #controlSessions = new Map<string, BrowserControlSession>();
  readonly #controlTimers = new Map<string, NodeJS.Timeout>();
  readonly #reservedDownloadPaths = new Set<string>();
  readonly #recorder: BrowserRecorder;
  #activeTabId: string | null = null;
  #visible = false;
  #bounds: BrowserBounds | null = null;
  #attachedView: WebContentsView | null = null;
  #pictureInPictureWindow: BrowserWindow | null = null;
  #pictureInPictureOverlayView: WebContentsView | null = null;
  #target: BrowserViewTarget = "main";
  readonly #mountedViews = new Map<WebContentsView, BrowserWindow>();
  readonly #takeoverTabIds = new Set<string>();
  #persistQueue: Promise<void> = Promise.resolve();
  #destroyPromise: Promise<void> | null = null;

  constructor(
    window: BrowserWindow,
    downloadsRoot: string,
    statePath: string,
    options: {
      recordingDurationMs?: number;
      recordingMaxConcurrent?: number;
      recordingMaxAggregateBytes?: number;
    } = {},
  ) {
    this.#window = window;
    this.#downloadsRoot = downloadsRoot;
    this.#statePath = statePath;
    this.#session = session.fromPartition("persist:openbot-browser", { cache: true });
    this.#recorder = new BrowserRecorder(
      downloadsRoot,
      (tabId, recording) => {
        const tab = this.#tabs.get(tabId);
        if (!tab) return;
        tab.recording = recording;
        this.#emitChanged();
      },
      {
        maxRecordingMs: options.recordingDurationMs,
        maxConcurrentRecordings: options.recordingMaxConcurrent,
        maxAggregateBytes: options.recordingMaxAggregateBytes,
      },
    );
    this.#configureSession();
  }

  async restore(): Promise<void> {
    const state = await readBrowserState(this.#statePath);
    if (state.tabs.length === 0) return;

    const tabs = state.tabs.slice(0, INPUT_LIMITS.browserTabs).map((stored) => {
      const tab = this.#createTab(
        stored.id,
        stored.url,
        stored.ownerThreadId,
        stored.ownerBotId,
        "environment" in stored ? stored.environment : defaultBrowserEnvironment(),
      );
      this.#tabs.set(tab.id, tab);
      this.#bindTabEvents(tab);
      return tab;
    });
    this.#activeTabId = this.#tabs.has(state.activeTabId ?? "") ? state.activeTabId : (tabs[0]?.id ?? null);
    this.#syncAttachedView();
    this.#emitChanged();

    const restoreTab = async (tab: InternalTab) => {
      await tab.view.webContents.loadURL("about:blank");
      await tab.engine.setEnvironment(tab.environment);
      await tab.engine.navigate(tab.requestedUrl);
      tab.view.webContents.navigationHistory.clear();
    };
    const activeTab = this.#activeTabId ? this.#tabs.get(this.#activeTabId) : undefined;
    const activeReady = activeTab ? restoreTab(activeTab).catch(() => undefined) : Promise.resolve();
    if (activeTab) activeTab.queue = activeReady;
    for (const tab of tabs) {
      if (tab === activeTab) continue;
      tab.queue = activeReady.then(() => restoreTab(tab)).catch(() => undefined);
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

  onDocumentChanged(listener: (...args: BrowserHostEvents["documentChanged"]) => void): () => void {
    this.#documentListeners.add(listener);
    return () => this.#documentListeners.delete(listener);
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
    const focusedContents = focus ? null : webContents.getFocusedWebContents();
    const previouslyFocused =
      focusedContents && ![...this.#tabs.values()].some((candidate) => candidate.view.webContents === focusedContents)
        ? focusedContents
        : null;
    const tab = this.#createTab(randomUUID(), normalizedUrl, ownerThreadId, ownerBotId);

    this.#tabs.set(tab.id, tab);
    this.#bindTabEvents(tab);
    this.#activeTabId = tab.id;
    tab.focusOnVisible = focus;
    this.#syncAttachedView();
    if (!focus) restoreWebContentsFocus(previouslyFocused, tab.view.webContents);
    this.#emitChanged();
    await this.#persistState();

    try {
      await tab.view.webContents.loadURL(normalizedUrl, browserLoadOptions());
      if (focus) {
        this.#focusTab(tab);
        setImmediate(() => this.#focusTab(tab));
      } else restoreWebContentsFocus(previouslyFocused, tab.view.webContents);
    } catch (error) {
      if (this.#tabs.get(tab.id) === tab) {
        this.#unmountView(tab.view);
        this.#tabs.delete(tab.id);
        tab.engine.destroy();
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
      await navigateAndWait(tab.view.webContents, () =>
        navigateHistory(tab.view.webContents, direction, this.#session.getUserAgent()),
      );
    });
  }

  async reload(tabId: string): Promise<void> {
    await this.#enqueue(tabId, async (tab) =>
      navigateAndWait(tab.view.webContents, () => {
        tab.view.webContents.reload();
        return true;
      }),
    );
  }

  async close(tabId: string): Promise<void> {
    const tab = this.#tabs.get(tabId);
    if (!tab) return;
    const tabIds = [...this.#tabs.keys()];
    const closedIndex = tabIds.indexOf(tabId);
    this.#unmountView(tab.view);
    this.#tabs.delete(tabId);
    this.#takeoverTabIds.delete(tabId);

    if (this.#activeTabId === tabId) {
      this.#activeTabId = tabIds[closedIndex + 1] ?? tabIds[closedIndex - 1] ?? null;
    }
    this.#syncAttachedView();
    this.#emitChanged();
    const destroy = tab.queue.then(async () => {
      try {
        await this.#recorder.discard(tabId, "tab-closed");
      } finally {
        tab.engine.destroy();
        if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
      }
    });
    this.#closingTabDrains.set(tab.id, destroy);
    tab.queue = destroy.catch(() => undefined);
    const statePersistence = this.#persistState();
    try {
      await destroy;
      await statePersistence;
    } finally {
      if (this.#closingTabDrains.get(tab.id) === destroy) this.#closingTabDrains.delete(tab.id);
    }
  }

  async beginTakeover(tabId: string): Promise<void> {
    const tab = this.#tabs.get(tabId);
    if (!tab) throw new Error("Browser tab not found.");
    tab.engine.invalidateReferences();
    this.#takeoverTabIds.add(tabId);
    tab.diagnostics.clearDiagnostics();
    this.#emitChanged();
    try {
      await this.#enqueue(tabId, () => this.#recorder.discard(tabId, "tab-closed"));
    } catch (error) {
      tab.diagnostics.clearDiagnostics();
      this.#takeoverTabIds.delete(tabId);
      throw error;
    }
  }

  endTakeover(tabId: string): void {
    const tab = this.#tabs.get(tabId);
    if (tab) {
      tab.engine.invalidateReferences();
      tab.diagnostics.clearDiagnostics();
    }
    this.#takeoverTabIds.delete(tabId);
    this.#emitChanged();
  }

  async setVisible(input: BrowserVisibilityInput): Promise<void> {
    const restoreRendererFocus = !input.visible && this.#attachedView?.webContents.isFocused();
    this.#visible = input.visible;
    if (input.bounds) this.#bounds = validateBounds(input.bounds);
    if (input.target) this.#target = input.target;
    this.#syncAttachedView();
    if (restoreRendererFocus) this.#window.webContents.focus();
  }

  async snapshot(tabId: string): Promise<BrowserSnapshot> {
    return this.#enqueue(tabId, async (tab, keepQueueBlocked) => {
      const revision = tab.revision + 1;
      return (await this.#readSnapshot(tab, revision, keepQueueBlocked)).snapshot;
    });
  }

  async act(tabId: string, revision: number, action: BrowserAction): Promise<BrowserSnapshot> {
    return this.#enqueue(tabId, async (tab, keepQueueBlocked) => {
      if (revision !== tab.revision) {
        throw new Error("Stale browser references. Take a fresh snapshot before acting.");
      }
      const target = "ref" in action ? ({ kind: "ref", ref: action.ref, revision } as const) : undefined;
      try {
        switch (action.type) {
          case "click":
            if (!target) throw new Error("Legacy click requires a target.");
            await tab.engine.click(target);
            break;
          case "type":
            if (!target) throw new Error("Legacy type requires a target.");
            await tab.engine.type(target, action.text, "replace");
            if (action.submit) await tab.engine.press("Enter", target);
            break;
          case "key":
            await tab.engine.press(action.key);
            break;
          case "scroll":
            await tab.engine.scroll(undefined, 0, action.deltaY);
            break;
          case "back":
          case "forward":
            await navigateAndWait(tab.view.webContents, () =>
              navigateHistory(tab.view.webContents, action.type, this.#session.getUserAgent()),
            );
            break;
          case "reload":
            await navigateAndWait(tab.view.webContents, () => {
              tab.view.webContents.reload();
              return true;
            });
        }
        await tab.engine.settle();
        tab.diagnostics.action({
          action: action.type,
          target: target ? describeBrowserTarget(target) : undefined,
          outcome: "success",
        });
      } catch (error) {
        tab.diagnostics.action({
          action: action.type,
          target: target ? describeBrowserTarget(target) : undefined,
          outcome: "error",
          detail: String(error),
        });
        throw error;
      }
      const nextRevision = tab.revision + 1;
      return (await this.#readSnapshot(tab, nextRevision, keepQueueBlocked)).snapshot;
    });
  }

  async screenshot(tabId: string): Promise<string> {
    return this.#enqueue(tabId, async (tab) => {
      const image = await withTimeout(tab.view.webContents.capturePage(), 10_000, "Browser screenshot timed out.");
      return boundedCaptureDataUrl(image);
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

  async handleDynamicTool(
    params: DynamicToolCallParams,
    hooks: BrowserDynamicToolHooks = {},
  ): Promise<DynamicToolResult> {
    try {
      const args = parseBrowserToolArguments(params.tool, params.arguments);
      this.#beginControl(params, args);
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
        case "status": {
          const tabs = this.listTabs().filter((tab) => this.#canUseToolTab(params, tab));
          const activeTabId = tabs.some((tab) => tab.id === this.#activeTabId)
            ? this.#activeTabId
            : (tabs.at(-1)?.id ?? null);
          const control = {
            sessions: this.getControlState().sessions.filter((session) => session.threadId === params.threadId),
          };
          return textResult({ tabs, activeTabId, control });
        }
        case "snapshot": {
          const tabId = requiredString(args, "tabId", INPUT_LIMITS.identifier);
          this.#requireToolTab(params, tabId);
          const mode = parseImageMode(args.image);
          const capture = await this.#enqueue(tabId, async (tab, keepQueueBlocked) => {
            const result = await this.#readSnapshot(tab, tab.revision + 1, keepQueueBlocked);
            const includeImage = mode === "always" || (mode === "auto" && result.recommendImage);
            if (!includeImage) return { result, imageUrl: null };
            const image = await withTimeout(
              tab.view.webContents.capturePage(),
              10_000,
              "Browser screenshot timed out.",
            );
            return { result, imageUrl: boundedCaptureDataUrl(image) };
          });
          return this.#snapshotResult(capture.result, mode, capture.imageUrl);
        }
        case "navigate": {
          const tabId = requiredString(args, "tabId", INPUT_LIMITS.identifier);
          this.#requireToolTab(params, tabId);
          const url = optionalString(args, "url", INPUT_LIMITS.browserUrl);
          const direction = optionalEnum(args, "direction", ["back", "forward", "reload"] as const);
          if (!url && !direction) throw new Error("navigate requires url or direction.");
          const timeoutMs = readTimeout(args, 30_000);
          return textResult(
            await this.#runAction(
              tabId,
              "navigate",
              undefined,
              async (tab, deadline) => {
                const operationTimeout = remainingTime(deadline, "Browser navigate timed out.");
                if (url) {
                  const normalizedUrl = normalizeBrowserUrl(url);
                  tab.requestedUrl = normalizedUrl;
                  tab.view.webContents.setUserAgent(
                    embeddedBrowserUserAgentForUrl(this.#session.getUserAgent(), normalizedUrl),
                  );
                  await navigateAndWait(
                    tab.view.webContents,
                    () => tab.view.webContents.loadURL(normalizedUrl, browserLoadOptions()),
                    operationTimeout,
                  );
                } else if (direction === "reload") {
                  await navigateAndWait(
                    tab.view.webContents,
                    () => {
                      tab.view.webContents.reload();
                      return true;
                    },
                    operationTimeout,
                  );
                } else if (direction) {
                  await navigateAndWait(
                    tab.view.webContents,
                    () => navigateHistory(tab.view.webContents, direction, this.#session.getUserAgent()),
                    operationTimeout,
                  );
                }
              },
              timeoutMs,
            ),
          );
        }
        case "click": {
          const tabId = requiredString(args, "tabId", INPUT_LIMITS.identifier);
          this.#requireToolTab(params, tabId);
          const target = parseTarget(args.target);
          return textResult(
            await this.#runAction(
              tabId,
              "click",
              target,
              (tab, deadline) =>
                tab.engine.click(
                  target,
                  {
                    button: optionalEnum(args, "button", ["left", "middle", "right"] as const),
                    clickCount: optionalNumber(args, "clickCount"),
                    modifiers: optionalStringArray(args, "modifiers", 4),
                  },
                  deadline,
                ),
              readTimeout(args),
            ),
          );
        }
        case "type": {
          const tabId = requiredString(args, "tabId", INPUT_LIMITS.identifier);
          this.#requireToolTab(params, tabId);
          const target = parseTarget(args.target);
          const text = stringValue(args, "text", INPUT_LIMITS.browserActionText);
          const mode = optionalEnum(args, "mode", ["replace", "append"] as const) ?? "replace";
          return textResult(
            await this.#runAction(
              tabId,
              "type",
              target,
              async (tab, deadline) => {
                await tab.engine.type(target, text, mode, deadline);
                if (args.submit === true) await tab.engine.press("Enter", target);
              },
              readTimeout(args),
            ),
          );
        }
        case "press": {
          const tabId = requiredString(args, "tabId", INPUT_LIMITS.identifier);
          this.#requireToolTab(params, tabId);
          const target = args.target === undefined ? undefined : parseTarget(args.target);
          const key = requiredString(args, "key", 128);
          return textResult(
            await this.#runAction(
              tabId,
              "press",
              target,
              (tab, deadline) => tab.engine.press(key, target, deadline),
              readTimeout(args),
            ),
          );
        }
        case "hover": {
          const tabId = requiredString(args, "tabId", INPUT_LIMITS.identifier);
          this.#requireToolTab(params, tabId);
          const target = parseTarget(args.target);
          return textResult(
            await this.#runAction(
              tabId,
              "hover",
              target,
              (tab, deadline) => tab.engine.hover(target, deadline),
              readTimeout(args),
            ),
          );
        }
        case "scroll": {
          const tabId = requiredString(args, "tabId", INPUT_LIMITS.identifier);
          this.#requireToolTab(params, tabId);
          const target = args.target === undefined ? undefined : parseTarget(args.target);
          const deltaX = optionalNumber(args, "deltaX") ?? 0;
          const deltaY = optionalNumber(args, "deltaY") ?? 0;
          if (deltaX === 0 && deltaY === 0) throw new Error("scroll requires deltaX or deltaY.");
          return textResult(
            await this.#runAction(
              tabId,
              "scroll",
              target,
              (tab, deadline) => tab.engine.scroll(target, deltaX, deltaY, deadline),
              readTimeout(args),
            ),
          );
        }
        case "select_option": {
          const tabId = requiredString(args, "tabId", INPUT_LIMITS.identifier);
          this.#requireToolTab(params, tabId);
          const target = parseTarget(args.target);
          const values = requiredStringArray(args, "values", 100, 1_000);
          return textResult(
            await this.#runAction(
              tabId,
              "select-option",
              target,
              (tab, deadline) => tab.engine.selectOption(target, values, deadline),
              readTimeout(args),
            ),
          );
        }
        case "set_checked": {
          const tabId = requiredString(args, "tabId", INPUT_LIMITS.identifier);
          this.#requireToolTab(params, tabId);
          const target = parseTarget(args.target);
          const checked = requiredBoolean(args, "checked");
          return textResult(
            await this.#runAction(
              tabId,
              "set-checked",
              target,
              (tab, deadline) => tab.engine.setChecked(target, checked, deadline),
              readTimeout(args),
            ),
          );
        }
        case "drag": {
          const tabId = requiredString(args, "tabId", INPUT_LIMITS.identifier);
          this.#requireToolTab(params, tabId);
          const source = parseTarget(args.source);
          const target = parseTarget(args.target);
          return textResult(
            await this.#runAction(
              tabId,
              "drag",
              source,
              (tab, deadline) => tab.engine.drag(source, target, deadline),
              readTimeout(args),
            ),
          );
        }
        case "upload_files": {
          const tabId = requiredString(args, "tabId", INPUT_LIMITS.identifier);
          this.#requireToolTab(params, tabId);
          const target = parseTarget(args.target);
          const paths = requiredStringArray(args, "paths", INPUT_LIMITS.attachments, INPUT_LIMITS.path);
          return textResult(
            await this.#runAction(
              tabId,
              "upload-files",
              target,
              async (tab, deadline) => {
                const assignment = await tab.engine.uploadFiles(
                  target,
                  paths,
                  (resolved) => hooks.onUploadTargetResolved?.(resolved.inputId, resolved.documentId),
                  deadline,
                );
                hooks.onUploadAssigned?.(assignment.inputId, assignment.documentId);
              },
              readTimeout(args),
              hooks.onUploadOperationStarted,
            ),
          );
        }
        case "wait_for": {
          const tabId = requiredString(args, "tabId", INPUT_LIMITS.identifier);
          this.#requireToolTab(params, tabId);
          const target = args.target === undefined ? undefined : parseTarget(args.target);
          const condition = {
            target,
            text: optionalString(args, "text", 2_000),
            url: optionalString(args, "url", INPUT_LIMITS.browserUrl),
            state: optionalEnum(args, "state", ["load", "domcontentloaded", "dom-quiet"] as const),
          };
          if (!condition.target && !condition.text && !condition.url && !condition.state)
            throw new Error("wait_for requires a condition.");
          const timeoutMs = readTimeout(args, 30_000);
          return textResult(
            await this.#enqueue(tabId, async (tab, keepQueueBlocked) => {
              const timeoutMessage = "Browser wait condition timed out.";
              const deadline = Date.now() + timeoutMs;
              await tab.engine.waitFor(condition, remainingTime(deadline, timeoutMessage));
              return (
                await this.#readSnapshot(
                  tab,
                  tab.revision + 1,
                  keepQueueBlocked,
                  remainingTime(deadline, timeoutMessage),
                  timeoutMessage,
                )
              ).snapshot;
            }),
          );
        }
        case "evaluate": {
          const tabId = requiredString(args, "tabId", INPUT_LIMITS.identifier);
          this.#requireToolTab(params, tabId);
          const expression = requiredString(args, "expression", 64_000);
          if (!expression.trim()) throw new Error("expression must not be blank.");
          const awaitPromise = args.awaitPromise === undefined ? true : requiredBoolean(args, "awaitPromise");
          return textResult(await this.#runEvaluation(tabId, expression, awaitPromise, readTimeout(args)));
        }
        case "set_environment": {
          const tabId = requiredString(args, "tabId", INPUT_LIMITS.identifier);
          this.#requireToolTab(params, tabId);
          return textResult(
            await this.#enqueue(tabId, async (tab, keepQueueBlocked) => {
              const environment = parseEnvironment(args, tab.environment, tab.view.getBounds());
              await tab.engine.setEnvironment(environment);
              tab.environment = environment;
              await this.#persistState();
              this.#emitChanged();
              return (await this.#readSnapshot(tab, tab.revision + 1, keepQueueBlocked)).snapshot;
            }),
          );
        }
        case "recording_start": {
          const tabId = requiredString(args, "tabId", INPUT_LIMITS.identifier);
          this.#requireToolTab(params, tabId);
          await this.#enqueue(tabId, (tab) => this.#recorder.start(tabId, tab.view.webContents));
          return textResult({ recording: true, tabId, limits: { durationMs: 300_000, bytes: 104_857_600 } });
        }
        case "recording_stop": {
          const tabId = requiredString(args, "tabId", INPUT_LIMITS.identifier);
          this.#requireToolTab(params, tabId);
          return textResult({ artifact: await this.#enqueue(tabId, () => this.#recorder.stop(tabId)) });
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
          if (this.#tabs.has(tabId)) this.#requireToolTab(params, tabId);
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

  async resolveUploadTarget(params: DynamicToolCallParams): Promise<BrowserUploadAssignment> {
    const args = parseBrowserToolArguments("upload_files", params.arguments);
    const tabId = requiredString(args, "tabId", INPUT_LIMITS.identifier);
    this.#requireToolTab(params, tabId);
    const target = parseTarget(args.target);
    return this.#enqueue(tabId, (tab) => tab.engine.resolveUploadTarget(target));
  }

  destroy(): Promise<void> {
    this.#destroyPromise ??= this.#destroyPersistentStorageAndViews();
    return this.#destroyPromise;
  }

  async #destroyPersistentStorageAndViews(): Promise<void> {
    const statePersistence = this.#persistState();
    const closingTabDrains = [...this.#closingTabDrains.values()];
    const activeTabDrains: Promise<void>[] = [];
    this.#session.flushStorageData();
    for (const tab of this.#tabs.values()) {
      this.#unmountView(tab.view);
      const drain = tab.queue.then(() => {
        tab.engine.destroy();
        if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
      });
      activeTabDrains.push(drain);
      tab.queue = drain.catch(() => undefined);
    }
    const tabDrains = [...closingTabDrains, ...activeTabDrains];
    const recorderDestruction = Promise.allSettled(tabDrains).then(() => this.#recorder.destroy());
    this.#tabs.clear();
    this.#listeners.clear();
    this.clearControls();
    this.#controlListeners.clear();
    this.#documentListeners.clear();
    const results = await Promise.allSettled([
      this.#session.cookies.flushStore(),
      statePersistence,
      recorderDestruction,
      ...tabDrains,
    ]);
    this.#closingTabDrains.clear();
    this.#session.flushStorageData();
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }

  async flushPersistentStorage(): Promise<void> {
    this.#session.flushStorageData();
    await this.#session.cookies.flushStore();
    await this.#persistState();
  }

  #createTab(
    id: string,
    requestedUrl: string,
    ownerThreadId: string | null,
    ownerBotId: string | null,
    environment = defaultBrowserEnvironment(),
  ): InternalTab {
    if (this.#destroyPromise) throw new Error("BrowserHost is shutting down.");
    const view = this.#createView();
    view.webContents.setUserAgent(embeddedBrowserUserAgentForUrl(this.#session.getUserAgent(), requestedUrl));
    this.#mountView(view);
    const diagnostics = new BrowserDiagnostics();
    return {
      id,
      view,
      requestedUrl,
      ownerThreadId,
      ownerBotId,
      revision: 0,
      queue: Promise.resolve(),
      focusOnVisible: false,
      environment,
      engine: new BrowserCdpEngine(view.webContents),
      diagnostics,
      recording: false,
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
    this.#session.webRequest.onCompleted((details) => {
      const tab = [...this.#tabs.values()].find((candidate) => candidate.view.webContents.id === details.webContentsId);
      if (!tab) return;
      tab.diagnostics.add({
        kind: "network",
        level: details.statusCode >= 400 ? "error" : "info",
        message: `${details.method} ${details.statusCode}`,
        url: diagnosticUrl(details.url),
        method: details.method,
        status: details.statusCode,
      });
      if (details.statusCode >= 400) this.#emitChanged();
    });
    this.#session.webRequest.onErrorOccurred((details) => {
      const tab = [...this.#tabs.values()].find((candidate) => candidate.view.webContents.id === details.webContentsId);
      if (!tab) return;
      tab.diagnostics.add({
        kind: "network",
        level: "error",
        message: `${details.method} ${details.error}`,
        url: diagnosticUrl(details.url),
        method: details.method,
      });
      this.#emitChanged();
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
    let documentGeneration = 0;
    contents.on("did-frame-navigate", (_event, _url, _code, _status, isMainFrame) => {
      const generation = ++documentGeneration;
      if (!tab.engine.hasUploadDocuments()) {
        if (this.#tabs.get(tab.id) !== tab) return;
        for (const listener of this.#documentListeners) listener(tab.id, new Set());
        return;
      }
      const documentIds = tab.queue.then(() => tab.engine.documentIds());
      tab.queue = documentIds.then(
        () => undefined,
        () => undefined,
      );
      void documentIds
        .then((documentIds) => {
          if (generation !== documentGeneration || this.#tabs.get(tab.id) !== tab) return;
          for (const listener of this.#documentListeners) listener(tab.id, documentIds);
        })
        .catch(() => {
          if (!isMainFrame || generation !== documentGeneration || this.#tabs.get(tab.id) !== tab) return;
          for (const listener of this.#documentListeners) listener(tab.id, new Set());
        });
    });
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
    contents.on("console-message", (...eventArgs) => {
      if (this.#takeoverTabIds.has(tab.id)) return;
      const details = readConsoleMessage(eventArgs);
      if (!details) return;
      tab.diagnostics.add({
        kind: "console",
        level: details.level,
        message: details.message.slice(0, 2_000),
        url: diagnosticUrl(details.sourceId),
      });
      if (details.level === "error") this.#emitChanged();
    });
    contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      tab.diagnostics.add({
        kind: "load",
        level: "error",
        message: `${code}: ${description}`,
        url: diagnosticUrl(url),
      });
      this.#emitChanged();
    });
    contents.on("page-title-updated", changed);
    contents.on("did-navigate", (_event, url) => {
      if (this.#tabs.get(tab.id) !== tab) return;
      if (isPersistableBrowserUrl(url)) tab.requestedUrl = persistentBrowserUrl(url);
      tab.revision += 1;
      changed();
      this.#schedulePersist();
    });
    contents.on("did-navigate-in-page", (_event, url) => {
      if (this.#tabs.get(tab.id) !== tab) return;
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

  async #readSnapshot(
    tab: InternalTab,
    revision: number,
    keepQueueBlocked: KeepQueueBlocked,
    timeoutMs = 10_000,
    timeoutMessage = "Browser snapshot timed out.",
  ): Promise<SnapshotReadResult> {
    const history = tab.diagnostics.snapshot();
    const completion = tab.engine.snapshot({
      tabId: tab.id,
      revision,
      environment: tab.environment,
      diagnostics: history.diagnostics,
      actions: history.actions,
    });
    keepQueueBlocked(completion);
    const result = await withTimeout(completion, timeoutMs, timeoutMessage);
    tab.revision = revision;
    return result;
  }

  async #runAction(
    tabId: string,
    action: string,
    target: BrowserTarget | undefined,
    operation: (tab: InternalTab, deadline: number) => Promise<void>,
    timeoutMs = 10_000,
    onOperationStarted?: (completion: Promise<void>) => void,
  ): Promise<BrowserSnapshot> {
    const tab = this.#requireTab(tabId);
    const started = tab.queue.then(() => {
      const focusedContents = webContents.getFocusedWebContents();
      const previouslyFocused =
        focusedContents && ![...this.#tabs.values()].some((candidate) => candidate.view.webContents === focusedContents)
          ? focusedContents
          : null;
      const deadline = Date.now() + timeoutMs;
      const timeoutMessage = `Browser ${action} timed out.`;
      const snapshotDrains: Promise<unknown>[] = [];
      let actionRecorded = false;
      const operationCompletion = (async () => {
        let highlighted = false;
        try {
          tab.view.webContents.focus();
          if (target && target.kind !== "point") {
            highlighted = await tab.engine.highlight(target).then(
              () => true,
              () => false,
            );
          }
          remainingTime(deadline, timeoutMessage);
          await operation(tab, deadline);
        } finally {
          if (highlighted) await tab.engine.hideHighlight().catch(() => undefined);
        }
      })();
      onOperationStarted?.(operationCompletion);
      const response = operationCompletion
        .then(async () => {
          const settleTimeout = Math.max(1, deadline - Date.now());
          try {
            await tab.engine.settle(settleTimeout);
          } catch (error) {
            if (!isTimeoutError(error)) throw error;
            if (tab.view.webContents.isLoading()) await tab.engine.stopLoading().catch(() => undefined);
          }
          tab.diagnostics.action({
            action,
            target: target ? describeBrowserTarget(target) : undefined,
            outcome: "success",
            ...(Date.now() >= deadline
              ? { detail: "Action completed; page settling exceeded the requested timeout." }
              : {}),
          });
          actionRecorded = true;
          const snapshot = (
            await this.#readSnapshot(
              tab,
              tab.revision + 1,
              (promise) => snapshotDrains.push(promise),
              ACTION_POST_DISPATCH_TIMEOUT_MS,
              timeoutMessage,
            )
          ).snapshot;
          return snapshot;
        })
        .catch((error) => {
          if (!actionRecorded) {
            tab.diagnostics.action({
              action,
              target: target ? describeBrowserTarget(target) : undefined,
              outcome: "error",
              detail: String(error).slice(0, 2_000),
            });
          }
          throw error;
        })
        .finally(() => restoreWebContentsFocus(previouslyFocused, tab.view.webContents));
      const drained = Promise.allSettled([operationCompletion, response])
        .then(() => (tab.view.webContents.isLoading() ? tab.engine.stopLoading().catch(() => undefined) : undefined))
        .then(() => Promise.allSettled(snapshotDrains))
        .then(() => undefined);
      return { drained, response };
    });
    const result = started.then(({ response }) => response);
    tab.queue = started.then(
      ({ drained }) => drained,
      () => undefined,
    );
    return result;
  }

  async #runEvaluation(tabId: string, expression: string, awaitPromise: boolean, timeoutMs: number): Promise<unknown> {
    const tab = this.#requireTab(tabId);
    const started = tab.queue.then(() => {
      const deadline = Date.now() + timeoutMs;
      const timeoutMessage = "Browser evaluate timed out.";
      const operationCompletion = tab.engine.evaluate(
        expression,
        awaitPromise,
        remainingTime(deadline, timeoutMessage),
      );
      const response = withTimeout(operationCompletion, remainingTime(deadline, timeoutMessage), timeoutMessage)
        .then(async (value) => {
          const settleTimeout = remainingTime(deadline, timeoutMessage);
          await withTimeout(tab.engine.settle(settleTimeout), settleTimeout, timeoutMessage);
          tab.diagnostics.action({ action: "evaluate", outcome: "success" });
          return value;
        })
        .catch((error) => {
          tab.diagnostics.action({
            action: "evaluate",
            outcome: "error",
            detail: String(error).slice(0, 2_000),
          });
          throw error;
        });
      const drained = Promise.allSettled([operationCompletion, response]).then(() => undefined);
      return { drained, response };
    });
    const result = started.then(({ response }) => response);
    tab.queue = started.then(
      ({ drained }) => drained,
      () => undefined,
    );
    return result;
  }

  #snapshotResult(result: SnapshotReadResult, mode: BrowserImageMode, imageUrl: string | null): DynamicToolResult {
    if (!imageUrl) return textResult(result.snapshot);
    result.snapshot.image = {
      included: true,
      reason: mode === "always" ? "requested" : result.imageReason,
      width: result.snapshot.viewport.width,
      height: result.snapshot.viewport.height,
    };
    return {
      success: true,
      contentItems: [
        { type: "inputText", text: JSON.stringify(result.snapshot) },
        { type: "inputImage", imageUrl },
      ],
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

  #enqueue<T>(
    tabId: string,
    operation: (tab: InternalTab, keepQueueBlocked: KeepQueueBlocked) => Promise<T>,
  ): Promise<T> {
    const tab = this.#requireTab(tabId);
    const started = tab.queue.then(() => {
      const drains: Promise<unknown>[] = [];
      const result = operation(tab, (promise) => drains.push(promise));
      const drained = result
        .catch(() => undefined)
        .then(() => Promise.allSettled(drains))
        .then(() => undefined);
      return { drained, result };
    });
    const result = started.then(({ result }) => result);
    tab.queue = started.then(
      ({ drained }) => drained,
      () => undefined,
    );
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
      detailAction: browserControlDetailAction(params.tool),
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
    const state: StoredBrowserStateV2 = {
      version: 2,
      activeTabId: this.#activeTabId,
      tabs: [...this.#tabs.values()].map((tab) => ({
        id: tab.id,
        url: persistentBrowserUrl(currentTabUrl(tab)),
        ownerThreadId: tab.ownerThreadId,
        ownerBotId: tab.ownerBotId,
        environment: tab.environment,
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

function restoreWebContentsFocus(previous: WebContents | null, controlled: WebContents): void {
  const current = webContents.getFocusedWebContents();
  if (current && current !== controlled) return;
  if (previous && !previous.isDestroyed()) {
    const window = BrowserWindow.fromWebContents(previous);
    if (window && !window.isDestroyed()) window.focus();
    previous.focus();
  }
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
    case "status":
      return "list-tabs";
    case "navigate":
      if (args.direction === "back") return "back";
      if (args.direction === "forward") return "forward";
      if (args.direction === "reload") return "reload";
      return "open";
    case "click":
      return "click";
    case "type":
      return "type";
    case "press":
      return "key";
    case "hover":
      return "click";
    case "scroll":
      return "scroll";
    case "select_option":
      return "click";
    case "set_checked":
      return "click";
    case "drag":
      return "click";
    case "upload_files":
      return "type";
    case "wait_for":
      return "snapshot";
    case "evaluate":
      return "snapshot";
    case "set_environment":
      return "snapshot";
    case "recording_start":
      return "screenshot";
    case "recording_stop":
      return "screenshot";
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

function browserControlDetailAction(tool: string): BrowserControlDetailAction | undefined {
  switch (tool) {
    case "status":
    case "navigate":
    case "press":
    case "hover":
    case "drag":
      return tool;
    case "select_option":
      return "select-option";
    case "set_checked":
      return "set-checked";
    case "upload_files":
      return "upload-files";
    case "wait_for":
      return "wait-for";
    case "evaluate":
      return "evaluate";
    case "set_environment":
      return "set-environment";
    case "recording_start":
      return "recording-start";
    case "recording_stop":
      return "recording-stop";
    default:
      return undefined;
  }
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

async function readBrowserState(path: string): Promise<StoredBrowserStateV2> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(parsed) || (parsed.version !== 1 && parsed.version !== 2)) {
      return { version: 2, activeTabId: null, tabs: [] };
    }
    const tabs = Array.isArray(parsed.tabs)
      ? parsed.tabs.filter(isStoredBrowserTab).map((tab) => ({
          ...tab,
          url: persistentBrowserUrl(tab.url),
          environment:
            parsed.version === 2 && isBrowserEnvironment(tab.environment)
              ? tab.environment
              : defaultBrowserEnvironment(),
        }))
      : [];
    return {
      version: 2,
      activeTabId: isString(parsed.activeTabId) ? parsed.activeTabId : null,
      tabs: tabs.filter((tab, index) => tabs.findIndex((candidate) => candidate.id === tab.id) === index),
    };
  } catch (error) {
    if (isMissingFile(error) || error instanceof SyntaxError) {
      return { version: 2, activeTabId: null, tabs: [] };
    }
    throw error;
  }
}

function isStoredBrowserTab(value: unknown): value is StoredBrowserStateV1["tabs"][number] & { environment?: unknown } {
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

function diagnosticUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().slice(0, INPUT_LIMITS.browserUrl);
  } catch {
    return undefined;
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
  const environment =
    tab.environment.viewport.mode === "fill"
      ? {
          ...tab.environment,
          viewport: {
            ...tab.environment.viewport,
            width: tab.view.getBounds().width,
            height: tab.view.getBounds().height,
          },
        }
      : tab.environment;
  return {
    id: tab.id,
    title: tab.view.webContents.getTitle() || "New tab",
    url: currentTabUrl(tab),
    loading: tab.view.webContents.isLoading(),
    ownerThreadId: tab.ownerThreadId,
    ownerBotId: tab.ownerBotId,
    environment,
    recording: tab.recording,
    diagnosticErrorCount: tab.diagnostics.errorCount,
  };
}

function currentTabUrl(tab: InternalTab): string {
  const currentUrl = tab.view.webContents.getURL();
  return isPersistableBrowserUrl(currentUrl) ? currentUrl : tab.requestedUrl;
}

function readConsoleMessage(args: unknown[]): BrowserConsoleMessageDetails | null {
  const modern = args[1];
  if (
    isRecord(modern) &&
    (modern.level === "info" || modern.level === "warning" || modern.level === "error" || modern.level === "debug") &&
    isString(modern.message) &&
    isString(modern.sourceId)
  ) {
    return { level: modern.level, message: modern.message, sourceId: modern.sourceId };
  }
  const level = args[1];
  const message = args[2];
  const sourceId = args[4];
  if (!isNumber(level) || !isString(message)) return null;
  return {
    level: level >= 3 ? "error" : level === 2 ? "warning" : level === 0 ? "debug" : "info",
    message,
    sourceId: isString(sourceId) ? sourceId : "",
  };
}

function defaultBrowserEnvironment(): BrowserEnvironment {
  return {
    viewport: { mode: "fill", width: 1200, height: 800, deviceScaleFactor: 1, preset: null },
    colorScheme: "system",
    reducedMotion: false,
  };
}

function isBrowserEnvironment(value: unknown): value is BrowserEnvironment {
  if (!isRecord(value) || !isRecord(value.viewport)) return false;
  const viewport = value.viewport;
  const minimumWidth = viewport.mode === "fill" ? 1 : 320;
  const minimumHeight = viewport.mode === "fill" ? 1 : 240;
  return (
    (viewport.mode === "fill" || viewport.mode === "custom") &&
    isNumber(viewport.width) &&
    viewport.width >= minimumWidth &&
    viewport.width <= INPUT_LIMITS.browserDimension &&
    isNumber(viewport.height) &&
    viewport.height >= minimumHeight &&
    viewport.height <= INPUT_LIMITS.browserDimension &&
    isNumber(viewport.deviceScaleFactor) &&
    viewport.deviceScaleFactor >= 0.5 &&
    viewport.deviceScaleFactor <= 4 &&
    isSafeViewportSize(viewport.width, viewport.height, viewport.deviceScaleFactor) &&
    (viewport.preset === null ||
      viewport.preset === "desktop" ||
      viewport.preset === "tablet" ||
      viewport.preset === "mobile") &&
    (value.colorScheme === "light" || value.colorScheme === "dark" || value.colorScheme === "system") &&
    isBoolean(value.reducedMotion)
  );
}

function parseEnvironment(
  value: DynamicRecord,
  current: BrowserEnvironment,
  bounds: BrowserBounds,
): BrowserEnvironment {
  const preset = optionalEnum(value, "preset", ["fill", "desktop", "tablet", "mobile", "custom"] as const);
  const presetSize = presetDimensions(preset);
  const explicitScale = value.deviceScaleFactor !== undefined;
  const scaleConvertsFill =
    explicitScale && (preset === "fill" || (preset === undefined && current.viewport.mode === "fill"));
  const requestedWidth =
    optionalNumber(value, "width") ??
    presetSize?.width ??
    (preset === "fill" || scaleConvertsFill ? bounds.width : current.viewport.width);
  const requestedHeight =
    optionalNumber(value, "height") ??
    presetSize?.height ??
    (preset === "fill" || scaleConvertsFill ? bounds.height : current.viewport.height);
  const width = Math.round(requestedWidth);
  const height = Math.round(requestedHeight);
  const mode =
    preset === "fill" && !explicitScale
      ? "fill"
      : preset || value.width !== undefined || value.height !== undefined || explicitScale
        ? "custom"
        : current.viewport.mode;
  const minimumWidth = mode === "fill" ? 1 : 320;
  const minimumHeight = mode === "fill" ? 1 : 240;
  if (
    width < minimumWidth ||
    width > INPUT_LIMITS.browserDimension ||
    height < minimumHeight ||
    height > INPUT_LIMITS.browserDimension
  ) {
    throw new Error("Viewport dimensions are outside the supported range.");
  }
  const scale = optionalNumber(value, "deviceScaleFactor") ?? presetSize?.scale ?? current.viewport.deviceScaleFactor;
  if (scale < 0.5 || scale > 4) throw new Error("deviceScaleFactor must be between 0.5 and 4.");
  if (!isSafeViewportSize(width, height, scale)) {
    throw new Error(`The physical viewport must not exceed ${MAX_PHYSICAL_VIEWPORT_PIXELS.toLocaleString()} pixels.`);
  }
  const resolvedPreset =
    preset === "desktop" || preset === "tablet" || preset === "mobile"
      ? preset
      : preset === "custom" || preset === "fill"
        ? null
        : current.viewport.preset;
  return {
    viewport: {
      mode,
      width,
      height,
      deviceScaleFactor: scale,
      preset: resolvedPreset,
    },
    colorScheme: optionalEnum(value, "colorScheme", ["light", "dark", "system"] as const) ?? current.colorScheme,
    reducedMotion: value.reducedMotion === undefined ? current.reducedMotion : requiredBoolean(value, "reducedMotion"),
  };
}

function isSafeViewportSize(width: number, height: number, deviceScaleFactor: number): boolean {
  return width * height * deviceScaleFactor * deviceScaleFactor <= MAX_PHYSICAL_VIEWPORT_PIXELS;
}

function boundedCaptureDataUrl(image: NativeImage): string {
  const size = image.getSize();
  if (size.width <= 0 || size.height <= 0) throw new Error("Browser screenshot is empty.");
  const area = size.width * size.height;
  if (area <= MAX_ENCODED_CAPTURE_PIXELS) return image.toDataURL();
  const scale = Math.sqrt(MAX_ENCODED_CAPTURE_PIXELS / area);
  return image
    .resize({
      width: Math.max(1, Math.floor(size.width * scale)),
      height: Math.max(1, Math.floor(size.height * scale)),
      quality: "good",
    })
    .toDataURL();
}

function parseTarget(value: unknown): BrowserTarget {
  const parsed = browserTargetSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid browser target: ${parsed.error.issues[0]?.message ?? "unknown error"}`);
  return parsed.data;
}

function describeBrowserTarget(target: BrowserTarget): string {
  switch (target.kind) {
    case "ref":
      return `ref ${target.ref}@${target.revision}`;
    case "role":
      return `${target.role}${target.name ? ` “${target.name}”` : ""}`;
    case "text":
      return `text “${target.text}”`;
    case "css":
      return `css ${target.selector}`;
    case "point":
      return `point ${target.x},${target.y}`;
  }
}

function parseImageMode(value: unknown): BrowserImageMode {
  return value === undefined
    ? "auto"
    : (optionalEnum({ value }, "value", ["auto", "always", "never"] as const) ?? "auto");
}

function readTimeout(value: DynamicRecord, maximum = 30_000): number {
  const timeout = optionalNumber(value, "timeoutMs") ?? Math.min(maximum, 10_000);
  if (!Number.isInteger(timeout) || timeout < 0 || timeout > maximum)
    throw new Error(`timeoutMs must be between 0 and ${maximum}.`);
  return Math.max(1, timeout);
}

function optionalString(value: DynamicRecord, key: string, maxLength: number): string | undefined {
  if (value[key] === undefined) return undefined;
  return requiredString(value, key, maxLength);
}

function stringValue(value: DynamicRecord, key: string, maxLength: number): string {
  const raw = value[key];
  if (!isString(raw)) throw new Error(`${key} must be a string.`);
  if (raw.length > maxLength) throw new Error(`${key} is too long.`);
  return raw;
}

function optionalNumber(value: DynamicRecord, key: string): number | undefined {
  if (value[key] === undefined) return undefined;
  return requiredNumber(value, key);
}

function requiredBoolean(value: DynamicRecord, key: string): boolean {
  if (!isBoolean(value[key])) throw new Error(`${key} must be a boolean.`);
  return value[key];
}

function optionalEnum<const T extends readonly string[]>(
  value: DynamicRecord,
  key: string,
  options: T,
): T[number] | undefined {
  const raw = value[key];
  if (raw === undefined) return undefined;
  if (!isString(raw)) throw new Error(`${key} must be one of: ${options.join(", ")}.`);
  const match = options.find((option) => option === raw);
  if (match === undefined) throw new Error(`${key} must be one of: ${options.join(", ")}.`);
  return match;
}

function presetDimensions(preset: "fill" | "desktop" | "tablet" | "mobile" | "custom" | undefined) {
  switch (preset) {
    case "desktop":
      return { width: 1440, height: 900, scale: 1 };
    case "tablet":
      return { width: 820, height: 1180, scale: 2 };
    case "mobile":
      return { width: 390, height: 844, scale: 3 };
    default:
      return null;
  }
}

function requiredStringArray(value: DynamicRecord, key: string, maximum: number, maxLength: number): string[] {
  const raw = value[key];
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > maximum)
    throw new Error(`${key} must contain between 1 and ${maximum} strings.`);
  return raw.map((entry) => {
    if (!isString(entry) || !entry || entry.length > maxLength) throw new Error(`${key} contains an invalid string.`);
    return entry;
  });
}

function optionalStringArray(value: DynamicRecord, key: string, maximum: number): string[] | undefined {
  if (value[key] === undefined) return undefined;
  return requiredStringArray(value, key, maximum, 64);
}

function navigateHistory(
  contents: WebContents,
  direction: BrowserNavigationDirection,
  sessionUserAgent: string,
): boolean {
  const history = contents.navigationHistory;
  const offset = direction === "back" ? -1 : 1;
  if (!history.canGoToOffset(offset)) return false;
  const entry = history.getEntryAtIndex(history.getActiveIndex() + offset);
  if (!entry?.url) return false;
  contents.setUserAgent(embeddedBrowserUserAgentForUrl(sessionUserAgent, entry.url));
  history.goToOffset(offset);
  return true;
}

async function navigateAndWait(
  contents: WebContents,
  initiate: () => boolean | Promise<unknown>,
  timeoutMs = 10_000,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let started = false;
    let inPlace = false;
    let settled = false;
    let timedOut = false;
    let initiationPending = false;
    let timer: NodeJS.Timeout;
    const cleanup = () => {
      clearTimeout(timer);
      contents.off("did-start-navigation", didStartNavigation);
      contents.off("did-stop-loading", didStopLoading);
      contents.off("did-navigate-in-page", didNavigateInPage);
      contents.off("did-fail-load", didFailLoad);
      contents.off("destroyed", destroyed);
    };
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const complete = () => {
      finish(timedOut ? new Error("Navigation timed out.") : undefined);
    };
    const didStartNavigation = (_event: unknown, _url: string, isInPlace: boolean, isMainFrame: boolean) => {
      if (!isMainFrame) return;
      started = true;
      inPlace = isInPlace;
    };
    const didStopLoading = () => {
      if (started && !inPlace) complete();
    };
    const didNavigateInPage = (_event: unknown, _url: string, isMainFrame: boolean) => {
      if (started && inPlace && isMainFrame) complete();
    };
    const didFailLoad = (_event: unknown, code: number, description: string, _url: string, isMainFrame: boolean) => {
      if (!started || !isMainFrame) return;
      finish(timedOut ? new Error("Navigation timed out.") : new Error(`Navigation failed (${code}): ${description}`));
    };
    const destroyed = () => {
      finish(new Error("Browser tab was closed during navigation."));
    };
    contents.on("did-start-navigation", didStartNavigation);
    contents.on("did-stop-loading", didStopLoading);
    contents.on("did-navigate-in-page", didNavigateInPage);
    contents.on("did-fail-load", didFailLoad);
    contents.once("destroyed", destroyed);
    timer = setTimeout(() => {
      timedOut = true;
      try {
        const navigationWasActive = started || contents.isLoading();
        contents.stop();
        if (!navigationWasActive && !initiationPending) complete();
      } catch (error) {
        finish(error);
      }
    }, timeoutMs);
    timer.unref();
    try {
      const initiation = initiate();
      if (initiation === false) {
        complete();
      } else if (initiation !== true) {
        initiationPending = true;
        void initiation.then(
          () => {
            initiationPending = false;
            if (!contents.isLoading()) complete();
          },
          (error) => {
            initiationPending = false;
            finish(timedOut ? new Error("Navigation timed out.") : error);
          },
        );
      }
    } catch (error) {
      finish(error);
    }
  });
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

function textResult(value: unknown): DynamicToolResult {
  return {
    success: true,
    contentItems: [{ type: "inputText", text: JSON.stringify(value) }],
  };
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

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && /timed out/i.test(error.message);
}

function remainingTime(deadline: number, message: string): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(message);
  return remaining;
}
