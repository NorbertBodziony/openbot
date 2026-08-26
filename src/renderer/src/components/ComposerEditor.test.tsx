import { serializeAttachmentReference } from "@openbot/contracts/attachment-references";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { DraftAttachment } from "@openbot/contracts/ipc";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BotProfile } from "../data";
import { ComposerEditor } from "./ComposerEditor";

const originalMatchMedia = window.matchMedia;

afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

function renderComposer(attachments: DraftAttachment[] = [], initialValue = "", bots: BotProfile[] = []) {
  const onSubmit = vi.fn();
  const onValueChange = vi.fn();
  const onOpenAttachment = vi.fn();

  render(() => {
    const [value, setValue] = createSignal(initialValue);
    return (
      <ComposerEditor
        botId="chief"
        bots={bots}
        attachments={attachments}
        value={value()}
        placeholder="Message Chief"
        ariaLabel="Message Chief"
        disabled={false}
        onValueChange={(nextValue) => {
          onValueChange(nextValue);
          setValue(nextValue);
        }}
        onSubmit={onSubmit}
        onOpenAttachment={onOpenAttachment}
      />
    );
  });

  return {
    editor: screen.getByRole("textbox", { name: "Message Chief" }),
    onSubmit,
    onValueChange,
    onOpenAttachment,
  };
}

function placeCaretAtEnd(editor: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function placeCaret(container: Node, offset: number): void {
  const range = document.createRange();
  range.setStart(container, offset);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function testBot(id: string, name: string, description = ""): BotProfile {
  return {
    id,
    name,
    title: "Agent",
    description,
    notifications: true,
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
    threadId: null,
    avatarSeed: id,
    avatarHue: null,
    avatarUrl: null,
    time: "",
    preview: "",
  };
}

describe("ComposerEditor", () => {
  it("focuses the editor and places the caret at the end for a focus request", async () => {
    const [focusRequest, setFocusRequest] = createSignal(0);
    render(() => (
      <ComposerEditor
        botId="chief"
        bots={[]}
        value="Queued message"
        placeholder="Message Chief"
        ariaLabel="Message Chief"
        disabled={false}
        focusRequest={focusRequest()}
        onValueChange={vi.fn()}
        onSubmit={vi.fn()}
      />
    ));
    const editor = screen.getByRole("textbox", { name: "Message Chief" });

    setFocusRequest(1);

    await waitFor(() => expect(editor).toHaveFocus());
    const selection = window.getSelection();
    const range = selection?.getRangeAt(0);
    expect(range?.collapsed).toBe(true);
    expect(range?.endContainer).toBe(editor);
    expect(range?.endOffset).toBe(editor.childNodes.length);
  });

  it("inserts printable keys when the browser omits native input events", async () => {
    const { editor, onValueChange } = renderComposer();
    editor.focus();

    await fireEvent.keyDown(editor, { key: "a" });
    await waitFor(() => expect(editor).toHaveTextContent("a"));
    await fireEvent.keyDown(editor, { key: "b" });
    await fireEvent.keyDown(editor, { key: "c" });

    expect(editor).toHaveTextContent("abc");
    expect(editor.childNodes).toHaveLength(1);
    expect(editor.firstChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(onValueChange).toHaveBeenLastCalledWith("abc");
    expect(editor.contains(window.getSelection()?.getRangeAt(0).commonAncestorContainer ?? null)).toBe(true);
  });

  it("does not duplicate printable keys when a native input event arrives", async () => {
    const { editor, onValueChange } = renderComposer();
    editor.focus();

    await fireEvent.keyDown(editor, { key: "a" });
    editor.textContent = "a";
    await fireEvent.input(editor, { inputType: "insertText", data: "a" });
    await new Promise((resolve) => window.setTimeout(resolve, 10));

    expect(editor).toHaveTextContent("a");
    expect(onValueChange).toHaveBeenLastCalledWith("a");
  });

  it("keeps repeated Shift+Enter line breaks in the draft", async () => {
    const { editor, onSubmit, onValueChange } = renderComposer();
    editor.textContent = "First line";
    placeCaretAtEnd(editor);
    await fireEvent.input(editor);

    await fireEvent.keyDown(editor, { key: "Enter", shiftKey: true });

    expect(editor.querySelector("[data-composer-trailing-line]")).not.toBeNull();
    expect(onValueChange).toHaveBeenLastCalledWith("First line\n");

    placeCaretAtEnd(editor);
    await fireEvent.keyDown(editor, { key: "Enter", shiftKey: true });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(onValueChange).toHaveBeenLastCalledWith("First line\n\n");
    expect(editor.textContent).toBe("First line\n\n");
    expect(editor.querySelectorAll("[data-composer-trailing-line]")).toHaveLength(1);
  });

  it("removes a trailing line break without creating a phantom row", async () => {
    const { editor, onValueChange } = renderComposer([], "First line\n");
    editor.focus();
    placeCaretAtEnd(editor);

    await fireEvent.keyDown(editor, { key: "Backspace" });

    expect(editor.textContent).toBe("First line");
    expect(editor.querySelector("[data-composer-trailing-line]")).toBeNull();
    expect(onValueChange).toHaveBeenLastCalledWith("First line");
  });

  it("submits with Enter without changing the multiline draft", async () => {
    const { editor, onSubmit, onValueChange } = renderComposer();
    editor.textContent = "First line\nSecond line";
    placeCaretAtEnd(editor);
    await fireEvent.input(editor);

    await fireEvent.keyDown(editor, { key: "Enter" });

    expect(onValueChange).toHaveBeenLastCalledWith("First line\nSecond line");
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(editor.textContent).toBe("First line\nSecond line");
  });

  it.each([
    ["Control+A", { ctrlKey: true }],
    ["Command+A", { metaKey: true }],
  ])("selects the full draft with %s and keeps editor focus", async (_shortcut, modifier) => {
    const { editor } = renderComposer([], "Select this entire draft");
    editor.focus();
    placeCaretAtEnd(editor);

    await fireEvent.keyDown(editor, { key: "a", ...modifier });

    const selection = window.getSelection();
    expect(editor).toHaveFocus();
    expect(selection?.toString()).toBe("Select this entire draft");
    expect(selection?.getRangeAt(0).commonAncestorContainer).toBe(editor);
  });

  it.each([
    ["ArrowLeft", { metaKey: true }],
    ["ArrowRight", { altKey: true }],
    ["Backspace", { altKey: true }],
    ["Delete", {}],
  ])("restores an escaped DOM selection before native %s handling", async (key, modifier) => {
    const { editor } = renderComposer([], "Keep native editing active");
    editor.focus();
    const outsideRange = document.createRange();
    outsideRange.selectNodeContents(document.body);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(outsideRange);

    const handled = await fireEvent.keyDown(editor, { key, ...modifier });

    expect(handled).toBe(true);
    expect(editor).toHaveFocus();
    expect(editor.contains(selection?.getRangeAt(0).commonAncestorContainer ?? null)).toBe(true);
  });

  it("normalizes fragmented text nodes on focus without moving the caret", async () => {
    const { editor } = renderComposer();
    editor.replaceChildren(document.createTextNode("First"), document.createTextNode(" second"));
    const range = document.createRange();
    range.setStart(editor.childNodes[1] ?? editor, 3);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    await fireEvent.focus(editor);

    expect(editor.childNodes).toHaveLength(1);
    expect(editor.textContent).toBe("First second");
    expect(selection?.getRangeAt(0).startContainer).toBe(editor.firstChild);
    expect(selection?.getRangeAt(0).startOffset).toBe(8);
  });

  it("does not submit when Enter confirms IME composition", async () => {
    const { editor, onSubmit } = renderComposer();

    await fireEvent.compositionStart(editor);
    await fireEvent.keyDown(editor, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();

    await fireEvent.compositionEnd(editor);
    await fireEvent.keyDown(editor, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("preserves multiline plain text when pasted", async () => {
    const { editor, onValueChange } = renderComposer();
    placeCaretAtEnd(editor);

    await fireEvent.paste(editor, {
      clipboardData: {
        files: [],
        getData: () => "First line\r\nSecond line\rThird line",
      },
    });

    expect(onValueChange).toHaveBeenLastCalledWith("First line\nSecond line\nThird line");
    expect(editor.textContent).toBe("First line\nSecond line\nThird line");
  });

  it("limits typed and pasted messages to the shared message limit", async () => {
    const { editor, onValueChange } = renderComposer();
    editor.textContent = "x".repeat(INPUT_LIMITS.messageText + 1);
    placeCaretAtEnd(editor);
    await fireEvent.input(editor);

    expect(onValueChange).toHaveBeenLastCalledWith("x".repeat(INPUT_LIMITS.messageText));
    expect(editor.textContent).toHaveLength(INPUT_LIMITS.messageText);

    editor.textContent = "";
    placeCaretAtEnd(editor);
    await fireEvent.paste(editor, {
      clipboardData: {
        files: [],
        getData: () => "y".repeat(INPUT_LIMITS.messageText + 1),
      },
    });
    expect(onValueChange).toHaveBeenLastCalledWith("y".repeat(INPUT_LIMITS.messageText));
  });

  it("renders saved mentions with the static agent avatar", async () => {
    const sales: BotProfile = {
      id: "sales",
      provider: "codex",
      name: "Sales",
      title: "Agent",
      description: "",
      notifications: true,
      model: "gpt-5.6-luna",
      reasoningEffort: "medium",
      threadId: null,
      avatarSeed: "sales:avatar:0:2",
      avatarHue: 215,
      avatarUrl: null,
      time: "",
      preview: "",
    };

    render(() => (
      <ComposerEditor
        botId="chief"
        bots={[sales]}
        value="Ask @[Sales](sales)"
        placeholder="Message Chief"
        ariaLabel="Mention test"
        disabled={false}
        onValueChange={() => undefined}
        onSubmit={() => undefined}
      />
    ));

    const token = document.querySelector<HTMLElement>('[data-mention-id="sales"]');
    await waitFor(() =>
      expect(token?.querySelector('.composer-mention-avatar svg[aria-hidden="true"]')).not.toBeNull(),
    );
  });

  it("finds mention targets by title and description", async () => {
    const design: BotProfile = {
      id: "design",
      provider: "codex",
      name: "Studio",
      title: "General teammate",
      description: "Owns product interface design.",
      notifications: true,
      model: "gpt-5.6-luna",
      reasoningEffort: "medium",
      threadId: null,
      avatarSeed: "design",
      avatarHue: null,
      avatarUrl: null,
      time: "",
      preview: "",
    };
    const research: BotProfile = { ...design, id: "research", name: "Research", description: "Finds sources." };
    const { editor } = renderComposer([], "", [design, research]);
    editor.textContent = "@interface";
    placeCaretAtEnd(editor);
    await fireEvent.input(editor);

    expect(await screen.findByRole("option", { name: "Studio Agent" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Research Agent" })).toBeNull();
  });

  it("navigates the mention picker with arrows and inserts the active agent with Enter", async () => {
    const research = testBot("research", "Research");
    const sales = testBot("sales", "Sales");
    const { editor, onSubmit, onValueChange } = renderComposer([], "", [research, sales]);
    editor.textContent = "@";
    placeCaretAtEnd(editor);
    await fireEvent.input(editor);

    const researchOption = await screen.findByRole("option", { name: "Research Agent" });
    const salesOption = screen.getByRole("option", { name: "Sales Agent" });
    expect(researchOption).toHaveClass("mention-picker-option-active");

    await fireEvent.keyDown(editor, { key: "ArrowDown" });
    expect(salesOption).toHaveClass("mention-picker-option-active");
    await fireEvent.keyDown(editor, { key: "ArrowUp" });
    expect(researchOption).toHaveClass("mention-picker-option-active");
    await fireEvent.keyDown(editor, { key: "ArrowUp" });
    expect(salesOption).toHaveClass("mention-picker-option-active");
    await fireEvent.keyDown(editor, { key: "Enter" });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(onValueChange).toHaveBeenLastCalledWith("@[Sales](sales) ");
    expect(editor.querySelector('[data-mention-id="sales"]')).not.toBeNull();
    expect(screen.queryByRole("listbox", { name: "Insert mention" })).toBeNull();
    expect(editor).toHaveFocus();
  });

  it("removes a leading mention atomically with Backspace", async () => {
    const research = testBot("research", "Research");
    const { editor, onValueChange } = renderComposer([], "@[Research](research)after", [research]);
    const trailingText = editor.lastChild;
    if (!trailingText) throw new Error("Composer did not render trailing text");
    editor.focus();
    placeCaret(trailingText, 0);

    await fireEvent.keyDown(editor, { key: "Backspace" });

    expect(editor.querySelector('[data-mention-id="research"]')).toBeNull();
    expect(editor).toHaveTextContent("after");
    expect(onValueChange).toHaveBeenLastCalledWith("after");
  });

  it("removes a trailing mention atomically with Delete", async () => {
    const research = testBot("research", "Research");
    const { editor, onValueChange } = renderComposer([], "before@[Research](research)", [research]);
    const leadingText = editor.firstChild;
    if (!leadingText) throw new Error("Composer did not render leading text");
    editor.focus();
    placeCaret(leadingText, leadingText.textContent?.length ?? 0);

    await fireEvent.keyDown(editor, { key: "Delete" });

    expect(editor.querySelector('[data-mention-id="research"]')).toBeNull();
    expect(editor).toHaveTextContent("before");
    expect(onValueChange).toHaveBeenLastCalledWith("before");
  });

  it("removes the automatic mention space without creating a phantom line", async () => {
    const research = testBot("research", "Research");
    const { editor, onValueChange } = renderComposer([], "", [research]);
    editor.textContent = "before @";
    placeCaretAtEnd(editor);
    await fireEvent.input(editor);
    await fireEvent.keyDown(editor, { key: "Enter" });
    placeCaretAtEnd(editor);

    await fireEvent.keyDown(editor, { key: "Backspace" });

    expect(editor.querySelector('[data-mention-id="research"]')).not.toBeNull();
    expect(editor.querySelector("br, [data-composer-trailing-line]")).toBeNull();
    expect(onValueChange).toHaveBeenLastCalledWith("before @[Research](research)");

    await fireEvent.keyDown(editor, { key: "Backspace" });

    expect(editor.querySelector('[data-mention-id="research"]')).toBeNull();
    expect(editor.querySelector("br, [data-composer-trailing-line]")).toBeNull();
    expect(onValueChange).toHaveBeenLastCalledWith("before ");
  });

  it("keeps the caret editable after removing a mention from the middle", async () => {
    const research = testBot("research", "Research");
    const { editor, onValueChange } = renderComposer([], "before@[Research](research)after", [research]);
    const token = editor.querySelector<HTMLElement>('[data-mention-id="research"]');
    if (!token) throw new Error("Composer did not render the mention");
    editor.focus();
    placeCaret(editor, Array.from(editor.childNodes).indexOf(token) + 1);

    await fireEvent.keyDown(editor, { key: "Backspace" });
    await fireEvent.keyDown(editor, { key: "x" });

    await waitFor(() => expect(onValueChange).toHaveBeenLastCalledWith("beforexafter"));
    expect(editor.querySelector('[data-mention-id="research"]')).toBeNull();
    expect(editor).toHaveTextContent("beforexafter");
    expect(editor.contains(window.getSelection()?.getRangeAt(0).commonAncestorContainer ?? null)).toBe(true);
  });

  it("inserts an attached file from the mention picker and opens the chip", async () => {
    const attachment: DraftAttachment = {
      id: "draft-types",
      name: "start-types.d.ts",
      size: 1_024,
      kind: "file",
      mimeType: "text/plain",
      previewKind: "text",
      previewUrl: null,
    };
    const { editor, onValueChange, onOpenAttachment } = renderComposer([attachment]);
    editor.textContent = "@start";
    placeCaretAtEnd(editor);
    await fireEvent.input(editor);

    const option = await screen.findByRole("option", { name: "start-types.d.ts File" });
    await fireEvent.click(option);

    expect(onValueChange).toHaveBeenLastCalledWith(`${serializeAttachmentReference(attachment.name, attachment.id)} `);
    const chip = editor.querySelector<HTMLElement>('[data-attachment-reference-id="draft-types"]');
    if (!chip) throw new Error("Composer editor did not insert the file reference");
    expect(chip).toHaveAttribute("data-file-tone", "source");
    await fireEvent.click(chip);
    expect(onOpenAttachment).toHaveBeenCalledWith(attachment);
  });

  it("focuses file references, exposes truncated names, and opens them from the keyboard", async () => {
    const attachment: DraftAttachment = {
      id: "draft-long",
      name: "a-very-long-file-name-that-needs-to-be-truncated.ts",
      size: 1_024,
      kind: "file",
      mimeType: "text/plain",
      previewKind: "text",
      previewUrl: null,
    };
    const { editor, onOpenAttachment, onSubmit } = renderComposer(
      [attachment],
      serializeAttachmentReference(attachment.name, attachment.id),
    );
    const token = editor.querySelector<HTMLElement>('[data-attachment-reference-id="draft-long"]');
    const label = token?.querySelector<HTMLElement>(".inline-file-reference-name");
    if (!token || !label) throw new Error("Composer did not render the file reference");
    Object.defineProperties(label, {
      clientWidth: { configurable: true, value: 120 },
      scrollWidth: { configurable: true, value: 320 },
    });

    expect(token).toHaveAttribute("tabindex", "0");
    await fireEvent.focus(token);
    const tooltip = await screen.findByRole("tooltip");
    expect(token).toHaveAttribute("aria-describedby", tooltip.id);
    expect(tooltip).toHaveTextContent(attachment.name);

    await fireEvent.keyDown(token, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    await fireEvent.keyDown(token, { key: "Enter" });
    await fireEvent.keyDown(token, { key: " " });
    expect(onOpenAttachment).toHaveBeenCalledTimes(2);
    expect(onSubmit).not.toHaveBeenCalled();
    await fireEvent.keyDown(token, { key: "Delete" });
    expect(editor.querySelector('[data-attachment-reference-id="draft-long"]')).toBeNull();
  });

  it("renders missing file references as plain text", () => {
    render(() => (
      <ComposerEditor
        botId="chief"
        bots={[]}
        attachments={[]}
        value={serializeAttachmentReference("missing.md", "missing")}
        placeholder="Message Chief"
        ariaLabel="Missing file"
        disabled={false}
        onValueChange={() => undefined}
        onSubmit={() => undefined}
      />
    ));

    const editor = screen.getByRole("textbox", { name: "Missing file" });
    expect(editor).toHaveTextContent("missing.md");
    expect(editor.querySelector("[data-attachment-reference-id]")).toBeNull();
  });

  it("keeps the full truncated name visible after opening a file by touch", async () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true });
    const attachment: DraftAttachment = {
      id: "draft-touch",
      name: "a-very-long-touch-friendly-file-name.docx",
      size: 1_024,
      kind: "file",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      previewKind: "none",
      previewUrl: null,
    };
    const { editor, onOpenAttachment } = renderComposer(
      [attachment],
      serializeAttachmentReference(attachment.name, attachment.id),
    );
    const token = editor.querySelector<HTMLElement>('[data-attachment-reference-id="draft-touch"]');
    const label = token?.querySelector<HTMLElement>(".inline-file-reference-name");
    if (!token || !label) throw new Error("Composer did not render the touch file reference");
    Object.defineProperties(label, {
      clientWidth: { configurable: true, value: 120 },
      scrollWidth: { configurable: true, value: 320 },
    });

    await fireEvent.click(token);
    expect(onOpenAttachment).toHaveBeenCalledWith(attachment);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(attachment.name);
  });

  it("does not split an atomic file reference at the message limit", async () => {
    const attachment: DraftAttachment = {
      id: "draft-types",
      name: "start-types.d.ts",
      size: 1_024,
      kind: "file",
      mimeType: "text/plain",
      previewKind: "text",
      previewUrl: null,
    };
    const marker = serializeAttachmentReference(attachment.name, attachment.id);
    const { editor, onValueChange } = renderComposer([attachment], marker);
    editor.append(document.createTextNode("x".repeat(INPUT_LIMITS.messageText)));
    placeCaretAtEnd(editor);
    await fireEvent.input(editor);

    const value = onValueChange.mock.lastCall?.[0];
    expect(value).toHaveLength(INPUT_LIMITS.messageText);
    expect(value?.startsWith(marker)).toBe(true);
    expect(editor.querySelector('[data-attachment-reference-id="draft-types"]')).not.toBeNull();
  });
});
