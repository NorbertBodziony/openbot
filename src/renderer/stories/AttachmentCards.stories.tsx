import { expect, fn, userEvent, within } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { AttachmentCards } from "../src/components/conversation/AttachmentCards";
import { STORY_ATTACHMENTS } from "./fixtures";

const compactFile = {
  id: "attachment-index",
  name: "index.html",
  size: 65 * 1024,
  kind: "file" as const,
  mimeType: "text/html",
  previewKind: "text" as const,
  previewUrl: null,
};

const longNamedFiles = [
  {
    ...compactFile,
    id: "attachment-long-typescript",
    name: "customer-import-validation-pipeline.final.review.ts",
    mimeType: "text/typescript",
  },
  {
    ...compactFile,
    id: "attachment-long-spreadsheet",
    name: "quarterly-operating-plan-with-regional-breakdown.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    previewKind: "none" as const,
  },
];

const args: Parameters<typeof AttachmentCards>[0] = {
  attachments: STORY_ATTACHMENTS,
  onPreview: fn(),
  onAction: fn(),
};

const meta = {
  title: "Conversation/AttachmentCards",
  component: AttachmentCards,
  args,
  parameters: { layout: "centered" },
} satisfies Meta<typeof AttachmentCards>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Files: Story = {};

export const SingleCompactFile: Story = {
  name: "Single compact file",
  args: { attachments: [compactFile] },
  play: async ({ canvas }) => {
    const preview = canvas.getByRole("button", { name: `Preview ${compactFile.name}` });
    const open = canvas.getByRole("button", { name: `Open ${compactFile.name}` });
    const visual = preview.querySelector<HTMLElement>(".attachment-file-visual");
    const copy = preview.querySelector<HTMLElement>(".attachment-file-copy");
    if (!visual || !copy) throw new Error("The attachment preview content is incomplete");

    const previewBounds = preview.getBoundingClientRect();
    const visualBounds = visual.getBoundingClientRect();
    const copyBounds = copy.getBoundingClientRect();
    const openBounds = open.getBoundingClientRect();
    await expect(getComputedStyle(preview).justifyContent).toBe("flex-start");
    await expect(previewBounds.height).toBe(40);
    await expect(visual).toHaveAttribute("data-file-tone", "markup");
    await expect(visualBounds.left).toBe(previewBounds.left);
    await expect(copyBounds.left).toBeGreaterThan(visualBounds.right);
    await expect(openBounds.left).toBeGreaterThan(previewBounds.right);
    await expect(openBounds.width).toBe(40);
    await expect(openBounds.height).toBe(40);

    open.focus();
    await expect(within(document.body).findByRole("tooltip")).resolves.toHaveTextContent("Open file");
    await userEvent.keyboard("{Escape}");
    await expect(within(document.body).queryByRole("tooltip")).not.toBeInTheDocument();
  },
};

export const NarrowLongNames: Story = {
  name: "Narrow layout with long names",
  args: { attachments: longNamedFiles },
  render: (storyArgs) => (
    <div style={{ width: "220px" }}>
      <AttachmentCards {...storyArgs} />
    </div>
  ),
  play: async ({ canvas }) => {
    const cards = canvas.getAllByRole("button", { name: /^(Preview|Open) /u });
    const names = canvas.getAllByText(/customer-import|quarterly-operating/u);
    const openButtons = canvas.getAllByRole("button", { name: /^Open /u });

    await expect(cards).toHaveLength(4);
    await expect(openButtons).toHaveLength(2);
    for (const name of names) {
      await expect(name.scrollWidth).toBeGreaterThan(name.clientWidth);
    }
    for (const open of openButtons) {
      const bounds = open.getBoundingClientRect();
      await expect(bounds.width).toBe(40);
      await expect(bounds.height).toBe(40);
    }
    await expect(
      canvas.getByText(longNamedFiles[0].name).closest(".message-attachment")?.getBoundingClientRect().width,
    ).toBe(220);
  },
};

export const Empty: Story = {
  args: { attachments: [] },
};
