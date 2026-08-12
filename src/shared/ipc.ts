export const IPC_CHANNELS = {
  getAppInfo: "app:get-info",
  agentGetStatus: "agent:get-status",
  agentListBots: "agent:list-bots",
  agentCreateBot: "agent:create-bot",
  agentReadConversation: "agent:read-conversation",
  agentSendMessage: "agent:send-message",
  agentInterrupt: "agent:interrupt",
  agentRespondToPrompt: "agent:respond-to-prompt",
  agentEvent: "agent:event",
  browserOpen: "browser:open",
  browserActivate: "browser:activate",
  browserClose: "browser:close",
  browserListTabs: "browser:list-tabs",
  browserSetVisible: "browser:set-visible",
} as const;

export type DesktopPlatform = "darwin" | "win32" | "linux";

export interface AppInfo {
  name: string;
  version: string;
  platform: DesktopPlatform;
}

export type AgentPhase = "idle" | "starting" | "ready" | "restarting" | "blocked" | "stopped";

export type CapabilityState = "ready" | "setup-required" | "unavailable";

export type AgentAuthState =
  | { kind: "unknown" }
  | { kind: "signed-out" }
  | { kind: "unsupported"; accountType: string }
  | { kind: "chatgpt"; planType: string | null };

export interface AgentStatus {
  phase: AgentPhase;
  cliVersion: string | null;
  auth: AgentAuthState;
  capabilities: {
    chat: CapabilityState;
    browser: CapabilityState;
    computerUse: CapabilityState;
  };
  message: string | null;
  fullAccess: true;
}

export interface BotSummary {
  id: string;
  name: string;
  role: string;
  threadId: string | null;
  workspacePath: string;
  preview: string;
  updatedAt: string | null;
}

export type ConversationMessageAuthor = "user" | "assistant" | "system";

export interface ConversationMessage {
  id: string;
  author: ConversationMessageAuthor;
  text: string;
  createdAt: string;
  status: "streaming" | "completed" | "failed" | "interrupted";
  itemType?: string;
}

export interface ConversationSnapshot {
  botId: string;
  threadId: string | null;
  activeTurnId: string | null;
  messages: ConversationMessage[];
}

export interface SendMessageInput {
  botId: string;
  text: string;
}

export interface TurnHandle {
  botId: string;
  threadId: string;
  turnId: string;
  mode: "start" | "steer";
}

export interface InterruptTurnInput {
  botId: string;
  turnId: string;
}

export interface AgentPromptQuestion {
  id: string;
  header: string;
  question: string;
  isSecret: boolean;
  options: Array<{ label: string; description: string }> | null;
}

export interface RespondToPromptInput {
  requestId: string | number;
  answers: Record<string, string[]>;
}

export type AgentEvent =
  | { type: "status"; status: AgentStatus }
  | { type: "conversation"; snapshot: ConversationSnapshot }
  | { type: "turn-started"; botId: string; threadId: string; turnId: string }
  | {
      type: "assistant-delta";
      botId: string;
      threadId: string;
      turnId: string;
      itemId: string;
      delta: string;
    }
  | {
      type: "item";
      botId: string;
      threadId: string;
      turnId: string;
      phase: "started" | "completed";
      item: unknown;
    }
  | {
      type: "turn-completed";
      botId: string;
      threadId: string;
      turnId: string;
      status: string;
    }
  | {
      type: "prompt";
      requestId: string | number;
      botId: string;
      threadId: string;
      turnId: string;
      questions: AgentPromptQuestion[];
    }
  | { type: "browser-changed"; tabs: BrowserTab[]; activeTabId: string | null }
  | { type: "error"; botId?: string; code: string; message: string };

export interface BrowserTab {
  id: string;
  title: string;
  url: string;
  loading: boolean;
  ownerThreadId: string | null;
}

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserOpenInput {
  url: string;
  ownerThreadId?: string | null;
}

export interface BrowserVisibilityInput {
  visible: boolean;
  bounds?: BrowserBounds;
}

export interface AgentDesktopApi {
  getStatus: () => Promise<AgentStatus>;
  listBots: () => Promise<BotSummary[]>;
  createBot: () => Promise<BotSummary>;
  readConversation: (botId: string) => Promise<ConversationSnapshot>;
  sendMessage: (input: SendMessageInput) => Promise<TurnHandle>;
  interrupt: (input: InterruptTurnInput) => Promise<void>;
  respondToPrompt: (input: RespondToPromptInput) => Promise<void>;
  onEvent: (listener: (event: AgentEvent) => void) => () => void;
}

export interface BrowserDesktopApi {
  open: (input: BrowserOpenInput) => Promise<BrowserTab>;
  activate: (tabId: string) => Promise<void>;
  close: (tabId: string) => Promise<void>;
  listTabs: () => Promise<BrowserTab[]>;
  setVisible: (input: BrowserVisibilityInput) => Promise<void>;
}

export interface InfeldDesktopApi {
  getAppInfo: () => Promise<AppInfo>;
  agent: AgentDesktopApi;
  browser: BrowserDesktopApi;
}
