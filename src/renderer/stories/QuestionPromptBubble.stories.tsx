import type { AgentPromptQuestion } from "@openbot/contracts/ipc";
import { expect, fn, waitFor } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { AgentAvatar } from "../src/components/AgentAvatar";
import { QuestionPromptBubble, type QuestionPromptBubbleProps } from "../src/components/QuestionPromptBubble";
import {
  ArrowUp,
  Bubble,
  BubbleContent,
  Button,
  ChevronDown,
  Message,
  MessageContent,
  MessageFooter,
  Plus,
  Textarea,
} from "../src/components/ui";

const singleQuestion: AgentPromptQuestion[] = [
  {
    id: "reply",
    header: "Message",
    question: "Want me to send that reply?",
    isSecret: false,
    options: [
      { label: "Send that reply", description: "Send the prepared message now." },
      { label: "Hold off", description: "Keep the draft without sending it." },
      { label: "Also message the second seller", description: "Send the same offer to both listings." },
    ],
  },
];

const multipleQuestions: AgentPromptQuestion[] = [
  {
    id: "approach",
    header: "Approach",
    question: "Which auth approach should we use?",
    isSecret: false,
    options: [
      { label: "Session cookies", description: "Best fit for the desktop session." },
      { label: "JWT bearer", description: "Useful for clients that manage their own token." },
      { label: "OAuth only", description: "Require an external identity provider." },
    ],
  },
  {
    id: "secrets",
    header: "Secrets",
    question: "Where should local development secrets live?",
    isSecret: false,
    options: [
      { label: "Environment file", description: "Keep secrets in an ignored local file." },
      { label: "Secrets manager", description: "Read secrets from a managed vault." },
      { label: "CI only", description: "Do not provide secrets to local runs." },
    ],
  },
  {
    id: "rollout",
    header: "Rollout",
    question: "How should we release the change?",
    isSecret: false,
    options: [
      { label: "Gradual rollout", description: "Start with a small group and expand." },
      { label: "Full release", description: "Enable the change for everyone at once." },
    ],
  },
];

const customQuestion: AgentPromptQuestion[] = [
  {
    id: "outcome",
    header: "Outcome",
    question: "What result should the agent produce?",
    isSecret: false,
    options: [
      { label: "Implementation plan", description: "Prepare a decision-complete plan." },
      { label: "Working prototype", description: "Build an interactive first version." },
    ],
  },
];

const secretQuestion: AgentPromptQuestion[] = [
  {
    id: "token",
    header: "Private answer",
    question: "Which temporary access token should the agent use?",
    isSecret: true,
    options: null,
  },
];

function QuestionPromptChatPreview(props: QuestionPromptBubbleProps) {
  return (
    <section class="conversation-panel question-prompt-chat-preview" aria-label="Conversation preview">
      <header class="conversation-header">
        <div class="conversation-heading-group">
          <Button variant="ghost" size="sm" type="button" class="conversation-title" aria-label="View Chief settings">
            <AgentAvatar seed="chief" motion="idle" />
            <h1>Chief</h1>
          </Button>
        </div>
        <div class="conversation-header-actions">
          <Button
            variant="ghost"
            size="sm"
            type="button"
            class="provider-model-trigger question-prompt-chat-model"
            aria-label="Change model"
          >
            <span class="provider-model-trigger-name">Luna</span>
            <ChevronDown aria-hidden="true" />
          </Button>
        </div>
      </header>

      <div class="conversation-scroll">
        <div class="question-prompt-chat-thread">
          <time class="time-marker" datetime="2026-08-28T10:00:00.000Z">
            Today, 10:00
          </time>

          <Message role="article" align="end" class="message-entry message-entry-user" aria-label="You at 10:00">
            <MessageContent>
              <div class="message-shell">
                <Bubble align="end" variant="secondary">
                  <BubbleContent>Help me choose the safest auth setup for the launch.</BubbleContent>
                </Bubble>
              </div>
              <MessageFooter>10:00</MessageFooter>
            </MessageContent>
          </Message>

          <Message role="article" align="start" class="message-entry message-entry-bot" aria-label="Chief at 10:01">
            <MessageContent>
              <div class="message-shell">
                <Bubble variant="muted">
                  <BubbleContent>I need a few decisions before I finish the setup.</BubbleContent>
                </Bubble>
              </div>
              <MessageFooter>10:01</MessageFooter>
            </MessageContent>
          </Message>

          <Message
            role="article"
            align="start"
            class="message-entry message-entry-bot question-prompt-chat-question"
            aria-label="Chief asks questions at 10:01"
          >
            <MessageContent>
              <QuestionPromptBubble {...props} />
              <MessageFooter>10:01</MessageFooter>
            </MessageContent>
          </Message>
        </div>
      </div>

      <div class="composer-wrap question-prompt-chat-composer-wrap">
        <div class="composer" data-compact="">
          <div class="composer-input-label">
            <Textarea aria-label="Message Chief" placeholder="Message Chief" rows={1} />
          </div>
          <div class="composer-toolbar">
            <Button
              variant="ghost"
              type="button"
              class="composer-button"
              aria-label="Add to prompt"
              title="Add to prompt"
            >
              <Plus aria-hidden="true" />
            </Button>
            <div class="composer-primary-actions">
              <Button
                variant="ghost"
                type="button"
                class="voice-button"
                aria-label="Send message"
                title="Send message"
                disabled
              >
                <ArrowUp aria-hidden="true" />
              </Button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

const meta = {
  title: "Conversation/QuestionPromptBubble",
  component: QuestionPromptBubble,
  args: {
    questions: singleQuestion,
    onSubmit: fn(async () => false),
  },
  decorators: [
    (Story) => (
      <main class="question-prompt-story-stage">
        <Story />
      </main>
    ),
  ],
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta<typeof QuestionPromptBubble>;

export default meta;
type Story = StoryObj<typeof meta>;

const renderInChat: Story["render"] = (args) => <QuestionPromptChatPreview {...args} />;

export const InChat: Story = {
  name: "In chat",
  args: { questions: multipleQuestions, onSubmit: fn(async () => true) },
  render: renderInChat,
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("radio", { name: /Session cookies/ }));
    await waitFor(() => expect(canvas.getByRole("radio", { name: /Environment file/ })).toBeEnabled());
    await userEvent.click(canvas.getByRole("radio", { name: /Environment file/ }));
    await waitFor(() => expect(canvas.getByRole("radio", { name: /Gradual rollout/ })).toBeEnabled());
    await userEvent.click(canvas.getByRole("radio", { name: /Gradual rollout/ }));
    await waitFor(() => expect(canvas.getByRole("region", { name: "Answers sent" })).toBeVisible());
  },
};

export const SingleQuestion: Story = {
  render: renderInChat,
};

export const SelectedAnswer: Story = {
  render: renderInChat,
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("radio", { name: /Send that reply/ }));
    await expect(canvas.getByRole("radio", { name: /Send that reply/ })).toBeChecked();
    await waitFor(() => expect(args.onSubmit).toHaveBeenCalledWith({ reply: ["Send that reply"] }));
  },
};

export const MultipleQuestions: Story = {
  args: { questions: multipleQuestions },
  render: renderInChat,
};

export const CustomAnswer: Story = {
  args: { questions: customQuestion },
  render: renderInChat,
  play: async ({ canvas, userEvent }) => {
    const input = canvas.getByRole("textbox", { name: /Custom answer/ });
    await userEvent.type(input, "A short technical brief with risks and owners.");
    await expect(input).toHaveFocus();
  },
};

export const SecretAnswer: Story = {
  args: { questions: secretQuestion },
  render: renderInChat,
  play: async ({ canvas }) => {
    const input = canvas.getByLabelText(/Custom answer/);
    await expect(input).toHaveAttribute("type", "password");
    await expect(input).toHaveFocus();
  },
};

export const Sending: Story = {
  args: { pending: true },
  render: renderInChat,
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("status")).toHaveTextContent("Sending");
    await expect(canvas.getByRole("button", { name: "Skip" })).toBeDisabled();
    await expect(canvas.getByRole("button", { name: "Cancel questions" })).toBeDisabled();
    for (const option of canvas.getAllByRole("radio")) await expect(option).toBeDisabled();
  },
};

export const Empty: Story = {
  args: { questions: [] },
  render: renderInChat,
};

export const Narrow: Story = {
  args: { questions: multipleQuestions },
  render: renderInChat,
  decorators: [
    (Story) => (
      <div class="question-prompt-story-narrow">
        <Story />
      </div>
    ),
  ],
};

export const AutoAdvanceAndPreserveAnswers: Story = {
  args: { questions: multipleQuestions },
  render: renderInChat,
  play: async ({ canvas, userEvent }) => {
    const firstDraft = canvas.getByRole("textbox", { name: /Custom answer for: Which auth/ });
    await userEvent.type(firstDraft, "Keep the existing session format.");
    await userEvent.click(canvas.getByRole("radio", { name: /Session cookies/ }));
    await waitFor(() => expect(canvas.getByRole("radio", { name: /Environment file/ })).toBeEnabled());
    await userEvent.click(canvas.getByRole("radio", { name: /Environment file/ }));
    await waitFor(() => expect(canvas.getByRole("radio", { name: /Gradual rollout/ })).toBeEnabled());

    await userEvent.click(canvas.getByRole("button", { name: "Previous question" }));
    await waitFor(() => expect(canvas.getByRole("radio", { name: /Environment file/ })).toBeEnabled());
    await expect(canvas.getByRole("radio", { name: /Environment file/ })).toBeChecked();
    await userEvent.click(canvas.getByRole("button", { name: "Previous question" }));
    await waitFor(() => expect(canvas.getByRole("radio", { name: /Session cookies/ })).toBeEnabled());
    await expect(canvas.getByRole("radio", { name: /Session cookies/ })).toBeChecked();
    await expect(canvas.getByRole("textbox", { name: /Custom answer for: Which auth/ })).toHaveValue(
      "Keep the existing session format.",
    );
  },
};

export const SkipAndCancel: Story = {
  args: { questions: multipleQuestions },
  render: renderInChat,
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Skip" }));
    await waitFor(() => expect(canvas.getByRole("button", { name: "Cancel questions" })).toBeEnabled());
    await userEvent.click(canvas.getByRole("button", { name: "Cancel questions" }));
    await waitFor(() => expect(args.onSubmit).toHaveBeenCalledWith({}));
  },
};

export const PersistedAnswered: Story = {
  args: {
    questions: multipleQuestions,
    resolution: {
      status: "answered",
      responses: {
        approach: { status: "answered", answers: ["Session cookies"] },
        secrets: { status: "answered", answers: ["Environment file"] },
        rollout: { status: "skipped" },
      },
    },
  },
  render: renderInChat,
};

export const PersistedExpired: Story = {
  args: { questions: multipleQuestions, resolution: { status: "expired" } },
  render: renderInChat,
};
