import { attachmentReferenceIds, serializeAttachmentReference } from "@openbot/contracts/attachment-references";
import { chatTagReferences, serializeChatTagReference } from "@openbot/contracts/chat-tag-references";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { DraftAttachment, InstalledSkill } from "@openbot/contracts/ipc";
import { Portal } from "@solidjs/web";
import { createEffect, createMemo, createSignal, createUniqueId, Show } from "solid-js";
import { createStaticAvatarSvg } from "../../bloub-avatar";
import { AgentAvatar } from "../../components/AgentAvatar";
import { Listbox, Puzzle } from "../../components/ui";
import type { AgentProfile } from "../../data";
import { AnchoredTooltip } from "./AnchoredTooltip";
import { AttachmentReferenceVisual, appendAttachmentReferenceVisual } from "./AttachmentReference";

interface ComposerEditorProps {
  agentId: string | undefined;
  agents: AgentProfile[];
  skills?: InstalledSkill[];
  attachments?: DraftAttachment[];
  value: string;
  placeholder: string;
  ariaLabel: string;
  disabled: boolean;
  focusRequest?: number;
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
  return value.replace(MENTION_PATTERN, (match, name: string, target: string) => {
    if (target.includes(":")) return match;
    return serializeChatTagReference("agent", name, target);
  });
}

type PickerOption =
  | { type: "agent"; agent: AgentProfile }
  | { type: "skill"; skill: InstalledSkill }
  | { type: "attachment"; attachment: DraftAttachment };

function pickerOptionKey(option: PickerOption): string {
  if (option.type === "agent") return `agent:${option.agent.id}`;
  return option.type === "skill" ? `skill:${option.skill.skillId}` : `attachment:${option.attachment.id}`;
}

function pickerOptionText(option: PickerOption): string {
  if (option.type === "agent") return `${option.agent.name} Agent`;
  return option.type === "skill" ? `${option.skill.name} Skill` : `${option.attachment.name} File`;
}

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
  const matchingAgents = createMemo(() => {
    const query = mention()?.query.trim().toLocaleLowerCase() ?? "";
    return props.agents.filter(
      (agent) =>
        agent.id !== props.agentId &&
        (!query || `${agent.name} ${agent.title} ${agent.description}`.toLocaleLowerCase().includes(query)),
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
  const matchingSkills = createMemo(() => {
    const query = mention()?.query.trim().toLocaleLowerCase() ?? "";
    return (props.skills ?? []).filter(
      (skill) =>
        skill.state !== "needs-repair" && (!query || `${skill.name} ${skill.slug}`.toLocaleLowerCase().includes(query)),
    );
  });
  const matchingOptions = createMemo<PickerOption[]>(() => [
    ...matchingAgents().map((agent) => ({ type: "agent" as const, agent })),
    ...matchingSkills().map((skill) => ({ type: "skill" as const, skill })),
    ...matchingAttachments().map((attachment) => ({
      type: "attachment" as const,
      attachment,
    })),
  ]);
  const activePickerValue = createMemo(() => {
    const option = matchingOptions()[activeOption()];
    return option ? new Set([pickerOptionKey(option)]) : new Set<string>();
  });
  const pickerOptionElements = new Map<string, HTMLElement>();
  let editor: HTMLDivElement | undefined;
  let lastAgentId: string | undefined;
  let lastAttachmentKey = "";
  let lastSkillKey = "";
  let lastEmittedValue = "";
  let lastFocusRequest = 0;
  let isComposing = false;
  let nextPrintableKeyId = 0;
  let manualPrintableInput = false;
  const pendingPrintableKeys = new Map<number, string>();
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
      agentId: props.agentId,
      value: props.value,
      agents: props.agents,
      skills: props.skills ?? [],
      attachments: props.attachments ?? [],
      focusRequest: props.focusRequest ?? 0,
    }),
    ({ agentId, value, agents, skills, attachments, focusRequest }) => {
      if (!editor) return;
      const attachmentKey = attachments.map((attachment) => `${attachment.id}:${attachment.name}`).join("|");
      const skillKey = skills.map((skill) => `${skill.skillId}:${skill.name}:${skill.state}`).join("|");
      const contentChanged =
        agentId !== lastAgentId || value !== lastEmittedValue || attachmentKey !== lastAttachmentKey;
      const skillsChanged = skillKey !== lastSkillKey;
      const focusRequested = focusRequest > lastFocusRequest;
      if (contentChanged) {
        lastAgentId = agentId;
        lastAttachmentKey = attachmentKey;
        lastEmittedValue = value;
        setAttachmentTooltip(null);
        renderEditorValue(editor, value, agents, skills, attachments, attachmentTokenActions);
        syncTrailingLineSentinel(editor, value);
        setMention(null);
      } else if (skillsChanged) {
        syncSkillTokens(editor, skills);
      }
      lastSkillKey = skillKey;
      if (focusRequested) {
        lastFocusRequest = focusRequest;
        editor.focus();
        placeCaretAtEnd(editor);
      }
    },
  );

  function emitValue() {
    if (!editor) return;
    let value = serializeEditor(editor);
    if (value.length > INPUT_LIMITS.messageText) {
      value = truncateComposerValue(value, INPUT_LIMITS.messageText);
      setAttachmentTooltip(null);
      renderEditorValue(
        editor,
        value,
        props.agents,
        props.skills ?? [],
        props.attachments ?? [],
        attachmentTokenActions,
      );
      placeCaretAtEnd(editor);
    }
    syncTrailingLineSentinel(editor, value);
    lastEmittedValue = value;
    props.onValueChange(value);
  }

  function insertPrintableKey(key: string) {
    if (!editor) return;
    insertPlainText(editor, key);
    emitValue();
    updateMention();
    editor.scrollTop = editor.scrollHeight;
  }

  function acknowledgeNativePrintableInput(event: InputEvent) {
    if (event.inputType !== "insertText" || !event.data) return;
    let matchingKeyId: number | undefined;
    for (const [keyId, key] of pendingPrintableKeys) {
      if (key === event.data) matchingKeyId = keyId;
    }
    if (matchingKeyId !== undefined) pendingPrintableKeys.delete(matchingKeyId);
  }

  function schedulePrintableInputFallback(key: string) {
    const keyId = ++nextPrintableKeyId;
    pendingPrintableKeys.set(keyId, key);
    window.setTimeout(() => {
      if (!pendingPrintableKeys.delete(keyId) || !editor || editor.ownerDocument.activeElement !== editor) return;
      manualPrintableInput = true;
      insertPrintableKey(key);
    }, 0);
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
    const gutter = 12;
    const width = Math.min(720, bounds.width + 36, window.innerWidth - gutter * 2);
    setPickerPosition({
      bottom: window.innerHeight - bounds.top + 10,
      left: Math.max(gutter, Math.min(bounds.left, window.innerWidth - width - gutter)),
      width,
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
      option.type === "agent"
        ? createMentionToken(option.agent)
        : option.type === "skill"
          ? createSkillToken(option.skill)
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

  function ensureEditorSelection(normalize = false) {
    if (!editor) return;
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    if (!range || !editor.contains(range.commonAncestorContainer)) {
      if (normalize) editor.normalize();
      placeCaretAtEnd(editor);
      return;
    }
    if (!normalize) return;
    const startPrefix = range.cloneRange();
    startPrefix.selectNodeContents(editor);
    startPrefix.setEnd(range.startContainer, range.startOffset);
    const endPrefix = range.cloneRange();
    endPrefix.selectNodeContents(editor);
    endPrefix.setEnd(range.endContainer, range.endOffset);
    const start = startPrefix.toString().length;
    const end = endPrefix.toString().length;
    editor.normalize();
    const normalizedRange = rangeFromTextOffsets(editor, start, end);
    if (!normalizedRange) return;
    selection?.removeAllRanges();
    selection?.addRange(normalizedRange);
  }

  function moveActiveOption(delta: number, optionCount: number) {
    setActiveOption((current) => {
      const next = (current + delta + optionCount) % optionCount;
      const option = matchingOptions()[next];
      if (option) {
        queueMicrotask(() => pickerOptionElements.get(pickerOptionKey(option))?.scrollIntoView?.({ block: "nearest" }));
      }
      return next;
    });
  }

  function handleMentionPickerKeyDown(event: KeyboardEvent): boolean {
    if (!mention()) return false;
    const options = matchingOptions();
    if (event.key === "Escape") {
      event.preventDefault();
      setMention(null);
      return true;
    }
    if (options.length === 0) return false;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActiveOption(1, options.length);
      return true;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActiveOption(-1, options.length);
      return true;
    }
    if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
      event.preventDefault();
      const option = options[activeOption()];
      if (option) insertOption(option);
      return true;
    }
    return false;
  }

  function removeAdjacentMention(key: "Backspace" | "Delete"): boolean {
    if (!editor) return false;
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    if (!range?.collapsed || !editor.contains(range.commonAncestorContainer)) return false;
    const token = mentionTokenAtCaretBoundary(editor, range, key);
    if (!token) return false;

    const tokenParent = token.parentNode;
    if (!tokenParent) return false;
    const caretOffset = Array.from(tokenParent.childNodes).indexOf(token);
    token.remove();
    setMention(null);
    emitValue();
    editor.focus();
    placeCaretAtChildOffset(tokenParent, Math.min(caretOffset, tokenParent.childNodes.length));
    return true;
  }

  function removeAutomaticMentionSpace(): boolean {
    if (!editor) return false;
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    if (!range?.collapsed || !editor.contains(range.commonAncestorContainer)) return false;
    const boundary = automaticMentionSpaceAtCaretBoundary(editor, range);
    if (!boundary) return false;

    boundary.text.deleteData(boundary.offset - 1, 1);
    if (!boundary.text.data) boundary.text.remove();
    const tokenParent = boundary.token.parentNode;
    if (!tokenParent) return false;
    const caretOffset = Array.from(tokenParent.childNodes).indexOf(boundary.token) + 1;
    setMention(null);
    emitValue();
    editor.focus();
    placeCaretAtChildOffset(tokenParent, caretOffset);
    return true;
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (event.key === "Enter" && (isComposing || event.isComposing)) return;
    if (handleMentionPickerKeyDown(event)) return;
    if (event.key === "Backspace" && removeAutomaticMentionSpace()) {
      event.preventDefault();
      return;
    }
    if ((event.key === "Backspace" || event.key === "Delete") && removeAdjacentMention(event.key)) {
      event.preventDefault();
      return;
    }
    ensureEditorSelection();

    if (event.key === "Backspace" && removeTrailingLineBreak()) {
      event.preventDefault();
      return;
    }

    if (event.key.toLocaleLowerCase() === "a" && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      if (!editor) return;
      const range = document.createRange();
      range.selectNodeContents(editor);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return;
    }

    const printableKey = event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.isComposing;
    if (printableKey) {
      if (manualPrintableInput) {
        event.preventDefault();
        insertPrintableKey(event.key);
      } else {
        schedulePrintableInputFallback(event.key);
      }
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

  function removeTrailingLineBreak(): boolean {
    if (!editor) return false;
    const value = serializeEditor(editor);
    if (!value.endsWith("\n")) return false;
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    if (!range?.collapsed || !editor.contains(range.commonAncestorContainer)) return false;
    const afterCaret = range.cloneRange();
    afterCaret.setEndAfter(editor.lastChild ?? editor);
    if (afterCaret.toString()) return false;

    const nextValue = value.slice(0, -1);
    renderEditorValue(
      editor,
      nextValue,
      props.agents,
      props.skills ?? [],
      props.attachments ?? [],
      attachmentTokenActions,
    );
    syncTrailingLineSentinel(editor, nextValue);
    placeCaretAtEnd(editor);
    emitValue();
    updateMention();
    return true;
  }

  function handlePaste(event: ClipboardEvent) {
    event.preventDefault();
    if (!editor || props.disabled) return;

    const clipboard = event.clipboardData;
    const hasFileItem = Array.from(clipboard?.items ?? []).some((item) => item.kind === "file");
    if (!clipboard || clipboard.files.length > 0 || hasFileItem) return;

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
        onFocus={() => ensureEditorSelection(true)}
        onInput={(event) => {
          acknowledgeNativePrintableInput(event);
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
          pendingPrintableKeys.clear();
          manualPrintableInput = false;
          isComposing = false;
          window.setTimeout(() => setMention(null), 100);
        }}
      />
      <Portal>
        <Show when={mention() && matchingOptions().length > 0}>
          <Listbox.Root<PickerOption>
            as="div"
            class="mention-picker"
            aria-label="Insert mention"
            options={matchingOptions()}
            optionValue={pickerOptionKey}
            optionTextValue={pickerOptionText}
            selectionMode="single"
            disallowEmptySelection={true}
            allowDuplicateSelectionEvents={true}
            shouldUseVirtualFocus={true}
            shouldFocusOnHover={true}
            shouldSelectOnPressUp={true}
            value={activePickerValue()}
            onChange={(keys) => {
              const key = keys.values().next().value;
              const option = matchingOptions().find((candidate) => pickerOptionKey(candidate) === key);
              if (option) insertOption(option);
            }}
            renderItem={(item) => {
              const option = item.rawValue;
              const optionIndex = () =>
                matchingOptions().findIndex((candidate) => pickerOptionKey(candidate) === item.key);
              const firstSkillIndex = () => matchingAgents().length;
              const firstAttachmentIndex = () => matchingAgents().length + matchingSkills().length;
              return (
                <>
                  <Show when={option.type === "agent" && item.index === 0}>
                    <div class="mention-picker-section">Agents</div>
                  </Show>
                  <Show when={option.type === "skill" && item.index === firstSkillIndex()}>
                    <div class="mention-picker-section">Skills</div>
                  </Show>
                  <Show when={option.type === "attachment" && item.index === firstAttachmentIndex()}>
                    <div class="mention-picker-section">Files</div>
                  </Show>
                  <Listbox.Item
                    ref={(element) => pickerOptionElements.set(pickerOptionKey(option), element)}
                    item={item}
                    aria-label={pickerOptionText(option)}
                    class={[
                      "mention-picker-option",
                      {
                        "mention-picker-file-option": option.type === "attachment",
                        "mention-picker-option-active": activeOption() === optionIndex(),
                      },
                    ]}
                    onPointerDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setActiveOption(optionIndex())}
                  >
                    {option.type === "agent" ? (
                      <AgentAvatar agent={option.agent} />
                    ) : option.type === "skill" ? (
                      <span class="mention-picker-skill-icon" aria-hidden="true">
                        <Puzzle />
                      </span>
                    ) : (
                      <AttachmentReferenceVisual name={option.attachment.name} />
                    )}
                    <strong>
                      {option.type === "agent"
                        ? option.agent.name
                        : option.type === "skill"
                          ? option.skill.name
                          : option.attachment.name}
                    </strong>
                    <span>{option.type === "agent" ? "Agent" : option.type === "skill" ? "Skill" : "File"}</span>
                  </Listbox.Item>
                </>
              );
            }}
            style={{
              bottom: `${pickerPosition().bottom}px`,
              left: `${pickerPosition().left}px`,
              width: `${pickerPosition().width}px`,
            }}
          />
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

function createMentionToken(agent: AgentProfile): HTMLSpanElement {
  const token = document.createElement("span");
  token.className = "composer-mention-token";
  token.contentEditable = "false";
  token.dataset.mentionId = agent.id;
  token.dataset.mentionName = agent.name;
  token.setAttribute("aria-label", `Agent ${agent.name}`);
  const avatar = document.createElement("span");
  avatar.className = "composer-mention-avatar agent-avatar-motion-hover";
  if (agent.avatarUrl) {
    const image = document.createElement("img");
    image.src = agent.avatarUrl;
    image.alt = "";
    image.draggable = false;
    image.addEventListener("error", () => {
      scheduleStaticMentionAvatar(avatar, agent);
    });
    avatar.append(image);
  } else {
    scheduleStaticMentionAvatar(avatar, agent);
  }
  const name = document.createElement("span");
  name.textContent = agent.name;
  token.append(avatar, name);
  return token;
}

function createSkillToken(skill: InstalledSkill): HTMLSpanElement {
  const token = document.createElement("span");
  updateSkillToken(token, skill);
  return token;
}

function updateSkillToken(token: HTMLSpanElement, skill: InstalledSkill): void {
  token.className = "composer-mention-token composer-skill-token";
  token.contentEditable = "false";
  token.dataset.skillId = skill.skillId;
  token.dataset.skillName = skill.name;
  token.removeAttribute("aria-label");
  token.setAttribute("aria-label", `Skill ${skill.name}`);
  const icon = Puzzle({ class: "composer-skill-icon" });
  if (!(icon instanceof Node)) throw new Error("Puzzle icon did not render to a DOM node");
  const name = document.createElement("span");
  name.textContent = skill.name;
  token.replaceChildren(icon, name);
}

function createUnavailableTagToken(kind: "agent" | "skill", id: string, name: string): HTMLSpanElement {
  const token = document.createElement("span");
  if (kind === "skill") {
    updateUnavailableSkillToken(token, id, name);
    return token;
  }
  token.className = "composer-mention-token composer-tag-unavailable";
  token.contentEditable = "false";
  token.dataset.mentionId = id;
  token.dataset.mentionName = name;
  token.setAttribute("aria-label", `Unavailable ${kind} ${name}`);
  token.textContent = name;
  return token;
}

function updateUnavailableSkillToken(token: HTMLSpanElement, id: string, name: string): void {
  token.className = "composer-mention-token composer-tag-unavailable";
  token.contentEditable = "false";
  token.dataset.skillId = id;
  token.dataset.skillName = name;
  token.setAttribute("aria-label", `Unavailable skill ${name}`);
  token.textContent = name;
}

function syncSkillTokens(editor: HTMLDivElement, skills: InstalledSkill[]): void {
  const available = new Map(
    skills.filter((skill) => skill.state !== "needs-repair").map((skill) => [skill.skillId, skill]),
  );
  for (const token of editor.querySelectorAll<HTMLSpanElement>("[data-skill-id]")) {
    const id = token.dataset.skillId;
    if (!id) continue;
    const skill = available.get(id);
    if (skill) updateSkillToken(token, skill);
    else updateUnavailableSkillToken(token, id, token.dataset.skillName ?? "Skill");
  }
}

function renderEditorValue(
  editor: HTMLDivElement,
  value: string,
  agents: AgentProfile[],
  skills: InstalledSkill[],
  attachments: DraftAttachment[],
  attachmentTokenActions: AttachmentTokenActions,
) {
  editor.replaceChildren();
  let cursor = 0;
  for (const match of value.matchAll(MENTION_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) editor.append(document.createTextNode(value.slice(cursor, index)));
    const semanticReference = chatTagReferences(match[0])[0];
    const name = semanticReference?.name ?? match[1] ?? "Agent";
    const target = semanticReference ? `${semanticReference.kind}:${semanticReference.id}` : (match[2] ?? "");
    if (target.startsWith("attachment:")) {
      const id = target.slice("attachment:".length);
      const attachment = attachments.find((candidate) => candidate.id === id);
      editor.append(
        attachment ? createAttachmentToken(attachment, attachmentTokenActions) : document.createTextNode(name),
      );
      cursor = index + match[0].length;
      continue;
    }
    if (target.startsWith("skill:")) {
      const id = target.slice("skill:".length);
      const skill = skills.find((candidate) => candidate.skillId === id && candidate.state !== "needs-repair");
      editor.append(skill ? createSkillToken(skill) : createUnavailableTagToken("skill", id, name));
      cursor = index + match[0].length;
      continue;
    }
    const id = target.startsWith("agent:") ? target.slice("agent:".length) : target;
    const agent = agents.find((candidate) => candidate.id === id);
    editor.append(agent ? createMentionToken(agent) : createUnavailableTagToken("agent", id, name));
    cursor = index + match[0].length;
  }
  if (cursor < value.length) editor.append(document.createTextNode(value.slice(cursor)));
}

function scheduleStaticMentionAvatar(avatar: HTMLElement, agent: AgentProfile): void {
  queueMicrotask(() => {
    if (!avatar.isConnected) return;
    avatar.replaceChildren(createStaticAvatarSvg(agent.avatarSeed, agent.avatarHue));
  });
}

function serializeEditor(editor: HTMLDivElement): string {
  if (
    editor.textContent === "" &&
    !editor.querySelector("[data-mention-id], [data-skill-id], [data-attachment-reference-id]")
  )
    return "";
  return Array.from(editor.childNodes).map(serializeNode).join("");
}

function serializeNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (!(node instanceof HTMLElement)) return "";
  if (node.dataset.composerTrailingLine !== undefined) return "";
  const attachmentId = node.dataset.attachmentReferenceId;
  const attachmentName = node.dataset.attachmentReferenceName;
  if (attachmentId && attachmentName) {
    return serializeAttachmentReference(attachmentName, attachmentId);
  }
  const mentionId = node.dataset.mentionId;
  const mentionName = node.dataset.mentionName;
  if (mentionId && mentionName) return serializeChatTagReference("agent", mentionName, mentionId);
  const skillId = node.dataset.skillId;
  const skillName = node.dataset.skillName;
  if (skillId && skillName) return serializeChatTagReference("skill", skillName, skillId);
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

  const prefix = range.cloneRange();
  prefix.selectNodeContents(editor);
  prefix.setEnd(range.startContainer, range.startOffset);
  const caretOffset = prefix.toString().length + text.length;
  range.deleteContents();
  range.insertNode(document.createTextNode(text));
  editor.normalize();
  syncTrailingLineSentinel(editor);
  const caretRange = rangeFromTextOffsets(editor, caretOffset, caretOffset);
  if (!caretRange) return;
  selection?.removeAllRanges();
  selection?.addRange(caretRange);
}

function syncTrailingLineSentinel(editor: HTMLDivElement, value = serializeEditor(editor)): void {
  const existing = editor.querySelector<HTMLElement>("[data-composer-trailing-line]");
  existing?.remove();
  if (!value.endsWith("\n")) return;

  const sentinel = document.createElement("span");
  sentinel.className = "composer-trailing-line";
  sentinel.dataset.composerTrailingLine = "";
  sentinel.contentEditable = "false";
  sentinel.setAttribute("aria-hidden", "true");
  editor.append(sentinel);
}

function placeCaretAtEnd(editor: HTMLDivElement): void {
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function placeCaretAtChildOffset(container: Node, offset: number): void {
  const range = document.createRange();
  range.setStart(container, offset);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function mentionTokenAtCaretBoundary(
  editor: HTMLDivElement,
  range: Range,
  key: "Backspace" | "Delete",
): HTMLElement | null {
  const tokenAtCaret = closestMentionToken(range.startContainer, editor);
  if (tokenAtCaret) return tokenAtCaret;

  let candidate: Node | null = null;
  const container = range.startContainer;
  if (container === editor) {
    candidate = editor.childNodes[key === "Backspace" ? range.startOffset - 1 : range.startOffset] ?? null;
  } else if (container.nodeType === Node.TEXT_NODE) {
    const length = container.textContent?.length ?? 0;
    const atBoundary = key === "Backspace" ? range.startOffset === 0 : range.startOffset === length;
    if (!atBoundary) return null;
    const directChild = directChildOf(editor, container);
    candidate = key === "Backspace" ? (directChild?.previousSibling ?? null) : (directChild?.nextSibling ?? null);
  } else if (container instanceof HTMLElement) {
    candidate =
      container.childNodes[key === "Backspace" ? range.startOffset - 1 : range.startOffset] ??
      (key === "Backspace" ? container.previousSibling : container.nextSibling);
  }

  while (candidate?.nodeType === Node.TEXT_NODE && !candidate.textContent) {
    candidate = key === "Backspace" ? candidate.previousSibling : candidate.nextSibling;
  }
  return candidate ? closestMentionToken(candidate, editor) : null;
}

function closestMentionToken(node: Node, editor: HTMLDivElement): HTMLElement | null {
  const element = node instanceof HTMLElement ? node : node.parentElement;
  const token = element?.closest<HTMLElement>("[data-mention-id], [data-skill-id]") ?? null;
  return token && editor.contains(token) ? token : null;
}

function directChildOf(editor: HTMLDivElement, node: Node): Node | null {
  let current: Node | null = node;
  while (current?.parentNode && current.parentNode !== editor) current = current.parentNode;
  return current?.parentNode === editor ? current : null;
}

function automaticMentionSpaceAtCaretBoundary(
  editor: HTMLDivElement,
  range: Range,
): { text: Text; offset: number; token: HTMLElement } | null {
  const container = range.startContainer;
  let text: Text | null = null;
  let offset = 0;
  if (isTextNode(container)) {
    text = container;
    offset = range.startOffset;
    if (!offset && !text.data) {
      const candidate = previousNonemptySibling(text.previousSibling);
      if (!candidate || !isTextNode(candidate)) return null;
      text = candidate;
      offset = candidate.data.length;
    }
  } else if (container === editor) {
    const candidate = previousNonemptySibling(editor.childNodes[range.startOffset - 1] ?? null);
    if (!candidate || !isTextNode(candidate)) return null;
    text = candidate;
    offset = candidate.data.length;
  }

  if (!text || offset !== 1 || text.data[0] !== " ") return null;
  let previous = text.previousSibling;
  while (previous && isTextNode(previous) && !previous.data) previous = previous.previousSibling;
  const token = previous ? closestMentionToken(previous, editor) : null;
  return token ? { text, offset, token } : null;
}

function isTextNode(node: Node): node is Text {
  return node.nodeType === Node.TEXT_NODE;
}

function previousNonemptySibling(node: Node | null): Node | null {
  let candidate = node;
  while (candidate?.nodeType === Node.TEXT_NODE && !candidate.textContent) candidate = candidate.previousSibling;
  return candidate;
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
