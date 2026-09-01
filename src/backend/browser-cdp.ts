import { stat } from "node:fs/promises";
import type {
  BrowserActionHistoryEntry,
  BrowserBounds,
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

export interface SnapshotReadResult {
  snapshot: BrowserSnapshot;
  recommendImage: boolean;
  imageReason: string;
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
  readonly #targetSessions = new Map<string, { sessionId: string; url: string }>();

  constructor(contents: WebContents) {
    this.#contents = contents;
    contents.debugger.on("message", (_event, method, params, sessionId) => {
      if (method === "Target.attachedToTarget" && isRecord(params)) {
        const attachedSessionId = stringValue(params.sessionId) || sessionId || "";
        const targetInfo = recordValue(params.targetInfo);
        const targetId = stringValue(targetInfo?.targetId);
        if (attachedSessionId && targetId) {
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
  }

  async snapshot(context: SnapshotContext): Promise<SnapshotReadResult> {
    return this.#lease(async (send) => {
      const [dom, metrics, frames] = await Promise.all([
        send("DOMSnapshot.captureSnapshot", {
          computedStyles: [],
          includePaintOrder: true,
          includeDOMRects: true,
        }),
        send("Page.getLayoutMetrics"),
        send("Page.getFrameTree"),
      ]);
      const rootAxTrees = await Promise.all(
        allFrameIds(frames).map((frameId) =>
          send("Accessibility.getFullAXTree", { frameId }).catch(() => ({ nodes: [] })),
        ),
      );
      const childCaptures = await Promise.all(
        [...this.#targetSessions.entries()].map(async ([targetId, target]) => {
          const [childAx, childDom] = await Promise.all([
            send("Accessibility.getFullAXTree", {}, target.sessionId).catch(() => ({ nodes: [] })),
            send(
              "DOMSnapshot.captureSnapshot",
              {
                computedStyles: [],
                includePaintOrder: true,
                includeDOMRects: true,
              },
              target.sessionId,
            ).catch(() => ({ documents: [], strings: [] })),
          ]);
          return { targetId, sessionId: target.sessionId, url: target.url, ax: childAx, dom: childDom };
        }),
      );
      const parsed = parseSnapshot(
        [
          { ax: { nodes: rootAxTrees.flatMap((tree) => (Array.isArray(tree.nodes) ? tree.nodes : [])) }, dom },
          ...childCaptures,
        ],
        frames,
        context.revision,
      );
      this.#targets = parsed.targets;
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
      await this.#callOnNode(
        send,
        resolved.backendNodeId,
        `function(mode) {
          if (!('value' in this) && !this.isContentEditable) throw new Error('Target does not accept text.');
          if (mode === 'replace') {
            if ('select' in this && typeof this.select === 'function') this.select();
            else {
              const selection = getSelection(); const range = document.createRange();
              range.selectNodeContents(this); selection.removeAllRanges(); selection.addRange(range);
            }
          } else if ('value' in this && typeof this.setSelectionRange === 'function') {
            const end = String(this.value).length; this.setSelectionRange(end, end);
          }
        }`,
        [mode],
        resolved.sessionId,
      );
      await send("Input.insertText", { text });
    });
  }

  async press(key: string, target?: BrowserTarget): Promise<void> {
    await this.#lease(async (send) => {
      if (target) {
        const resolved = await this.#resolveTarget(send, target);
        if (resolved.backendNodeId)
          await send("DOM.focus", { backendNodeId: resolved.backendNodeId }, resolved.sessionId);
      }
      await dispatchShortcut(send, key);
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
          const wanted = new Set(values);
          let matched = 0;
          for (const option of this.options) {
            option.selected = wanted.has(option.value) || wanted.has(option.label) || wanted.has(option.text);
            if (option.selected) matched++;
          }
          if (!matched) throw new Error('No requested option exists.');
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
    });
  }

  async uploadFiles(target: BrowserTarget, paths: string[]): Promise<void> {
    if (paths.length === 0 || paths.length > 10) throw new Error("Upload requires between 1 and 10 files.");
    if (Buffer.byteLength(JSON.stringify(paths)) > MAX_RESULT_BYTES)
      throw new Error("Upload path arguments exceed 64 KB.");
    for (const path of paths) {
      const info = await stat(path).catch(() => null);
      if (!info?.isFile()) throw new Error(`Upload file does not exist or is not a regular file: ${path}`);
    }
    await this.#lease(async (send) => {
      const resolved = await this.#resolveElement(send, target);
      await send("DOM.setFileInputFiles", { backendNodeId: resolved.backendNodeId, files: paths }, resolved.sessionId);
    });
  }

  async evaluate(expression: string, timeoutMs = ACTION_TIMEOUT_MS): Promise<unknown> {
    return this.#lease(async (send) => {
      const tree = await send("Page.getFrameTree");
      const frameId = frameTreeRootId(tree);
      if (!frameId) throw new Error("The page has no main frame.");
      const world = await send("Page.createIsolatedWorld", {
        frameId,
        worldName: `openbot-browser-${Date.now()}`,
        grantUniveralAccess: false,
      });
      const contextId = numberValue(world.executionContextId);
      const result = await withTimeout(
        send("Runtime.evaluate", {
          expression: `Promise.resolve((0, eval)(${JSON.stringify(expression)}))`,
          contextId,
          awaitPromise: true,
          returnByValue: true,
          userGesture: false,
        }),
        clamp(timeoutMs, 1, WAIT_TIMEOUT_MS),
        "Browser evaluation timed out.",
      );
      const exception = recordValue(result.exceptionDetails);
      if (exception) throw new Error(`Browser evaluation failed: ${exceptionDescription(exception)}`);
      const value = recordValue(result.result)?.value;
      const serialized = JSON.stringify(value);
      if (serialized === undefined) throw new Error("Browser evaluation result is not serializable.");
      if (Buffer.byteLength(serialized) > MAX_RESULT_BYTES) throw new Error("Browser evaluation result exceeds 64 KB.");
      return value;
    });
  }

  async setEnvironment(environment: BrowserEnvironment): Promise<void> {
    this.#environment = environment;
    await this.#lease(async (send) => {
      await this.#applyEnvironment(send, environment);
    });
  }

  async waitFor(
    condition: { target?: BrowserTarget; text?: string; url?: string; state?: string },
    timeoutMs = WAIT_TIMEOUT_MS,
  ): Promise<void> {
    await this.#lease(async (send) => {
      const deadline = Date.now() + clamp(timeoutMs, 1, WAIT_TIMEOUT_MS);
      while (true) {
        let matched = true;
        if (condition.url) matched &&= this.#contents.getURL().includes(condition.url);
        if (condition.text) {
          const result = await send("Runtime.evaluate", {
            expression: `Boolean(document.body?.innerText.includes(${JSON.stringify(condition.text)}))`,
            returnByValue: true,
          });
          matched &&= recordValue(result.result)?.value === true;
        }
        if (condition.target) {
          try {
            if (condition.target.kind === "role" || condition.target.kind === "text") {
              await this.#refreshSemanticTargets(send);
            }
            await this.#resolveTarget(send, condition.target);
          } catch {
            matched = false;
          }
        }
        if (condition.state === "load") matched &&= !this.#contents.isLoading();
        if (condition.state === "domcontentloaded") {
          const result = await send("Runtime.evaluate", {
            expression: "document.readyState !== 'loading'",
            returnByValue: true,
          });
          matched &&= recordValue(result.result)?.value === true;
        }
        if (matched) {
          if (condition.state === "dom-quiet") await waitForDomQuiet(send, Math.min(1_000, deadline - Date.now()));
          return;
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
      await waitForDomQuiet(send, Math.min(timeoutMs, 1_500)).catch((error) => {
        if (error instanceof Error && error.message === "DOM did not become quiet.") return;
        throw error;
      });
    });
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
    });
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
  ): Promise<{ backendNodeId?: number; sessionId?: string; x: number; y: number }> {
    if (target.kind === "point") return { x: target.x, y: target.y };
    if (target.kind === "ref") {
      if (!this.#lastSnapshot || target.revision !== this.#lastSnapshot.revision) {
        throw new Error("Stale browser reference. Take a fresh snapshot before acting.");
      }
      const record = this.#targets.get(target.ref);
      if (!record) throw new Error("Element reference is no longer available. Take a fresh snapshot.");
      return {
        backendNodeId: record.backendNodeId,
        sessionId: record.targetId ? this.#targetSessions.get(record.targetId)?.sessionId : undefined,
        x: 0,
        y: 0,
      };
    }
    if (target.kind === "css") {
      const expression = `(() => {
        const visit = root => {
          const direct = root.querySelector(${JSON.stringify(target.selector)}); if (direct) return direct;
          for (const node of root.querySelectorAll('*')) { if (node.shadowRoot) { const found = visit(node.shadowRoot); if (found) return found; } }
          return null;
        }; return visit(document);
      })()`;
      const result = await send("Runtime.evaluate", { expression, returnByValue: false });
      const remote = recordValue(result.result);
      const objectId = stringValue(remote?.objectId);
      if (!objectId || remote?.subtype === "null")
        throw new Error(`No element matches CSS selector: ${target.selector}`);
      const node = await send("DOM.requestNode", { objectId });
      const backendNodeId = numberValue(node.backendNodeId);
      const nodeId = numberValue(node.nodeId);
      if (backendNodeId) return { backendNodeId, x: 0, y: 0 };
      if (!nodeId) throw new Error(`Unable to resolve CSS selector: ${target.selector}`);
      const described = await send("DOM.describeNode", { nodeId });
      const describedNode = recordValue(described.node);
      return { backendNodeId: numberValue(describedNode?.backendNodeId), x: 0, y: 0 };
    }
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
    const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
    const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
    if (hitTest) {
      const hit = await send(
        "DOM.getNodeForLocation",
        { x: Math.round(x), y: Math.round(y), includeUserAgentShadowDOM: true },
        sessionId,
      );
      const hitId = numberValue(hit.backendNodeId);
      if (hitId && !(await isNodeOrDescendant(send, hitId, backendNodeId, sessionId))) {
        const blocker = await send("DOM.describeNode", { backendNodeId: hitId, depth: 0 }, sessionId);
        const node = recordValue(blocker.node);
        const name = stringValue(node?.nodeName).toLowerCase() || "element";
        throw new Error(
          `Target is covered by ${name} (backendNodeId ${hitId}). Dismiss the covering layer or choose a visible point.`,
        );
      }
    }
    return { x, y, sessionId };
  }

  async #callOnNode(
    send: SendCommand,
    backendNodeId: number,
    declaration: string,
    args: unknown[],
    sessionId?: string,
  ): Promise<unknown> {
    const resolved = await send("DOM.resolveNode", { backendNodeId }, sessionId);
    const objectId = stringValue(recordValue(resolved.object)?.objectId);
    if (!objectId) throw new Error("Element is no longer attached to the document.");
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
  }

  async #refreshSemanticTargets(send: SendCommand): Promise<void> {
    const frames = await send("Page.getFrameTree");
    const rootAxTrees = await Promise.all(
      allFrameIds(frames).map((frameId) =>
        send("Accessibility.getFullAXTree", { frameId }).catch(() => ({ nodes: [] })),
      ),
    );
    const childCaptures = await Promise.all(
      [...this.#targetSessions.entries()].map(async ([targetId, target]) => ({
        targetId,
        sessionId: target.sessionId,
        url: target.url,
        ax: await send("Accessibility.getFullAXTree", {}, target.sessionId).catch(() => ({ nodes: [] })),
        dom: { documents: [], strings: [] },
      })),
    );
    const parsed = parseSnapshot(
      [
        {
          ax: { nodes: rootAxTrees.flatMap((tree) => (Array.isArray(tree.nodes) ? tree.nodes : [])) },
          dom: { documents: [], strings: [] },
        },
        ...childCaptures,
      ],
      frames,
      this.#lastSnapshot?.revision ?? 0,
    );
    this.#targets = parsed.targets;
  }

  async #lease<T>(operation: (send: SendCommand) => Promise<T>): Promise<T> {
    if (this.#contents.isDestroyed()) throw new Error("Browser tab was closed.");
    const attachedHere = !this.#contents.debugger.isAttached();
    if (attachedHere) this.#contents.debugger.attach("1.3");
    const send: SendCommand = async (method, params = {}, sessionId) => {
      const result = await this.#contents.debugger.sendCommand(method, params, sessionId);
      if (!isDynamicRecord(result)) throw new Error(`CDP ${method} returned an invalid result.`);
      return result;
    };
    try {
      await send("Emulation.setFocusEmulationEnabled", { enabled: true });
      await send("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
        filter: [{ type: "iframe", exclude: false }],
      }).catch(() => undefined);
      if (this.#environment) await this.#applyEnvironment(send, this.#environment);
      return await operation(send);
    } finally {
      if (attachedHere && this.#contents.debugger.isAttached()) this.#contents.debugger.detach();
    }
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
}

type SendCommand = (method: string, params?: DynamicRecord, sessionId?: string) => Promise<CdpResult>;

function parseSnapshot(
  captures: Array<{ ax: CdpResult; dom: CdpResult; sessionId?: string; targetId?: string; url?: string }>,
  frames: CdpResult,
  revision: number,
) {
  const nodeMeta = new Map<string, { tag: string; bounds: BrowserBounds | null; frame: BrowserElement["frame"] }>();
  const domTextParts: string[] = [];
  let hasVisualSurface = false;
  let hasFrame = false;
  for (const capture of captures) {
    const strings = Array.isArray(capture.dom.strings)
      ? capture.dom.strings.filter((value): value is string => isString(value))
      : [];
    const domDocuments = Array.isArray(capture.dom.documents) ? capture.dom.documents.filter(isRecord) : [];
    for (const document of domDocuments) {
      const nodes = recordValue(document.nodes);
      const layout = recordValue(document.layout);
      const backendIds = numberArray(nodes?.backendNodeId);
      const names = numberArray(nodes?.nodeName);
      const values = numberArray(nodes?.nodeValue);
      const layoutIndexes = numberArray(layout?.nodeIndex);
      const bounds = Array.isArray(layout?.bounds) ? layout.bounds : [];
      const boundByIndex = new Map<number, BrowserBounds>();
      for (let index = 0; index < layoutIndexes.length; index++) {
        const raw = Array.isArray(bounds[index]) ? bounds[index].filter(isFiniteNumber) : [];
        if (raw.length >= 4)
          boundByIndex.set(layoutIndexes[index], { x: raw[0], y: raw[1], width: raw[2], height: raw[3] });
      }
      const frameId = stringValue(document.frameId) || capture.targetId || "";
      const frameUrl = indexedString(strings, document.documentURL) || capture.url || "";
      for (let index = 0; index < backendIds.length; index++) {
        const tag = (strings[names[index]] ?? "").toLowerCase();
        if (tag === "#text" && boundByIndex.has(index)) {
          const text = strings[values[index]] ?? "";
          if (text.trim()) domTextParts.push(text);
        }
        if (tag === "canvas" || tag === "video") hasVisualSurface = true;
        if (tag === "iframe" || tag === "frame") hasFrame = true;
        nodeMeta.set(nodeKey(capture.sessionId, backendIds[index]), {
          tag,
          bounds: boundByIndex.get(index) ?? null,
          frame: frameId ? { id: frameId, url: frameUrl } : null,
        });
      }
    }
  }
  const frameUrls = frameUrlMap(frames);
  const targets = new Map<string, TargetRecord>();
  const elements: BrowserElement[] = [];
  const textParts: string[] = [];
  for (const capture of captures) {
    const axNodes = Array.isArray(capture.ax.nodes) ? capture.ax.nodes.filter(isRecord) : [];
    for (const node of axNodes) {
      if (node.ignored === true) continue;
      const role = axValue(node.role)?.toLowerCase() || null;
      const name = axValue(node.name).slice(0, 500);
      const description = axValue(node.description).slice(0, 500);
      if ((role === "statictext" || role === "inlinetextbox") && name) textParts.push(name);
      const backendNodeId = numberValue(node.backendDOMNodeId);
      if (!backendNodeId || !role || !ACTIONABLE_ROLES.has(role)) continue;
      const meta = nodeMeta.get(nodeKey(capture.sessionId, backendNodeId));
      const properties = Array.isArray(node.properties) ? node.properties.filter(isRecord) : [];
      const states = properties
        .filter((property) =>
          ["checked", "disabled", "expanded", "focused", "pressed", "readonly", "required", "selected"].includes(
            stringValue(property.name),
          ),
        )
        .map((property) => `${stringValue(property.name)}:${axValue(property.value)}`);
      const frameId = stringValue(node.frameId) || capture.targetId || meta?.frame?.id || "";
      const ref = `${revision}:${capture.targetId ?? "main"}:${backendNodeId}`;
      const element: BrowserElement = {
        ref,
        role,
        name,
        description,
        tag: meta?.tag ?? "",
        value: axValue(node.value) || null,
        states,
        disabled: states.includes("disabled:true"),
        bounds: meta?.bounds ?? null,
        frame: frameId ? { id: frameId, url: frameUrls.get(frameId) ?? meta?.frame?.url ?? "" } : null,
      };
      elements.push(element);
      targets.set(ref, { backendNodeId, targetId: capture.targetId, element });
      if (elements.length >= 1_000) break;
    }
  }
  return {
    targets,
    elements,
    text:
      (domTextParts.length === 1 ? domTextParts[0] : domTextParts.join(" ")).trim().slice(0, 100_000) ||
      textParts.join(" ").replace(/\s+/g, " ").trim().slice(0, 100_000),
    hasVisualSurface,
    hasFrame,
  };
}

function readViewport(metrics: CdpResult, environment: BrowserEnvironment): BrowserEnvironment["viewport"] {
  const viewport = recordValue(metrics.cssLayoutViewport);
  return {
    ...environment.viewport,
    width: Math.round(numberValue(viewport?.clientWidth) || environment.viewport.width),
    height: Math.round(numberValue(viewport?.clientHeight) || environment.viewport.height),
  };
}

async function dispatchShortcut(send: SendCommand, shortcut: string): Promise<void> {
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
  const modifiers = modifierMask(modifierNames);
  for (const modifier of modifierNames) {
    await send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: modifier,
      code: `${modifier}Left`,
      modifiers: modifierMask([modifier]),
    });
  }
  const keyInfo = normalizeKey(key);
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...keyInfo, modifiers });
  if (key.length === 1 && modifiers === 0)
    await send("Input.dispatchKeyEvent", { type: "char", ...keyInfo, text: key });
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...keyInfo, modifiers });
  for (const modifier of [...modifierNames].reverse()) {
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: modifier, code: `${modifier}Left`, modifiers: 0 });
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
  return withTimeout(
    new Promise<void>((resolve, reject) => {
      const stopped = () => {
        cleanup();
        resolve();
      };
      const failed = (_event: unknown, code: number, description: string, _url: string, isMainFrame: boolean) => {
        if (!isMainFrame) return;
        cleanup();
        reject(new Error(`Navigation failed (${code}): ${description}`));
      };
      const destroyed = () => {
        cleanup();
        reject(new Error("Browser tab was closed during navigation."));
      };
      const cleanup = () => {
        contents.off("did-stop-loading", stopped);
        contents.off("did-fail-load", failed);
        contents.off("destroyed", destroyed);
      };
      contents.once("did-stop-loading", stopped);
      contents.on("did-fail-load", failed);
      contents.once("destroyed", destroyed);
    }),
    timeoutMs,
    "Navigation timed out.",
  );
}

async function waitForDomQuiet(send: SendCommand, timeoutMs: number): Promise<void> {
  if (timeoutMs <= 0) throw new Error("DOM did not become quiet.");
  await withTimeout(
    send("Runtime.evaluate", {
      expression: `new Promise(resolve => {
      let timer; const done = () => { observer.disconnect(); resolve(true); };
      const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(done, 120); });
      observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      timer = setTimeout(done, 120);
    })`,
      awaitPromise: true,
      returnByValue: true,
    }),
    timeoutMs,
    "DOM did not become quiet.",
  );
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

function frameUrlMap(value: CdpResult): Map<string, string> {
  const result = new Map<string, string>();
  const visit = (tree: unknown) => {
    const record = recordValue(tree);
    const frame = recordValue(record?.frame);
    const id = stringValue(frame?.id);
    if (id) result.set(id, stringValue(frame?.url));
    if (Array.isArray(record?.childFrames)) for (const child of record.childFrames) visit(child);
  };
  visit(value.frameTree);
  return result;
}

function frameTreeRootId(value: CdpResult): string {
  return stringValue(recordValue(recordValue(value.frameTree)?.frame)?.id);
}

function allFrameIds(value: CdpResult): string[] {
  const result: string[] = [];
  const visit = (tree: unknown) => {
    const record = recordValue(tree);
    const id = stringValue(recordValue(record?.frame)?.id);
    if (id) result.push(id);
    if (Array.isArray(record?.childFrames)) for (const child of record.childFrames) visit(child);
  };
  visit(value.frameTree);
  return result;
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

function indexedString(strings: string[], value: unknown): string {
  return strings[numberValue(value)] ?? "";
}

function nodeKey(sessionId: string | undefined, backendNodeId: number): string {
  return `${sessionId ?? "main"}:${backendNodeId}`;
}

function numberArray(value: unknown): number[] {
  return Array.isArray(value) ? value.filter(isFiniteNumber) : [];
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
