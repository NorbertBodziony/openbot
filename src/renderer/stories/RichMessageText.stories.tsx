import { serializeAttachmentReference } from "@openbot/contracts/attachment-references";
import type { AttachmentSummary } from "@openbot/contracts/ipc";
import { expect, fn, waitFor, within } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { RichMessageText } from "../src/components/conversation/RichMessageText";
import type { MessageCitation } from "../src/data";
import { STORY_ATTACHMENTS, STORY_BOTS } from "./fixtures";

const args: Parameters<typeof RichMessageText>[0] = {
  body: "Ask @Research to review https://openbot.run/docs before the launch.",
  bots: STORY_BOTS,
  attachments: [],
  onSelectAgent: fn(),
  onOpenLink: fn(),
  onOpenAttachment: fn(),
};

const citations: MessageCitation[] = [
  {
    number: 1,
    label: "Attention Is All You Need",
    url: "https://arxiv.org/abs/1706.03762",
    host: "arxiv.org",
  },
  {
    number: 2,
    label: "Efficient Transformers: A Survey",
    url: "https://arxiv.org/abs/2009.06732",
    host: "arxiv.org",
  },
];

const longAttachment: AttachmentSummary = {
  id: "attachment-long",
  name: "bardzo-długi-raport-źródłowy-z-wynikami-eksperymentu-i-komentarzami-finalnymi.ts",
  size: 48_120,
  kind: "file",
  mimeType: "text/plain",
  previewKind: "text",
  previewUrl: null,
};

type AttachmentFixtureInput = readonly [
  string,
  string,
  string,
  AttachmentSummary["previewKind"],
  AttachmentSummary["kind"],
];

const fileTypeInputs: AttachmentFixtureInput[] = [
  ["type-ts", "start-types.ts", "text/plain", "text", "file"],
  ["type-pdf", "brief.pdf", "application/pdf", "pdf", "file"],
  ["type-png", "diagram.png", "image/png", "image", "image"],
  ["type-zip", "archive.zip", "application/zip", "none", "file"],
  [
    "type-docx",
    "zażółć-gęślą.docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "none",
    "file",
  ],
  ["type-extensionless", "LICENSE", "application/octet-stream", "none", "file"],
];

const fileTypeAttachments: AttachmentSummary[] = fileTypeInputs.map(
  ([id, name, mimeType, previewKind, kind], index) => ({
    id,
    name,
    size: (index + 1) * 2_048,
    kind,
    mimeType,
    previewKind,
    previewUrl: null,
  }),
);

const meta = {
  title: "Conversation/RichMessageText",
  component: RichMessageText,
  args,
  parameters: { layout: "centered" },
} satisfies Meta<typeof RichMessageText>;

export default meta;
type Story = StoryObj<typeof meta>;

export const LinksAndMentions: Story = {};

export const InlineCitations: Story = {
  args: {
    body: "Transformers scale well with data and compute [1], though attention is quadratic in sequence length [2].",
    citations,
  },
  play: async ({ canvas, userEvent }) => {
    const marker = canvas.getByRole("link", {
      name: "Open citation 1: Attention Is All You Need",
    });
    await userEvent.hover(marker);
    await expect(within(document.body).findByRole("tooltip")).resolves.toBeInTheDocument();
    await userEvent.click(marker);
    await expect(canvas.getByRole("link", { name: "Open source 1: Attention Is All You Need" })).toBeInTheDocument();
  },
};

export const CitationEdges: Story = {
  args: { body: "", citations },
  parameters: { layout: "fullscreen" },
  render: (storyArgs) => (
    <div
      style={{
        position: "fixed",
        top: "0",
        left: "0",
        width: "100vw",
        "box-sizing": "border-box",
        padding: "0 8px",
      }}
    >
      <p style={{ margin: "0" }}>
        <RichMessageText {...storyArgs} body="[1] Citation at the left edge." />
      </p>
      <p style={{ "margin-top": "64px", "text-align": "right" }}>
        <RichMessageText {...storyArgs} body="Citation at the right edge [2]" />
      </p>
    </div>
  ),
  play: async ({ canvas, userEvent }) => {
    const first = canvas.getByRole("link", {
      name: "Open citation 1: Attention Is All You Need",
    });
    await userEvent.hover(first);
    const firstTooltip = await within(document.body).findByRole("tooltip");
    await waitFor(() => expect(firstTooltip).toHaveAttribute("data-ready", "true"));
    const firstBounds = firstTooltip.getBoundingClientRect();
    await expect(firstTooltip).toHaveAttribute("data-placement", "bottom");
    await expect(firstBounds.left).toBeGreaterThanOrEqual(8);
    await expect(firstBounds.right).toBeLessThanOrEqual(window.innerWidth - 8);
    await userEvent.unhover(first);

    const second = canvas.getByRole("link", {
      name: "Open citation 2: Efficient Transformers: A Survey",
    });
    await userEvent.hover(second);
    const secondTooltip = await within(document.body).findByRole("tooltip");
    await waitFor(() => expect(secondTooltip).toHaveAttribute("data-ready", "true"));
    const secondBounds = secondTooltip.getBoundingClientRect();
    await expect(secondBounds.left).toBeGreaterThanOrEqual(8);
    await expect(secondBounds.right).toBeLessThanOrEqual(window.innerWidth - 8);
  },
};

export const PlainText: Story = {
  args: { body: "A message without links or agent mentions." },
};

export const InlineFileReferences: Story = {
  args: {
    body: `Review ${serializeAttachmentReference(STORY_ATTACHMENTS[0].name, STORY_ATTACHMENTS[0].id)} and keep the implementation aligned with ${serializeAttachmentReference(STORY_ATTACHMENTS[1].name, STORY_ATTACHMENTS[1].id)}.`,
    attachments: STORY_ATTACHMENTS,
    onOpenAttachment: fn(),
  },
  play: async ({ args: storyArgs, canvas, userEvent }) => {
    const reference = canvas.getByRole("button", {
      name: `Open attached file ${STORY_ATTACHMENTS[0].name}`,
    });
    await userEvent.click(reference);
    await expect(storyArgs.onOpenAttachment).toHaveBeenCalledWith(STORY_ATTACHMENTS[0]);
  },
};

export const LongFileReference: Story = {
  args: {
    body: `Review ${serializeAttachmentReference(longAttachment.name, longAttachment.id)} before continuing.`,
    attachments: [longAttachment],
    onOpenAttachment: fn(),
  },
  render: (storyArgs) => (
    <section aria-label="Long file reference sample" style={{ width: "320px" }}>
      <RichMessageText {...storyArgs} />
    </section>
  ),
  play: async ({ args: storyArgs, canvas, userEvent }) => {
    const reference = canvas.getByRole("button", {
      name: `Open attached file ${longAttachment.name}`,
    });
    const label = reference.querySelector<HTMLElement>(".inline-file-reference-name");
    if (!label) throw new Error("The file reference label is missing");
    await expect(label.scrollWidth).toBeGreaterThan(label.clientWidth);
    const sampleBounds = canvas.getByLabelText("Long file reference sample").getBoundingClientRect();
    await expect(reference.getBoundingClientRect().right).toBeLessThanOrEqual(sampleBounds.right);

    await userEvent.hover(reference);
    await expect(within(document.body).findByRole("tooltip")).resolves.toHaveTextContent(longAttachment.name);
    await userEvent.unhover(reference);
    reference.focus();
    await expect(within(document.body).findByRole("tooltip")).resolves.toHaveTextContent(longAttachment.name);
    await userEvent.keyboard("{Escape}");
    await expect(within(document.body).queryByRole("tooltip")).not.toBeInTheDocument();
    await userEvent.click(reference);
    await expect(storyArgs.onOpenAttachment).toHaveBeenCalledWith(longAttachment);
  },
};

export const FileReferenceTypes: Story = {
  args: {
    body: fileTypeAttachments
      .map((attachment) => serializeAttachmentReference(attachment.name, attachment.id))
      .join(" "),
    attachments: fileTypeAttachments,
  },
  render: (storyArgs) => (
    <p style={{ width: "620px" }}>
      <RichMessageText {...storyArgs} />
    </p>
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getByText("TS")).toBeInTheDocument();
    await expect(canvas.getByText("PDF")).toBeInTheDocument();
    await expect(canvas.getByText("PNG")).toBeInTheDocument();
    await expect(canvas.getByText("ZIP")).toBeInTheDocument();
    await expect(canvas.getByText("DOCX")).toBeInTheDocument();
    const references = canvas.getAllByRole("button", { name: /Open attached file/u });
    await expect(references).toHaveLength(6);
    const root = references[0]?.parentElement;
    if (!root) throw new Error("The file reference story root is missing");
    await expect(root.querySelectorAll(".attachment-reference-visual > svg")).toHaveLength(1);
  },
};

export const MixedReferencesStress: Story = {
  name: "Mixed references stress",
  args: {
    body: `Ask @Research to compare ${serializeAttachmentReference(longAttachment.name, longAttachment.id)} with ${serializeAttachmentReference(fileTypeAttachments[1].name, fileTypeAttachments[1].id)} and https://openbot.run/docs. Keep the decision traceable to the primary paper [1], then verify the compressed handoff in ${serializeAttachmentReference(fileTypeAttachments[3].name, fileTypeAttachments[3].id)} before shipping [2].`,
    attachments: [longAttachment, fileTypeAttachments[1], fileTypeAttachments[3]],
    citations,
    onOpenAttachment: fn(),
  },
  render: (storyArgs) => (
    <article aria-label="Mixed references stress sample" style={{ width: "360px" }}>
      <RichMessageText {...storyArgs} />
    </article>
  ),
  play: async ({ canvas }) => {
    const sample = canvas.getByLabelText("Mixed references stress sample");
    await expect(sample.scrollWidth).toBeLessThanOrEqual(sample.clientWidth);
    await expect(canvas.getAllByRole("button", { name: /Open attached file/u })).toHaveLength(3);
    await expect(canvas.getByRole("button", { name: "Open agent Research" })).toBeInTheDocument();
    await expect(canvas.getAllByRole("link", { name: /Open citation/u })).toHaveLength(2);
  },
};

export const InlineAlignment: Story = {
  name: "Inline alignment",
  args: {
    body: `Review ${serializeAttachmentReference(fileTypeAttachments[1].name, fileTypeAttachments[1].id)} before launch.`,
    attachments: [fileTypeAttachments[1]],
  },
  render: (storyArgs) => (
    <article aria-label="Inline alignment sample" style={{ width: "360px" }}>
      <RichMessageText {...storyArgs} />
    </article>
  ),
};
