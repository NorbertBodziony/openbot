import { serializeAttachmentReference } from "@openbot/contracts/attachment-references";
import type {
  AgentEvent,
  AttachmentSummary,
  AvatarImageInput,
  DraftAttachment,
  QueueSnapshot,
  UpdateBotInput,
} from "@openbot/contracts/ipc";
import { Portal } from "@solidjs/web";
import { createEffect, createSignal, onCleanup, onSettled, Show } from "solid-js";
import { expect, fireEvent, fn, waitFor, within } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { clipboardFiles } from "../../preload/clipboard-files";
import {
  Conversation,
  ConversationControllerProvider,
  createConversationController,
} from "../src/components/Conversation";
import { BrowserTakeoverCard } from "../src/components/ConversationPrompts";
import { ConversationView } from "../src/components/ConversationView";
import type { BotMessage as RendererBotMessage } from "../src/data";
import browserTakeoverPreviewUrl from "./assets/browser-takeover-preview.svg";
import {
  STORY_AGENT_STATUS,
  STORY_ATTACHMENTS,
  STORY_BOTS,
  STORY_CONVERSATION_MESSAGES,
  STORY_MODELS,
  STORY_PRESENCE,
  STORY_REMOTE_DESKTOP_SESSION,
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
const generatedImagePreviewAlternate = new URL("../src/assets/openbot-logo-dev.png", import.meta.url).href;
const generatedImageAttachment: AttachmentSummary = {
  id: "generated-image-in-chat",
  name: "generated-image.png",
  size: 184_320,
  kind: "image",
  mimeType: "image/png",
  previewKind: "image",
  previewUrl: generatedImagePreview,
};
const queuePreviewAttachments: AttachmentSummary[] = [
  { ...generatedImageAttachment, id: "queue-preview-primary", name: "command-search.png" },
  {
    ...generatedImageAttachment,
    id: "queue-preview-alternate",
    name: "message-search.png",
    previewUrl: generatedImagePreviewAlternate,
  },
];
const supportedContextAttachments: AttachmentSummary[] = [
  {
    id: "composer-context-pdf",
    name: "product-brief.pdf",
    size: 842_752,
    kind: "file",
    mimeType: "application/pdf",
    previewKind: "pdf",
    previewUrl: null,
  },
  {
    id: "composer-context-markdown",
    name: "README.md",
    size: 12_288,
    kind: "file",
    mimeType: "text/markdown",
    previewKind: "text",
    previewUrl: null,
  },
  {
    id: "composer-context-text",
    name: "meeting-notes.txt",
    size: 4_096,
    kind: "file",
    mimeType: "text/plain",
    previewKind: "text",
    previewUrl: null,
  },
  {
    id: "composer-context-json",
    name: "sample-data.json",
    size: 24_576,
    kind: "file",
    mimeType: "application/json",
    previewKind: "text",
    previewUrl: null,
  },
  {
    id: "composer-context-docx",
    name: "requirements.docx",
    size: 126_976,
    kind: "file",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    previewKind: "none",
    previewUrl: null,
  },
];
const sentContextFileMessages: RendererBotMessage[] = [
  {
    id: "sent-context-request",
    author: "bot",
    body: "Podeślij materiały, na których mam oprzeć podsumowanie.",
    time: "10:04",
    kind: "text",
  },
  {
    id: "sent-context-files",
    author: "you",
    body: "Jasne — załączam brief, notatki, dane i wymagania. Przygotuj z nich krótkie podsumowanie.",
    time: "10:05",
    kind: "text",
    attachments: supportedContextAttachments,
  },
];

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

const botMessageGalleryMessages: RendererBotMessage[] = [
  {
    id: "bot-gallery-user",
    author: "you",
    body: "Show every message surface and interaction in one thread.",
    time: "10:00",
    kind: "text",
  },
  {
    id: "bot-gallery-plain",
    author: "bot",
    body: "Plain assistant text uses the muted Bubble surface and keeps its actions aligned with the bottom edge.",
    time: "10:01",
    kind: "text",
    reaction: "👍",
    reactionSummary: { emojis: ["👍", "🚀"], overflowCount: 2 },
  },
  {
    id: "bot-gallery-links",
    author: "bot",
    body: [
      "## Links and references",
      "",
      "Review [OpenBot documentation](https://openbot.run/docs), the [Kobalte guide](https://kobalte.dev/docs/core/overview/introduction), and https://zaidan.carere.dev/docs/components/kobalte/bubble.",
      "",
      "You can also open [ConversationView.tsx](/Users/test/OpenBot/src/renderer/src/components/ConversationView.tsx), ask @Research, or inspect the attached source file below.",
      "",
      `Attachment reference: ${serializeAttachmentReference(STORY_ATTACHMENTS[0].name, STORY_ATTACHMENTS[0].id)}.`,
      "",
      "The implementation follows the component source [1] and the accessibility guidance [2].",
    ].join("\n"),
    time: "10:02",
    kind: "text",
    attachments: [STORY_ATTACHMENTS[0]],
    citations: [
      {
        number: 1,
        label: "Zaidan Bubble",
        url: "https://zaidan.carere.dev/docs/components/kobalte/bubble",
        host: "zaidan.carere.dev",
      },
      {
        number: 2,
        label: "Kobalte accessibility",
        url: "https://kobalte.dev/docs/core/overview/accessibility",
        host: "kobalte.dev",
      },
    ],
    reaction: "👀",
    reactionSummary: { emojis: ["👀", "🔥", "✅"], overflowCount: 1 },
  },
  {
    id: "bot-gallery-reply",
    author: "bot",
    body: "This Bubble includes a reply context without changing how reactions or message actions are positioned.",
    time: "10:03",
    kind: "text",
    replyToMessageId: "bot-gallery-user",
    reaction: "❤️",
  },
  {
    id: "bot-gallery-markdown",
    author: "bot",
    body: [
      "## Markdown response",
      "",
      "- **Bold**, *emphasis*, and `inline code`",
      "- [x] Completed task",
      "- [ ] Pending task",
      "",
      "> Rich text remains inside one assistant Bubble.",
    ].join("\n"),
    time: "10:04",
    kind: "text",
    reaction: "🎉",
  },
  {
    id: "bot-gallery-code",
    author: "bot",
    body: [
      "Run the focused verification:",
      "",
      "```bash verify-chat.sh",
      "bun run typecheck:renderer",
      "bunx vitest run src/renderer/src/components/conversation/MessageRendering.test.tsx",
      "```",
    ].join("\n"),
    time: "10:05",
    kind: "text",
    reaction: "✅",
    reactionSummary: { emojis: ["✅", "🚀"] },
  },
  {
    id: "bot-gallery-data-table",
    author: "bot",
    body: [
      "Current message surfaces:",
      "",
      "| Content | Surface | Actions |",
      "| --- | --- | --- |",
      "| Plain text | Muted | Reply + react |",
      "| Code | Ghost | Reply + react |",
      "| Image | Ghost | Reply + react |",
    ].join("\n"),
    time: "10:06",
    kind: "text",
    reaction: "🚀",
  },
  {
    id: "bot-gallery-comparison-table",
    author: "bot",
    body: [
      "Feature matrix:",
      "",
      "| Capability | Text | Rich content |",
      "| --- | --- | --- |",
      "| Reactions | ✓ | ✓ |",
      "| Reply | ✓ | ✓ |",
      "| Keyboard actions | ✓ | ✓ |",
      "| Nested frame | — | — |",
    ].join("\n"),
    time: "10:07",
    kind: "text",
    reaction: "💯",
  },
  {
    id: "bot-gallery-attachment-with-text",
    author: "bot",
    body: "The supporting files are ready. This example keeps an attachment inside a regular text Bubble.",
    time: "10:08",
    kind: "text",
    attachments: STORY_ATTACHMENTS.slice(0, 2),
    reaction: "👏",
  },
  {
    id: "bot-gallery-attachment-only",
    author: "bot",
    body: "",
    time: "10:09",
    kind: "text",
    attachments: [STORY_ATTACHMENTS[0]],
    reaction: "🔥",
  },
  {
    id: "bot-gallery-image",
    author: "bot",
    body: "",
    time: "10:10",
    kind: "text",
    status: "completed",
    attachments: [generatedImageAttachment],
    imageGeneration: {
      prompt: "A quiet observatory above the clouds at blue hour",
      resolution: "1024 × 1024",
      aspectRatio: "square",
    },
    reaction: "😮",
    reactionSummary: { emojis: ["😮", "🎉"], overflowCount: 3 },
  },
  {
    id: "bot-gallery-failed",
    author: "bot",
    body: "I could not finish the remote verification. The message still exposes reply, copy, and reaction actions.",
    time: "10:11",
    kind: "text",
    status: "Failed",
    reaction: "🤔",
  },
  {
    id: "bot-gallery-streaming",
    author: "bot",
    body: [
      "Streaming response with an open code fence:",
      "",
      "```ts stream.ts",
      "const message = await renderNextChunk();",
    ].join("\n"),
    time: "10:12",
    kind: "text",
    turnId: "bot-gallery-stream",
    status: "streaming",
    streaming: true,
  },
];

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

const codeBlockMessages: RendererBotMessage[] = [
  {
    id: "code-block-user",
    author: "you",
    body: "Show me the launch check command.",
    time: "10:02",
    kind: "text",
  },
  {
    id: "code-block-agent",
    author: "bot",
    body: [
      "Run this from the repository root:",
      "",
      "```bash",
      "bun run check",
      "bun run test",
      "bun run build",
      "```",
    ].join("\n"),
    time: "10:03",
    kind: "text",
  },
  {
    id: "code-block-follow-up",
    author: "bot",
    body: "The checks should complete before release.",
    time: "10:04",
    kind: "text",
  },
];

const markdownMessages: RendererBotMessage[] = [
  {
    id: "markdown-user",
    author: "you",
    body: "Which component library should we use for Solid JS?",
    time: "10:02",
    kind: "text",
  },
  {
    id: "markdown-agent",
    author: "bot",
    body: [
      "## Recommendation",
      "",
      "The best fit is **Kobalte**. Use *Solid UI* when you need ready-made components.",
      "",
      "### Why",
      "",
      "- Mature and actively maintained",
      "- Strong accessibility support",
      "  - Keyboard navigation",
      "  - Focus management",
      "- [x] Works with our design system",
      "- [ ] Add the remaining primitives",
      "",
      "1. Install `@kobalte/core`.",
      "2. Replace ~~custom controls~~ with shared primitives.",
      "",
      "> Keep the public UI API small and stable.",
      "",
      "Read [the Kobalte guide](https://kobalte.dev/docs/core/overview/introduction).",
    ].join("\n"),
    time: "10:03",
    kind: "text",
  },
  {
    id: "markdown-follow-up",
    author: "bot",
    body: "I can prepare the migration checklist next.",
    time: "10:04",
    kind: "text",
  },
];

const streamingMarkdownChunks = [
  "## Live response\n\nI am checking the",
  "## Live response\n\nI am checking the **Markdown renderer**.",
  [
    "## Live response",
    "",
    "I am checking the **Markdown renderer**.",
    "",
    "- Parse emphasis",
    "- Resize the message row",
  ].join("\n"),
  [
    "## Live response",
    "",
    "I am checking the **Markdown renderer**.",
    "",
    "- Parse emphasis",
    "- Resize the message row",
    "",
    "```ts",
    "const ready = true;",
  ].join("\n"),
  [
    "## Live response",
    "",
    "I am checking the **Markdown renderer**.",
    "",
    "- Parse emphasis",
    "- Resize the message row",
    "",
    "```ts",
    "const ready = true;",
    "```",
    "",
    "The streamed response is complete.",
  ].join("\n"),
] as const;

function streamingMarkdownMessages(chunkIndex: number): RendererBotMessage[] {
  return [
    {
      id: "streaming-markdown-user",
      author: "you",
      body: "Check Markdown while the model response streams.",
      time: "10:02",
      kind: "text",
    },
    {
      id: "streaming-markdown-agent",
      author: "bot",
      body: streamingMarkdownChunks[chunkIndex],
      time: "10:03",
      kind: "text",
      streaming: chunkIndex < streamingMarkdownChunks.length - 1,
    },
    {
      id: "streaming-markdown-follow-up",
      author: "bot",
      body: "This message must stay below the growing response.",
      time: "10:04",
      kind: "text",
    },
  ];
}

function StreamingMarkdownConversation(props: { args: Parameters<typeof Conversation>[0] }) {
  const [chunkIndex, setChunkIndex] = createSignal(0);
  const stableMessages = streamingMarkdownMessages(0);
  const streamingMessage = stableMessages[1];
  if (streamingMessage) {
    Object.defineProperties(streamingMessage, {
      body: { configurable: true, enumerable: true, get: () => streamingMarkdownChunks[chunkIndex()] },
      streaming: {
        configurable: true,
        enumerable: true,
        get: () => chunkIndex() < streamingMarkdownChunks.length - 1,
      },
    });
  }
  let interval: number | undefined;
  const start = window.setTimeout(() => {
    interval = window.setInterval(() => {
      setChunkIndex((current) => {
        if (current < streamingMarkdownChunks.length - 1) return current + 1;
        if (interval) window.clearInterval(interval);
        return current;
      });
    }, 180);
  }, 450);
  onCleanup(() => {
    window.clearTimeout(start);
    if (interval) window.clearInterval(interval);
  });

  return <MockedConversation args={{ ...props.args, activeTurnId: "streaming-markdown" }} messages={stableMessages} />;
}

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

const browserTakeover: Extract<AgentEvent, { type: "browser-takeover-requested" }>["request"] = {
  requestId: "takeover-1",
  botId: "chief",
  threadId: "thread-chief",
  turnId: "turn-takeover",
  tabId: "tab-login",
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

const queueReferenceMessages = [
  "Improve how right-clicking an agent works in the sidebar. It should match the app…",
  "The inputs are still not right. Check exactly how they work in the application…",
  "Add Command+F to chat, like in Grok Bot, and keep message reordering consistent…",
  "Add the same search modal as Grok Bot for messages and agents…",
  "The latest chat message is too low. Move it up so it stays visible…",
  "Run all checks and fix every failure",
  "Push the final changes to main",
] as const;

const referenceQueue: QueueSnapshot = {
  ...queue,
  deliveries: queueWithItems(queueReferenceMessages.length).deliveries.map((delivery, index) => ({
    ...delivery,
    text: queueReferenceMessages[index],
    attachments: index === 2 ? [queuePreviewAttachments[0]] : index === 3 ? [queuePreviewAttachments[1]] : [],
  })),
};

function MockedConversation(props: {
  args: Parameters<typeof Conversation>[0];
  messages?: RendererBotMessage[];
  initialAttachments?: DraftAttachment[];
  voiceModelProgress?: number;
  takeoverStateGallery?: boolean;
}) {
  const previousApi = window.openbot;
  const mock = createMockOpenBot();
  const controller = createConversationController({ onTypingChange: props.args.onTypingChange });
  const previewUrls = new Set<string>();
  let storyFrameElement: HTMLDivElement | undefined;
  let takeoverGalleryScrollTimer: number | undefined;
  const initialBotId = props.args.bot?.id;
  if (initialBotId && props.initialAttachments?.length) {
    onSettled(() => {
      controller.setDrafts({
        [initialBotId]: { text: "", attachments: props.initialAttachments ?? [], replyToMessageId: null },
      });
    });
  }
  if (props.voiceModelProgress !== undefined) {
    onSettled(() => {
      controller.setVoicePhase("preparing");
      controller.setVoiceModelProgress(props.voiceModelProgress ?? null);
    });
  }
  const [unreadCount, setUnreadCount] = createSignal(0);
  const [firstUnreadMessageId, setFirstUnreadMessageId] = createSignal<string | null>(null);
  const [takeoverGalleryMount, setTakeoverGalleryMount] = createSignal<HTMLElement | null>(null);
  createEffect(
    () => [props.args.unreadCount, props.args.firstUnreadMessageId] as const,
    ([count, messageId]) => {
      setUnreadCount(count);
      setFirstUnreadMessageId(messageId);
    },
  );
  window.openbot = mock.api;
  if (props.takeoverStateGallery) {
    onSettled(() => {
      const mount = storyFrameElement?.querySelector<HTMLElement>(".conversation-scroll") ?? null;
      setTakeoverGalleryMount(mount);
      takeoverGalleryScrollTimer = window.setTimeout(() => {
        if (mount) mount.scrollTop = 0;
      }, 200);
    });
  }
  const handlePastedImages = (event: ClipboardEvent) => {
    const files = clipboardFiles(event.clipboardData).filter((file) => file.type.startsWith("image/"));
    if (files.length === 0) return;

    const botId = props.args.bot?.id;
    if (!botId) return;
    event.preventDefault();
    const requestId = crypto.randomUUID();
    const currentDraft = controller.drafts()[botId] ?? { text: "", attachments: [], replyToMessageId: null };
    const attachments: DraftAttachment[] = files
      .slice(0, Math.max(0, 10 - currentDraft.attachments.length))
      .map((file, index) => {
        const previewUrl = URL.createObjectURL(file);
        previewUrls.add(previewUrl);
        return {
          id: `${requestId}-${index}`,
          name: file.name || `pasted-${index + 1}.png`,
          size: file.size,
          kind: "image",
          mimeType: file.type || "image/png",
          previewKind: "image",
          previewUrl,
        };
      });
    controller.setDrafts((current) => ({
      ...current,
      [botId]: { ...currentDraft, attachments: [...currentDraft.attachments, ...attachments] },
    }));
  };
  const setStoryFrameElement = (element: HTMLDivElement) => {
    storyFrameElement = element;
    element.addEventListener("paste", handlePastedImages, true);
  };
  onCleanup(() => {
    storyFrameElement?.removeEventListener("paste", handlePastedImages, true);
    if (takeoverGalleryScrollTimer !== undefined) window.clearTimeout(takeoverGalleryScrollTimer);
    for (const previewUrl of previewUrls) URL.revokeObjectURL(previewUrl);
    mock.dispose();
    window.openbot = previousApi;
  });
  return (
    <div ref={setStoryFrameElement} class="conversation-story-frame">
      <ConversationControllerProvider controller={controller}>
        <ConversationView
          {...props.args}
          messages={props.messages ?? props.args.messages}
          unreadCount={unreadCount()}
          firstUnreadMessageId={firstUnreadMessageId()}
          onMarkRead={async () => {
            await props.args.onMarkRead();
            setUnreadCount(0);
            setFirstUnreadMessageId(null);
          }}
        />
      </ConversationControllerProvider>
      <Show when={props.takeoverStateGallery && takeoverGalleryMount()}>
        <Portal mount={takeoverGalleryMount() ?? undefined}>
          <div class="browser-takeover-story-states">
            <BrowserTakeoverCard
              botName={props.args.bot?.name ?? "the agent"}
              tab={props.args.browserTabs[0]}
              preview={{ dataUrl: browserTakeoverPreviewUrl, width: 960, height: 600 }}
              previewStatus="ready"
              decision="complete"
              onComplete={async () => false}
              onCancel={async () => false}
            />
            <BrowserTakeoverCard
              botName={props.args.bot?.name ?? "the agent"}
              tab={props.args.browserTabs[0]}
              preview={{ dataUrl: browserTakeoverPreviewUrl, width: 960, height: 600 }}
              previewStatus="ready"
              decision="cancel"
              onComplete={async () => false}
              onCancel={async () => false}
            />
          </div>
        </Portal>
      </Show>
    </div>
  );
}

function RecordingConversation(props: { args: Parameters<typeof Conversation>[0] }) {
  const previousMediaDevices = navigator.mediaDevices;
  const previousMediaRecorder = window.MediaRecorder;
  class StoryMediaRecorder extends EventTarget {
    readonly mimeType = "audio/webm";
    state: RecordingState = "inactive";

    start(): void {
      this.state = "recording";
    }

    stop(): void {
      this.state = "inactive";
    }
  }
  Object.defineProperty(window, "MediaRecorder", { configurable: true, value: StoryMediaRecorder });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => undefined }] }) },
  });
  onCleanup(() => {
    Object.defineProperty(window, "MediaRecorder", { configurable: true, value: previousMediaRecorder });
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: previousMediaDevices });
  });
  return <MockedConversation args={props.args} />;
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
  globalOverlayOpen: false,
  settingsRequest: null,
  messageFocusRequest: null,
  queue: undefined,
  browserTabs: [],
  activeBrowserTabId: null,
  browserControlState: { sessions: [] },
  server: STORY_SERVERS[0],
  presence: STORY_PRESENCE,
  currentUserEmail: "person@example.com",
  remoteDesktopSessionActive: Boolean(STORY_REMOTE_DESKTOP_SESSION),
  remoteDesktopVisible: false,
  prompt: undefined,
  approval: undefined,
  browserTakeover: undefined,
  onSelectAgent: fn(),
  onUpdateBot: async (_botId: string, _updates: Omit<UpdateBotInput, "botId">) => undefined,
  onSetAgentAvatar: async (_botId: string, _image: AvatarImageInput | null) => undefined,
  onSendMessage: async (_body: string, _attachmentDraftIds: string[], _replyToMessageId: string | null) => true,
  onMarkRead: async () => undefined,
  onTypingChange: fn(),
  onAnswerPrompt: async (_answers: Record<string, string[]>) => true,
  onRespondToApproval: async (_decision: "accept" | "decline") => true,
  onRespondToBrowserTakeover: async (_decision: "complete" | "cancel") => true,
  onCancelQueuedMessage: fn(),
  onSteerQueuedMessage: fn(),
  onUpdateQueuedMessage: async (
    _deliveryId: string,
    _text: string,
    _keepAttachmentIds: string[],
    _attachmentDraftIds: string[],
  ) => true,
  onReorderQueue: fn(),
  onActivateBrowserTab: fn(),
  onCloseBrowserTab: fn(),
  onOpenRemoteDesktop: async (_serverId: string, _trigger: HTMLElement) => undefined,
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

export const AllBotMessageTypes: Story = {
  name: "All bot message types",
  args: {
    messages: botMessageGalleryMessages,
    activeTurnId: "bot-gallery-stream",
    presence: completedImageGenerationPresence,
  },
};

export const VoiceRecording: Story = {
  name: "Voice recording",
  render: (storyArgs) => <RecordingConversation args={storyArgs} />,
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Create prompt with voice" }));
    await expect(canvas.findByRole("group", { name: "Voice recording" })).resolves.toBeVisible();
    await expect(canvas.findByRole("button", { name: "Stop voice recording" })).resolves.toBeVisible();
  },
};

export const VoiceModelDownload: Story = {
  name: "Voice model download",
  render: (storyArgs) => <MockedConversation args={storyArgs} voiceModelProgress={47} />,
};

export const SearchConversation: Story = {
  name: "Search conversation",
  play: async ({ canvas, canvasElement, userEvent }) => {
    const storyWindow = canvasElement.ownerDocument.defaultView;
    if (!storyWindow) throw new Error("Story window is missing.");
    const searchReturnTarget = canvas.getByRole("button", { name: "View agent settings" });
    fireEvent.keyDown(searchReturnTarget, { key: "f", ctrlKey: true });

    const search = await canvas.findByRole("search", { name: "Search conversation" });
    const input = canvas.getByRole("searchbox", { name: "Search messages" });
    await expect(search).toBeVisible();
    await waitFor(() => expect(input).toHaveFocus());
    await userEvent.type(input, "milestone");
    await expect(canvas.findByText("1/2")).resolves.toBeVisible();

    await userEvent.click(canvas.getByRole("button", { name: "Next match" }));
    await expect(canvas.findByText("2/2")).resolves.toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect(canvas.queryByRole("search", { name: "Search conversation" })).not.toBeInTheDocument();
  },
};

export const ComposerActionMenu: Story = {
  name: "Composer action menu",
  play: async ({ canvas, canvasElement, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Add to prompt" }));
    const menu = await within(canvasElement.ownerDocument.body).findByRole("menu", { name: "Add to prompt" });
    await waitFor(() => expect(menu).toBeVisible());
    const attachImage = within(menu).getByRole("menuitem", { name: /Attach image/ });
    const useSkill = within(menu).getByRole("menuitem", { name: /Use a skill/ });
    const addContext = within(menu).getByRole("menuitem", { name: /Add context/ });
    await expect(menu).toHaveClass("ui-action-menu");
    await waitFor(() => expect(attachImage).toHaveFocus());
    await expect(useSkill).toHaveAttribute("data-disabled");
    await expect(addContext).toBeVisible();
  },
};

export const PastedImageInComposer: Story = {
  name: "Pasted image in composer",
  render: (storyArgs) => <MockedConversation args={storyArgs} initialAttachments={queuePreviewAttachments} />,
};

export const MixedAttachmentsInNarrowComposer: Story = {
  name: "Mixed attachments in narrow composer",
  render: (storyArgs) => (
    <section
      data-testid="narrow-composer-attachments-sample"
      style={{ width: "360px", height: "820px", overflow: "hidden" }}
    >
      <MockedConversation args={storyArgs} initialAttachments={[...queuePreviewAttachments, STORY_ATTACHMENTS[0]]} />
    </section>
  ),
};

export const SupportedContextFilesInComposer: Story = {
  name: "Supported context files in composer",
  render: (storyArgs) => <MockedConversation args={storyArgs} initialAttachments={supportedContextAttachments} />,
};

export const SentMessageWithContextFiles: Story = {
  name: "Sent message with context files",
  render: (storyArgs) => <MockedConversation args={storyArgs} messages={sentContextFileMessages} />,
};

export const NarrowRichConversation: Story = {
  name: "Narrow rich conversation",
  render: (storyArgs) => (
    <section data-testid="narrow-conversation-sample" style={{ width: "360px", height: "820px", overflow: "hidden" }}>
      <MockedConversation args={storyArgs} />
    </section>
  ),
  play: async ({ canvas }) => {
    const sample = canvas.getByTestId("narrow-conversation-sample");
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
  },
};

export const ScrollToLatest: Story = {
  args: {
    messages: unreadStoryMessages,
    unreadCount: 0,
    firstUnreadMessageId: null,
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
  },
};

export const ImageGenerationCompletedInChat: Story = {
  name: "Image generation completed in chat",
  args: {
    messages: completedImageGenerationMessages,
    activeTurnId: "turn-image-generation",
    presence: completedImageGenerationPresence,
  },
  play: async ({ canvas, canvasElement }) => {
    expect(canvas.queryByRole("status", { name: "Chief is working" })).not.toBeInTheDocument();
    await canvas.getByRole("button", { name: "Preview generated image" }).click();
    await expect(
      within(canvasElement.ownerDocument.body).findByRole("dialog", { name: "generated-image.png" }),
    ).resolves.toBeInTheDocument();
  },
};

export const DataTableInChat: Story = {
  name: "Data table in chat",
  args: {
    messages: dataTableMessages,
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByText("Compare the available models by context window and input price.")).toBeVisible();
    await expect(canvas.getByRole("table")).toBeVisible();
    await expect(canvas.getAllByRole("columnheader")).toHaveLength(3);
  },
};

export const CodeBlockInChat: Story = {
  name: "Code block in chat",
  args: {
    messages: codeBlockMessages,
  },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole("region", { name: "Shell code block" })).toBeVisible();
    const codeRow = canvasElement.querySelector<HTMLElement>(".virtual-chat-row:has(.message-code-block)");
    const followUp = canvas
      .getByText("The checks should complete before release.")
      .closest<HTMLElement>(".virtual-chat-row");
    if (!codeRow || !followUp) throw new Error("Code block chat rows are missing.");
    await waitFor(() =>
      expect(followUp.getBoundingClientRect().top).toBeGreaterThanOrEqual(codeRow.getBoundingClientRect().bottom),
    );
  },
};

export const MarkdownInChat: Story = {
  name: "Markdown in chat",
  args: {
    messages: markdownMessages,
  },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole("heading", { level: 2, name: "Recommendation" })).toBeVisible();
    await expect(canvas.getByText("Kobalte").tagName).toBe("STRONG");
    await expect(canvas.getByRole("checkbox", { name: "Works with our design system" })).toBeChecked();
    await expect(canvas.queryByText("## Recommendation")).not.toBeInTheDocument();
    const markdownRow = canvasElement.querySelector<HTMLElement>(".virtual-chat-row:has(.message-markdown)");
    const followUp = canvas
      .getByText("I can prepare the migration checklist next.")
      .closest<HTMLElement>(".virtual-chat-row");
    if (!markdownRow || !followUp) throw new Error("Markdown chat rows are missing.");
    await waitFor(() =>
      expect(followUp.getBoundingClientRect().top).toBeGreaterThanOrEqual(markdownRow.getBoundingClientRect().bottom),
    );
  },
};

export const StreamingMarkdownInChat: Story = {
  name: "Streaming Markdown in chat",
  args: {
    messages: streamingMarkdownMessages(0),
    activeTurnId: "streaming-markdown",
  },
  render: (storyArgs) => <StreamingMarkdownConversation args={storyArgs} />,
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole("heading", { level: 2, name: "Live response" })).toBeVisible();
    const streamingRow = canvasElement.querySelector<HTMLElement>(
      '.virtual-chat-row:has([data-chat-search-message="streaming-markdown-agent"])',
    );
    if (!streamingRow) throw new Error("The streaming Markdown row is missing.");
    const initialHeight = streamingRow.getBoundingClientRect().height;

    await expect(
      canvas.findByText("The streamed response is complete.", {}, { timeout: 2_000 }),
    ).resolves.toBeVisible();
    await expect(canvas.getByText("Markdown renderer").tagName).toBe("STRONG");
    await expect(canvas.getByRole("region", { name: "TypeScript code block" })).toBeVisible();

    const updatedRow = canvasElement.querySelector<HTMLElement>(
      '.virtual-chat-row:has([data-chat-search-message="streaming-markdown-agent"])',
    );
    const followUp = canvas
      .getByText("This message must stay below the growing response.")
      .closest<HTMLElement>(".virtual-chat-row");
    if (!updatedRow || !followUp) throw new Error("The streamed chat rows are missing.");
    expect(updatedRow).toBe(streamingRow);
    await waitFor(() => expect(updatedRow.getBoundingClientRect().height).toBeGreaterThan(initialHeight));
    await waitFor(() =>
      expect(followUp.getBoundingClientRect().top).toBeGreaterThanOrEqual(updatedRow.getBoundingClientRect().bottom),
    );
  },
};

export const ComparisonTableInChat: Story = {
  name: "Comparison table in chat",
  args: {
    messages: comparisonTableMessages,
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

export const BrowserTakeover: Story = {
  name: "Browser authorization takeover",
  args: {
    browserTakeover,
    browserTabs: [
      {
        id: "tab-login",
        title: "Sign in",
        url: "https://example.com/login",
        loading: false,
        ownerThreadId: "thread-chief",
        ownerBotId: "chief",
      },
    ],
    activeBrowserTabId: "tab-login",
    activeTurnId: "turn-takeover",
    messages: [],
  },
  render: (storyArgs) => <MockedConversation args={storyArgs} takeoverStateGallery />,
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("region", { name: "Browser takeover" })).toBeVisible();
    await expect(canvas.getByRole("region", { name: "Browser takeover complete" })).toBeVisible();
    await expect(canvas.getByRole("region", { name: "Browser takeover cancelled" })).toBeVisible();
  },
};

export const PromptQuestionsInChat: Story = {
  name: "Prompt questions in chat",
  args: {
    messages: promptChatMessages,
    prompt: promptQuestions,
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
    queue: referenceQueue,
    activeTurnId: "turn-active",
  },
  render: (storyArgs) => {
    const [queueState, setQueueState] = createSignal(storyArgs.queue ?? referenceQueue);
    let nextStoryDeliveryId = 1;
    const normalizePositions = (deliveries: QueueSnapshot["deliveries"]) =>
      deliveries.map((delivery, index) => ({ ...delivery, position: index + 1 }));
    const reorderQueue = (deliveryIds: string[]) => {
      storyArgs.onReorderQueue(deliveryIds);
      setQueueState((current) => {
        const deliveriesById = new Map(current.deliveries.map((delivery) => [delivery.id, delivery]));
        const reordered = deliveryIds.flatMap((id) => {
          const delivery = deliveriesById.get(id);
          return delivery ? [delivery] : [];
        });
        let queuedIndex = 0;
        return {
          ...current,
          deliveries: current.deliveries.map((delivery) => {
            if (delivery.status !== "queued") return delivery;
            const next = reordered[queuedIndex++];
            return next ? { ...next, position: delivery.position } : delivery;
          }),
        };
      });
    };
    const cancelQueuedMessage = (deliveryId: string) => {
      storyArgs.onCancelQueuedMessage(deliveryId);
      setQueueState((current) => ({
        ...current,
        deliveries: normalizePositions(current.deliveries.filter((delivery) => delivery.id !== deliveryId)),
      }));
    };
    const updateQueuedMessage = async (
      deliveryId: string,
      text: string,
      keepAttachmentIds: string[],
      attachmentDraftIds: string[],
    ) => {
      const saved = await storyArgs.onUpdateQueuedMessage(deliveryId, text, keepAttachmentIds, attachmentDraftIds);
      if (!saved) return false;
      setQueueState((current) => ({
        ...current,
        deliveries: current.deliveries.map((delivery) =>
          delivery.id === deliveryId
            ? {
                ...delivery,
                text,
                attachments: delivery.attachments.filter((attachment) => keepAttachmentIds.includes(attachment.id)),
              }
            : delivery,
        ),
      }));
      return true;
    };
    const sendMessage = async (body: string, attachmentDraftIds: string[], replyToMessageId: string | null) => {
      const sent = await storyArgs.onSendMessage(body, attachmentDraftIds, replyToMessageId);
      if (!sent || !storyArgs.activeTurnId) return sent;
      const id = `storybook-queued-${nextStoryDeliveryId++}`;
      setQueueState((current) => ({
        ...current,
        deliveries: [
          ...current.deliveries,
          {
            id,
            messageId: `${id}-message`,
            recipientBotId: current.botId,
            sender: { kind: "user" },
            text: body,
            attachments: [],
            replyToMessageId,
            status: "queued",
            position: current.deliveries.length + 1,
            turnId: null,
            error: null,
            createdAt: new Date().toISOString(),
          },
        ],
      }));
      return true;
    };

    return (
      <MockedConversation
        args={{
          ...storyArgs,
          queue: queueState(),
          onSendMessage: sendMessage,
          onCancelQueuedMessage: cancelQueuedMessage,
          onUpdateQueuedMessage: updateQueuedMessage,
          onReorderQueue: reorderQueue,
        }}
      />
    );
  },
};

export const SevenQueuedMessagesInteractions: Story = {
  ...SevenQueuedMessages,
  name: "Seven queued messages interactions",
  tags: ["!dev"],
  play: async ({ canvas, canvasElement, userEvent }) => {
    const messagesInQueue = () =>
      Array.from(canvasElement.querySelectorAll(".agent-queue-message"), (element) => element.textContent);
    const composer = canvasElement.querySelector<HTMLElement>(".composer");
    const editor = canvas.getByRole("textbox", { name: "Message Chief" });
    if (!composer) throw new Error("Composer is missing.");

    const paddingPointerDown = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
    expect(composer.dispatchEvent(paddingPointerDown)).toBe(false);
    await waitFor(() => expect(editor).toHaveFocus());

    const firstRow = canvasElement.querySelector<HTMLFieldSetElement>(".agent-queue-item");
    if (!firstRow) throw new Error("Queue row is missing.");

    fireEvent.keyDown(firstRow, { key: "ArrowDown", altKey: true });
    await waitFor(() =>
      expect(messagesInQueue().slice(0, 2)).toEqual([queueReferenceMessages[1], queueReferenceMessages[0]]),
    );

    const movedRow = Array.from(canvasElement.querySelectorAll<HTMLFieldSetElement>(".agent-queue-item")).find((row) =>
      row.textContent?.includes(queueReferenceMessages[0]),
    );
    if (!movedRow) throw new Error("Moved queue row is missing.");
    fireEvent.keyDown(movedRow, { key: "ArrowUp", altKey: true });
    await waitFor(() =>
      expect(messagesInQueue().slice(0, 2)).toEqual([queueReferenceMessages[0], queueReferenceMessages[1]]),
    );

    await userEvent.click(canvas.getByRole("button", { name: "Edit queued message 1" }));
    await waitFor(() => expect(editor).toHaveFocus());
    await waitFor(() => expect(canvas.getByRole("button", { name: "Save queued message" })).toBeVisible());
    await waitFor(() => expect(messagesInQueue()).toHaveLength(queueReferenceMessages.length - 1));
    expect(messagesInQueue()).not.toContain(queueReferenceMessages[0]);
    editor.textContent = "Updated queue message from Storybook";
    await fireEvent.input(editor);
    await userEvent.click(canvas.getByRole("button", { name: "Save queued message" }));
    await waitFor(() => expect(messagesInQueue()[0]).toBe("Updated queue message from Storybook"));

    await userEvent.click(canvas.getByRole("button", { name: "Edit queued message 1" }));
    await waitFor(() => expect(messagesInQueue()).toHaveLength(queueReferenceMessages.length - 1));
    editor.textContent = queueReferenceMessages[0];
    await fireEvent.input(editor);
    await userEvent.click(canvas.getByRole("button", { name: "Save queued message" }));
    await waitFor(() => expect(messagesInQueue()[0]).toBe(queueReferenceMessages[0]));

    await userEvent.click(canvas.getByRole("button", { name: "Edit queued message 3" }));
    const attachmentCard = canvasElement.querySelector<HTMLElement>(".composer-attachment");
    const queuePanel = canvasElement.querySelector<HTMLElement>(".agent-queue-panel");
    if (!attachmentCard || !queuePanel) throw new Error("Queue attachment edit layout is missing.");
    await waitFor(() =>
      expect(queuePanel.getBoundingClientRect().bottom).toBeLessThanOrEqual(attachmentCard.getBoundingClientRect().top),
    );
    await userEvent.click(canvas.getByRole("button", { name: "Save queued message" }));
    await waitFor(() => expect(messagesInQueue()).toHaveLength(queueReferenceMessages.length));

    editor.textContent = "Queued from the Storybook composer";
    await fireEvent.input(editor);
    await userEvent.click(canvas.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(messagesInQueue().at(-1)).toBe("Queued from the Storybook composer"));

    await userEvent.click(canvas.getByRole("button", { name: "Delete queued message 8" }));
    await waitFor(() => expect(messagesInQueue()).toHaveLength(queueReferenceMessages.length));
  },
};

export const QueueWithItems: Story = {
  args: { queue: queueWithItems(3) },
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
