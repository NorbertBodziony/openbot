import type {
  AgentEvent,
  AgentModelId,
  AgentReasoningEffort,
  AvatarImageInput,
  QueueSnapshot,
  UpdateBotInput,
} from "@openbot/contracts/ipc";
import { onCleanup } from "solid-js";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { Conversation } from "../src/components/Conversation";
import type { BotMessage as RendererBotMessage } from "../src/data";
import {
  STORY_AGENT_STATUS,
  STORY_ATTACHMENTS,
  STORY_BOTS,
  STORY_BROWSER_CONTROL,
  STORY_BROWSER_TABS,
  STORY_CONVERSATION_MESSAGES,
  STORY_MODELS,
  STORY_PRESENCE,
  STORY_REMOTE_MAC_SESSION,
  STORY_SERVERS,
} from "./fixtures";
import { createMockOpenBot } from "./mock-openbot";

const messages: RendererBotMessage[] = STORY_CONVERSATION_MESSAGES.map((message) => ({
  id: message.id,
  author: message.author === "user" ? "you" : "bot",
  body: message.text,
  time: "10:00",
  itemType: message.itemType,
  senderBotId: message.senderBotId,
  replyToMessageId: message.replyToMessageId,
  attachments: message.attachments,
  exchange: message.exchange,
  reaction: message.reaction,
  kind: message.exchange ? "exchange" : "text",
}));

const prompt: Extract<AgentEvent, { type: "prompt" }> = {
  type: "prompt",
  requestId: "prompt-1",
  botId: "chief",
  threadId: "thread-chief",
  turnId: "turn-prompt",
  questions: [
    {
      id: "scope",
      header: "Scope",
      question: "What should the next update focus on?",
      isSecret: false,
      options: [
        { label: "Launch", description: "Focus on launch readiness." },
        { label: "Research", description: "Focus on source quality." },
      ],
    },
  ],
};

const queue: QueueSnapshot = {
  botId: "chief",
  paused: false,
  deliveries: [
    {
      id: "queued-1",
      messageId: "queued-message-1",
      recipientBotId: "chief",
      sender: { kind: "user" },
      text: "Add a final checklist.",
      attachments: [],
      replyToMessageId: null,
      status: "queued",
      position: 1,
      turnId: null,
      error: null,
      createdAt: "2026-08-19T10:00:00.000Z",
    },
  ],
};

function queueWithItems(
  count: number,
  text = "Add the final checklist and verify the rollout notes",
): QueueSnapshot {
  return {
    ...queue,
    deliveries: Array.from({ length: count }, (_, index) => ({
      ...queue.deliveries[0],
      id: `queued-${index + 1}`,
      messageId: `queued-message-${index + 1}`,
      text: index === 0 ? text : `${text} — item ${index + 1}`,
      position: index + 1,
      createdAt: `2026-08-19T10:0${index}:00.000Z`,
    })),
  };
}

function MockedConversation(props: { args: Parameters<typeof Conversation>[0] }) {
  const previousApi = window.openbot;
  const mock = createMockOpenBot();
  window.openbot = mock.api;
  onCleanup(() => {
    mock.dispose();
    window.openbot = previousApi;
  });
  return <Conversation {...props.args} />;
}

const args: Parameters<typeof Conversation>[0] = {
  agentStatus: STORY_AGENT_STATUS,
  bot: STORY_BOTS[0],
  bots: STORY_BOTS,
  modelOptions: STORY_MODELS,
  messages,
  loaded: true,
  activeTurnId: null,
  agentPickerOpen: false,
  creatingAgent: false,
  settingsRequest: null,
  onboardingRequest: null,
  queue: undefined,
  browserTabs: STORY_BROWSER_TABS,
  activeBrowserTabId: STORY_BROWSER_TABS[0].id,
  browserControlState: STORY_BROWSER_CONTROL,
  server: STORY_SERVERS[0],
  presence: STORY_PRESENCE,
  currentUserEmail: "person@example.com",
  remoteMacSession: STORY_REMOTE_MAC_SESSION,
  remoteDesktopRequest: 0,
  prompt: undefined,
  approval: undefined,
  onCloseAgentPicker: fn(),
  onCreateAgent: fn(),
  onSelectAgent: fn(),
  onUpdateBot: async (_botId: string, _updates: Omit<UpdateBotInput, "botId">) => undefined,
  onSetAgentAvatar: async (_botId: string, _image: AvatarImageInput | null) => undefined,
  onSendMessage: async (
    _body: string,
    _attachmentDraftIds: string[],
    _replyToMessageId: string | null,
  ) => true,
  onTypingChange: fn(),
  onCompleteOnboarding: async (
    _answer: string,
    _model: AgentModelId,
    _reasoningEffort: AgentReasoningEffort,
  ) => true,
  onAnswerPrompt: async (_answers: Record<string, string[]>) => true,
  onRespondToApproval: async (_decision: "accept" | "decline") => true,
  onCancelQueuedMessage: fn(),
  onSteerQueuedMessage: fn(),
  onUpdateQueuedMessage: async (
    _deliveryId: string,
    _text: string,
    _keepAttachmentIds: string[],
    _attachmentDraftIds: string[],
  ) => true,
  onReorderQueue: fn(),
  onResumeQueue: fn(),
  onActivateBrowserTab: fn(),
  onCloseBrowserTab: fn(),
  onConnectRemoteMac: async (_hostname: string, _serverId: string | null) => undefined,
  onDisconnectRemoteMac: async (_sessionId: string) => undefined,
  onOpenAgentSetup: async () => undefined,
  onStop: fn(),
};

const meta = {
  title: "Conversation/Conversation",
  component: Conversation,
  args,
  parameters: { layout: "fullscreen" },
  render: (storyArgs) => <MockedConversation args={storyArgs} />,
} satisfies Meta<typeof Conversation>;

export default meta;
type Story = StoryObj<typeof meta>;

export const RichConversation: Story = {};

export const Thinking: Story = {
  args: {
    activeTurnId: "turn-thinking",
    messages: [
      ...messages,
      {
        id: "thinking-1",
        author: "bot",
        body: "",
        time: "10:01",
        kind: "thinking",
        items: [
          "Read the project brief",
          "Compared the milestone owners",
          "Drafting the next action",
        ],
        streaming: true,
      },
    ],
  },
};

export const Prompt: Story = {
  args: { prompt },
};

export const Queued: Story = {
  args: { queue },
};

export const ThreeQueuedMessages: Story = {
  args: { queue: queueWithItems(3), activeTurnId: "turn-active" },
};

export const SevenQueuedMessages: Story = {
  args: {
    queue: queueWithItems(
      7,
      "Review the very long launch brief and summarize every dependency before shipping",
    ),
    activeTurnId: "turn-active",
  },
};

export const PausedQueue: Story = {
  args: { queue: { ...queueWithItems(3), paused: true } },
};

export const EditingQueuedMessage: Story = {
  args: {
    queue: {
      ...queue,
      deliveries: [{ ...queue.deliveries[0], attachments: STORY_ATTACHMENTS }],
    },
    activeTurnId: "turn-active",
  },
};

export const Empty: Story = {
  args: { messages: [], loaded: true, queue: undefined },
};
