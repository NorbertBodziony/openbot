import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { ChoiceCard } from "../src/features/conversation/ConversationPrompts";

const choiceArgs: Parameters<typeof ChoiceCard>[0] = {
  title: "What should I help with first?",
  hint: "Choose a focus area for this agent.",
  choices: ["Work & projects", "Research & writing", "Sales & outreach"],
  customChoice: "Something else",
  onSubmit: async () => true,
};

const meta = {
  title: "Conversation/ChoiceCard",
  component: ChoiceCard,
  args: choiceArgs,
  parameters: { layout: "centered" },
} satisfies Meta<typeof ChoiceCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Choices: Story = {};

export const Pending: Story = {
  args: { pending: true },
};
