import type {
  AccountUsage,
  AgentModelOption,
  AgentStatus,
  AttachmentSummary,
  BotSummary,
  BrowserControlState,
  BrowserTab,
  ConversationMessage,
  ConversationSnapshot,
  DirectConversationSnapshot,
  DirectThreadSummary,
  HostStatus,
  RemoteDesktopSession,
  ServerSummary,
  TeamInviteSummary,
  TeamMemberSummary,
  TeamPresenceSnapshot,
  TeamSessionSummary,
  UpdateStatus,
} from "@openbot/contracts/ipc";
import type { BotMessage, BotProfile } from "../data";

export const STORY_NOW = "2026-08-19T10:00:00.000Z";

export const STORY_BOT_SUMMARIES: BotSummary[] = [
  {
    id: "chief",
    name: "Chief",
    role: "Chief of staff",
    description: "Coordinates projects, priorities, and next steps across the workspace.",
    notifications: true,
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
    threadId: "thread-chief",
    workspacePath: "/mock/OpenBot/Bots/chief",
    preview: "I pulled together the latest project notes and next steps.",
    updatedAt: STORY_NOW,
    avatarSeed: "chief",
    avatarHue: 245,
    avatarUrl: null,
  },
  {
    id: "research",
    name: "Research",
    role: "Research partner",
    description: "Finds reliable sources and turns them into concise, useful briefs.",
    notifications: true,
    model: "claude-sonnet-5",
    reasoningEffort: "high",
    threadId: "thread-research",
    workspacePath: "/mock/OpenBot/Bots/research",
    preview: "Three useful sources are ready for your review.",
    updatedAt: "2026-08-18T16:32:00.000Z",
    avatarSeed: "research",
    avatarHue: 185,
    avatarUrl: null,
  },
  {
    id: "sales",
    name: "Sales Outbound",
    role: "Outbound specialist",
    description: "Prepares thoughtful prospect research and personalized outreach.",
    notifications: true,
    model: "gpt-5.6-terra",
    reasoningEffort: "medium",
    threadId: "thread-sales",
    workspacePath: "/mock/OpenBot/Bots/sales",
    preview: "The follow-up draft is ready to send.",
    updatedAt: "2026-08-17T09:20:00.000Z",
    avatarSeed: "sales-outbound",
    avatarHue: 280,
    avatarUrl: null,
  },
];

export const STORY_BOTS: BotProfile[] = STORY_BOT_SUMMARIES.map((bot, index) => ({
  id: bot.id,
  name: bot.name,
  role: bot.role,
  description: bot.description,
  notifications: bot.notifications,
  model: bot.model,
  reasoningEffort: bot.reasoningEffort,
  threadId: bot.threadId,
  avatarSeed: bot.avatarSeed,
  avatarHue: bot.avatarHue,
  avatarUrl: bot.avatarUrl,
  time: index === 0 ? "10:00" : index === 1 ? "Yesterday" : "Mon",
  preview: bot.preview,
}));

export const STORY_MODELS: AgentModelOption[] = [
  {
    id: "gpt-5.6-luna",
    name: "Luna",
    description: "Fast and efficient for everyday agent work.",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["low", "medium", "high"],
  },
  {
    id: "gpt-5.6-terra",
    name: "Terra",
    description: "Balanced speed and capability for involved tasks.",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["medium", "high"],
  },
  {
    id: "gpt-5.6-sol",
    name: "Sol",
    description: "Most capable for complex, long-running work.",
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: ["medium", "high", "xhigh"],
  },
  {
    id: "claude-opus-5",
    name: "Claude Opus 5",
    description: "Most capable Claude model for complex work.",
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: ["low", "medium", "high"],
  },
  {
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    description: "Balanced Claude model for general agent work.",
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: ["low", "medium", "high"],
  },
];

export const STORY_AGENT_STATUS: AgentStatus = {
  phase: "ready",
  cliVersion: "0.144.1",
  auth: { kind: "chatgpt", email: "person@example.com" },
  providers: [
    {
      id: "codex",
      state: "available",
      version: "0.144.1",
      message: null,
      email: "person@example.com",
    },
    {
      id: "claude",
      state: "available",
      version: "2.1.231",
      message: null,
      email: "person@example.com",
    },
  ],
  capabilities: { chat: "ready", browser: "ready", computerUse: "ready" },
  message: null,
  fullAccess: true,
};

export const STORY_USAGE: AccountUsage = {
  limits: [
    {
      id: "codex",
      primary: { usedPercent: 28, windowDurationMins: 300, resetsAt: 1_786_563_600 },
      secondary: { usedPercent: 41, windowDurationMins: 10_080, resetsAt: 1_787_040_000 },
    },
  ],
};

export const STORY_ATTACHMENTS: AttachmentSummary[] = [
  {
    id: "attachment-start-types",
    name: "start-types.d.ts",
    size: 6_144,
    kind: "file",
    mimeType: "text/plain",
    previewKind: "text",
    previewUrl: null,
  },
  {
    id: "attachment-agents",
    name: "AGENTS.md",
    size: 2_048,
    kind: "file",
    mimeType: "text/plain",
    previewKind: "text",
    previewUrl: null,
  },
];

export const STORY_CONVERSATION_MESSAGES: ConversationMessage[] = [
  {
    id: "message-user-1",
    author: "user",
    source: "user",
    text: "Can you turn the latest notes into a short plan and tag @Research for the source check?",
    createdAt: "2026-08-19T09:42:00.000Z",
    status: "completed",
  },
  {
    id: "message-agent-1",
    author: "assistant",
    source: "assistant",
    text: "Absolutely. I’ll structure the plan around the launch milestones and ask @Research to verify the supporting sources.\n\nThe first draft is ready here: https://openbot.run/docs",
    createdAt: "2026-08-19T09:43:00.000Z",
    status: "completed",
    attachments: STORY_ATTACHMENTS,
    reaction: "👍",
  },
  {
    id: "message-exchange",
    author: "system",
    source: "system",
    text: "",
    createdAt: "2026-08-19T09:44:00.000Z",
    status: "completed",
    exchange: {
      direction: "outgoing",
      messageId: "message-exchange",
      senderBotId: "chief",
      recipientBotIds: ["research", "sales"],
      replyToMessageId: null,
      deliveries: [
        {
          id: "delivery-research",
          recipientBotId: "research",
          status: "completed",
          position: null,
          error: null,
        },
        {
          id: "delivery-sales",
          recipientBotId: "sales",
          status: "running",
          position: 1,
          error: null,
        },
      ],
    },
  },
  {
    id: "message-agent-2",
    author: "assistant",
    source: "assistant",
    text: "I’ll keep the final plan concise, with owners and a clear next action for each milestone.",
    createdAt: "2026-08-19T09:45:00.000Z",
    status: "completed",
  },
];

export const STORY_SNAPSHOTS: Record<string, ConversationSnapshot> = Object.fromEntries(
  STORY_BOT_SUMMARIES.map((bot) => [
    bot.id,
    {
      botId: bot.id,
      threadId: bot.threadId,
      activeTurnId: null,
      revision: 1,
      messages: bot.id === "chief" ? STORY_CONVERSATION_MESSAGES : [],
    },
  ]),
);

export const STORY_PRESENCE: TeamPresenceSnapshot = {
  serverId: "team",
  updatedAt: STORY_NOW,
  members: [
    {
      id: "member-self",
      username: "norbert",
      email: "person@example.com",
      name: "Norbert",
      role: "owner",
      createdAt: "2026-01-10T08:00:00.000Z",
      disabled: false,
      online: true,
      typingBotId: null,
    },
    {
      id: "member-alice",
      username: "alice",
      email: "alice@example.com",
      name: "Alice Chen",
      role: "admin",
      createdAt: "2026-02-01T08:00:00.000Z",
      disabled: false,
      online: true,
      typingBotId: "chief",
    },
    {
      id: "member-jon",
      username: "jon",
      email: "jon@example.com",
      name: "Jon Bell",
      role: "member",
      createdAt: "2026-03-15T08:00:00.000Z",
      disabled: false,
      online: false,
      typingBotId: null,
    },
    {
      id: "member-maya",
      username: "maya",
      email: "maya@example.com",
      name: "Maya Singh",
      role: "member",
      createdAt: "2026-04-11T08:00:00.000Z",
      disabled: false,
      online: true,
      typingBotId: null,
    },
  ],
};

export const STORY_DIRECT_THREADS: DirectThreadSummary[] = [
  {
    threadId: "direct-alice",
    otherMemberId: "member-alice",
    lastMessage: {
      id: "direct-message-alice",
      threadId: "direct-alice",
      senderMemberId: "member-alice",
      recipientMemberId: "member-self",
      text: "The launch notes look good — can you review the last section?",
      createdAt: "2026-08-19T09:30:00.000Z",
      sequence: 2,
    },
    unreadCount: 2,
    updatedAt: "2026-08-19T09:30:00.000Z",
  },
];

export const STORY_DIRECT_SNAPSHOTS: Record<string, DirectConversationSnapshot> = {
  "member-alice": {
    threadId: "direct-alice",
    otherMemberId: "member-alice",
    revision: 1,
    readState: {
      unreadCount: 1,
      firstUnreadMessageId: "direct-message-alice",
      throughSequence: 1,
    },
    messages: [
      {
        id: "direct-message-hello",
        threadId: "direct-alice",
        senderMemberId: "member-self",
        recipientMemberId: "member-alice",
        text: "I’m reviewing the launch notes now.",
        createdAt: "2026-08-19T09:21:00.000Z",
        sequence: 1,
      },
      STORY_DIRECT_THREADS[0].lastMessage,
    ],
  },
};

export const STORY_SERVERS: ServerSummary[] = [
  {
    id: "local",
    name: "Local",
    logoUrl: null,
    kind: "local",
    state: "online",
    apiUrl: null,
    remoteDesktopAvailable: false,
    role: null,
    active: true,
  },
  {
    id: "team",
    name: "OpenBot team",
    logoUrl: null,
    kind: "remote",
    state: "online",
    apiUrl: "https://team.example.com",
    remoteDesktopAvailable: true,
    role: "owner",
    active: false,
  },
];

export const STORY_BROWSER_TABS: BrowserTab[] = [
  {
    id: "browser-tab-docs",
    title: "OpenBot documentation",
    url: "https://openbot.run/docs",
    loading: false,
    ownerThreadId: "thread-chief",
    ownerBotId: "chief",
  },
];

export const STORY_BROWSER_CONTROL: BrowserControlState = {
  sessions: [
    {
      id: "browser-session-1",
      threadId: "thread-chief",
      turnId: "turn-1",
      callId: "call-1",
      tabId: "browser-tab-docs",
      action: "snapshot",
      phase: "waiting",
      startedAt: STORY_NOW,
    },
  ],
};

export const STORY_HOST_STATUS: HostStatus = {
  phase: "online",
  configured: true,
  enabledOnLaunch: true,
  serverId: "team",
  serverName: "OpenBot team",
  logoUrl: null,
  apiUrl: "https://team.example.com",
  apiOnline: true,
  remoteDesktopReady: true,
  remoteDesktopUnattended: true,
  remoteDesktopActiveSessions: 1,
  remoteDesktopMaxSessions: 4,
  message: null,
};

export const STORY_TEAM_MEMBERS: TeamMemberSummary[] = STORY_PRESENCE.members.map((member) => ({
  id: member.id,
  username: member.username,
  email: member.email,
  name: member.name,
  role: member.role,
  createdAt: member.createdAt,
  disabled: member.disabled,
}));

export const STORY_INVITES: TeamInviteSummary[] = [
  {
    id: "invite-1",
    role: "member",
    expiresAt: "2026-08-29T10:00:00.000Z",
    usedAt: null,
    email: "new-person@example.com",
  },
];

export const STORY_SESSIONS: TeamSessionSummary[] = [
  {
    id: "session-1",
    memberId: "member-alice",
    username: "alice",
    createdAt: "2026-08-18T10:00:00.000Z",
    expiresAt: "2026-09-18T10:00:00.000Z",
  },
];

export const STORY_REMOTE_DESKTOP_SESSION: RemoteDesktopSession = {
  id: "remote-desktop-1",
  serverId: "team",
  viewerUrl: "https://team.example.com/v1/remote-screen/sessions/remote-desktop-1/viewer",
  viewerGrant: "story-viewer-grant",
  displays: [{ id: "display-1", label: "Main display", width: 1920, height: 1080, primary: true }],
  selectedDisplayId: "display-1",
  phase: "connected",
  transport: "p2p",
  errorCode: null,
  message: null,
  createdAt: STORY_NOW,
  grantExpiresAt: "2026-08-19T10:01:00.000Z",
};

export const STORY_UPDATE_STATUS: UpdateStatus = {
  phase: "available",
  currentVersion: "0.1.11",
  availableVersion: "0.2.0",
  progress: null,
  checkedAt: STORY_NOW,
  message: null,
};

export const STORY_APP_INFO = {
  name: "OpenBot",
  version: "0.1.11",
  platform: "darwin" as const,
  variant: "production" as const,
};

export function toConversationMessage(message: BotMessage): ConversationMessage {
  return {
    id: message.id,
    turnId: message.turnId,
    author: message.author === "you" ? "user" : "assistant",
    source: message.author === "you" ? "user" : "assistant",
    text: message.body,
    createdAt: STORY_NOW,
    status: message.streaming ? "streaming" : "completed",
    itemType: message.itemType,
    senderBotId: message.senderBotId,
    replyToMessageId: message.replyToMessageId,
    attachments: message.attachments,
    exchange: message.exchange,
    reaction: message.reaction,
  };
}
