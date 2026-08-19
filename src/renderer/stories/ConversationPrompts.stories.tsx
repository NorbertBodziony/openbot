import type { AgentPromptQuestion } from "@openbot/contracts/ipc";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { ApprovalCard, ChoiceCard } from "../src/components/ConversationPrompts";

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

export const PromptQuestions: Story = {
  name: "Questions",
  args: { title: "Prompt card", choices: [], onSubmit: async () => true },
  render: () => {
    const questions: AgentPromptQuestion[] = [
      {
        id: "approach",
        header: "Approach",
        question: "Which auth approach should we use?",
        isSecret: false,
        options: [
          { label: "Session cookies", description: "" },
          { label: "JWT bearer", description: "" },
          { label: "OAuth only", description: "" },
        ],
      },
      {
        id: "secrets",
        header: "Secrets",
        question: "Where should secrets live?",
        isSecret: false,
        options: [
          { label: ".env.local", description: "" },
          { label: "Vault / secrets manager", description: "" },
          { label: "CI only", description: "" },
        ],
      },
      {
        id: "rollout",
        header: "Rollout",
        question: "Ship behind a feature flag?",
        isSecret: false,
        options: [
          { label: "Yes — gradual rollout", description: "" },
          { label: "No — full release", description: "" },
        ],
      },
    ];
    return <ApprovalCard variant="questions" questions={questions} onSubmit={fn()} />;
  },
};
