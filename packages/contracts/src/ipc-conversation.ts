import type { BrowserControlState, BrowserTab } from "./ipc-browser";
import { isDynamicRecord, isNumber, isOneOf, isString } from "./runtime-values";

export type AgentPhase = "idle" | "starting" | "ready" | "restarting" | "blocked" | "stopped";

export type CapabilityState = "ready" | "setup-required" | "unavailable";

export type AgentProviderId = "codex" | "claude";
export type AgentProviderState =
  | "not-started"
  | "checking"
  | "available"
  | "sign-in-required"
  | "not-installed"
  | "outdated"
  | "error";

export interface AgentProviderStatus {
  id: AgentProviderId;
  state: AgentProviderState;
  version: string | null;
  message: string | null;
  email?: string | null;
}

export type AgentAuthState =
  | { kind: "unknown" }
  | { kind: "signed-out" }
  | { kind: "unsupported"; accountType: string }
  | { kind: "chatgpt"; email: string | null }
  | { kind: "claude"; email: string | null };

export interface AccountUsageWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface AccountUsageLimit {
  id: string;
  primary: AccountUsageWindow | null;
  secondary: AccountUsageWindow | null;
}

export interface AccountUsage {
  limits: AccountUsageLimit[];
}

export interface AgentStatus {
  phase: AgentPhase;
  cliVersion: string | null;
  auth: AgentAuthState;
  providers?: AgentProviderStatus[];
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
  title: string;
  description: string;
  notifications: boolean;
  model: AgentModelId;
  reasoningEffort: AgentReasoningEffort;
  threadId: string | null;
  workspacePath: string;
  preview: string;
  updatedAt: string | null;
  avatarSeed: string;
  avatarHue: BotAvatarHue | null;
  avatarUrl: string | null;
}

export const AGENT_MODELS = [
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
  "claude-fable-5",
  "claude-opus-5",
  "claude-sonnet-5",
] as const;
export type AgentModelId = (typeof AGENT_MODELS)[number];

export const AGENT_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AgentReasoningEffort = (typeof AGENT_REASONING_EFFORTS)[number];

export interface AgentModelOption {
  id: AgentModelId;
  name: string;
  description: string;
  defaultReasoningEffort: AgentReasoningEffort;
  supportedReasoningEfforts: AgentReasoningEffort[];
}

export const BOT_AVATAR_HUES = [0, 30, 55, 100, 150, 185, 215, 245, 280, 320] as const;
export type BotAvatarHue = (typeof BOT_AVATAR_HUES)[number];

export function isAgentModel(value: unknown): value is AgentModelId {
  return isOneOf(AGENT_MODELS, value);
}

export function isClaudeModel(model: AgentModelId): boolean {
  return model.startsWith("claude-");
}

export function isReasoningEffort(value: unknown): value is AgentReasoningEffort {
  return isOneOf(AGENT_REASONING_EFFORTS, value);
}

export function isAvatarSeed(value: unknown): value is string {
  return isString(value) && /^[a-z0-9:-]{1,128}$/.test(value);
}

export function isAvatarHue(value: unknown): value is BotAvatarHue {
  return isOneOf(BOT_AVATAR_HUES, value);
}

export interface CreateBotInput {
  name: string;
  description: string;
  avatarSeed: string;
  avatarHue: BotAvatarHue | null;
  initialMessage: string;
}

export interface UpdateBotInput {
  botId: string;
  name?: string;
  title?: string;
  description?: string;
  notifications?: boolean;
  model?: AgentModelId;
  reasoningEffort?: AgentReasoningEffort;
  avatarSeed?: string;
  avatarHue?: BotAvatarHue | null;
}

export interface AvatarImageInput {
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  bytes: Uint8Array;
}

export interface SetAgentAvatarInput {
  botId: string;
  image: AvatarImageInput | null;
}

export type ConversationMessageAuthor = "user" | "assistant" | "agent" | "system";

export const IMAGE_GENERATION_ASPECT_RATIOS = ["square", "portrait", "landscape"] as const;
export type ImageGenerationAspectRatio = (typeof IMAGE_GENERATION_ASPECT_RATIOS)[number];

export interface ImageGenerationInfo {
  prompt?: string;
  resolution: string;
  aspectRatio: ImageGenerationAspectRatio;
  error?: string;
}

export function isImageGenerationAspectRatio(value: unknown): value is ImageGenerationAspectRatio {
  return isOneOf(IMAGE_GENERATION_ASPECT_RATIOS, value);
}

export function isImageGenerationInfo(value: unknown): value is ImageGenerationInfo {
  return (
    isDynamicRecord(value) &&
    (value.prompt === undefined || isString(value.prompt)) &&
    isString(value.resolution) &&
    isImageGenerationAspectRatio(value.aspectRatio) &&
    (value.error === undefined || isString(value.error))
  );
}

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

export type DraftAttachment = AttachmentSummary;

export interface ChooseAttachmentsInput {
  filter: "all" | "images";
}

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
  | { type: "started"; requestId: string }
  | { type: "completed"; requestId: string; attachments: DraftAttachment[] }
  | { type: "error"; requestId: string; message: string };

export interface OpenAttachmentInput {
  attachmentId: string;
  action: "open" | "reveal" | "download";
}

export interface OpenSharedFileInput {
  path: string;
}

export interface OpenWorkspaceFileInput {
  botId: string;
  path: string;
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
  deliveries: QueueDelivery[];
}

export interface ConversationMessage {
  id: string;
  turnId?: string;
  author: ConversationMessageAuthor;
  text: string;
  createdAt: string;
  status: "streaming" | "completed" | "failed" | "interrupted";
  itemType?: string;
  source?: "user" | "assistant" | "agent" | "system";
  senderBotId?: string;
  replyToMessageId?: string | null;
  attachments?: AttachmentSummary[];
  imageGeneration?: ImageGenerationInfo;
  delivery?: Pick<QueueDelivery, "id" | "status" | "position">;
  exchange?: AgentExchangeSummary;
  reaction?: MessageReaction | null;
}

export function isConversationMessage(value: unknown): value is ConversationMessage {
  if (!isDynamicRecord(value)) return false;
  const author = value.author;
  const status = value.status;
  return (
    isString(value.id) &&
    isString(value.text) &&
    isString(value.createdAt) &&
    (author === "user" || author === "assistant" || author === "agent" || author === "system") &&
    (status === "streaming" || status === "completed" || status === "failed" || status === "interrupted") &&
    (value.turnId === undefined || isString(value.turnId)) &&
    (value.itemType === undefined || isString(value.itemType)) &&
    (value.source === undefined ||
      value.source === "user" ||
      value.source === "assistant" ||
      value.source === "agent" ||
      value.source === "system") &&
    (value.senderBotId === undefined || isString(value.senderBotId)) &&
    (value.replyToMessageId === undefined || value.replyToMessageId === null || isString(value.replyToMessageId)) &&
    (value.imageGeneration === undefined || isImageGenerationInfo(value.imageGeneration))
  );
}

export const MESSAGE_REACTIONS = ["👍", "👎", "❤️", "😂", "🎉", "😮"] as const;
export const MORE_MESSAGE_REACTIONS = ["🔥", "👏", "🙏", "🤔", "👀", "✅", "🚀", "💯"] as const;
export const ALL_MESSAGE_REACTIONS = [...MESSAGE_REACTIONS, ...MORE_MESSAGE_REACTIONS] as const;
export type MessageReaction = (typeof MESSAGE_REACTIONS)[number] | (typeof MORE_MESSAGE_REACTIONS)[number];

export function isMessageReaction(value: unknown): value is MessageReaction {
  return isOneOf(ALL_MESSAGE_REACTIONS, value);
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
  revision: number;
  messages: ConversationMessage[];
}

export interface ConversationReadState {
  unreadCount: number;
  firstUnreadMessageId: string | null;
  throughMessageId: string | null;
}

export interface ConversationWithReadState extends ConversationSnapshot {
  readState?: ConversationReadState;
}

export type ConversationPageAnchor =
  | { type: "latest" }
  | { type: "before"; cursor: string }
  | { type: "around"; messageId: string };

export interface ConversationPageInfo {
  hasOlder: boolean;
  olderCursor: string | null;
}

export interface ReadConversationPageInput {
  botId: string;
  anchor?: ConversationPageAnchor;
  limit?: number;
}

export interface ConversationPage {
  botId: string;
  threadId: string | null;
  activeTurnId: string | null;
  revision: number;
  messages: ConversationMessage[];
  references: Record<string, ConversationMessage>;
  pageInfo: ConversationPageInfo;
  readState?: ConversationReadState;
}

export interface SearchConversationMessagesInput {
  query: string;
  botId?: string;
  cursor?: string;
  limit?: number;
}

export interface ConversationSearchResult {
  botId: string;
  message: ConversationMessage;
}

export interface ConversationSearchPage {
  results: ConversationSearchResult[];
  total: number;
  nextCursor: string | null;
}

export interface MarkConversationReadInput {
  botId: string;
  throughMessageId: string | null;
}

export interface SendMessageInput {
  botId: string;
  text: string;
  attachmentDraftIds?: string[];
  replyToMessageId?: string | null;
}

export interface SetMessageReactionInput {
  botId: string;
  messageId: string;
  emoji: MessageReaction | null;
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

export interface SteerQueuedMessageInput {
  botId: string;
  deliveryId: string;
  expectedTurnId: string;
}

export interface UpdateQueuedMessageInput {
  botId: string;
  deliveryId: string;
  text: string;
  keepAttachmentIds: string[];
  attachmentDraftIds: string[];
}

export interface ReorderQueueInput {
  botId: string;
  deliveryIds: string[];
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

export type AgentApprovalKind = "command" | "file-change" | "permissions";

export interface AgentApprovalPermissions {
  fileSystem: {
    read: string[];
    write: string[];
  };
  network: boolean;
}

export interface AgentApproval {
  requestId: string | number;
  botId: string;
  threadId: string;
  turnId: string;
  kind: AgentApprovalKind;
  command: string | null;
  cwd: string | null;
  reason: string | null;
  grantRoot: string | null;
  permissions: AgentApprovalPermissions | null;
}

export interface RespondToApprovalInput {
  requestId: string | number;
  decision: "accept" | "decline";
}

export type AgentEvent =
  | { type: "status"; status: AgentStatus }
  | { type: "usage-changed"; usage: AccountUsage }
  | { type: "bots-changed"; bots: BotSummary[] }
  | { type: "conversation"; snapshot: ConversationSnapshot }
  | {
      type: "conversation-delta";
      botId: string;
      threadId: string;
      turnId: string;
      messageId: string;
      delta: string;
      createdAt: string;
      revision: number;
    }
  | { type: "queue-changed"; snapshot: QueueSnapshot }
  | { type: "turn-started"; botId: string; threadId: string; turnId: string }
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
  | { type: "approval"; approval: AgentApproval }
  | { type: "browser-changed"; tabs: BrowserTab[]; activeTabId: string | null }
  | { type: "browser-control-changed"; state: BrowserControlState }
  | { type: "error"; botId?: string; code: string; message: string };

export function isAgentEvent(value: unknown): value is AgentEvent {
  if (!isDynamicRecord(value) || !isString(value.type)) return false;
  switch (value.type) {
    case "status":
      return isDynamicRecord(value.status);
    case "usage-changed":
      return isDynamicRecord(value.usage);
    case "bots-changed":
      return Array.isArray(value.bots);
    case "conversation":
      return isDynamicRecord(value.snapshot);
    case "conversation-delta":
      return (
        isString(value.botId) &&
        isString(value.threadId) &&
        isString(value.turnId) &&
        isString(value.messageId) &&
        isString(value.delta) &&
        isString(value.createdAt) &&
        isNumber(value.revision)
      );
    case "queue-changed":
      return isDynamicRecord(value.snapshot);
    case "turn-started":
    case "turn-completed":
      return isString(value.botId) && isString(value.threadId) && isString(value.turnId);
    case "prompt":
      return (
        (isString(value.requestId) || isNumber(value.requestId)) &&
        isString(value.botId) &&
        isString(value.threadId) &&
        isString(value.turnId) &&
        Array.isArray(value.questions)
      );
    case "approval":
      return isDynamicRecord(value.approval);
    case "browser-changed":
      return Array.isArray(value.tabs) && (value.activeTabId === null || isString(value.activeTabId));
    case "browser-control-changed":
      return isDynamicRecord(value.state);
    case "error":
      return isString(value.code) && isString(value.message);
    default:
      return false;
  }
}

export interface ScopedAgentEvent {
  serverId: string;
  event: AgentEvent;
}

export interface AgentIpcRequest<T = unknown> {
  serverId: string;
  payload: T;
}
