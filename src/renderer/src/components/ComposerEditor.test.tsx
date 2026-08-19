import { serializeAttachmentReference } from "@openbot/contracts/attachment-references";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { DraftAttachment } from "@openbot/contracts/ipc";
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { BotProfile } from "../data";
import { ComposerEditor } from "./ComposerEditor";

function renderComposer(attachments: DraftAttachment[] = [], initialValue = "") {
  const onSubmit = vi.fn();
  const onValueChange = vi.fn();
  const onOpenAttachment = vi.fn();

  render(() => {
    const [value, setValue] = createSignal(initialValue);
    return (
      <ComposerEditor
        botId="chief"
        bots={[]}
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

describe("ComposerEditor", () => {
  it("keeps repeated Shift+Enter line breaks in the draft", async () => {
    const { editor, onSubmit, onValueChange } = renderComposer();
    editor.textContent = "First line";
    placeCaretAtEnd(editor);
    await fireEvent.input(editor);

    await fireEvent.keyDown(editor, { key: "Enter", shiftKey: true });
    placeCaretAtEnd(editor);
    await fireEvent.keyDown(editor, { key: "Enter", shiftKey: true });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(onValueChange).toHaveBeenLastCalledWith("First line\n\n");
    expect(editor.textContent).toBe("First line\n\n");
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

  it("renders saved mentions with the animated agent avatar", () => {
    const sales: BotProfile = {
      id: "sales",
      name: "Sales",
      role: "Agent",
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
    expect(token?.querySelector(".composer-mention-avatar svg .mo-root")).not.toBeNull();
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
