import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageSelectionActions, messageTextSelection, SelectionActionsBar } from "./SelectionActions";

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.querySelectorAll("[data-selection-test-root]").forEach((element) => {
    element.remove();
  });
});

describe("message text selection", () => {
  it("accepts plain text inside one eligible message block", () => {
    const paragraph = testParagraph("A concise answer for review.", "message-1");
    const text = paragraph.firstChild;
    if (!text) throw new Error("Missing text node");
    const range = document.createRange();
    range.setStart(text, 2);
    range.setEnd(text, 16);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    expect(messageTextSelection(selection)).toMatchObject({
      messageId: "message-1",
      text: "concise answer",
    });
  });

  it("rejects selections spanning messages or touching interactive content", () => {
    const first = testParagraph("First answer", "message-1");
    const second = testParagraph("Second answer", "message-2");
    const crossMessageRange = document.createRange();
    crossMessageRange.setStart(first.firstChild ?? first, 0);
    crossMessageRange.setEnd(second.firstChild ?? second, 6);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(crossMessageRange);
    expect(messageTextSelection(selection)).toBeNull();

    first.innerHTML = 'Read <a href="https://example.com">the source</a> today';
    const linkText = first.querySelector("a")?.firstChild;
    if (!linkText) throw new Error("Missing link text");
    const linkRange = document.createRange();
    linkRange.selectNodeContents(linkText);
    selection?.removeAllRanges();
    selection?.addRange(linkRange);
    expect(messageTextSelection(selection)).toBeNull();
  });
});

describe("SelectionActionsBar", () => {
  it("opens from a message selection and dismisses on Escape", async () => {
    const root = testParagraph("Selected sentence", "message-1");
    const range = positionedRange(root);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    render(() => <MessageSelectionActions contextKey="bot-1" disabled={false} onSend={vi.fn()} />);

    await fireEvent.pointerUp(root);
    expect(await screen.findByRole("toolbar", { name: "Actions for selected text" })).toBeInTheDocument();
    await fireEvent.keyUp(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("toolbar", { name: "Actions for selected text" })).toBeNull());
  });

  it("sends a custom instruction with the selected quote", async () => {
    const root = testParagraph("Selected sentence", "message-1");
    const range = positionedRange(root);
    const onSend = vi.fn().mockResolvedValue(true);
    const onDismiss = vi.fn();
    render(() => (
      <SelectionActionsBar
        selection={{ messageId: "message-1", text: "Selected sentence", range }}
        onSend={onSend}
        onDismiss={onDismiss}
      />
    ));

    const input = await screen.findByRole("textbox", { name: "Describe edits" });
    await fireEvent.input(input, { target: { value: "Make it warmer." } });
    await fireEvent.submit(input.closest("form") ?? input);

    await waitFor(() => expect(onSend).toHaveBeenCalledWith("message-1", "Make it warmer.\n\n> Selected sentence"));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("expands presets and keeps the action available after a failed send", async () => {
    const root = testParagraph("Selected sentence", "message-1");
    const range = positionedRange(root);
    const onSend = vi.fn().mockResolvedValue(false);
    render(() => (
      <SelectionActionsBar
        selection={{ messageId: "message-1", text: "Selected sentence", range }}
        onSend={onSend}
        onDismiss={vi.fn()}
      />
    ));

    const expand = await screen.findByRole("button", { name: "Show more actions" });
    await fireEvent.click(expand);
    expect(expand).toHaveAttribute("aria-expanded", "true");
    await fireEvent.click(screen.getByRole("button", { name: "Grammar" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn’t send");
    await fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
    expect(onSend).toHaveBeenLastCalledWith(
      "message-1",
      "Fix the grammar in this selected text.\n\n> Selected sentence",
    );
  });

  it("leaves a collapsed composer caret alone on keyup", async () => {
    const editor = document.createElement("div");
    editor.dataset.selectionTestRoot = "true";
    editor.contentEditable = "true";
    editor.textContent = "asd";
    document.body.append(editor);
    const text = editor.firstChild;
    if (!text) throw new Error("Missing text node");
    const caret = document.createRange();
    caret.setStart(text, 3);
    caret.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(caret);
    render(() => <MessageSelectionActions contextKey="bot-1" disabled={false} onSend={vi.fn()} />);

    await fireEvent.keyUp(editor, { key: "d" });

    expect(window.getSelection()?.rangeCount).toBe(1);
    const remaining = window.getSelection()?.getRangeAt(0);
    expect(remaining?.collapsed).toBe(true);
    expect(remaining?.startContainer).toBe(text);
    expect(remaining?.startOffset).toBe(3);
  });
});

function testParagraph(text: string, messageId: string): HTMLParagraphElement {
  const paragraph = document.createElement("p");
  paragraph.dataset.selectionTestRoot = "true";
  paragraph.dataset.selectionMessageId = messageId;
  paragraph.className = "message-copy";
  paragraph.textContent = text;
  document.body.append(paragraph);
  return paragraph;
}

function positionedRange(root: HTMLElement): Range {
  const range = document.createRange();
  range.selectNodeContents(root);
  Object.defineProperty(range, "getClientRects", {
    configurable: true,
    value: () => [
      {
        top: 100,
        right: 260,
        bottom: 120,
        left: 100,
        width: 160,
        height: 20,
      },
    ],
  });
  return range;
}
