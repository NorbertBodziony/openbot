import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { AttachmentCards } from "../src/components/conversation/AttachmentCards";
import { STORY_ATTACHMENTS } from "./fixtures";

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

export const Empty: Story = {
  args: { attachments: [] },
};
