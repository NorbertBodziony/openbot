import { Portal } from "@solidjs/web";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { INPUT_LIMITS } from "../../../shared/input-limits";
import { buildAnimatedAvatarSvg } from "../blobatar";
import type { BotProfile } from "../data";
import { AgentAvatar } from "./AgentAvatar";

interface ComposerEditorProps {
  botId: string | undefined;
  bots: BotProfile[];
  value: string;
  placeholder: string;
  ariaLabel: string;
  disabled: boolean;
  onValueChange: (value: string) => void;
  onSubmit: () => void;
}

interface MentionContext {
  query: string;
  start: number;
  end: number;
}

interface PickerPosition {
  bottom: number;
  left: number;
  width: number;
}

const MENTION_PATTERN = /@\[([^\]]+)]\(([^)]+)\)/g;

export function expandComposerMentions(value: string): string {
  return value.replace(MENTION_PATTERN, (_match, name: string) => `@${name}`);
}

export function ComposerEditor(props: ComposerEditorProps) {
  const [mention, setMention] = createSignal<MentionContext | null>(null);
  const [activeOption, setActiveOption] = createSignal(0);
  const [pickerPosition, setPickerPosition] = createSignal<PickerPosition>({
    bottom: 0,
    left: 0,
    width: 0,
  });
  const matchingBots = createMemo(() => {
    const query = mention()?.query.trim().toLocaleLowerCase() ?? "";
    return props.bots.filter(
      (bot) =>
        bot.id !== props.botId &&
        (!query || `${bot.name} ${bot.role}`.toLocaleLowerCase().includes(query)),
    );
  });
  let editor: HTMLDivElement | undefined;
  let lastBotId: string | undefined;
  let lastEmittedValue = "";
  let isComposing = false;

  createEffect(
    () => ({ botId: props.botId, value: props.value, bots: props.bots }),
    ({ botId, value, bots }) => {
      if (!editor) return;
      if (botId === lastBotId && value === lastEmittedValue) return;
      lastBotId = botId;
      lastEmittedValue = value;
      renderEditorValue(editor, value, bots);
      setMention(null);
    },
  );

  function emitValue() {
    if (!editor) return;
    let value = serializeEditor(editor);
    if (value.length > INPUT_LIMITS.messageText) {
      value = value.slice(0, INPUT_LIMITS.messageText);
      renderEditorValue(editor, value, props.bots);
      placeCaretAtEnd(editor);
    }
    lastEmittedValue = value;
    props.onValueChange(value);
  }

  function updateMention() {
    if (!editor) return;
    const selection = window.getSelection();
    if (!selection?.rangeCount || !editor.contains(selection.anchorNode)) {
      setMention(null);
      return;
    }
    const range = selection.getRangeAt(0).cloneRange();
    range.selectNodeContents(editor);
    range.setEnd(selection.anchorNode ?? editor, selection.anchorOffset);
    const beforeCaret = range.toString();
    const match = beforeCaret.match(/(?:^|\s)@([^@\n]{0,60})$/u);
    if (!match) {
      setMention(null);
      return;
    }
    const query = match[1] ?? "";
    const bounds = editor.getBoundingClientRect();
    setPickerPosition({
      bottom: window.innerHeight - bounds.top + 10,
      left: bounds.left,
      width: Math.min(720, bounds.width + 36),
    });
    setMention({ query, start: beforeCaret.length - query.length - 1, end: beforeCaret.length });
    setActiveOption(0);
  }

  function insertMention(bot: BotProfile) {
    const context = mention();
    if (!editor || !context) return;
    const range = rangeFromTextOffsets(editor, context.start, context.end);
    if (!range) return;
    range.deleteContents();
    const token = createMentionToken(bot);
    const trailingSpace = document.createTextNode(" ");
    range.insertNode(trailingSpace);
    range.insertNode(token);
    const selection = window.getSelection();
    range.setStartAfter(trailingSpace);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
    setMention(null);
    emitValue();
    editor.focus();
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (event.key === "Enter" && (isComposing || event.isComposing)) return;

    const options = matchingBots();
    if (mention() && options.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveOption((current) => (current + 1) % options.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveOption((current) => (current - 1 + options.length) % options.length);
        return;
      }
      if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
        event.preventDefault();
        const bot = options[activeOption()];
        if (bot) insertMention(bot);
        return;
      }
    }
    if (event.key === "Escape" && mention()) {
      event.preventDefault();
      setMention(null);
      return;
    }
    if (event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      if (!editor) return;
      insertPlainText(editor, "\n");
      emitValue();
      updateMention();
      editor.scrollTop = editor.scrollHeight;
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      props.onSubmit();
    }
  }

  function handlePaste(event: ClipboardEvent) {
    event.preventDefault();
    if (!editor || props.disabled) return;

    const clipboard = event.clipboardData;
    if (!clipboard || clipboard.files.length > 0) return;

    const text = clipboard
      .getData("text/plain")
      .replace(/\r\n?/g, "\n")
      .slice(0, INPUT_LIMITS.messageText);
    if (!text) return;

    insertPlainText(editor, text);
    emitValue();
    updateMention();
  }

  return (
    <div class="composer-editor-root">
      <Show when={!props.value}>
        <span class="composer-editor-placeholder" aria-hidden="true">
          {props.placeholder}
        </span>
      </Show>
      {/* biome-ignore lint/a11y/useSemanticElements: contenteditable is required for inline agent chips. */}
      {/* biome-ignore lint/a11y/useFocusableInteractive: Solid 2 uses the lowercase tabindex DOM attribute. */}
      <div
        ref={(element) => (editor = element)}
        class="composer-editor-surface"
        contenteditable={props.disabled ? "false" : "true"}
        role="textbox"
        tabindex={props.disabled ? -1 : 0}
        aria-label={props.ariaLabel}
        aria-disabled={props.disabled ? "true" : "false"}
        aria-multiline="true"
        spellcheck="true"
        onInput={() => {
          emitValue();
          updateMention();
        }}
        onClick={updateMention}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => {
          isComposing = true;
        }}
        onCompositionEnd={() => {
          isComposing = false;
        }}
        onPaste={handlePaste}
        onBlur={() => {
          isComposing = false;
          window.setTimeout(() => setMention(null), 100);
        }}
      />
      <Portal>
        <Show when={mention() && matchingBots().length > 0}>
          <div
            class="mention-picker"
            role="listbox"
            aria-label="Tag an agent"
            style={{
              bottom: `${pickerPosition().bottom}px`,
              left: `${pickerPosition().left}px`,
              width: `${pickerPosition().width}px`,
            }}
          >
            <For each={matchingBots()}>
              {(bot, index) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={activeOption() === index() ? "true" : "false"}
                  class={[
                    "mention-picker-option",
                    { "mention-picker-option-active": activeOption() === index() },
                  ]}
                  onPointerDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveOption(index())}
                  onClick={() => insertMention(bot)}
                >
                  <AgentAvatar bot={bot} />
                  <strong>{bot.name}</strong>
                  <span>Agent</span>
                </button>
              )}
            </For>
          </div>
        </Show>
      </Portal>
    </div>
  );
}

function createMentionToken(bot: BotProfile): HTMLSpanElement {
  const token = document.createElement("span");
  token.className = "composer-mention-token";
  token.contentEditable = "false";
  token.dataset.mentionId = bot.id;
  token.dataset.mentionName = bot.name;
  token.setAttribute("aria-label", `Agent ${bot.name}`);
  const avatar = document.createElement("span");
  avatar.className = "composer-mention-avatar bot-avatar-motion-hover";
  avatar.innerHTML = buildAnimatedAvatarSvg(bot.avatarSeed, bot.avatarHue);
  const name = document.createElement("span");
  name.textContent = bot.name;
  token.append(avatar, name);
  return token;
}

function renderEditorValue(editor: HTMLDivElement, value: string, bots: BotProfile[]) {
  editor.replaceChildren();
  let cursor = 0;
  for (const match of value.matchAll(MENTION_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) editor.append(document.createTextNode(value.slice(cursor, index)));
    const name = match[1] ?? "Agent";
    const id = match[2] ?? "";
    const bot = bots.find((candidate) => candidate.id === id);
    editor.append(
      createMentionToken(
        bot ?? {
          id,
          name,
          role: "Agent",
          description: "",
          notifications: true,
          model: "gpt-5.6-luna",
          reasoningEffort: "medium",
          threadId: null,
          avatarSeed: id || "agent",
          avatarHue: null,
          time: "",
          preview: "",
        },
      ),
    );
    cursor = index + match[0].length;
  }
  if (cursor < value.length) editor.append(document.createTextNode(value.slice(cursor)));
}

function serializeEditor(editor: HTMLDivElement): string {
  if (editor.textContent === "" && !editor.querySelector("[data-mention-id]")) return "";
  return Array.from(editor.childNodes).map(serializeNode).join("");
}

function serializeNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (!(node instanceof HTMLElement)) return "";
  const mentionId = node.dataset.mentionId;
  const mentionName = node.dataset.mentionName;
  if (mentionId && mentionName) return `@[${mentionName}](${mentionId})`;
  if (node.tagName === "BR") return "\n";
  const content = Array.from(node.childNodes).map(serializeNode).join("");
  return node.tagName === "DIV" || node.tagName === "P" ? `${content}\n` : content;
}

function insertPlainText(editor: HTMLDivElement, text: string): void {
  const selection = window.getSelection();
  let range: Range;
  const selectedRange = selection?.rangeCount ? selection.getRangeAt(0) : null;
  if (selectedRange && editor.contains(selectedRange.commonAncestorContainer)) {
    range = selectedRange.cloneRange();
  } else {
    range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
  }

  range.deleteContents();
  const textNode = document.createTextNode(text);
  range.insertNode(textNode);
  range.setStart(textNode, textNode.data.length);
  range.collapse(true);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function placeCaretAtEnd(editor: HTMLDivElement): void {
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function rangeFromTextOffsets(root: HTMLElement, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let offset = 0;
  let startSet = false;
  let node = walker.nextNode();
  while (node) {
    const length = node.textContent?.length ?? 0;
    if (!startSet && start <= offset + length) {
      range.setStart(node, Math.max(0, start - offset));
      startSet = true;
    }
    if (startSet && end <= offset + length) {
      range.setEnd(node, Math.max(0, end - offset));
      return range;
    }
    offset += length;
    node = walker.nextNode();
  }
  if (!startSet) range.setStart(root, root.childNodes.length);
  range.setEnd(root, root.childNodes.length);
  return range;
}
