import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { BotProfile } from "../data";
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
});
