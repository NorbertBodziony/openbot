import { attachmentReferenceIds, serializeAttachmentReference } from "@openbot/contracts/attachment-references";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { DraftAttachment } from "@openbot/contracts/ipc";
import { Portal } from "@solidjs/web";
import { createEffect, createMemo, createSignal, createUniqueId, For, Show } from "solid-js";
import { buildAnimatedAvatarSvg } from "../blobatar";
import type { BotProfile } from "../data";
import { AgentAvatar } from "./AgentAvatar";
import { AnchoredTooltip } from "./conversation/AnchoredTooltip";
import { AttachmentReferenceVisual, appendAttachmentReferenceVisual } from "./conversation/AttachmentReference";

interface ComposerEditorProps {
  botId: string | undefined;
  bots: BotProfile[];
  attachments?: DraftAttachment[];
  value: string;
  placeholder: string;
  ariaLabel: string;
  disabled: boolean;
  onValueChange: (value: string) => void;
  onSubmit: () => void;
  onOpenAttachment?: (attachment: DraftAttachment) => void;
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
  return value.replace(MENTION_PATTERN, (match, name: string, target: string) =>
    target.startsWith("attachment:") ? match : `@${name}`,
  );
}

type PickerOption = { type: "bot"; bot: BotProfile } | { type: "attachment"; attachment: DraftAttachment };

export function ComposerEditor(props: ComposerEditorProps) {
  const [mention, setMention] = createSignal<MentionContext | null>(null);
  const [activeOption, setActiveOption] = createSignal(0);
  const [attachmentTooltip, setAttachmentTooltip] = createSignal<{
    anchor: HTMLElement;
    content: string;
  } | null>(null);
  const attachmentTooltipId = `composer-file-tooltip-${createUniqueId()}`;
  const [pickerPosition, setPickerPosition] = createSignal<PickerPosition>({
    bottom: 0,
    left: 0,
    width: 0,
  });
  const matchingBots = createMemo(() => {
    const query = mention()?.query.trim().toLocaleLowerCase() ?? "";
    return props.bots.filter(
      (bot) => bot.id !== props.botId && (!query || `${bot.name} ${bot.role}`.toLocaleLowerCase().includes(query)),
    );
  });
  const matchingAttachments = createMemo(() => {
    const query = mention()?.query.trim().toLocaleLowerCase() ?? "";
    const referencedIds = attachmentReferenceIds(props.value);
    return (props.attachments ?? []).filter(
      (attachment) =>
        !referencedIds.has(attachment.id) && (!query || attachment.name.toLocaleLowerCase().includes(query)),
    );
  });
  const matchingOptions = createMemo<PickerOption[]>(() => [
    ...matchingBots().map((bot) => ({ type: "bot" as const, bot })),
    ...matchingAttachments().map((attachment) => ({
      type: "attachment" as const,
      attachment,
    })),
  ]);
  let editor: HTMLDivElement | undefined;
  let lastBotId: string | undefined;
  let lastAttachmentKey = "";
  let lastEmittedValue = "";
  let isComposing = false;
  const attachmentTokenActions: AttachmentTokenActions = {
    tooltipId: attachmentTooltipId,
    open: (attachment, keepTooltip = false) => {
      if (!keepTooltip) setAttachmentTooltip(null);
      props.onOpenAttachment?.(attachment);
    },
    showTooltip: (anchor, content) => {
      const label = anchor.querySelector<HTMLElement>(".inline-file-reference-name");
      if (!label || label.scrollWidth <= label.clientWidth + 1) {
        setAttachmentTooltip(null);
        return;
      }
      setAttachmentTooltip({ anchor, content });
    },
    hideTooltip: (anchor) => {
      if (attachmentTooltip()?.anchor === anchor) setAttachmentTooltip(null);
    },
    remove: (token) => {
      setAttachmentTooltip(null);
      token.remove();
      emitValue();
      editor?.focus();
    },
  };

  createEffect(
    () => ({
      botId: props.botId,
      value: props.value,
      bots: props.bots,
      attachments: props.attachments ?? [],
    }),
    ({ botId, value, bots, attachments }) => {
      if (!editor) return;
      const attachmentKey = attachments.map((attachment) => `${attachment.id}:${attachment.name}`).join("|");
      if (botId === lastBotId && value === lastEmittedValue && attachmentKey === lastAttachmentKey) return;
      lastBotId = botId;
      lastAttachmentKey = attachmentKey;
      lastEmittedValue = value;
      setAttachmentTooltip(null);
      renderEditorValue(editor, value, bots, attachments, attachmentTokenActions);
      setMention(null);
    },
  );

  function emitValue() {
    if (!editor) return;
    let value = serializeEditor(editor);
    if (value.length > INPUT_LIMITS.messageText) {
      value = truncateComposerValue(value, INPUT_LIMITS.messageText);
      setAttachmentTooltip(null);
      renderEditorValue(editor, value, props.bots, props.attachments ?? [], attachmentTokenActions);
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

  function insertOption(option: PickerOption) {
    const context = mention();
    if (!editor || !context) return;
    const range = rangeFromTextOffsets(editor, context.start, context.end);
    if (!range) return;
    range.deleteContents();
    const token =
      option.type === "bot"
        ? createMentionToken(option.bot)
        : createAttachmentToken(option.attachment, attachmentTokenActions);
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

    const options = matchingOptions();
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
        if (bot) insertOption(bot);
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

    const text = clipboard.getData("text/plain").replace(/\r\n?/g, "\n").slice(0, INPUT_LIMITS.messageText);
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
        <Show when={mention() && matchingOptions().length > 0}>
          <div
            class="mention-picker"
            role="listbox"
            aria-label="Insert mention"
            style={{
              bottom: `${pickerPosition().bottom}px`,
              left: `${pickerPosition().left}px`,
              width: `${pickerPosition().width}px`,
            }}
          >
            <Show when={matchingBots().length > 0}>
              <div class="mention-picker-section">Agents</div>
            </Show>
            <For each={matchingBots()}>
              {(bot, index) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={activeOption() === index() ? "true" : "false"}
                  class={["mention-picker-option", { "mention-picker-option-active": activeOption() === index() }]}
                  onPointerDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveOption(index())}
                  onClick={() => insertOption({ type: "bot", bot })}
                >
                  <AgentAvatar bot={bot} />
                  <strong>{bot.name}</strong>
                  <span>Agent</span>
                </button>
              )}
            </For>
            <Show when={matchingAttachments().length > 0}>
              <div class="mention-picker-section">Files</div>
            </Show>
            <For each={matchingAttachments()}>
              {(attachment, index) => {
                const optionIndex = () => matchingBots().length + index();
                return (
                  <button
                    type="button"
                    role="option"
                    aria-selected={activeOption() === optionIndex() ? "true" : "false"}
                    aria-label={`${attachment.name} File`}
                    class={[
                      "mention-picker-option",
                      "mention-picker-file-option",
                      { "mention-picker-option-active": activeOption() === optionIndex() },
                    ]}
                    onPointerDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setActiveOption(optionIndex())}
                    onClick={() => insertOption({ type: "attachment", attachment })}
                  >
                    <AttachmentReferenceVisual name={attachment.name} />
                    <strong>{attachment.name}</strong>
                    <span>File</span>
                  </button>
                );
              }}
            </For>
          </div>
        </Show>
      </Portal>
      <Show when={attachmentTooltip()}>
        {(activeTooltip) => (
          <AnchoredTooltip id={attachmentTooltipId} anchor={activeTooltip().anchor} content={activeTooltip().content} />
        )}
      </Show>
    </div>
  );
}

function truncateComposerValue(value: string, limit: number): string {
  if (value.length <= limit) return value;
  let result = "";
  let cursor = 0;
  for (const match of value.matchAll(MENTION_PATTERN)) {
    const index = match.index ?? 0;
    const text = value.slice(cursor, index);
    if (result.length + text.length >= limit) {
      return result + text.slice(0, limit - result.length);
    }
    result += text;
    if (result.length + match[0].length > limit) return result;
    result += match[0];
    cursor = index + match[0].length;
  }
  return result + value.slice(cursor, cursor + limit - result.length);
}

interface AttachmentTokenActions {
  tooltipId: string;
  open: (attachment: DraftAttachment, keepTooltip?: boolean) => void;
  showTooltip: (anchor: HTMLElement, content: string) => void;
  hideTooltip: (anchor: HTMLElement) => void;
  remove: (token: HTMLElement) => void;
}

function createAttachmentToken(attachment: DraftAttachment, actions: AttachmentTokenActions): HTMLSpanElement {
  const token = document.createElement("span");
  token.className = "composer-file-reference";
  token.contentEditable = "false";
  token.dataset.attachmentReferenceId = attachment.id;
  token.dataset.attachmentReferenceName = attachment.name;
  token.setAttribute("role", "button");
  token.setAttribute("tabindex", "0");
  token.setAttribute("aria-label", `Open attached file ${attachment.name}`);
  token.setAttribute("aria-describedby", actions.tooltipId);
  appendAttachmentReferenceVisual(token, attachment.name);
  const name = document.createElement("span");
  name.className = "inline-file-reference-name";
  name.textContent = attachment.name;
  token.append(name);
  const showTooltip = () => actions.showTooltip(token, attachment.name);
  const hideTooltip = () => actions.hideTooltip(token);
  token.addEventListener("pointerenter", showTooltip);
  token.addEventListener("pointerleave", hideTooltip);
  token.addEventListener("focus", showTooltip);
  token.addEventListener("blur", hideTooltip);
  token.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hideTooltip();
      return;
    }
    if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      event.stopPropagation();
      actions.remove(token);
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    actions.open(attachment);
  });
  token.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (usesTouchLayout()) showTooltip();
    actions.open(attachment, usesTouchLayout());
  });
  return token;
}

function usesTouchLayout(): boolean {
  return window.matchMedia?.("(hover: none), (pointer: coarse)").matches ?? false;
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
  if (bot.avatarUrl) {
    const image = document.createElement("img");
    image.src = bot.avatarUrl;
    image.alt = "";
    image.draggable = false;
    image.addEventListener("error", () => {
      avatar.innerHTML = buildAnimatedAvatarSvg(bot.avatarSeed, bot.avatarHue);
    });
    avatar.append(image);
  } else {
    avatar.innerHTML = buildAnimatedAvatarSvg(bot.avatarSeed, bot.avatarHue);
  }
  const name = document.createElement("span");
  name.textContent = bot.name;
  token.append(avatar, name);
  return token;
}

function renderEditorValue(
  editor: HTMLDivElement,
  value: string,
  bots: BotProfile[],
  attachments: DraftAttachment[],
  attachmentTokenActions: AttachmentTokenActions,
) {
  editor.replaceChildren();
  let cursor = 0;
  for (const match of value.matchAll(MENTION_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) editor.append(document.createTextNode(value.slice(cursor, index)));
    const name = match[1] ?? "Agent";
    const target = match[2] ?? "";
    if (target.startsWith("attachment:")) {
      const id = target.slice("attachment:".length);
      const attachment = attachments.find((candidate) => candidate.id === id);
      editor.append(
        attachment ? createAttachmentToken(attachment, attachmentTokenActions) : document.createTextNode(name),
      );
      cursor = index + match[0].length;
      continue;
    }
    const id = target;
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
          avatarUrl: null,
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
  if (editor.textContent === "" && !editor.querySelector("[data-mention-id], [data-attachment-reference-id]"))
    return "";
  return Array.from(editor.childNodes).map(serializeNode).join("");
}

function serializeNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (!(node instanceof HTMLElement)) return "";
  const attachmentId = node.dataset.attachmentReferenceId;
  const attachmentName = node.dataset.attachmentReferenceName;
  if (attachmentId && attachmentName) {
    return serializeAttachmentReference(attachmentName, attachmentId);
  }
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
