import { expect, fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { MessageBody } from "../src/components/conversation/MessageRendering";
import type { BotMessage } from "../src/data";
import { STORY_ATTACHMENTS, STORY_BOTS } from "./fixtures";

const message: BotMessage = {
  id: "message-body-1",
  author: "bot",
  body: "Here is the latest brief. You can also review https://openbot.run/docs or ask @Research.",
  time: "10:00",
  status: "Ready to review",
  attachments: STORY_ATTACHMENTS,
};

const args: Parameters<typeof MessageBody>[0] = {
  message,
  referencedMessage: undefined,
  bots: STORY_BOTS,
  onSelectAgent: fn(),
  onOpenLink: fn(),
  onPreview: fn(),
  onAttachmentAction: fn(),
};

const meta = {
  title: "Conversation/MessageBody",
  component: MessageBody,
  args,
  parameters: { layout: "centered" },
} satisfies Meta<typeof MessageBody>;

export default meta;
type Story = StoryObj<typeof meta>;

export const RichMessage: Story = {};

export const WithReplyContext: Story = {
  args: {
    referencedMessage: {
      id: "message-reference",
      author: "you",
      body: "Can you make this more concise?",
      time: "09:55",
    },
  },
};

export const AttachmentOnly: Story = {
  args: {
    message: { ...message, body: "", status: undefined },
  },
};

export const DataTable: Story = {
  args: {
    message: {
      ...message,
      id: "message-data-table",
      body: [
        "Current model pricing:",
        "",
        "| Model | Context | $/1M in |",
        "| --- | --- | ---: |",
        "| gpt-4o | 128k | $5.00 |",
        "| claude-3.5 | 200k | $3.00 |",
        "| llama-3.1 | 128k | $0.90 |",
      ].join("\n"),
      status: undefined,
      attachments: [],
    },
  },
  render: (storyArgs) => (
    <div class="bot-bubble" style={{ width: "680px", "max-width": "calc(100vw - 32px)" }}>
      <MessageBody {...storyArgs} />
    </div>
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("table")).toBeInTheDocument();
    await expect(canvas.getAllByRole("columnheader")).toHaveLength(3);
    await expect(canvas.queryByText("| --- | --- | ---: |")).not.toBeInTheDocument();
  },
};

export const DataTableNarrow: Story = {
  args: {
    message: {
      ...message,
      id: "message-data-table-narrow",
      body: [
        "| Model | Provider | Context | Input | Output | Released |",
        "| --- | --- | ---: | ---: | ---: | --- |",
        "| gpt-4o | OpenAI | 128k | $5.00 | $15.00 | May 2024 |",
        "| claude-3.5 | Anthropic | 200k | $3.00 | $15.00 | June 2024 |",
      ].join("\n"),
      status: undefined,
      attachments: [],
    },
  },
  render: (storyArgs) => (
    <div class="bot-bubble" style={{ width: "320px", "max-width": "calc(100vw - 32px)" }}>
      <MessageBody {...storyArgs} />
    </div>
  ),
  play: async ({ canvas }) => {
    const region = canvas.getByRole("region", { name: "Data table" });
    await expect(region.scrollWidth).toBeGreaterThan(region.clientWidth);
  },
};
