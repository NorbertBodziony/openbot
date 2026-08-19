import { createSignal } from "solid-js";
import { expect, fn, within } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { ComposerEditor } from "../src/components/ComposerEditor";
import { STORY_BOTS } from "./fixtures";

const args: Parameters<typeof ComposerEditor>[0] = {
  botId: "chief",
  bots: STORY_BOTS,
  value: "",
  placeholder: "Message Chief",
  ariaLabel: "Message Chief",
  disabled: false,
  onValueChange: fn(),
  onSubmit: fn(),
};

const meta = {
  title: "Conversation/ComposerEditor",
  component: ComposerEditor,
  args,
  parameters: { layout: "centered" },
} satisfies Meta<typeof ComposerEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};

export const WithDraft: Story = {
  args: { value: "Prepare a concise update for tomorrow." },
};

export const Disabled: Story = {
  args: { disabled: true, placeholder: "Complete agent setup to start" },
};

export const MentionPicker: Story = {
  render: (storyArgs) => {
    const [value, setValue] = createSignal(storyArgs.value);
    return (
      <ComposerEditor
        {...storyArgs}
        value={value()}
        onValueChange={setValue}
        onSubmit={storyArgs.onSubmit}
      />
    );
  },
  play: async ({ canvas, userEvent }) => {
    const editor = canvas.getByRole("textbox", { name: "Message Chief" });
    await userEvent.click(editor);
    editor.textContent = "@Res";
    const textNode = editor.firstChild;
    if (!textNode) throw new Error("Composer editor did not create a text node");
    const selectionRange = document.createRange();
    selectionRange.setStart(textNode, textNode.textContent?.length ?? 0);
    selectionRange.collapse(true);
    const selection = {
      anchorNode: textNode,
      anchorOffset: textNode.textContent?.length ?? 0,
      rangeCount: 1,
      getRangeAt: () => selectionRange,
      removeAllRanges: () => undefined,
      addRange: () => undefined,
    } as unknown as Selection;
    const originalGetSelection = window.getSelection;
    Object.defineProperty(window, "getSelection", {
      configurable: true,
      value: () => selection,
    });
    try {
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      const picker = await within(document.body).findByRole("listbox", { name: "Tag an agent" });
      await expect(picker).toBeInTheDocument();
      await userEvent.click(within(document.body).getByRole("option", { name: /Research/i }));
      await expect(editor.querySelector('[data-mention-id="research"]')).not.toBeNull();
    } finally {
      Object.defineProperty(window, "getSelection", {
        configurable: true,
        value: originalGetSelection,
      });
    }
  },
};
