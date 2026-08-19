import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { MessageActions } from "../src/components/conversation/MessageRendering";
import type { BotMessage } from "../src/data";

const message: BotMessage = {
  id: "message-actions-1",
  author: "bot",
  body: "A message with available actions.",
  time: "10:00",
};

const args: Parameters<typeof MessageActions>[0] = {
  message,
  pickerOpen: false,
  moreOpen: false,
  expandedEmoji: false,
  copied: false,
  onTogglePicker: fn(),
  onToggleMore: fn(),
  onExpandEmoji: fn(),
  onReact: fn(),
  onReply: fn(),
  onCopy: fn(),
};

const meta = {
  title: "Conversation/MessageActions",
  component: MessageActions,
  args,
  parameters: { layout: "centered" },
} satisfies Meta<typeof MessageActions>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const ReactionPicker: Story = {
  args: { pickerOpen: true },
};

export const MoreMenu: Story = {
  args: { moreOpen: true },
};
