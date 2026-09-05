import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { Portal } from "@solidjs/web";
import type { Element as SolidElement } from "solid-js";
import { createEffect, createMemo, createSignal, For, onSettled, Show } from "solid-js";
import { Button, Input } from "../../components/ui";

const MESSAGE_TEXT_SELECTOR = ".message-copy[data-selection-message-id]";
const INTERACTIVE_SELECTOR =
  'a, button, input, textarea, select, [contenteditable="true"], [role="button"], .message-citation';
const HIGHLIGHT_NAME = "openbot-message-selection";
const VIEWPORT_MARGIN = 12;
const TOOLBAR_GAP = 8;

export const SELECTION_ACTION_INSTRUCTIONS = {
  Explain: "Explain this selected text.",
  Improve: "Improve this selected text.",
  Shorten: "Shorten this selected text.",
  Tone: "Change the tone of this selected text.",
  Grammar: "Fix the grammar in this selected text.",
} as const;

export interface MessageTextSelection {
  messageId: string;
  text: string;
  range: Range;
}

export interface SelectionInstruction {
  instruction: string;
  quote: string;
}

export interface SelectionRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

export interface SelectionActionsPosition {
  top: number;
  left: number;
  placement: "top" | "bottom";
}

export function serializeSelectionInstruction(instruction: string, quote: string): string {
  const normalizedInstruction = instruction.trim();
  const normalizedQuote = quote.replace(/\r\n?/gu, "\n").trim();
  const quoted = normalizedQuote
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `${normalizedInstruction}\n\n${quoted}`;
}

export function parseSelectionInstruction(body: string): SelectionInstruction | null {
  const separator = body.lastIndexOf("\n\n>");
  if (separator <= 0) return null;
  const instruction = body.slice(0, separator).trim();
  const quoteLines = body.slice(separator + 2).split("\n");
  if (!instruction || quoteLines.length === 0 || quoteLines.some((line) => !/^>(?: |$)/u.test(line))) return null;
  const quote = quoteLines
    .map((line) => line.replace(/^> ?/u, ""))
    .join("\n")
    .trim();
  return quote ? { instruction, quote } : null;
}

export function messageTextSelection(selection: Selection | null): MessageTextSelection | null {
  if (selection?.rangeCount !== 1 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (range.collapsed) return null;
  const startBlock = messageTextBlock(range.startContainer);
  const endBlock = messageTextBlock(range.endContainer);
  if (!startBlock || startBlock !== endBlock) return null;
  const messageId = startBlock.dataset.selectionMessageId;
  const text = selection
    .toString()
    .replace(/\u00a0/gu, " ")
    .trim();
  if (!messageId || !text || rangeIntersectsInteractiveContent(range, startBlock)) return null;
  return { messageId, text, range: range.cloneRange() };
}

export function selectionActionsPosition(
  rects: SelectionRect[],
  toolbar: Pick<SelectionRect, "width" | "height">,
  viewport: { width: number; height: number },
): SelectionActionsPosition {
  if (rects.length === 0) return { top: VIEWPORT_MARGIN, left: VIEWPORT_MARGIN, placement: "bottom" };
  const firstLine = rects[0];
  const lastLine = rects[rects.length - 1];
  const leftEdge = Math.min(...rects.map((rect) => rect.left));
  const rightEdge = Math.max(...rects.map((rect) => rect.right));
  const idealLeft = leftEdge + (rightEdge - leftEdge - toolbar.width) / 2;
  const maximumLeft = Math.max(VIEWPORT_MARGIN, viewport.width - toolbar.width - VIEWPORT_MARGIN);
  const left = clamp(idealLeft, VIEWPORT_MARGIN, maximumLeft);
  const bottomTop = lastLine.bottom + TOOLBAR_GAP;
  const topTop = firstLine.top - TOOLBAR_GAP - toolbar.height;
  const bottomFits = bottomTop + toolbar.height <= viewport.height - VIEWPORT_MARGIN;
  const topFits = topTop >= VIEWPORT_MARGIN;
  const placement = bottomFits || !topFits ? "bottom" : "top";
  const idealTop = placement === "bottom" ? bottomTop : topTop;
  const maximumTop = Math.max(VIEWPORT_MARGIN, viewport.height - toolbar.height - VIEWPORT_MARGIN);
  return { top: clamp(idealTop, VIEWPORT_MARGIN, maximumTop), left, placement };
}

export function MessageSelectionActions(props: {
  contextKey: string | undefined;
  disabled: boolean;
  onSend: (messageId: string, body: string) => Promise<boolean>;
}) {
  const [selection, setSelection] = createSignal<MessageTextSelection | null>(null);
  const [fallbackHighlight, setFallbackHighlight] = createSignal(false);
  let lastContextKey: string | undefined;

  const clearSelection = () => {
    setSelection(null);
    clearPersistentHighlight();
  };

  // Only for deliberate dismissals: the composer is contenteditable, so its caret is the document
  // selection and clearing it here would wipe the caret out from under the person typing.
  const dismiss = () => {
    clearSelection();
    window.getSelection()?.removeAllRanges();
  };

  const captureSelection = () => {
    if (props.disabled) {
      clearSelection();
      return;
    }
    const next = messageTextSelection(window.getSelection());
    if (!next) {
      clearSelection();
      return;
    }
    setSelection(next);
  };

  createEffect(
    () => props.contextKey,
    (contextKey) => {
      if (lastContextKey !== undefined && contextKey !== lastContextKey) clearSelection();
      lastContextKey = contextKey;
    },
  );

  createEffect(
    () => props.disabled && selection(),
    (active) => {
      if (active) clearSelection();
    },
  );

  createEffect(
    () => selection(),
    (active) => {
      clearPersistentHighlight();
      if (!active) {
        setFallbackHighlight(false);
        return;
      }
      setFallbackHighlight(!installPersistentHighlight(active.range));
      return clearPersistentHighlight;
    },
  );

  onSettled(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest(".selection-actions-layer")) return;
      if (selection()) dismiss();
    };
    const onPointerUp = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest(".selection-actions-layer")) return;
      captureSelection();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        dismiss();
        return;
      }
      if (event.target instanceof Element && event.target.closest(".selection-actions-layer")) return;
      captureSelection();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("keyup", onKeyUp);
      clearPersistentHighlight();
    };
  });

  return (
    <Show when={selection()}>
      {(active) => (
        <SelectionActionsBar
          selection={active()}
          fallbackHighlight={fallbackHighlight()}
          onDismiss={dismiss}
          onSend={props.onSend}
        />
      )}
    </Show>
  );
}

export function SelectionActionsBar(props: {
  selection: MessageTextSelection;
  fallbackHighlight?: boolean;
  onDismiss: () => void;
  onSend: (messageId: string, body: string) => Promise<boolean>;
}) {
  const [prompt, setPrompt] = createSignal("");
  const [expanded, setExpanded] = createSignal(false);
  const [mode, setMode] = createSignal<"idle" | "sending" | "error">("idle");
  const [lastInstruction, setLastInstruction] = createSignal("");
  const [position, setPosition] = createSignal<SelectionActionsPosition | null>(null);
  const [highlightRects, setHighlightRects] = createSignal<SelectionRect[]>([]);
  const [barWidth, setBarWidth] = createSignal<number | null>(null);
  const [typingWidth, setTypingWidth] = createSignal<number | null>(null);
  let bar: HTMLDivElement | undefined;
  let content: HTMLDivElement | undefined;
  let animationFrame: number | undefined;
  let previousSelectionKey = "";

  const hasPrompt = createMemo(() => prompt().trim().length > 0);
  const maximumInstructionLength = createMemo(() => {
    const quoteOnly = serializeSelectionInstruction("", props.selection.text).length;
    return Math.max(1, INPUT_LIMITS.messageText - quoteOnly);
  });

  const schedulePosition = () => {
    if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
    animationFrame = requestAnimationFrame(() => {
      animationFrame = undefined;
      updateGeometry();
    });
  };

  const updateGeometry = () => {
    if (!bar || !props.selection.range.startContainer.isConnected) return;
    const rects = Array.from(props.selection.range.getClientRects())
      .map(rectValue)
      .filter((rect) => rect.width > 0);
    if (rects.length === 0) return;
    setHighlightRects(rects);
    const bounds = bar.getBoundingClientRect();
    setPosition(
      selectionActionsPosition(rects, bounds, {
        width: window.innerWidth,
        height: window.innerHeight,
      }),
    );
  };

  const updateWidth = () => {
    if (!content) return;
    const heldTypingWidth = typingWidth();
    if (mode() === "idle" && hasPrompt() && heldTypingWidth !== null) {
      const nextWidth = Math.min(window.innerWidth - VIEWPORT_MARGIN * 2, heldTypingWidth);
      setBarWidth(Math.max(44, nextWidth));
      schedulePosition();
      return;
    }
    const nextWidth = Math.min(window.innerWidth - VIEWPORT_MARGIN * 2, Math.ceil(content.scrollWidth) + 8);
    setBarWidth(Math.max(44, nextWidth));
    schedulePosition();
  };

  const updatePrompt = (value: string) => {
    if (!hasPrompt() && value.trim().length > 0 && bar) {
      const currentWidth = Math.ceil(bar.getBoundingClientRect().width);
      setTypingWidth(currentWidth);
      setBarWidth(currentWidth);
    } else if (value.trim().length === 0) {
      setTypingWidth(null);
    }
    setPrompt(value);
  };

  createEffect(
    () => `${props.selection.messageId}:${props.selection.text}`,
    (key) => {
      if (previousSelectionKey && previousSelectionKey !== key) {
        setPrompt("");
        setTypingWidth(null);
        setExpanded(false);
        setMode("idle");
        setLastInstruction("");
      }
      previousSelectionKey = key;
      schedulePosition();
    },
  );

  createEffect(
    () => [prompt(), expanded(), mode(), typingWidth()],
    () => {
      queueMicrotask(updateWidth);
    },
  );

  onSettled(() => {
    const observer = new ResizeObserver(() => {
      updateWidth();
      schedulePosition();
    });
    if (bar) observer.observe(bar);
    if (content) {
      observer.observe(content);
      content
        .querySelectorAll<HTMLElement>(
          ".selection-actions-form-shell, .selection-actions-form, .selection-actions-presets, .selection-actions-more-presets, .selection-actions-send-shell",
        )
        .forEach((element) => {
          observer.observe(element);
        });
    }
    window.addEventListener("resize", schedulePosition);
    window.addEventListener("scroll", schedulePosition, true);
    schedulePosition();
    updateWidth();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", schedulePosition);
      window.removeEventListener("scroll", schedulePosition, true);
      if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
    };
  });

  const submit = async (instruction: string) => {
    const normalized = instruction.trim();
    if (!normalized || mode() === "sending") return;
    const body = serializeSelectionInstruction(normalized, props.selection.text);
    if (body.length > INPUT_LIMITS.messageText) {
      setLastInstruction(normalized);
      setMode("error");
      return;
    }
    setLastInstruction(normalized);
    setExpanded(false);
    setMode("sending");
    try {
      if (await props.onSend(props.selection.messageId, body)) props.onDismiss();
      else setMode("error");
    } catch {
      setMode("error");
    }
  };

  return (
    <Portal>
      <Show when={props.fallbackHighlight}>
        <div class="selection-highlight-layer" aria-hidden="true">
          <For each={highlightRects()}>
            {(rect) => (
              <span
                style={{
                  top: `${rect.top}px`,
                  left: `${rect.left}px`,
                  width: `${rect.width}px`,
                  height: `${rect.height}px`,
                }}
              />
            )}
          </For>
        </div>
      </Show>
      <div
        class="selection-actions-layer"
        data-placement={position()?.placement ?? "bottom"}
        data-ready={position() ? "true" : "false"}
        style={{ top: `${position()?.top ?? 0}px`, left: `${position()?.left ?? 0}px` }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div
          ref={(element) => (bar = element)}
          class="selection-actions-bar"
          role="toolbar"
          aria-label="Actions for selected text"
          style={{ width: barWidth() ? `${barWidth()}px` : undefined }}
        >
          <div
            ref={(element) => (content = element)}
            class="selection-actions-content"
            style={{
              width:
                mode() === "idle" && hasPrompt() && typingWidth() !== null
                  ? `${Math.max(1, (typingWidth() ?? 8) - 8)}px`
                  : undefined,
            }}
          >
            <Show when={mode() === "sending"}>
              <span class="selection-actions-status" role="status">
                <span class="selection-actions-spinner" aria-hidden="true" />
                Sending…
              </span>
            </Show>

            <Show when={mode() === "error"}>
              <span class="selection-actions-error" role="alert">
                Couldn’t send
              </span>
              <Button
                variant="ghost"
                type="button"
                class="selection-actions-control"
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => void submit(lastInstruction())}
              >
                <RetryIcon />
                <span class="selection-actions-label">Retry</span>
              </Button>
              <Button
                variant="ghost"
                type="button"
                class="selection-actions-icon-button"
                aria-label="Close selected text actions"
                onPointerDown={(event) => event.preventDefault()}
                onClick={props.onDismiss}
              >
                <CloseSelectionIcon />
              </Button>
            </Show>

            <Show when={mode() === "idle"}>
              <div
                class={["selection-actions-form-shell", { "selection-actions-form-shell-hidden": expanded() }]}
                style={{
                  "max-width": expanded()
                    ? "0px"
                    : hasPrompt() && typingWidth() !== null
                      ? `${Math.max(1, (typingWidth() ?? 40) - 40)}px`
                      : "145px",
                }}
              >
                <form
                  class="selection-actions-form"
                  style={{
                    width:
                      hasPrompt() && typingWidth() !== null ? `${Math.max(1, (typingWidth() ?? 40) - 40)}px` : "145px",
                  }}
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submit(prompt());
                  }}
                >
                  <Input
                    value={prompt()}
                    aria-label="Describe edits"
                    placeholder="Describe edits"
                    maxlength={maximumInstructionLength()}
                    onValueChange={updatePrompt}
                  />
                </form>
              </div>

              <div
                class={[
                  "selection-actions-presets",
                  {
                    "selection-actions-presets-hidden": hasPrompt(),
                    "selection-actions-presets-expanded": expanded(),
                  },
                ]}
                style={{ "max-width": hasPrompt() ? "0px" : expanded() ? "462px" : "224px" }}
              >
                <Show when={!expanded()}>
                  <span class="selection-actions-divider" aria-hidden="true" />
                </Show>
                <PresetButton
                  label="Explain"
                  icon={<ExplainIcon />}
                  onSelect={() => void submit(SELECTION_ACTION_INSTRUCTIONS.Explain)}
                />
                <PresetButton
                  label="Improve"
                  icon={<ImproveIcon />}
                  onSelect={() => void submit(SELECTION_ACTION_INSTRUCTIONS.Improve)}
                />
                <Show when={expanded()}>
                  <div class="selection-actions-more-presets">
                    <PresetButton
                      label="Shorten"
                      icon={<ShortenIcon />}
                      onSelect={() => void submit(SELECTION_ACTION_INSTRUCTIONS.Shorten)}
                    />
                    <PresetButton
                      label="Tone"
                      icon={<ToneIcon />}
                      onSelect={() => void submit(SELECTION_ACTION_INSTRUCTIONS.Tone)}
                    />
                    <PresetButton
                      label="Grammar"
                      icon={<GrammarIcon />}
                      onSelect={() => void submit(SELECTION_ACTION_INSTRUCTIONS.Grammar)}
                    />
                  </div>
                </Show>
                <span class="selection-actions-divider selection-actions-more-divider" aria-hidden="true" />
                <Button
                  variant="ghost"
                  type="button"
                  class="selection-actions-icon-button selection-actions-expand"
                  aria-label={expanded() ? "Show fewer actions" : "Show more actions"}
                  aria-expanded={expanded() ? "true" : "false"}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => setExpanded((value) => !value)}
                >
                  <ChevronIcon />
                </Button>
              </div>

              <div
                class={["selection-actions-send-shell", { "selection-actions-send-shell-visible": hasPrompt() }]}
                aria-hidden={hasPrompt() ? undefined : "true"}
              >
                <Button
                  variant="ghost"
                  type="button"
                  class="selection-actions-send"
                  aria-label="Send edit instruction"
                  tabindex={hasPrompt() ? undefined : -1}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => void submit(prompt())}
                >
                  <SendIcon />
                </Button>
              </div>
            </Show>
          </div>
        </div>
      </div>
    </Portal>
  );
}

function PresetButton(props: { label: string; icon: SolidElement; onSelect: () => void }) {
  return (
    <Button
      variant="ghost"
      type="button"
      class="selection-actions-control"
      aria-label={props.label}
      onPointerDown={(event) => event.preventDefault()}
      onClick={props.onSelect}
    >
      {props.icon}
      <span class="selection-actions-label">{props.label}</span>
    </Button>
  );
}

function messageTextBlock(node: Node): HTMLElement | null {
  const element = node instanceof HTMLElement ? node : node.parentElement;
  return element?.closest<HTMLElement>(MESSAGE_TEXT_SELECTOR) ?? null;
}

function rangeIntersectsInteractiveContent(range: Range, root: HTMLElement): boolean {
  return Array.from(root.querySelectorAll(INTERACTIVE_SELECTOR)).some((element) => {
    try {
      return range.intersectsNode(element);
    } catch {
      return false;
    }
  });
}

function installPersistentHighlight(range: Range): boolean {
  try {
    CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(range));
    return true;
  } catch {
    return false;
  }
}

function clearPersistentHighlight(): void {
  try {
    CSS.highlights.delete(HIGHLIGHT_NAME);
  } catch {
    return;
  }
}

function rectValue(rect: DOMRect): SelectionRect {
  return {
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    left: rect.left,
    width: rect.width,
    height: rect.height,
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function SelectionIcon(props: { children: SolidElement }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="selection-actions-icon">
      {props.children}
    </svg>
  );
}

function ExplainIcon() {
  return (
    <SelectionIcon>
      <circle cx="10" cy="10" r="6.75" />
      <path d="M8.2 8.1a1.9 1.9 0 0 1 3.7.55c0 1.5-1.9 1.65-1.9 3M10 14.2h.01" />
    </SelectionIcon>
  );
}

function ImproveIcon() {
  return (
    <SelectionIcon>
      <path d="m10 2.9 1.1 4.2L15.3 8l-4.2 1.1-1.1 4.2-1.1-4.2L4.7 8l4.2-.9zM15.2 12.5l.5 1.8 1.8.5-1.8.5-.5 1.8-.5-1.8-1.8-.5 1.8-.5z" />
    </SelectionIcon>
  );
}

function ShortenIcon() {
  return (
    <SelectionIcon>
      <circle cx="6" cy="6" r="2.2" />
      <circle cx="6" cy="14" r="2.2" />
      <path d="m7.8 7.2 7 5.6M7.8 12.8l7-5.6" />
    </SelectionIcon>
  );
}

function ToneIcon() {
  return (
    <SelectionIcon>
      <circle cx="10" cy="10" r="6.75" />
      <path d="M7.2 8h.01M12.8 8h.01M7.1 11.5c.8 1.15 1.77 1.7 2.9 1.7s2.1-.55 2.9-1.7" />
    </SelectionIcon>
  );
}

function GrammarIcon() {
  return (
    <SelectionIcon>
      <rect x="3.5" y="4" width="13" height="12" rx="2" />
      <path d="M6.5 8h7M6.5 11h5M6.5 14h3" />
    </SelectionIcon>
  );
}

function ChevronIcon() {
  return (
    <SelectionIcon>
      <path d="m8 5 5 5-5 5" />
    </SelectionIcon>
  );
}

function SendIcon() {
  return (
    <SelectionIcon>
      <path d="M10 15.5v-11M5.7 8.8 10 4.5l4.3 4.3" />
    </SelectionIcon>
  );
}

function RetryIcon() {
  return (
    <SelectionIcon>
      <path d="M15 7.2A5.7 5.7 0 1 0 15.4 12M15 3.9v3.7h-3.7" />
    </SelectionIcon>
  );
}

function CloseSelectionIcon() {
  return (
    <SelectionIcon>
      <path d="m5.5 5.5 9 9m0-9-9 9" />
    </SelectionIcon>
  );
}
