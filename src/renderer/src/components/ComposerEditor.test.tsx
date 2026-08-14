import { fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { ComposerEditor } from "./ComposerEditor";

function renderComposer() {
  const onSubmit = vi.fn();
  const onValueChange = vi.fn();

  render(() => {
    const [value, setValue] = createSignal("");
    return (
      <ComposerEditor
        botId="chief"
        bots={[]}
        value={value()}
        placeholder="Message Chief"
        ariaLabel="Message Chief"
        disabled={false}
        onValueChange={(nextValue) => {
          onValueChange(nextValue);
          setValue(nextValue);
        }}
        onSubmit={onSubmit}
      />
    );
  });

  return {
    editor: screen.getByRole("textbox", { name: "Message Chief" }),
    onSubmit,
    onValueChange,
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
});
