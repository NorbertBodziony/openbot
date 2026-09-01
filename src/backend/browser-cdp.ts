import { stat } from "node:fs/promises";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type {
  BrowserActionHistoryEntry,
  BrowserDiagnosticEntry,
  BrowserElement,
  BrowserEnvironment,
  BrowserSnapshot,
  BrowserTarget,
} from "@openbot/contracts/ipc";
import { type DynamicRecord, isBoolean, isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import type { WebContents } from "electron";

const ACTION_TIMEOUT_MS = 10_000;
const WAIT_TIMEOUT_MS = 30_000;
const MAX_RESULT_BYTES = 64 * 1024;
const AUTOMATION_WORLD_NAME = "openbot-browser-automation";
const DOCUMENT_ID_PROPERTY = "__openbot_browser_document_id__";
const MAX_SNAPSHOT_FRAMES = 12;
const MAX_SNAPSHOT_ELEMENTS = 200;
const MAX_SNAPSHOT_TEXT = 100_000;
const MAX_SNAPSHOT_SCANNED_NODES = 10_000;
const MAX_SNAPSHOT_ELEMENT_VALUE = 2_000;
const MAX_SERIALIZED_SNAPSHOT_BYTES = 1024 * 1024;
const ACTIONABLE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
]);

type CdpResult = DynamicRecord;

interface TargetRecord {
  backendNodeId: number;
  targetId?: string;
  element: BrowserElement;
}

interface SnapshotTarget {
  sessionId?: string;
  targetId?: string;
  url?: string;
}

export interface SnapshotReadResult {
  snapshot: BrowserSnapshot;
  recommendImage: boolean;
  imageReason: string;
}

export interface BrowserUploadAssignment {
  inputId: string;
  documentId: string;
}

export interface SnapshotContext {
  tabId: string;
  revision: number;
  environment: BrowserEnvironment;
  diagnostics: BrowserDiagnosticEntry[];
  actions: BrowserActionHistoryEntry[];
}

export class BrowserCdpEngine {
  readonly #contents: WebContents;
  #targets = new Map<string, TargetRecord>();
  #lastSnapshot: BrowserSnapshot | null = null;
  #environment: BrowserEnvironment | null = null;
  #navigationGeneration = 0;
  #retainDebugger = false;
  #ownsDebugger = false;
  #highlightSessionId: string | undefined;
  readonly #uploadDocumentIds = new Set<string>();
  readonly #targetSessions = new Map<string, { sessionId: string; url: string }>();

  constructor(contents: WebContents) {
    this.#contents = contents;
    contents.on("did-start-navigation", () => {
      this.#navigationGeneration += 1;
      this.#targets.clear();
      this.#lastSnapshot = null;
    });
    contents.debugger.on("message", (_event, method, params, sessionId) => {
      if (method === "Target.attachedToTarget" && isRecord(params)) {
        const attachedSessionId = stringValue(params.sessionId) || sessionId || "";
        const targetInfo = recordValue(params.targetInfo);
        const targetId = stringValue(targetInfo?.targetId);
        if (
          attachedSessionId &&
          targetId &&
          (this.#targetSessions.has(targetId) || this.#targetSessions.size < MAX_SNAPSHOT_FRAMES - 1)
        ) {
          this.#targetSessions.set(targetId, { sessionId: attachedSessionId, url: stringValue(targetInfo?.url) });
        }
      }
      if (method === "Target.detachedFromTarget" && isRecord(params)) {
        const detached = stringValue(params.sessionId);
        for (const [targetId, target] of this.#targetSessions) {
          if (target.sessionId === detached) this.#targetSessions.delete(targetId);
        }
      }
    });
    contents.debugger.on("detach", () => this.#clearDebuggerSessions());
  }

  async snapshot(context: SnapshotContext): Promise<SnapshotReadResult> {
    return this.#lease(async (send) => {
      const navigationGeneration = this.#navigationGeneration;
      const [metrics, parsed] = await Promise.all([
        send("Page.getLayoutMetrics"),
        collectBoundedSnapshot(send, this.#snapshotTargets(), context.revision, true),
      ]);
      if (navigationGeneration !== this.#navigationGeneration) {
        throw new Error("Page navigated during the browser snapshot. Take a fresh snapshot.");
      }
      const viewport = readViewport(metrics, context.environment);
      const snapshot: BrowserSnapshot = {
        tabId: context.tabId,
        revision: context.revision,
        title: this.#contents.getTitle().slice(0, 500),
        url: this.#contents.getURL(),
        loading: this.#contents.isLoading(),
        viewport,
        text: parsed.text,
        elements: parsed.elements,
        diagnostics: context.diagnostics,
        actions: context.actions,
      };
      boundSerializedSnapshot(snapshot);
      const retainedRefs = new Set(snapshot.elements.map((element) => element.ref));
      this.#targets = new Map([...parsed.targets].filter(([ref]) => retainedRefs.has(ref)));
      this.#lastSnapshot = snapshot;
      const lowCoverage = parsed.elements.length < 3 && parsed.text.length > 200;
      const recommendImage = parsed.hasVisualSurface || parsed.hasFrame || lowCoverage;
      const imageReason = parsed.hasVisualSurface
        ? "canvas-or-video"
        : parsed.hasFrame
          ? "iframe"
          : "low-semantic-coverage";
      return { snapshot, recommendImage, imageReason };
    });
  }

  async click(
    target: BrowserTarget,
    options: { button?: "left" | "middle" | "right"; clickCount?: number; modifiers?: string[] } = {},
  ): Promise<void> {
    await this.#lease(async (send) => {
      const point = await this.#targetPoint(send, target, true);
      const { sessionId, ...coordinates } = point;
      const button = options.button ?? "left";
      const clickCount = options.clickCount ?? 1;
      const modifiers = modifierMask(options.modifiers ?? []);
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...coordinates, modifiers }, sessionId);
      await send(
        "Input.dispatchMouseEvent",
        { type: "mousePressed", ...coordinates, button, clickCount, modifiers },
        sessionId,
      );
      await send(
        "Input.dispatchMouseEvent",
        { type: "mouseReleased", ...coordinates, button, clickCount, modifiers },
        sessionId,
      );
    });
  }

  async hover(target: BrowserTarget): Promise<void> {
    await this.#lease(async (send) => {
      const point = await this.#targetPoint(send, target, false);
      const { sessionId, ...coordinates } = point;
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...coordinates }, sessionId);
    });
  }

  async type(target: BrowserTarget, text: string, mode: "replace" | "append" = "replace"): Promise<void> {
    await this.#lease(async (send) => {
      const resolved = await this.#resolveTarget(send, target);
      if (!resolved.backendNodeId) throw new Error("Typing requires an element target.");
      await send("DOM.focus", { backendNodeId: resolved.backendNodeId }, resolved.sessionId);
      const useEndKey = await this.#callOnNode(
        send,
        resolved.backendNodeId,
        `function(mode) {
          if (!('value' in this) && !this.isContentEditable) throw new Error('Target does not accept text.');
          if (mode === 'replace') {
            if ('select' in this && typeof this.select === 'function') this.select();
            else {
              const selection = this.ownerDocument.getSelection(); const range = this.ownerDocument.createRange();
              range.selectNodeContents(this); selection.removeAllRanges(); selection.addRange(range);
            }
          } else if ('value' in this && typeof this.setSelectionRange === 'function') {
            const selectable = this instanceof HTMLTextAreaElement ||
              (this instanceof HTMLInputElement && ['text', 'search', 'tel', 'url', 'password'].includes(this.type));
            if (!selectable) return true;
            const end = String(this.value).length; this.setSelectionRange(end, end);
          } else if (this.isContentEditable) {
            const selection = this.ownerDocument.getSelection(); const range = this.ownerDocument.createRange();
            range.selectNodeContents(this); range.collapse(false); selection.removeAllRanges(); selection.addRange(range);
          }
          return false;
        }`,
        [mode],
        resolved.sessionId,
      );
      if (useEndKey === true) await dispatchShortcut(send, "End", resolved.sessionId);
      await send("Input.insertText", { text }, resolved.sessionId);
    });
  }

  async press(key: string, target?: BrowserTarget): Promise<void> {
    await this.#lease(async (send) => {
      let sessionId: string | undefined;
      if (target) {
        const resolved = await this.#resolveTarget(send, target);
        sessionId = resolved.sessionId;
        if (resolved.backendNodeId) await send("DOM.focus", { backendNodeId: resolved.backendNodeId }, sessionId);
      }
      await dispatchShortcut(send, key, sessionId);
    });
  }

  async scroll(target: BrowserTarget | undefined, deltaX: number, deltaY: number): Promise<void> {
    await this.#lease(async (send) => {
      if (!target) {
        await send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: 1,
          y: 1,
          deltaX: clamp(deltaX, -100_000, 100_000),
          deltaY: clamp(deltaY, -100_000, 100_000),
        });
        return;
      }
      const resolved = await this.#resolveTarget(send, target);
      if (!resolved.backendNodeId) {
        await send(
          "Input.dispatchMouseEvent",
          {
            type: "mouseWheel",
            x: resolved.x,
            y: resolved.y,
            deltaX,
            deltaY,
          },
          resolved.sessionId,
        );
        return;
      }
      await this.#callOnNode(
        send,
        resolved.backendNodeId,
        "function(x, y) { this.scrollBy({ left: x, top: y, behavior: 'instant' }); }",
        [deltaX, deltaY],
        resolved.sessionId,
      );
    });
  }

  async selectOption(target: BrowserTarget, values: string[]): Promise<void> {
    await this.#lease(async (send) => {
      const resolved = await this.#resolveElement(send, target);
      await this.#callOnNode(
        send,
        resolved.backendNodeId,
        `function(values) {
          if (!(this instanceof HTMLSelectElement)) throw new Error('Target is not a select element.');
          if (!this.multiple && values.length > 1) throw new Error('A single-select accepts only one requested value.');
          const wanted = new Set(values);
          const matched = new Set();
          const selected = new Set();
          for (const option of this.options) {
            for (const value of wanted) {
              if (value === option.value || value === option.label || value === option.text) {
                matched.add(value);
                selected.add(option);
              }
            }
          }
          if (matched.size !== wanted.size) throw new Error('One or more requested options do not exist.');
          for (const option of this.options) option.selected = selected.has(option);
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
        }`,
        [values],
        resolved.sessionId,
      );
    });
  }

  async setChecked(target: BrowserTarget, checked: boolean): Promise<void> {
    await this.#lease(async (send) => {
      const resolved = await this.#resolveElement(send, target);
      const state = await this.#callOnNode(
        send,
        resolved.backendNodeId,
        `function() {
          if (!('checked' in this)) throw new Error('Target is not checkable.');
          return {
            checked: Boolean(this.checked),
            radio: this instanceof HTMLInputElement && this.type === 'radio',
          };
        }`,
        [],
        resolved.sessionId,
      );
      if (!isDynamicRecord(state) || !isBoolean(state.checked) || !isBoolean(state.radio)) {
        throw new Error("Target returned an invalid checked state.");
      }
      if (state.radio && state.checked && !checked) {
        throw new Error("A selected radio button cannot be cleared directly. Select another radio option instead.");
      }
      if (state.checked !== checked) {
        const point = await this.#elementPoint(send, resolved.backendNodeId, true, resolved.sessionId);
        const { sessionId, ...coordinates } = point;
        await send(
          "Input.dispatchMouseEvent",
          { type: "mousePressed", ...coordinates, button: "left", clickCount: 1 },
          sessionId,
        );
        await send(
          "Input.dispatchMouseEvent",
          { type: "mouseReleased", ...coordinates, button: "left", clickCount: 1 },
          sessionId,
        );
      }
      const updated = await this.#callOnNode(
        send,
        resolved.backendNodeId,
        "function() { return Boolean(this.checked); }",
        [],
        resolved.sessionId,
      );
      if (updated !== checked) throw new Error("Target did not reach the requested checked state.");
    });
  }

  async drag(source: BrowserTarget, target: BrowserTarget): Promise<void> {
    await this.#lease(async (send) => {
      const from = await this.#targetPoint(send, source, true);
      const to = await this.#targetPoint(send, target, false);
      if (from.sessionId !== to.sessionId) throw new Error("Cross-frame drag is not supported.");
      const sessionId = from.sessionId;
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y }, sessionId);
      await send(
        "Input.dispatchMouseEvent",
        { type: "mousePressed", x: from.x, y: from.y, button: "left", clickCount: 1 },
        sessionId,
      );
      let released = false;
      try {
        for (let step = 1; step <= 8; step++) {
          await send(
            "Input.dispatchMouseEvent",
            {
              type: "mouseMoved",
              x: from.x + ((to.x - from.x) * step) / 8,
              y: from.y + ((to.y - from.y) * step) / 8,
              button: "left",
              buttons: 1,
            },
            sessionId,
          );
        }
        await send(
          "Input.dispatchMouseEvent",
          { type: "mouseReleased", x: to.x, y: to.y, button: "left", clickCount: 1 },
          sessionId,
        );
        released = true;
      } finally {
        if (!released) {
          await send(
            "Input.dispatchMouseEvent",
            { type: "mouseReleased", x: to.x, y: to.y, button: "left", clickCount: 1 },
            sessionId,
          ).catch(() => undefined);
        }
      }
    });
  }

  async resolveUploadTarget(target: BrowserTarget): Promise<BrowserUploadAssignment> {
    return this.#lease(async (send) => {
      const resolved = await this.#resolveElement(send, target);
      return this.#identifyUploadTarget(send, resolved);
    });
  }

  async uploadFiles(
    target: BrowserTarget,
    paths: string[],
    onTargetResolved?: (assignment: BrowserUploadAssignment) => void,
  ): Promise<BrowserUploadAssignment> {
    if (paths.length === 0 || paths.length > 10) throw new Error("Upload requires between 1 and 10 files.");
    if (Buffer.byteLength(JSON.stringify(paths)) > MAX_RESULT_BYTES)
      throw new Error("Upload path arguments exceed 64 KB.");
    for (const path of paths) {
      const info = await stat(path).catch(() => null);
      if (!info?.isFile()) throw new Error(`Upload file does not exist or is not a regular file: ${path}`);
    }
    return this.#lease(async (send) => {
      const resolved = await this.#resolveElement(send, target);
      const assignment = await this.#identifyUploadTarget(send, resolved);
      onTargetResolved?.(assignment);
      await send("DOM.setFileInputFiles", { backendNodeId: resolved.backendNodeId, files: paths }, resolved.sessionId);
      return assignment;
    });
  }

  async #identifyUploadTarget(
    send: SendCommand,
    resolved: { backendNodeId: number; sessionId?: string },
  ): Promise<BrowserUploadAssignment> {
    const documentId = await this.#callOnNode(
      send,
      resolved.backendNodeId,
      documentIdFunctionDeclaration(),
      [],
      resolved.sessionId,
    );
    if (!isString(documentId)) throw new Error("Unable to identify the upload document.");
    this.#uploadDocumentIds.add(documentId);
    return {
      inputId: `${documentId}:${resolved.backendNodeId}`,
      documentId,
    };
  }

  async documentIds(): Promise<Set<string>> {
    return this.#lease(async (send) => {
      const ids = new Set<string>();
      for (const capture of this.#snapshotTargets()) {
        if (ids.size === this.#uploadDocumentIds.size) break;
        const contextId = await automationContextId(send, capture.sessionId);
        const result = await send(
          "Runtime.evaluate",
          {
            expression: documentIdsExpression([...this.#uploadDocumentIds]),
            contextId,
            returnByValue: true,
          },
          capture.sessionId,
        );
        const exception = recordValue(result.exceptionDetails);
        if (exception) throw new Error(exceptionDescription(exception));
        const values = recordValue(result.result)?.value;
        if (!Array.isArray(values)) throw new Error("Browser documents returned invalid identities.");
        for (const value of values) {
          if (isString(value)) ids.add(value);
        }
      }
      for (const documentId of this.#uploadDocumentIds) {
        if (!ids.has(documentId)) this.#uploadDocumentIds.delete(documentId);
      }
      return ids;
    });
  }

  hasUploadDocuments(): boolean {
    return this.#uploadDocumentIds.size > 0;
  }

  async setEnvironment(environment: BrowserEnvironment): Promise<void> {
    const previousEnvironment = this.#environment;
    const previousRetainDebugger = this.#retainDebugger;
    this.#retainDebugger = true;
    try {
      await this.#lease(async (send) => {
        try {
          await this.#applyEnvironment(send, environment);
        } catch (error) {
          if (previousEnvironment) await this.#applyEnvironment(send, previousEnvironment);
          else await this.#clearEnvironment(send);
          throw error;
        }
      }, false);
      this.#environment = environment;
    } catch (error) {
      this.#retainDebugger = previousRetainDebugger;
      if (!this.#retainDebugger) this.#detachOwnedDebugger();
      throw error;
    }
  }

  async navigate(url: string): Promise<void> {
    await this.#lease(async (send) => {
      await send("Network.enable");
      await send("Network.setCacheDisabled", { cacheDisabled: true });
      try {
        const result = await send("Page.navigate", { url });
        const errorText = stringValue(result.errorText);
        if (errorText) throw new Error(`Navigation failed: ${errorText}`);
        await waitForLoading(this.#contents, WAIT_TIMEOUT_MS);
      } finally {
        await send("Network.setCacheDisabled", { cacheDisabled: false }).catch(() => undefined);
        await send("Network.disable").catch(() => undefined);
      }
    }, false);
  }

  destroy(): void {
    this.#retainDebugger = false;
    this.#detachOwnedDebugger();
    this.#targetSessions.clear();
    this.#targets.clear();
    this.#lastSnapshot = null;
    this.#highlightSessionId = undefined;
    this.#uploadDocumentIds.clear();
  }

  async waitFor(
    condition: { target?: BrowserTarget; text?: string; url?: string; state?: string },
    timeoutMs = WAIT_TIMEOUT_MS,
  ): Promise<void> {
    await this.#lease(async (send) => {
      const deadline = Date.now() + clamp(timeoutMs, 1, WAIT_TIMEOUT_MS);
      const matches = async () => {
        let matched = true;
        if (condition.url) matched &&= this.#contents.getURL().includes(condition.url);
        if (condition.text) {
          matched &&= await pageContainsText(send, this.#snapshotTargets(), condition.text, deadline);
        }
        if (condition.target) {
          try {
            await this.#resolveTarget(send, condition.target, deadline);
          } catch {
            matched = false;
          }
        }
        if (condition.state === "load") matched &&= !this.#contents.isLoading();
        if (condition.state === "domcontentloaded") {
          const contextId = await automationContextId(send);
          const result = await send("Runtime.evaluate", {
            expression: "document.readyState !== 'loading'",
            contextId,
            returnByValue: true,
          });
          matched &&= recordValue(result.result)?.value === true;
        }
        return matched;
      };
      while (true) {
        if (await matches()) {
          if (condition.state !== "dom-quiet") return;
          await waitForDomQuietAcrossTargets(send, this.#snapshotTargets(), deadline - Date.now());
          if (await matches()) return;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("Browser wait condition timed out.");
        await waitForPageSignal(this.#contents, Math.min(remaining, 500));
      }
    });
  }

  async settle(timeoutMs = ACTION_TIMEOUT_MS): Promise<void> {
    await this.#lease(async (send) => {
      if (this.#contents.isLoading()) await waitForLoading(this.#contents, timeoutMs);
      await waitForDomQuietAcrossTargets(send, this.#snapshotTargets(), Math.min(timeoutMs, 1_500)).catch((error) => {
        if (error instanceof Error && error.message === "DOM did not become quiet.") return;
        throw error;
      });
    });
  }

  async stopLoading(): Promise<void> {
    await stopLoadingAndWait(this.#contents);
  }

  async highlight(target: BrowserTarget): Promise<void> {
    await this.#lease(async (send) => {
      const resolved = await this.#resolveElement(send, target);
      await send("Overlay.enable", {}, resolved.sessionId);
      await send(
        "Overlay.highlightNode",
        {
          backendNodeId: resolved.backendNodeId,
          highlightConfig: {
            showInfo: false,
            contentColor: { r: 59, g: 130, b: 246, a: 0.12 },
            borderColor: { r: 59, g: 130, b: 246, a: 0.95 },
          },
        },
        resolved.sessionId,
      );
      this.#highlightSessionId = resolved.sessionId;
    });
  }

  async hideHighlight(): Promise<void> {
    const sessionId = this.#highlightSessionId;
    this.#highlightSessionId = undefined;
    await this.#lease((send) => send("Overlay.hideHighlight", {}, sessionId).then(() => undefined));
  }

  async #resolveElement(
    send: SendCommand,
    target: BrowserTarget,
  ): Promise<{ backendNodeId: number; sessionId?: string }> {
    const resolved = await this.#resolveTarget(send, target);
    if (!resolved.backendNodeId) throw new Error("This operation requires an element target, not coordinates.");
    return { backendNodeId: resolved.backendNodeId, sessionId: resolved.sessionId };
  }

  async #resolveTarget(
    send: SendCommand,
    target: BrowserTarget,
    deadline?: number,
  ): Promise<{ backendNodeId?: number; sessionId?: string; x: number; y: number }> {
    if (target.kind === "point") return { x: target.x, y: target.y };
    if (target.kind === "ref") {
      if (!this.#lastSnapshot || target.revision !== this.#lastSnapshot.revision) {
        throw new Error("Stale browser reference. Take a fresh snapshot before acting.");
      }
      const record = this.#targets.get(target.ref);
      if (!record) throw new Error("Element reference is no longer available. Take a fresh snapshot.");
      const sessionId = record.targetId ? this.#targetSessions.get(record.targetId)?.sessionId : undefined;
      if (deadline !== undefined) {
        assertBeforeDeadline(deadline);
        const visible = await this.#callOnNode(
          send,
          record.backendNodeId,
          `function() {
            if (!(this instanceof Element) || !this.isConnected || this.getClientRects().length === 0) return false;
            let element = this;
            while (element) {
              if (element.hidden || element.inert || String(element.getAttribute('aria-hidden')).toLowerCase() === 'true') return false;
              const style = getComputedStyle(element);
              if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.contentVisibility === 'hidden' || style.opacity === '0') return false;
              const parent = element.parentElement;
              if (parent) element = parent;
              else {
                const root = element.getRootNode();
                element = root?.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? root.host : null;
              }
            }
            return true;
          }`,
          [],
          sessionId,
        );
        assertBeforeDeadline(deadline);
        if (visible !== true) throw new Error("Element reference is no longer visible.");
      }
      return {
        backendNodeId: record.backendNodeId,
        sessionId,
        x: 0,
        y: 0,
      };
    }
    if (target.kind === "css") {
      const matches: Array<{ objectId: string; sessionId?: string }> = [];
      let ambiguous = false;
      try {
        for (const capture of this.#snapshotTargets()) {
          const match = await cssObjectMatch(send, target.selector, capture.sessionId);
          ambiguous ||= match.ambiguous;
          if (match.objectId) matches.push({ objectId: match.objectId, sessionId: capture.sessionId });
        }
      } catch (error) {
        await Promise.allSettled(
          matches.map((match) =>
            send("Runtime.releaseObject", { objectId: match.objectId }, match.sessionId).catch(() => undefined),
          ),
        );
        throw error;
      }
      if (ambiguous || matches.length > 1) {
        await Promise.allSettled(
          matches.map((match) =>
            send("Runtime.releaseObject", { objectId: match.objectId }, match.sessionId).catch(() => undefined),
          ),
        );
        throw new Error(`CSS selector is ambiguous (at least 2 matches): ${target.selector}`);
      }
      const match = matches[0];
      if (!match) throw new Error(`No element matches CSS selector: ${target.selector}`);
      try {
        const described = await send("DOM.describeNode", { objectId: match.objectId, depth: 0 }, match.sessionId);
        const describedNode = recordValue(described.node);
        const backendNodeId = numberValue(describedNode?.backendNodeId);
        if (!backendNodeId) throw new Error(`Unable to resolve CSS selector: ${target.selector}`);
        return {
          backendNodeId,
          sessionId: match.sessionId,
          x: 0,
          y: 0,
        };
      } finally {
        await send("Runtime.releaseObject", { objectId: match.objectId }, match.sessionId).catch(() => undefined);
      }
    }
    await this.#refreshSemanticTargets(send, deadline);
    const candidates = [...this.#targets.values()].filter(({ element }) => {
      if (target.kind === "role") {
        if (element.role?.toLowerCase() !== target.role.toLowerCase()) return false;
        if (!target.name) return true;
        return textMatches(element.name, target.name, target.exact);
      }
      return textMatches(`${element.name} ${element.description}`, target.text, target.exact);
    });
    if (candidates.length === 0) throw new Error(`No element matches ${describeTarget(target)}.`);
    if (candidates.length > 1) {
      const sample = candidates
        .slice(0, 5)
        .map(({ element }) => `${element.ref} ${element.role ?? element.tag} “${element.name.slice(0, 80)}”`)
        .join("; ");
      throw new Error(`Target is ambiguous (${candidates.length} matches). Candidates: ${sample}`);
    }
    return {
      backendNodeId: candidates[0].backendNodeId,
      sessionId: candidates[0].targetId ? this.#targetSessions.get(candidates[0].targetId)?.sessionId : undefined,
      x: 0,
      y: 0,
    };
  }

  async #targetPoint(
    send: SendCommand,
    target: BrowserTarget,
    hitTest: boolean,
  ): Promise<{ x: number; y: number; sessionId?: string }> {
    const resolved = await this.#resolveTarget(send, target);
    if (!resolved.backendNodeId) return { x: resolved.x, y: resolved.y };
    return this.#elementPoint(send, resolved.backendNodeId, hitTest, resolved.sessionId);
  }

  async #elementPoint(
    send: SendCommand,
    backendNodeId: number,
    hitTest: boolean,
    sessionId?: string,
  ): Promise<{ x: number; y: number; sessionId?: string }> {
    await send("DOM.scrollIntoViewIfNeeded", { backendNodeId }, sessionId);
    const box = await send("DOM.getBoxModel", { backendNodeId }, sessionId);
    const model = recordValue(box.model);
    const quad = Array.isArray(model?.content) ? model.content.filter(isFiniteNumber) : [];
    if (quad.length < 8) throw new Error("Element has no visible clickable bounds.");
    const metrics = await send("Page.getLayoutMetrics", {}, sessionId);
    const viewport = recordValue(metrics.cssLayoutViewport);
    const viewportWidth = numberValue(viewport?.clientWidth);
    const viewportHeight = numberValue(viewport?.clientHeight);
    const xs = [quad[0], quad[2], quad[4], quad[6]];
    const ys = [quad[1], quad[3], quad[5], quad[7]];
    const left = Math.max(0, Math.min(...xs));
    const right = Math.min(viewportWidth - 1, Math.max(...xs));
    const top = Math.max(0, Math.min(...ys));
    const bottom = Math.min(viewportHeight - 1, Math.max(...ys));
    if (viewportWidth <= 0 || viewportHeight <= 0 || right < left || bottom < top) {
      throw new Error("Element has no visible clickable bounds.");
    }
    const insetX = Math.min(4, Math.max(0, (right - left) / 4));
    const insetY = Math.min(4, Math.max(0, (bottom - top) / 4));
    const points = uniquePoints([
      { x: (left + right) / 2, y: (top + bottom) / 2 },
      { x: left + insetX, y: top + insetY },
      { x: right - insetX, y: top + insetY },
      { x: left + insetX, y: bottom - insetY },
      { x: right - insetX, y: bottom - insetY },
    ]);
    if (!hitTest) return { ...points[0], sessionId };
    let blockerId = 0;
    for (const point of points) {
      const hit = await send(
        "DOM.getNodeForLocation",
        { x: Math.round(point.x), y: Math.round(point.y), includeUserAgentShadowDOM: true },
        sessionId,
      );
      const hitId = numberValue(hit.backendNodeId);
      if (hitId && (await isNodeOrDescendant(send, hitId, backendNodeId, sessionId))) {
        return { ...point, sessionId };
      }
      blockerId ||= hitId;
    }
    if (!blockerId) throw new Error("Element has no visible clickable point.");
    const blocker = await send("DOM.describeNode", { backendNodeId: blockerId, depth: 0 }, sessionId);
    const node = recordValue(blocker.node);
    const name = stringValue(node?.nodeName).toLowerCase() || "element";
    throw new Error(
      `Target is covered by ${name} (backendNodeId ${blockerId}). Dismiss the covering layer or choose a visible point.`,
    );
  }

  async #callOnNode(
    send: SendCommand,
    backendNodeId: number,
    declaration: string,
    args: unknown[],
    sessionId?: string,
  ): Promise<unknown> {
    const executionContextId = await automationContextId(send, sessionId);
    const resolved = await send("DOM.resolveNode", { backendNodeId, executionContextId }, sessionId);
    const objectId = stringValue(recordValue(resolved.object)?.objectId);
    if (!objectId) throw new Error("Element is no longer attached to the document.");
    try {
      const result = await send(
        "Runtime.callFunctionOn",
        {
          objectId,
          functionDeclaration: declaration,
          arguments: args.map((value) => ({ value })),
          awaitPromise: true,
          returnByValue: true,
          userGesture: true,
        },
        sessionId,
      );
      const exception = recordValue(result.exceptionDetails);
      if (exception) throw new Error(exceptionDescription(exception));
      return recordValue(result.result)?.value;
    } finally {
      await send("Runtime.releaseObject", { objectId }, sessionId).catch(() => undefined);
    }
  }

  async #refreshSemanticTargets(send: SendCommand, deadline?: number): Promise<void> {
    const navigationGeneration = this.#navigationGeneration;
    const parsed = await collectBoundedSnapshot(
      send,
      this.#snapshotTargets(),
      this.#lastSnapshot?.revision ?? 0,
      false,
      deadline,
    );
    if (navigationGeneration !== this.#navigationGeneration) {
      throw new Error("Page navigated during semantic target collection. Take a fresh snapshot.");
    }
    this.#targets = parsed.targets;
  }

  #snapshotTargets(): SnapshotTarget[] {
    return [
      {},
      ...[...this.#targetSessions.entries()]
        .slice(0, MAX_SNAPSHOT_FRAMES - 1)
        .map(([targetId, target]) => ({ ...target, targetId })),
    ];
  }

  async #lease<T>(operation: (send: SendCommand) => Promise<T>, attachFrames = true): Promise<T> {
    if (this.#contents.isDestroyed()) throw new Error("Browser tab was closed.");
    const attachedHere = !this.#contents.debugger.isAttached();
    if (attachedHere) {
      this.#contents.debugger.attach("1.3");
      this.#ownsDebugger = true;
    }
    const send: SendCommand = async (method, params = {}, sessionId) => {
      const result = await this.#contents.debugger.sendCommand(method, params, sessionId);
      if (!isDynamicRecord(result)) throw new Error(`CDP ${method} returned an invalid result.`);
      return result;
    };
    try {
      await send("Emulation.setFocusEmulationEnabled", { enabled: true });
      if (attachFrames) {
        await send("Target.setAutoAttach", {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
          filter: [{ type: "iframe", exclude: false }],
        }).catch(() => undefined);
      }
      if (this.#environment) await this.#applyEnvironment(send, this.#environment);
      return await operation(send);
    } finally {
      if (attachedHere && !this.#retainDebugger) this.#detachOwnedDebugger();
    }
  }

  #detachOwnedDebugger(): void {
    if (!this.#ownsDebugger) return;
    this.#ownsDebugger = false;
    this.#clearDebuggerSessions();
    if (this.#contents.isDestroyed() || !this.#contents.debugger.isAttached()) return;
    this.#contents.debugger.detach();
  }

  #clearDebuggerSessions(): void {
    this.#targetSessions.clear();
    this.#highlightSessionId = undefined;
  }

  async #applyEnvironment(send: SendCommand, environment: BrowserEnvironment): Promise<void> {
    if (environment.viewport.mode === "fill") {
      await send("Emulation.clearDeviceMetricsOverride");
    } else {
      await send("Emulation.setDeviceMetricsOverride", {
        width: environment.viewport.width,
        height: environment.viewport.height,
        deviceScaleFactor: environment.viewport.deviceScaleFactor,
        // Viewport presets deliberately do not alter browser identity or mobile page semantics.
        mobile: false,
        screenWidth: environment.viewport.width,
        screenHeight: environment.viewport.height,
      });
    }
    const features: Array<{ name: string; value: string }> = [];
    if (environment.colorScheme !== "system") {
      features.push({ name: "prefers-color-scheme", value: environment.colorScheme });
    }
    if (environment.reducedMotion) features.push({ name: "prefers-reduced-motion", value: "reduce" });
    await send("Emulation.setEmulatedMedia", { features });
  }

  async #clearEnvironment(send: SendCommand): Promise<void> {
    await send("Emulation.clearDeviceMetricsOverride");
    await send("Emulation.setEmulatedMedia", { features: [] });
  }
}

type SendCommand = (method: string, params?: DynamicRecord, sessionId?: string) => Promise<CdpResult>;

async function collectBoundedSnapshot(
  send: SendCommand,
  captures: SnapshotTarget[],
  revision: number,
  includeText: boolean,
  deadline?: number,
) {
  const targets = new Map<string, TargetRecord>();
  const elements: BrowserElement[] = [];
  const textParts: string[] = [];
  let textLength = 0;
  let hasVisualSurface = false;
  let hasFrame = captures.length > 1;
  for (const capture of captures) {
    assertBeforeDeadline(deadline);
    if (includeText) {
      const remainingText = Math.max(0, MAX_SNAPSHOT_TEXT - textLength);
      const summary = await collectPageSummary(send, capture.sessionId, remainingText).catch(() => null);
      if (summary) {
        if (summary.text) {
          textParts.push(summary.text);
          textLength += summary.text.length;
        }
        hasVisualSurface ||= summary.hasVisualSurface;
        hasFrame ||= summary.hasFrame;
      }
    }
    const remainingElements = MAX_SNAPSHOT_ELEMENTS - elements.length;
    if (remainingElements <= 0) break;
    const candidates =
      capture.sessionId && deadline === undefined
        ? await collectActionableNodes(send, capture, remainingElements).catch(() => [])
        : await collectActionableNodes(send, capture, remainingElements, deadline);
    for (const candidate of candidates) {
      const properties = Array.isArray(candidate.ax.properties) ? candidate.ax.properties.filter(isRecord) : [];
      const states = properties
        .filter((property) =>
          ["checked", "disabled", "expanded", "focused", "pressed", "readonly", "required", "selected"].includes(
            stringValue(property.name),
          ),
        )
        .map((property) => `${stringValue(property.name)}:${axValue(property.value)}`);
      const frameId = stringValue(candidate.node.frameId) || capture.targetId || "";
      const ref = `${revision}:${capture.targetId ?? "main"}:${candidate.backendNodeId}`;
      const element: BrowserElement = {
        ref,
        role: candidate.role,
        name: axValue(candidate.ax.name).slice(0, 500),
        description: axValue(candidate.ax.description).slice(0, 500),
        tag: (stringValue(candidate.node.localName) || stringValue(candidate.node.nodeName)).toLowerCase(),
        value: axValue(candidate.ax.value).slice(0, MAX_SNAPSHOT_ELEMENT_VALUE) || null,
        states,
        disabled: states.includes("disabled:true"),
        bounds: null,
        frame: frameId ? { id: frameId, url: redactedMetadataUrl(capture.url) } : null,
      };
      elements.push(element);
      targets.set(ref, { backendNodeId: candidate.backendNodeId, targetId: capture.targetId, element });
      if (elements.length >= MAX_SNAPSHOT_ELEMENTS) break;
    }
  }
  return {
    targets,
    elements,
    text: textParts.join(" ").replace(/\s+/g, " ").trim().slice(0, MAX_SNAPSHOT_TEXT),
    hasVisualSurface,
    hasFrame,
  };
}

async function collectPageSummary(
  send: SendCommand,
  sessionId: string | undefined,
  maxText: number,
): Promise<{ text: string; hasVisualSurface: boolean; hasFrame: boolean }> {
  const contextId = await automationContextId(send, sessionId);
  const result = await send(
    "Runtime.evaluate",
    {
      expression: `(() => {
        const maxNodes = ${MAX_SNAPSHOT_SCANNED_NODES};
        const maxText = ${maxText};
        const roots = [document];
        const seen = new Set();
        const text = [];
        let chars = 0;
        let scanned = 0;
        let hasVisualSurface = false;
        let hasFrame = false;
        const isVisibleText = node => {
          let element = node.parentElement;
          while (element) {
            if (element.hidden || element.inert || String(element.getAttribute('aria-hidden')).toLowerCase() === 'true') return false;
            const style = getComputedStyle(element);
            if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.contentVisibility === 'hidden' || style.opacity === '0') return false;
            const parent = element.parentElement;
            if (parent) element = parent;
            else {
              const root = element.getRootNode();
              element = root?.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? root.host : null;
            }
          }
          const range = node.ownerDocument.createRange();
          range.selectNodeContents(node);
          return range.getClientRects().length > 0;
        };
        while (roots.length && scanned < maxNodes) {
          const root = roots.shift();
          if (!root || seen.has(root)) continue;
          seen.add(root);
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
          let node;
          while ((node = walker.nextNode()) && scanned < maxNodes) {
            scanned++;
            if (node.nodeType === Node.TEXT_NODE && chars < maxText) {
              const parentTag = node.parentElement?.localName;
              if (parentTag === 'script' || parentTag === 'style' || parentTag === 'noscript' || parentTag === 'template') continue;
              if (!isVisibleText(node)) continue;
              const value = String(node.nodeValue || '').replace(/\\s+/g, ' ').trim();
              if (value) {
                const part = value.slice(0, Math.max(0, maxText - chars));
                text.push(part);
                chars += part.length + 1;
              }
              continue;
            }
            if (!(node instanceof Element)) continue;
            const tag = node.localName;
            if (tag === 'canvas' || tag === 'video') hasVisualSurface = true;
            if (tag === 'iframe' || tag === 'frame') {
              hasFrame = true;
              try { if (node.contentDocument) roots.push(node.contentDocument); } catch {}
            }
            if (node.shadowRoot) roots.push(node.shadowRoot);
          }
        }
        return { text: text.join(' '), hasVisualSurface, hasFrame };
      })()`,
      contextId,
      returnByValue: true,
    },
    sessionId,
  );
  const value = recordValue(recordValue(result.result)?.value);
  return {
    text: stringValue(value?.text),
    hasVisualSurface: value?.hasVisualSurface === true,
    hasFrame: value?.hasFrame === true,
  };
}

async function pageContainsText(
  send: SendCommand,
  captures: SnapshotTarget[],
  text: string,
  deadline: number,
): Promise<boolean> {
  for (const capture of captures) {
    assertBeforeDeadline(deadline);
    const scanBudgetMs = Math.max(1, deadline - Date.now());
    const contextId = await automationContextId(send, capture.sessionId);
    const result = await send(
      "Runtime.evaluate",
      {
        expression: `(() => {
          const needle = ${JSON.stringify(text)};
          const scanDeadline = performance.now() + ${scanBudgetMs};
          const roots = [document];
          const seen = new Set();
          let combined = '';
          let chars = 0;
          let scanned = 0;
          const isVisibleText = node => {
            let element = node.parentElement;
            while (element) {
              if (element.hidden || element.inert || String(element.getAttribute('aria-hidden')).toLowerCase() === 'true') return false;
              const style = getComputedStyle(element);
              if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.contentVisibility === 'hidden' || style.opacity === '0') return false;
              const parent = element.parentElement;
              if (parent) element = parent;
              else {
                const root = element.getRootNode();
                element = root?.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? root.host : null;
              }
            }
            const range = node.ownerDocument.createRange();
            range.selectNodeContents(node);
            return range.getClientRects().length > 0;
          };
          while (roots.length && scanned < ${MAX_SNAPSHOT_SCANNED_NODES} && chars < ${MAX_SNAPSHOT_TEXT}) {
            if (performance.now() >= scanDeadline) return { matched: false, expired: true };
            const root = roots.shift();
            if (!root || seen.has(root)) continue;
            seen.add(root);
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode()) && scanned < ${MAX_SNAPSHOT_SCANNED_NODES}) {
              if (performance.now() >= scanDeadline) return { matched: false, expired: true };
              scanned++;
              if (node.nodeType === Node.TEXT_NODE) {
                const parentTag = node.parentElement?.localName;
                if (parentTag === 'script' || parentTag === 'style' || parentTag === 'noscript' || parentTag === 'template') continue;
                if (!isVisibleText(node)) continue;
                const value = String(node.nodeValue || '').replace(/\\s+/g, ' ').trim();
                if (value) {
                  const part = value.slice(0, Math.max(0, ${MAX_SNAPSHOT_TEXT} - chars));
                  combined += (combined ? ' ' : '') + part;
                  chars += part.length + 1;
                  if (combined.includes(needle)) return { matched: true, expired: false };
                }
                continue;
              }
              if (!(node instanceof Element)) continue;
              if ((node.localName === 'iframe' || node.localName === 'frame')) {
                try { if (node.contentDocument) roots.push(node.contentDocument); } catch {}
              }
              if (node.shadowRoot) roots.push(node.shadowRoot);
            }
          }
          return { matched: combined.includes(needle), expired: false };
        })()`,
        contextId,
        returnByValue: true,
      },
      capture.sessionId,
    ).catch(() => null);
    assertBeforeDeadline(deadline);
    const value = recordValue(recordValue(result?.result)?.value);
    if (value?.expired === true) throw new Error("Browser wait condition timed out.");
    if (value?.matched === true) return true;
  }
  return false;
}

async function cssObjectMatch(
  send: SendCommand,
  selector: string,
  sessionId?: string,
): Promise<{ objectId?: string; ambiguous: boolean }> {
  const contextId = await automationContextId(send, sessionId);
  const collection = await send(
    "Runtime.evaluate",
    {
      expression: `(() => {
        const selector = ${JSON.stringify(selector)};
        const roots = [document];
        const seen = new Set();
        const matches = [];
        let scanned = 0;
        while (roots.length && scanned < ${MAX_SNAPSHOT_SCANNED_NODES} && matches.length < 2) {
          const root = roots.shift();
          if (!root || seen.has(root)) continue;
          seen.add(root);
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
          let node;
          while ((node = walker.nextNode()) && scanned < ${MAX_SNAPSHOT_SCANNED_NODES} && matches.length < 2) {
            scanned++;
            if (node.matches(selector)) matches.push(node);
            if (node.localName === 'iframe' || node.localName === 'frame') {
              try { if (node.contentDocument) roots.push(node.contentDocument); } catch {}
            }
            if (node.shadowRoot) roots.push(node.shadowRoot);
          }
        }
        return matches;
      })()`,
      contextId,
      returnByValue: false,
    },
    sessionId,
  );
  const exception = recordValue(collection.exceptionDetails);
  if (exception) throw new Error(exceptionDescription(exception));
  const collectionId = stringValue(recordValue(collection.result)?.objectId);
  if (!collectionId) return { ambiguous: false };
  try {
    const lengthResult = await send(
      "Runtime.callFunctionOn",
      {
        objectId: collectionId,
        functionDeclaration: "function() { return this.length; }",
        returnByValue: true,
      },
      sessionId,
    );
    const length = numberValue(recordValue(lengthResult.result)?.value);
    if (length === 0) return { ambiguous: false };
    if (length > 1) return { ambiguous: true };
    const element = await send(
      "Runtime.callFunctionOn",
      {
        objectId: collectionId,
        functionDeclaration: "function() { return this[0]; }",
        returnByValue: false,
      },
      sessionId,
    );
    const objectId = stringValue(recordValue(element.result)?.objectId);
    if (!objectId) throw new Error(`Unable to resolve CSS selector: ${selector}`);
    return { objectId, ambiguous: false };
  } finally {
    await send("Runtime.releaseObject", { objectId: collectionId }, sessionId).catch(() => undefined);
  }
}

async function collectActionableNodes(
  send: SendCommand,
  capture: SnapshotTarget,
  limit: number,
  deadline?: number,
): Promise<Array<{ backendNodeId: number; node: CdpResult; ax: CdpResult; role: string }>> {
  assertBeforeDeadline(deadline);
  await Promise.all([send("DOM.enable", {}, capture.sessionId), send("Accessibility.enable", {}, capture.sessionId)]);
  assertBeforeDeadline(deadline);
  const contextId = await automationContextId(send, capture.sessionId);
  const collection = await send(
    "Runtime.evaluate",
    {
      expression: actionableNodesExpression(limit),
      contextId,
      returnByValue: false,
    },
    capture.sessionId,
  );
  const exception = recordValue(collection.exceptionDetails);
  if (exception) throw new Error(exceptionDescription(exception));
  const collectionId = stringValue(recordValue(collection.result)?.objectId);
  if (!collectionId) return [];
  const objectIds: string[] = [];
  try {
    const properties = await send(
      "Runtime.getProperties",
      { objectId: collectionId, ownProperties: true },
      capture.sessionId,
    );
    const descriptors = Array.isArray(properties.result) ? properties.result.filter(isRecord) : [];
    objectIds.push(
      ...descriptors
        .filter((descriptor) => /^\d+$/.test(stringValue(descriptor.name)))
        .sort((left, right) => Number(left.name) - Number(right.name))
        .map((descriptor) => stringValue(recordValue(descriptor.value)?.objectId))
        .filter(Boolean)
        .slice(0, limit),
    );
    const resolved = await Promise.all(
      objectIds.map(async (objectId) => {
        const [description, partialAxTree] = await Promise.all([
          send("DOM.describeNode", { objectId, depth: 0 }, capture.sessionId),
          send("Accessibility.getPartialAXTree", { objectId, fetchRelatives: false }, capture.sessionId),
        ]);
        const node = recordValue(description.node);
        const backendNodeId = numberValue(node?.backendNodeId);
        if (!node || !backendNodeId) return null;
        const axNodes = Array.isArray(partialAxTree.nodes) ? partialAxTree.nodes.filter(isRecord) : [];
        const ax = axNodes.find((candidate) => numberValue(candidate.backendDOMNodeId) === backendNodeId) ?? axNodes[0];
        if (!ax || ax.ignored === true) return null;
        const role = axValue(ax.role).toLowerCase() || fallbackRole(node);
        if (!ACTIONABLE_ROLES.has(role)) return null;
        return { backendNodeId, node, ax, role };
      }),
    );
    assertBeforeDeadline(deadline);
    return resolved.filter((candidate) => candidate !== null).slice(0, limit);
  } finally {
    await Promise.allSettled([
      ...objectIds.map((objectId) => send("Runtime.releaseObject", { objectId }, capture.sessionId)),
      send("Runtime.releaseObject", { objectId: collectionId }, capture.sessionId),
    ]);
  }
}

function actionableNodesExpression(limit: number): string {
  return `(() => {
    const roles = new Set(${JSON.stringify([...ACTIONABLE_ROLES])});
    const roots = [document];
    const seenRoots = new Set();
    const matches = [];
    let scanned = 0;
    const isCandidate = node => {
      if (!(node instanceof Element) || node.hidden || node.closest('[hidden],[inert],[aria-hidden="true"]')) return false;
      const explicitRole = (node.getAttribute('role') || '').trim().split(/\\s+/)[0].toLowerCase();
      const tag = node.localName;
      const semantic = tag === 'button' || tag === 'summary' || tag === 'a' || tag === 'select' ||
        tag === 'textarea' || (tag === 'input' && node.type !== 'hidden') || node.isContentEditable;
      if (!semantic && !roles.has(explicitRole)) return false;
      return node.getClientRects().length > 0;
    };
    while (roots.length && scanned < ${MAX_SNAPSHOT_SCANNED_NODES} && matches.length < ${Math.max(0, limit)}) {
      const root = roots.shift();
      if (!root || seenRoots.has(root)) continue;
      seenRoots.add(root);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let node;
      while ((node = walker.nextNode()) && scanned < ${MAX_SNAPSHOT_SCANNED_NODES} && matches.length < ${Math.max(0, limit)}) {
        scanned++;
        if (node.shadowRoot) roots.push(node.shadowRoot);
        if (node.localName === 'iframe' || node.localName === 'frame') {
          try { if (node.contentDocument) roots.push(node.contentDocument); } catch {}
        }
        if (isCandidate(node)) matches.push(node);
      }
    }
    return matches;
  })()`;
}

function redactedMetadataUrl(value: string | undefined): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().slice(0, INPUT_LIMITS.browserUrl);
  } catch {
    return "";
  }
}

function boundSerializedSnapshot(snapshot: BrowserSnapshot): void {
  let bytes = Buffer.byteLength(JSON.stringify(snapshot));
  while (bytes > MAX_SERIALIZED_SNAPSHOT_BYTES) {
    if (snapshot.diagnostics.length > 20) snapshot.diagnostics.shift();
    else if (snapshot.actions.length > 20) snapshot.actions.shift();
    else if (snapshot.elements.length > 0) snapshot.elements.pop();
    else if (snapshot.text.length > 0) {
      const excess = bytes - MAX_SERIALIZED_SNAPSHOT_BYTES;
      snapshot.text = snapshot.text.slice(0, Math.max(0, snapshot.text.length - Math.max(1, excess)));
    } else if (snapshot.diagnostics.length > 0) snapshot.diagnostics.shift();
    else if (snapshot.actions.length > 0) snapshot.actions.shift();
    else throw new Error("Browser snapshot exceeds its serialized size limit.");
    bytes = Buffer.byteLength(JSON.stringify(snapshot));
  }
}

function assertBeforeDeadline(deadline: number | undefined): void {
  if (deadline !== undefined && Date.now() >= deadline) throw new Error("Browser wait condition timed out.");
}

function fallbackRole(node: CdpResult): string {
  const tag = (stringValue(node.localName) || stringValue(node.nodeName)).toLowerCase();
  const attributes = nodeAttributes(node.attributes);
  if (attributes.role) return attributes.role.toLowerCase();
  if (tag === "button" || tag === "summary") return "button";
  if (tag === "a") return "link";
  if (tag === "select") return attributes.multiple === undefined ? "combobox" : "listbox";
  if (tag === "textarea" || attributes.contenteditable !== undefined) return "textbox";
  if (tag !== "input") return "";
  if (attributes.type === "checkbox") return "checkbox";
  if (attributes.type === "radio") return "radio";
  if (attributes.type === "range") return "slider";
  if (attributes.type === "number") return "spinbutton";
  return "textbox";
}

function nodeAttributes(value: unknown): Record<string, string> {
  const raw = Array.isArray(value) ? value.filter(isString) : [];
  const result: Record<string, string> = {};
  for (let index = 0; index + 1 < raw.length; index += 2) result[raw[index].toLowerCase()] = raw[index + 1];
  return result;
}

function readViewport(metrics: CdpResult, environment: BrowserEnvironment): BrowserEnvironment["viewport"] {
  const viewport = recordValue(metrics.cssLayoutViewport);
  return {
    ...environment.viewport,
    width: Math.round(numberValue(viewport?.clientWidth) || environment.viewport.width),
    height: Math.round(numberValue(viewport?.clientHeight) || environment.viewport.height),
  };
}

async function dispatchShortcut(send: SendCommand, shortcut: string, sessionId?: string): Promise<void> {
  const parts = shortcut
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0 || parts.length > 5) throw new Error("Invalid browser shortcut.");
  const key = parts.pop();
  if (!key) throw new Error("Invalid browser shortcut.");
  const modifierNames: string[] = [];
  for (const part of parts) {
    const modifier = normalizeModifier(part);
    if (!modifier) throw new Error(`Invalid browser shortcut: ${shortcut}`);
    modifierNames.push(modifier);
  }
  const keyInfo = normalizeKey(key);
  const modifiers = modifierMask(modifierNames);
  const pressedModifiers: string[] = [];
  let keyPressed = false;
  try {
    for (const modifier of modifierNames) {
      await send(
        "Input.dispatchKeyEvent",
        {
          type: "rawKeyDown",
          key: modifier,
          code: `${modifier}Left`,
          modifiers: modifierMask([...pressedModifiers, modifier]),
        },
        sessionId,
      );
      pressedModifiers.push(modifier);
    }
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...keyInfo, modifiers }, sessionId);
    keyPressed = true;
    if (key.length === 1 && modifiers === 0)
      await send("Input.dispatchKeyEvent", { type: "char", ...keyInfo, text: key }, sessionId);
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...keyInfo, modifiers }, sessionId);
    keyPressed = false;
  } finally {
    if (keyPressed) {
      await send("Input.dispatchKeyEvent", { type: "keyUp", ...keyInfo, modifiers }, sessionId).catch(() => undefined);
    }
    for (const modifier of [...pressedModifiers].reverse()) {
      await send(
        "Input.dispatchKeyEvent",
        { type: "keyUp", key: modifier, code: `${modifier}Left`, modifiers: 0 },
        sessionId,
      ).catch(() => undefined);
    }
  }
}

function normalizeModifier(value: string) {
  const lower = value.toLowerCase();
  if (lower === "cmd" || lower === "command" || lower === "meta") return "Meta";
  if (lower === "ctrl" || lower === "control") return "Control";
  if (lower === "alt" || lower === "option") return "Alt";
  if (lower === "shift") return "Shift";
  return null;
}

function normalizeKey(key: string): { key: string; code: string; windowsVirtualKeyCode?: number } {
  const aliases: Record<string, [string, string, number?]> = {
    enter: ["Enter", "Enter", 13],
    tab: ["Tab", "Tab", 9],
    escape: ["Escape", "Escape", 27],
    esc: ["Escape", "Escape", 27],
    backspace: ["Backspace", "Backspace", 8],
    delete: ["Delete", "Delete", 46],
    space: [" ", "Space", 32],
    arrowup: ["ArrowUp", "ArrowUp", 38],
    arrowdown: ["ArrowDown", "ArrowDown", 40],
    arrowleft: ["ArrowLeft", "ArrowLeft", 37],
    arrowright: ["ArrowRight", "ArrowRight", 39],
    home: ["Home", "Home", 36],
    end: ["End", "End", 35],
    pageup: ["PageUp", "PageUp", 33],
    pagedown: ["PageDown", "PageDown", 34],
  };
  const alias = aliases[key.toLowerCase()];
  if (alias) return { key: alias[0], code: alias[1], windowsVirtualKeyCode: alias[2] };
  if (!/^[\w\-.,/;='[\]`]{1,20}$/u.test(key)) throw new Error(`Unsupported browser key: ${key}`);
  const upper = key.length === 1 ? key.toUpperCase() : key;
  return { key, code: key.length === 1 && /[a-z]/i.test(key) ? `Key${upper}` : upper };
}

function modifierMask(values: string[]) {
  let result = 0;
  for (const value of values) {
    const normalized = normalizeModifier(value) ?? value;
    if (normalized === "Alt") result |= 1;
    if (normalized === "Control") result |= 2;
    if (normalized === "Meta") result |= 4;
    if (normalized === "Shift") result |= 8;
  }
  return result;
}

function uniquePoints(points: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  const seen = new Set<string>();
  return points.filter((point) => {
    const key = `${Math.round(point.x)}:${Math.round(point.y)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function isNodeOrDescendant(
  send: SendCommand,
  candidate: number,
  target: number,
  sessionId?: string,
): Promise<boolean> {
  let current = candidate;
  for (let depth = 0; depth < 50; depth++) {
    if (current === target) return true;
    const result = await send("DOM.describeNode", { backendNodeId: current, depth: 0 }, sessionId);
    const node = recordValue(result.node);
    const parentId = numberValue(node?.parentId);
    if (!parentId) return false;
    const parent = await send("DOM.describeNode", { nodeId: parentId, depth: 0 }, sessionId);
    current = numberValue(recordValue(parent.node)?.backendNodeId);
    if (!current) return false;
  }
  return false;
}

function waitForLoading(contents: WebContents, timeoutMs: number): Promise<void> {
  if (!contents.isLoading()) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        contents.stop();
      } catch (error) {
        cleanup();
        reject(error);
      }
    }, timeoutMs);
    timer.unref();
    const stopped = () => {
      cleanup();
      if (timedOut) reject(new Error("Navigation timed out."));
      else resolve();
    };
    const failed = (_event: unknown, code: number, description: string, _url: string, isMainFrame: boolean) => {
      if (!isMainFrame) return;
      cleanup();
      if (timedOut) reject(new Error("Navigation timed out."));
      else reject(new Error(`Navigation failed (${code}): ${description}`));
    };
    const destroyed = () => {
      cleanup();
      reject(new Error("Browser tab was closed during navigation."));
    };
    const cleanup = () => {
      clearTimeout(timer);
      contents.off("did-stop-loading", stopped);
      contents.off("did-fail-load", failed);
      contents.off("destroyed", destroyed);
    };
    contents.once("did-stop-loading", stopped);
    contents.on("did-fail-load", failed);
    contents.once("destroyed", destroyed);
  });
}

function stopLoadingAndWait(contents: WebContents): Promise<void> {
  if (!contents.isLoading()) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      contents.off("did-stop-loading", stopped);
      contents.off("destroyed", destroyed);
    };
    const stopped = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const destroyed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("Browser tab was closed during navigation."));
    };
    contents.once("did-stop-loading", stopped);
    contents.once("destroyed", destroyed);
    try {
      contents.stop();
      if (!contents.isLoading()) setImmediate(stopped);
    } catch (error) {
      settled = true;
      cleanup();
      reject(error);
    }
  });
}

async function waitForDomQuietAcrossTargets(
  send: SendCommand,
  captures: SnapshotTarget[],
  timeoutMs: number,
): Promise<void> {
  if (timeoutMs <= 0) throw new Error("DOM did not become quiet.");
  const deadlineMs = Math.max(1, Math.floor(timeoutMs));
  const results = await Promise.all(
    captures.map(async (capture) => {
      const contextId = await automationContextId(send, capture.sessionId);
      return send(
        "Runtime.evaluate",
        {
          expression: `new Promise(resolve => {
      let quietTimer;
      let deadlineTimer;
      let discoveryTimer;
      let completed = false;
      const observers = [];
      const observedRoots = new Set();
      const done = value => {
        if (completed) return;
        completed = true;
        clearTimeout(quietTimer);
        clearTimeout(deadlineTimer);
        clearInterval(discoveryTimer);
        for (const observer of observers) observer.disconnect();
        resolve(value);
      };
      const changed = () => {
        discoverRoots();
        clearTimeout(quietTimer);
        quietTimer = setTimeout(() => done(true), 120);
      };
      const discoverRoots = () => {
        const pending = [document];
        let discovered = false;
        let scanned = 0;
        while (pending.length && scanned < ${MAX_SNAPSHOT_SCANNED_NODES}) {
          const root = pending.shift();
          if (!root) continue;
          if (!observedRoots.has(root)) {
            const observer = new MutationObserver(changed);
            observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
            observedRoots.add(root);
            observers.push(observer);
            discovered = true;
          }
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
          let node;
          while ((node = walker.nextNode()) && scanned < ${MAX_SNAPSHOT_SCANNED_NODES}) {
            scanned++;
            if (node.shadowRoot) pending.push(node.shadowRoot);
            if (node.localName === 'iframe' || node.localName === 'frame') {
              try { if (node.contentDocument) pending.push(node.contentDocument); } catch {}
            }
          }
        }
        if (discovered) {
          clearTimeout(quietTimer);
          quietTimer = setTimeout(() => done(true), 120);
        }
      };
      discoverRoots();
      discoveryTimer = setInterval(discoverRoots, 25);
      quietTimer = setTimeout(() => done(true), 120);
      deadlineTimer = setTimeout(() => done(false), ${deadlineMs});
    })`,
          contextId,
          awaitPromise: true,
          returnByValue: true,
        },
        capture.sessionId,
      );
    }),
  );
  if (results.some((result) => recordValue(result.result)?.value !== true)) {
    throw new Error("DOM did not become quiet.");
  }
}

async function automationContextId(send: SendCommand, sessionId?: string): Promise<number> {
  const tree = await send("Page.getFrameTree", {}, sessionId);
  const frameId = frameTreeRootId(tree);
  if (!frameId) throw new Error("The browser automation world has no frame.");
  const world = await send(
    "Page.createIsolatedWorld",
    { frameId, worldName: AUTOMATION_WORLD_NAME, grantUniveralAccess: false },
    sessionId,
  );
  const contextId = numberValue(world.executionContextId);
  if (!contextId) throw new Error("The browser automation world is unavailable.");
  return contextId;
}

function documentIdFunctionDeclaration(): string {
  return `function() {
    const documentNode = this.nodeType === Node.DOCUMENT_NODE ? this : this.ownerDocument;
    if (!documentNode) return null;
    const key = ${JSON.stringify(DOCUMENT_ID_PROPERTY)};
    if (typeof documentNode[key] !== 'string') {
      const values = crypto.getRandomValues(new Uint32Array(4));
      const value = Array.from(values, number => number.toString(16).padStart(8, '0')).join('');
      Object.defineProperty(documentNode, key, { value });
    }
    return documentNode[key];
  }`;
}

function documentIdsExpression(documentIds: string[]): string {
  return `(() => {
    const key = ${JSON.stringify(DOCUMENT_ID_PROPERTY)};
    const wanted = new Set(${JSON.stringify(documentIds)});
    const pending = [document];
    const seen = new Set();
    const ids = [];
    while (pending.length && seen.size < ${MAX_SNAPSHOT_SCANNED_NODES} && wanted.size > 0) {
      const documentNode = pending.shift();
      if (!documentNode || seen.has(documentNode)) continue;
      seen.add(documentNode);
      if (typeof documentNode[key] === 'string' && wanted.has(documentNode[key])) {
        ids.push(documentNode[key]);
        wanted.delete(documentNode[key]);
      }
      for (const frame of documentNode.querySelectorAll('iframe,frame')) {
        try { if (frame.contentDocument) pending.push(frame.contentDocument); } catch {}
      }
    }
    return ids;
  })()`;
}

function waitForPageSignal(contents: WebContents, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout;
    const cleanup = () => {
      clearTimeout(timer);
      contents.off("did-stop-loading", signal);
      contents.off("did-navigate-in-page", signal);
      resolve();
    };
    const signal = () => cleanup();
    timer = setTimeout(cleanup, timeoutMs);
    contents.once("did-stop-loading", signal);
    contents.once("did-navigate-in-page", signal);
  });
}

function frameTreeRootId(value: CdpResult): string {
  return stringValue(recordValue(recordValue(value.frameTree)?.frame)?.id);
}

function exceptionDescription(value: CdpResult): string {
  return stringValue(recordValue(value.exception)?.description) || stringValue(value.text) || "Unknown page error";
}

function describeTarget(target: Exclude<BrowserTarget, { kind: "ref" | "css" | "point" }>): string {
  return target.kind === "role"
    ? `role ${target.role}${target.name ? ` named “${target.name}”` : ""}`
    : `text “${target.text}”`;
}

function textMatches(actual: string, expected: string, exact = false): boolean {
  const left = actual.trim().toLocaleLowerCase();
  const right = expected.trim().toLocaleLowerCase();
  return exact ? left === right : left.includes(right);
}

function axValue(value: unknown): string {
  const record = recordValue(value);
  const raw = record?.value;
  return isString(raw) || isNumber(raw) || isBoolean(raw) ? String(raw) : "";
}

function recordValue(value: unknown): CdpResult | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is CdpResult {
  return isDynamicRecord(value);
}

function stringValue(value: unknown): string {
  return isString(value) ? value : "";
}

function numberValue(value: unknown): number {
  return isFiniteNumber(value) ? value : 0;
}

function isFiniteNumber(value: unknown): value is number {
  return isNumber(value) && Number.isFinite(value);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
