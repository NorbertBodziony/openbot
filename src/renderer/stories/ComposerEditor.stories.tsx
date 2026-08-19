import { serializeAttachmentReference } from "@openbot/contracts/attachment-references";
import type { DraftAttachment } from "@openbot/contracts/ipc";
import { createSignal } from "solid-js";
import { expect, fn, within } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { ComposerEditor } from "../src/components/ComposerEditor";
import { STORY_BOTS } from "./fixtures";

const args: Parameters<typeof ComposerEditor>[0] = {
  botId: "chief",
  bots: STORY_BOTS,
  attachments: [],
  value: "",
  placeholder: "Message Chief",
  ariaLabel: "Message Chief",
  disabled: false,
  onValueChange: fn(),
  onSubmit: fn(),
  onOpenAttachment: fn(),
};

const referencedFiles: DraftAttachment[] = [
  {
    id: "draft-start-types",
    name: "start-types.d.ts",
    size: 6_144,
    kind: "file",
    mimeType: "text/plain",
    previewKind: "text",
    previewUrl: null,
  },
  {
    id: "draft-agents",
    name: "AGENTS.md",
    size: 2_048,
    kind: "file",
    mimeType: "text/plain",
    previewKind: "text",
    previewUrl: null,
  },
];

const longReferencedFile: DraftAttachment = {
  id: "draft-long-report",
  name: "bardzo-długi-raport-źródłowy-z-wynikami-eksperymentu-i-komentarzami-finalnymi.ts",
  size: 48_120,
  kind: "file",
  mimeType: "text/plain",
  previewKind: "text",
  previewUrl: null,
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
    return <ComposerEditor {...storyArgs} value={value()} onValueChange={setValue} onSubmit={storyArgs.onSubmit} />;
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
      // biome-ignore lint/nursery/noUnsafeTypeAssertion: Storybook needs a minimal Selection double for contenteditable caret placement.
    } as unknown as Selection;
    const originalGetSelection = window.getSelection;
    Object.defineProperty(window, "getSelection", {
      configurable: true,
      value: () => selection,
    });
    try {
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      const picker = await within(document.body).findByRole("listbox", { name: "Insert mention" });
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

export const FileReferencePicker: Story = {
  args: {
    attachments: referencedFiles,
    onOpenAttachment: fn(),
  },
  render: (storyArgs) => {
    const [value, setValue] = createSignal(storyArgs.value);
    return (
      <div class="composer" style={{ width: "480px" }}>
        <div class="composer-input-label">
          <ComposerEditor {...storyArgs} value={value()} onValueChange={setValue} onSubmit={storyArgs.onSubmit} />
        </div>
      </div>
    );
  },
  play: async ({ args: storyArgs, canvas, userEvent }) => {
    const editor = canvas.getByRole("textbox", { name: "Message Chief" });
    await userEvent.click(editor);
    editor.textContent = "@start";
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
      // biome-ignore lint/nursery/noUnsafeTypeAssertion: Storybook needs a minimal Selection double for contenteditable caret placement.
    } as unknown as Selection;
    const originalGetSelection = window.getSelection;
    Object.defineProperty(window, "getSelection", {
      configurable: true,
      value: () => selection,
    });
    try {
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      const picker = await within(document.body).findByRole("listbox", { name: "Insert mention" });
      await expect(within(picker).getByRole("option", { name: "start-types.d.ts File" })).toBeInTheDocument();
      await userEvent.keyboard("{Enter}");
      const chip = editor.querySelector<HTMLElement>('[data-attachment-reference-id="draft-start-types"]');
      if (!chip) throw new Error("Composer editor did not insert the file reference");
      await expect(editor).toHaveTextContent("start-types.d.ts");
      await userEvent.click(chip);
      await expect(storyArgs.onOpenAttachment).toHaveBeenCalledWith(referencedFiles[0]);
    } finally {
      Object.defineProperty(window, "getSelection", {
        configurable: true,
        value: originalGetSelection,
      });
    }
  },
};

export const WithFileReferences: Story = {
  args: {
    attachments: referencedFiles,
    value: `${serializeAttachmentReference("start-types.d.ts", "draft-start-types")} ${serializeAttachmentReference("AGENTS.md", "draft-agents")}`,
  },
  render: (storyArgs) => (
    <div class="composer" style={{ width: "480px" }}>
      <div class="composer-input-label">
        <ComposerEditor {...storyArgs} />
      </div>
    </div>
  ),
};

export const LongFileReference: Story = {
  args: {
    attachments: [longReferencedFile],
    value: serializeAttachmentReference(longReferencedFile.name, longReferencedFile.id),
    onOpenAttachment: fn(),
  },
  render: (storyArgs) => (
    <div class="composer" style={{ width: "320px" }}>
      <div class="composer-input-label">
        <ComposerEditor {...storyArgs} />
      </div>
    </div>
  ),
  play: async ({ args: storyArgs, canvas, userEvent }) => {
    const token = canvas.getByRole("button", {
      name: `Open attached file ${longReferencedFile.name}`,
    });
    const label = token.querySelector<HTMLElement>(".inline-file-reference-name");
    if (!label) throw new Error("The composer file reference label is missing");
    await expect(label.scrollWidth).toBeGreaterThan(label.clientWidth);

    token.focus();
    await expect(within(document.body).findByRole("tooltip")).resolves.toHaveTextContent(longReferencedFile.name);
    await userEvent.keyboard("{Escape}");
    await expect(within(document.body).queryByRole("tooltip")).not.toBeInTheDocument();
    await userEvent.keyboard("{Enter}");
    await expect(storyArgs.onOpenAttachment).toHaveBeenCalledTimes(1);
    await userEvent.keyboard(" ");
    await expect(storyArgs.onOpenAttachment).toHaveBeenCalledTimes(2);
  },
};
