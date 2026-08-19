import { serializeAttachmentReference } from "@openbot/contracts/attachment-references";
import type {
  AgentEvent,
  AgentModelId,
  AgentReasoningEffort,
  AttachmentSummary,
  AvatarImageInput,
  QueueSnapshot,
  UpdateBotInput,
} from "@openbot/contracts/ipc";
import { createEffect, createSignal, onCleanup } from "solid-js";
import { expect, fn } from "storybook/test";
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
  body:
    message.id === "message-agent-1"
      ? `${message.text}\n\nPlease review ${serializeAttachmentReference(STORY_ATTACHMENTS[0].name, STORY_ATTACHMENTS[0].id)} before editing the implementation notes.\n\nTransformers scale well with data and compute [1], though attention is quadratic in sequence length [2].`
      : message.text,
  time: "10:00",
  itemType: message.itemType,
  senderBotId: message.senderBotId,
  replyToMessageId: message.replyToMessageId,
  attachments: message.attachments,
  citations:
    message.id === "message-agent-1"
      ? [
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
        ]
      : undefined,
  exchange: message.exchange,
  reaction: message.reaction,
  kind: message.exchange ? "exchange" : "text",
}));

const unreadStoryMessages: RendererBotMessage[] = [
  ...Array.from(
    { length: 12 },
    (_, index): RendererBotMessage => ({
      id: `unread-history-${index + 1}`,
      author: index % 2 === 0 ? "you" : "bot",
      body:
        index % 2 === 0
          ? `Historical project update ${index + 1}: please check the owner and due date.`
          : `Reviewed historical update ${index + 1}. The owner and due date are confirmed.`,
      time: `09:${String(20 + index).padStart(2, "0")}`,
      kind: "text",
    }),
  ),
  ...Array.from(
    { length: 8 },
    (_, index): RendererBotMessage => ({
      id: `unread-story-new-${index + 1}`,
      author: "bot",
      body: `New update ${index + 1}: I reviewed the launch plan, verified the supporting notes, and added a concrete next action for the team. This message intentionally has enough detail to keep the unread boundary above the visible viewport when the conversation opens at the bottom.`,
      time: `09:${String(40 + index).padStart(2, "0")}`,
      kind: "text",
    }),
  ),
];

const imageGenerationMessages: RendererBotMessage[] = [
  ...messages,
  {
    id: "image-generation-user",
    author: "you",
    body: "Create a quiet observatory above the clouds at blue hour.",
    time: "10:02",
    kind: "text",
  },
  {
    id: "image-generation-in-chat",
    author: "bot",
    body: "",
    time: "10:02",
    turnId: "turn-image-generation",
    itemType: "image_generation",
    status: "streaming",
    streaming: true,
    kind: "text",
    imageGeneration: {
      prompt: "A quiet observatory above the clouds at blue hour",
      resolution: "1024 × 1024",
      aspectRatio: "square",
    },
  },
];

const generatedImagePreview = new URL("../src/assets/openbot-logo-production.png", import.meta.url).href;
const generatedImageAttachment: AttachmentSummary = {
  id: "generated-image-in-chat",
  name: "generated-image.png",
  size: 184_320,
  kind: "image",
  mimeType: "image/png",
  previewKind: "image",
  previewUrl: generatedImagePreview,
};

const completedImageGenerationMessages: RendererBotMessage[] = imageGenerationMessages.map((message) =>
  message.id === "image-generation-in-chat"
    ? {
        ...message,
        status: "completed",
        streaming: false,
        attachments: [generatedImageAttachment],
      }
    : message,
);
const completedImageGenerationPresence = {
  ...STORY_PRESENCE,
  members: STORY_PRESENCE.members.map((member) =>
    member.typingBotId === "chief" ? { ...member, typingBotId: null } : member,
  ),
};

const dataTableMessages: RendererBotMessage[] = [
  {
    id: "data-table-user",
    author: "you",
    body: "Compare the available models by context window and input price.",
    time: "10:02",
    kind: "text",
  },
  {
    id: "data-table-agent",
    author: "bot",
    body: [
      "Here’s a compact comparison:",
      "",
      "| Model | Context | $/1M in |",
      "| --- | --- | ---: |",
      "| gpt-4o | 128k | $5.00 |",
      "| claude-3.5 | 200k | $3.00 |",
      "| llama-3.1 | 128k | $0.90 |",
    ].join("\n"),
    time: "10:03",
    kind: "text",
  },
];

const comparisonTableMessages: RendererBotMessage[] = [
  {
    id: "comparison-table-user",
    author: "you",
    body: "Compare the Personal and Enterprise plans feature by feature.",
    time: "10:02",
    kind: "text",
  },
  {
    id: "comparison-table-agent",
    author: "bot",
    body: [
      "Here’s the feature breakdown:",
      "",
      "| Feature | Personal | Enterprise |",
      "| --- | --- | --- |",
      "| Unlimited projects | ✓ | ✓ |",
      "| All components | ✓ | ✓ |",
      "| Team-wide usage | — | ✓ |",
      "| Priority support | — | ✓ |",
    ].join("\n"),
    time: "10:03",
    kind: "text",
  },
];

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

const promptQuestions: Extract<AgentEvent, { type: "prompt" }> = {
  type: "prompt",
  requestId: "prompt-questions",
  botId: "chief",
  threadId: "thread-chief",
  turnId: "turn-prompt-questions",
  questions: [
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
  ],
};

const promptChatMessages: RendererBotMessage[] = [
  {
    id: "prompt-chat-user",
    author: "you",
    body: "Help me choose the safest auth setup for the launch.",
    time: "10:00",
    kind: "text",
  },
  {
    id: "prompt-chat-agent",
    author: "bot",
    body: "I have a few decisions to confirm before I finish the setup.",
    time: "10:01",
    kind: "text",
  },
];

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

function queueWithItems(count: number, text = "Add the final checklist and verify the rollout notes"): QueueSnapshot {
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
  const [unreadCount, setUnreadCount] = createSignal(0);
  const [firstUnreadMessageId, setFirstUnreadMessageId] = createSignal<string | null>(null);
  createEffect(
    () => [props.args.unreadCount, props.args.firstUnreadMessageId] as const,
    ([count, messageId]) => {
      setUnreadCount(count);
      setFirstUnreadMessageId(messageId);
    },
  );
  window.openbot = mock.api;
  onCleanup(() => {
    mock.dispose();
    window.openbot = previousApi;
  });
  return (
    <div class="conversation-story-frame">
      <Conversation
        {...props.args}
        unreadCount={unreadCount()}
        firstUnreadMessageId={firstUnreadMessageId()}
        onMarkRead={async () => {
          await props.args.onMarkRead();
          setUnreadCount(0);
          setFirstUnreadMessageId(null);
        }}
      />
    </div>
  );
}

const args: Parameters<typeof Conversation>[0] = {
  agentStatus: STORY_AGENT_STATUS,
  bot: STORY_BOTS[0],
  bots: STORY_BOTS,
  modelOptions: STORY_MODELS,
  messages,
  unreadCount: 0,
  firstUnreadMessageId: null,
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
  onSendMessage: async (_body: string, _attachmentDraftIds: string[], _replyToMessageId: string | null) => true,
  onMarkRead: async () => undefined,
  onTypingChange: fn(),
  onCompleteOnboarding: async (_answer: string, _model: AgentModelId, _reasoningEffort: AgentReasoningEffort) => true,
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

export const NarrowRichConversation: Story = {
  name: "Narrow rich conversation",
  args: {
    browserTabs: [],
    activeBrowserTabId: null,
    browserControlState: { sessions: [] },
  },
  render: (storyArgs) => (
    <section aria-label="Narrow conversation sample" style={{ width: "360px", height: "820px", overflow: "hidden" }}>
      <MockedConversation args={storyArgs} />
    </section>
  ),
  play: async ({ canvas }) => {
    const sample = canvas.getByLabelText("Narrow conversation sample");
    const reference = canvas.getByRole("button", {
      name: `Open attached file ${STORY_ATTACHMENTS[0].name}`,
    });
    await expect(sample.scrollWidth).toBeLessThanOrEqual(sample.clientWidth);
    await expect(reference.getBoundingClientRect().right).toBeLessThanOrEqual(sample.getBoundingClientRect().right);
  },
};

export const UnreadMessages: Story = {
  args: {
    messages: unreadStoryMessages,
    unreadCount: 8,
    firstUnreadMessageId: "unread-story-new-1",
    browserTabs: [],
    activeBrowserTabId: null,
    browserControlState: { sessions: [] },
  },
};

export const ScrollToLatest: Story = {
  args: {
    messages: unreadStoryMessages,
    unreadCount: 0,
    firstUnreadMessageId: null,
    browserTabs: [],
    activeBrowserTabId: null,
    browserControlState: { sessions: [] },
  },
  play: async ({ canvas, canvasElement }) => {
    const scrollElement = canvasElement.querySelector<HTMLElement>(".conversation-scroll");
    if (!scrollElement) throw new Error("Conversation scroll element is missing.");
    Object.defineProperties(scrollElement, {
      clientHeight: { configurable: true, value: 600 },
      scrollHeight: { configurable: true, value: 1_200 },
    });
    scrollElement.scrollTop = 0;
    scrollElement.dispatchEvent(new Event("scroll"));
    await expect(canvas.findByRole("button", { name: "Scroll to latest message" })).resolves.toBeVisible();
  },
};

export const CitationsInChat: Story = {
  name: "Citations in chat",
};

export const ImageGenerationInChat: Story = {
  name: "Image generation in chat",
  args: {
    messages: imageGenerationMessages,
    activeTurnId: "turn-image-generation",
    browserTabs: [],
    activeBrowserTabId: null,
    browserControlState: { sessions: [] },
  },
};

export const ImageGenerationCompletedInChat: Story = {
  name: "Image generation completed in chat",
  args: {
    messages: completedImageGenerationMessages,
    activeTurnId: "turn-image-generation",
    presence: completedImageGenerationPresence,
    browserTabs: [],
    activeBrowserTabId: null,
    browserControlState: { sessions: [] },
  },
  play: async ({ canvas }) => {
    expect(canvas.queryByRole("status", { name: "Chief is working" })).not.toBeInTheDocument();
    await canvas.getByRole("button", { name: "Preview generated image" }).click();
    await expect(canvas.findByRole("dialog", { name: "generated-image.png" })).resolves.toBeInTheDocument();
  },
};

export const DataTableInChat: Story = {
  name: "Data table in chat",
  args: {
    messages: dataTableMessages,
    browserTabs: [],
    activeBrowserTabId: null,
    browserControlState: { sessions: [] },
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByText("Compare the available models by context window and input price.")).toBeVisible();
    await expect(canvas.getByRole("table")).toBeVisible();
    await expect(canvas.getAllByRole("columnheader")).toHaveLength(3);
  },
};

export const ComparisonTableInChat: Story = {
  name: "Comparison table in chat",
  args: {
    messages: comparisonTableMessages,
    browserTabs: [],
    activeBrowserTabId: null,
    browserControlState: { sessions: [] },
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByText("Compare the Personal and Enterprise plans feature by feature.")).toBeVisible();
    await expect(canvas.getByRole("region", { name: "Comparison table" })).toBeVisible();
    await expect(canvas.getAllByRole("columnheader")).toHaveLength(3);
  },
};

export const ImageGenerationUnavailableWithClaude: Story = {
  name: "Image generation unavailable with Claude",
  args: {
    bot: { ...STORY_BOTS[0], model: "claude-sonnet-5" },
    messages: [],
    browserTabs: [],
    activeBrowserTabId: null,
    browserControlState: { sessions: [] },
  },
};

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
        items: ["Read the project brief", "Compared the milestone owners", "Drafting the next action"],
        streaming: true,
      },
    ],
  },
};

export const Prompt: Story = {
  args: { prompt },
};

export const PromptQuestionsInChat: Story = {
  name: "Prompt questions in chat",
  args: {
    messages: promptChatMessages,
    prompt: promptQuestions,
    browserTabs: [],
    activeBrowserTabId: null,
    browserControlState: { sessions: [] },
  },
};

export const Queued: Story = {
  args: { queue },
};

export const ThreeQueuedMessages: Story = {
  args: { queue: queueWithItems(3), activeTurnId: "turn-active" },
};

export const SevenQueuedMessages: Story = {
  args: {
    queue: queueWithItems(7, "Review the very long launch brief and summarize every dependency before shipping"),
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
