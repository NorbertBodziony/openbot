import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { RichMessageText } from "../src/components/conversation/RichMessageText";
import { STORY_BOTS } from "./fixtures";

const args: Parameters<typeof RichMessageText>[0] = {
  body: "Ask @Research to review https://openbot.run/docs before the launch.",
  bots: STORY_BOTS,
  onSelectAgent: fn(),
  onOpenLink: fn(),
};

const meta = {
  title: "Conversation/RichMessageText",
  component: RichMessageText,
  args,
  parameters: { layout: "centered" },
} satisfies Meta<typeof RichMessageText>;

export default meta;
type Story = StoryObj<typeof meta>;

export const LinksAndMentions: Story = {};

export const PlainText: Story = {
  args: { body: "A message without links or agent mentions." },
};
