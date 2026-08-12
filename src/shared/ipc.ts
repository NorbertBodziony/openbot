export const IPC_CHANNELS = {
  getAppInfo: "app:get-info",
  agentGetStatus: "agent:get-status",
  agentListBots: "agent:list-bots",
  agentCreateBot: "agent:create-bot",
  agentUpdateBot: "agent:update-bot",
  agentDeleteBot: "agent:delete-bot",
  agentReadConversation: "agent:read-conversation",
  agentSendMessage: "agent:send-message",
  agentChooseAttachments: "agent:choose-attachments",
  agentImportAttachments: "agent:import-attachments",
  agentDiscardDraftAttachment: "agent:discard-draft-attachment",
  agentOpenAttachment: "agent:open-attachment",
  agentListQueue: "agent:list-queue",
  agentCancelQueuedMessage: "agent:cancel-queued-message",
  agentSetQueuePaused: "agent:set-queue-paused",
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
  description: string;
  notifications: boolean;
  threadId: string | null;
  workspacePath: string;
  preview: string;
  updatedAt: string | null;
}

export interface UpdateBotInput {
  botId: string;
  name?: string;
  role?: string;
  description?: string;
  notifications?: boolean;
}

export type ConversationMessageAuthor = "user" | "assistant" | "agent" | "system";

export type AttachmentKind = "image" | "file";
export type AttachmentPreviewKind = "image" | "pdf" | "text" | "none";

export interface AttachmentSummary {
  id: string;
  name: string;
  size: number;
  kind: AttachmentKind;
  mimeType: string;
  previewKind: AttachmentPreviewKind;
  previewUrl: string | null;
}

export interface DraftAttachment extends AttachmentSummary {}

export interface AttachmentDataInput {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface ImportAttachmentsInput {
  paths: string[];
  data: AttachmentDataInput[];
}

export type AttachmentImportEvent =
  | { type: "started" }
  | { type: "completed"; attachments: DraftAttachment[] }
  | { type: "error"; message: string };

export interface OpenAttachmentInput {
  attachmentId: string;
  action: "open" | "reveal";
}

export type QueueDeliveryStatus =
  | "queued"
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "cancelled";

export interface QueueDelivery {
  id: string;
  messageId: string;
  recipientBotId: string;
  sender: { kind: "user" } | { kind: "bot"; botId: string };
  text: string;
  attachments: AttachmentSummary[];
  replyToMessageId: string | null;
  status: QueueDeliveryStatus;
  position: number | null;
  turnId: string | null;
  error: string | null;
  createdAt: string;
}

export interface QueueSnapshot {
  botId: string;
  paused: boolean;
  deliveries: QueueDelivery[];
}

export interface ConversationMessage {
  id: string;
  author: ConversationMessageAuthor;
  text: string;
  createdAt: string;
  status: "streaming" | "completed" | "failed" | "interrupted";
  itemType?: string;
  source?: "user" | "assistant" | "agent" | "system";
  senderBotId?: string;
  replyToMessageId?: string | null;
  attachments?: AttachmentSummary[];
  delivery?: Pick<QueueDelivery, "id" | "status" | "position">;
  exchange?: AgentExchangeSummary;
}

export interface AgentExchangeSummary {
  direction: "incoming" | "outgoing";
  messageId: string;
  senderBotId: string;
  recipientBotIds: string[];
  replyToMessageId: string | null;
  deliveries: Array<Pick<QueueDelivery, "id" | "recipientBotId" | "status" | "position" | "error">>;
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
  attachmentDraftIds?: string[];
}

export interface QueuedMessageReceipt {
  messageId: string;
  deliveries: Array<{
    id: string;
    recipientBotId: string;
    status: QueueDeliveryStatus;
    position: number | null;
  }>;
}

export interface CancelQueuedMessageInput {
  botId: string;
  deliveryId: string;
}

export interface SetQueuePausedInput {
  botId: string;
  paused: boolean;
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
  | { type: "bots-changed"; bots: BotSummary[] }
  | { type: "conversation"; snapshot: ConversationSnapshot }
  | { type: "queue-changed"; snapshot: QueueSnapshot }
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
  updateBot: (input: UpdateBotInput) => Promise<BotSummary>;
  deleteBot: (botId: string) => Promise<void>;
  readConversation: (botId: string) => Promise<ConversationSnapshot>;
  chooseAttachments: () => Promise<DraftAttachment[]>;
  onAttachmentImport: (listener: (event: AttachmentImportEvent) => void) => () => void;
  discardDraftAttachment: (attachmentId: string) => Promise<void>;
  openAttachment: (input: OpenAttachmentInput) => Promise<void>;
  sendMessage: (input: SendMessageInput) => Promise<QueuedMessageReceipt>;
  listQueue: (botId: string) => Promise<QueueSnapshot>;
  cancelQueuedMessage: (input: CancelQueuedMessageInput) => Promise<void>;
  setQueuePaused: (input: SetQueuePausedInput) => Promise<void>;
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
