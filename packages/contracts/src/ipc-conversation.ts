import { INPUT_LIMITS } from "./input-limits";
import type { BrowserControlState, BrowserTab } from "./ipc-browser";
import { isBoolean, isDynamicRecord, isNumber, isOneOf, isString } from "./runtime-values";

export type AgentPhase = "idle" | "starting" | "ready" | "restarting" | "blocked" | "stopped";

export type CapabilityState = "ready" | "setup-required" | "unavailable";

export const AGENT_PROVIDERS = ["codex", "claude", "grok"] as const;
export type AgentProviderId = (typeof AGENT_PROVIDERS)[number];

export function isAgentProvider(value: unknown): value is AgentProviderId {
  return isOneOf(AGENT_PROVIDERS, value);
}
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
  connectionState?: "connecting";
  checkError?: string | null;
}

export type AgentAuthState =
  | { kind: "unknown" }
  | { kind: "signed-out" }
  | { kind: "unsupported"; accountType: string }
  | { kind: "chatgpt"; email: string | null }
  | { kind: "claude"; email: string | null }
  | { kind: "grok"; email: string | null };

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
  provider: AgentProviderId;
  model: AgentModelId;
  reasoningEffort: AgentReasoningEffort;
  threadId: string | null;
  workspacePath: string;
  preview: string;
  updatedAt: string | null;
  avatarSeed: string;
  avatarHue: BotAvatarHue | null;
  avatarUrl: string | null;
  marketplaceSource?: {
    agentId: string;
    versionId: string;
    version: number;
    skillIds: string[];
    routineIds: string[];
  };
}

export type BotMemoryOrigin = "automatic" | "manual";

export interface BotMemory {
  id: string;
  botId: string;
  text: string;
  origin: BotMemoryOrigin;
  sourceTurnId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateBotMemoryInput {
  botId: string;
  text: string;
}

export interface UpdateBotMemoryInput {
  botId: string;
  memoryId: string;
  text: string;
}

export interface DeleteBotMemoryInput {
  botId: string;
  memoryId: string;
}

export type RoutineIntervalUnit = "minutes" | "hours" | "days";
export type RoutineDaySelection =
  | { kind: "every-day" }
  | { kind: "days-of-week"; days: number[] }
  | { kind: "days-of-month"; days: number[] };
export type RoutineTimeSelection =
  | { kind: "at-time"; time: string }
  | { kind: "every"; amount: number; unit: Exclude<RoutineIntervalUnit, "days"> };

export type RoutineSchedule =
  | { kind: "hourly"; minute: number }
  | { kind: "daily"; time: string }
  | { kind: "weekdays"; time: string }
  | { kind: "weekly"; weekday: number; time: string }
  | { kind: "monthly"; day: number; time: string }
  | { kind: "interval"; amount: number; unit: RoutineIntervalUnit; anchorAt: string }
  | {
      kind: "advanced";
      months: number[];
      days: RoutineDaySelection;
      time: RoutineTimeSelection;
    }
  | { kind: "custom"; expression: string };

export interface RoutineTrigger {
  id: string;
  routineId: string;
  schedule: RoutineSchedule;
  nextRunAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface Routine {
  id: string;
  botId: string;
  name: string;
  instruction: string;
  active: boolean;
  timezone: string;
  trigger: RoutineTrigger;
  createdAt: string;
  updatedAt: string;
}

export type RoutineRunStatus =
  | "queued"
  | "running"
  | "needs-attention"
  | "succeeded"
  | "failed"
  | "interrupted"
  | "cancelled";

export interface RoutineRun {
  id: string;
  routineId: string;
  botId: string;
  triggerId: string | null;
  kind: "scheduled" | "manual";
  scheduledFor: string;
  routineName: string;
  instruction: string;
  deliveryId: string | null;
  status: RoutineRunStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRoutineInput {
  botId: string;
  name: string;
  instruction: string;
  active: boolean;
  timezone: string;
  schedule: RoutineSchedule;
}

export interface UpdateRoutineInput {
  botId: string;
  routineId: string;
  name?: string;
  instruction?: string;
  active?: boolean;
  schedule?: RoutineSchedule;
}

export interface DeleteRoutineInput {
  botId: string;
  routineId: string;
}

export interface TestRoutineInput {
  botId: string;
  routineId: string;
}

export interface ListRoutineRunsInput {
  botId: string;
  routineId: string;
  limit?: number;
}

export function isRoutineSchedule(value: unknown): value is RoutineSchedule {
  if (!isDynamicRecord(value) || !isString(value.kind)) return false;
  switch (value.kind) {
    case "hourly":
      return integerInRange(value.minute, 0, 59);
    case "daily":
    case "weekdays":
      return isRoutineTime(value.time);
    case "weekly":
      return integerInRange(value.weekday, 0, 6) && isRoutineTime(value.time);
    case "monthly":
      return integerInRange(value.day, 1, 31) && isRoutineTime(value.time);
    case "interval":
      return (
        integerInRange(value.amount, 1, 100_000) &&
        isOneOf(["minutes", "hours", "days"] as const, value.unit) &&
        isString(value.anchorAt) &&
        !Number.isNaN(Date.parse(value.anchorAt))
      );
    case "advanced":
      return (
        Array.isArray(value.months) &&
        value.months.length > 0 &&
        value.months.every((month) => integerInRange(month, 1, 12)) &&
        isRoutineDaySelection(value.days) &&
        isRoutineTimeSelection(value.time)
      );
    case "custom":
      return (
        isString(value.expression) && value.expression.length > 0 && value.expression.length <= INPUT_LIMITS.routineCron
      );
    default:
      return false;
  }
}

export function isRoutine(value: unknown): value is Routine {
  return (
    isDynamicRecord(value) &&
    isString(value.id) &&
    isString(value.botId) &&
    isString(value.name) &&
    isString(value.instruction) &&
    isBoolean(value.active) &&
    isString(value.timezone) &&
    isRoutineTrigger(value.trigger) &&
    isString(value.createdAt) &&
    isString(value.updatedAt)
  );
}

export function isRoutineRun(value: unknown): value is RoutineRun {
  return (
    isDynamicRecord(value) &&
    isString(value.id) &&
    isString(value.routineId) &&
    isString(value.botId) &&
    (value.triggerId === null || isString(value.triggerId)) &&
    isOneOf(["scheduled", "manual"] as const, value.kind) &&
    isString(value.scheduledFor) &&
    isString(value.routineName) &&
    isString(value.instruction) &&
    (value.deliveryId === null || isString(value.deliveryId)) &&
    isOneOf(
      ["queued", "running", "needs-attention", "succeeded", "failed", "interrupted", "cancelled"] as const,
      value.status,
    ) &&
    (value.error === null || isString(value.error)) &&
    isString(value.createdAt) &&
    isString(value.updatedAt)
  );
}

function isRoutineTrigger(value: unknown): value is RoutineTrigger {
  return (
    isDynamicRecord(value) &&
    isString(value.id) &&
    isString(value.routineId) &&
    isRoutineSchedule(value.schedule) &&
    isString(value.nextRunAt) &&
    isString(value.createdAt) &&
    isString(value.updatedAt)
  );
}

function isRoutineTime(value: unknown): value is string {
  return isString(value) && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function isRoutineDaySelection(value: unknown): value is RoutineDaySelection {
  if (!isDynamicRecord(value) || !isString(value.kind)) return false;
  if (value.kind === "every-day") return true;
  if (!Array.isArray(value.days) || value.days.length === 0) return false;
  if (value.kind === "days-of-week") return value.days.every((day) => integerInRange(day, 0, 6));
  if (value.kind === "days-of-month") return value.days.every((day) => integerInRange(day, 1, 31));
  return false;
}

function isRoutineTimeSelection(value: unknown): value is RoutineTimeSelection {
  if (!isDynamicRecord(value) || !isString(value.kind)) return false;
  if (value.kind === "at-time") return isRoutineTime(value.time);
  return (
    value.kind === "every" &&
    integerInRange(value.amount, 1, 100_000) &&
    isOneOf(["minutes", "hours"] as const, value.unit)
  );
}

function integerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return isNumber(value) && Number.isInteger(value) && value >= minimum && value <= maximum;
}

export function isBotMemory(value: unknown): value is BotMemory {
  return (
    isDynamicRecord(value) &&
    isString(value.id) &&
    value.id.length > 0 &&
    value.id.length <= INPUT_LIMITS.identifier &&
    isString(value.botId) &&
    value.botId.length > 0 &&
    value.botId.length <= INPUT_LIMITS.identifier &&
    isString(value.text) &&
    value.text.length > 0 &&
    value.text.length <= INPUT_LIMITS.agentMemoryText &&
    isOneOf(["automatic", "manual"] as const, value.origin) &&
    (value.sourceTurnId === null ||
      (isString(value.sourceTurnId) &&
        value.sourceTurnId.length > 0 &&
        value.sourceTurnId.length <= INPUT_LIMITS.identifier)) &&
    isString(value.createdAt) &&
    isString(value.updatedAt)
  );
}

export const SIDEBAR_PEOPLE_SECTION_ID = "people";
export const SIDEBAR_UNASSIGNED_SECTION_ID = "unassigned";

export interface SidebarSection {
  id: string;
  name: string;
}

export interface SidebarLayoutSnapshot {
  revision: number;
  sections: SidebarSection[];
  order: string[];
  agentAssignments: Record<string, string>;
  agentOrder: string[];
}

export type SidebarLayoutAction =
  | { type: "create"; name: string; agentId?: string }
  | { type: "rename"; sectionId: string; name: string }
  | { type: "delete"; sectionId: string }
  | { type: "move"; sectionId: string; direction: "up" | "down"; steps?: number }
  | { type: "assign"; agentId: string; sectionId: string | null }
  | { type: "move-agent"; agentId: string; sectionId: string | null; beforeAgentId: string | null };

export const AGENT_MODELS = [
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
  "claude-fable-5",
  "claude-opus-5",
  "claude-sonnet-5",
] as const;
export type AgentModelId = string;

export const AGENT_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AgentReasoningEffort = (typeof AGENT_REASONING_EFFORTS)[number];

export interface AgentModelOption {
  provider: AgentProviderId;
  id: AgentModelId;
  name: string;
  description: string;
  defaultReasoningEffort: AgentReasoningEffort;
  supportedReasoningEfforts: AgentReasoningEffort[];
}

export const BOT_AVATAR_HUES = [0, 30, 55, 100, 150, 185, 215, 245, 280, 320] as const;
export type BotAvatarHue = (typeof BOT_AVATAR_HUES)[number];

export function isAgentModel(value: unknown): value is AgentModelId {
  return isString(value) && value.length > 0 && value.length <= 160 && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value);
}

export function isClaudeModel(model: AgentModelId): boolean {
  return model.startsWith("claude-");
}

export function providerForLegacyModel(model: AgentModelId): AgentProviderId {
  if (isClaudeModel(model)) return "claude";
  if (model.startsWith("grok-")) return "grok";
  return "codex";
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
  provider?: AgentProviderId;
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

export type FilePreviewKind = "markdown" | "text" | "image" | "pdf" | "none";

export interface FilePreview {
  name: string;
  size: number;
  mimeType: string;
  previewKind: FilePreviewKind;
  bytes: Uint8Array | null;
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
  sender:
    | { kind: "user" }
    | { kind: "bot"; botId: string }
    | { kind: "routine"; routineId: string; runId: string; routineName: string; scheduledFor: string };
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

export interface AgentPromptQuestion {
  id: string;
  header: string;
  question: string;
  isSecret: boolean;
  options: Array<{ label: string; description: string }> | null;
}

export type AgentPromptQuestionResolution = { status: "answered"; answers?: string[] } | { status: "skipped" };

export type AgentPromptResolution =
  | { status: "answered"; responses: Record<string, AgentPromptQuestionResolution> }
  | { status: "cancelled" }
  | { status: "expired" };

export interface ConversationQuestionPrompt {
  requestId: string | number;
  questions: AgentPromptQuestion[];
  resolution: AgentPromptResolution | null;
}

export interface ConversationMessage {
  id: string;
  turnId?: string;
  author: ConversationMessageAuthor;
  text: string;
  createdAt: string;
  status: "streaming" | "completed" | "failed" | "interrupted";
  itemType?: string;
  source?: "user" | "assistant" | "agent" | "system" | "routine";
  senderBotId?: string;
  replyToMessageId?: string | null;
  attachments?: AttachmentSummary[];
  imageGeneration?: ImageGenerationInfo;
  delivery?: Pick<QueueDelivery, "id" | "status" | "position">;
  exchange?: AgentExchangeSummary;
  reaction?: MessageReaction | null;
  reactions?: ConversationReaction[];
  routine?: {
    routineId: string;
    runId: string;
    name: string;
    scheduledFor: string;
  };
  questionPrompt?: ConversationQuestionPrompt;
}

function isAgentPromptQuestion(value: unknown): value is AgentPromptQuestion {
  if (!isDynamicRecord(value)) return false;
  return (
    isBoundedString(value.id, INPUT_LIMITS.identifier) &&
    isBoundedString(value.header, INPUT_LIMITS.promptHeader) &&
    isBoundedString(value.question, INPUT_LIMITS.promptQuestion) &&
    isBoolean(value.isSecret) &&
    (value.options === null ||
      (Array.isArray(value.options) &&
        value.options.length <= INPUT_LIMITS.promptOptions &&
        value.options.every(
          (option) =>
            isDynamicRecord(option) &&
            isBoundedString(option.label, INPUT_LIMITS.promptOptionLabel) &&
            isBoundedString(option.description, INPUT_LIMITS.promptOptionDescription),
        )))
  );
}

function isAgentPromptResolution(value: unknown): value is AgentPromptResolution {
  if (!isDynamicRecord(value)) return false;
  if (value.status === "cancelled" || value.status === "expired") return true;
  if (value.status !== "answered" || !isDynamicRecord(value.responses)) return false;
  return Object.values(value.responses).every(
    (response) =>
      isDynamicRecord(response) &&
      (response.status === "skipped" ||
        (response.status === "answered" &&
          (response.answers === undefined || (Array.isArray(response.answers) && response.answers.every(isString))))),
  );
}

function isConversationQuestionPrompt(value: unknown): value is ConversationQuestionPrompt {
  if (!isDynamicRecord(value)) return false;
  return (
    isRequestId(value.requestId) &&
    Array.isArray(value.questions) &&
    value.questions.length <= INPUT_LIMITS.promptQuestions &&
    value.questions.every(isAgentPromptQuestion) &&
    (value.resolution === null || isAgentPromptResolution(value.resolution))
  );
}

export function isConversationMessage(value: unknown): value is ConversationMessage {
  if (!isDynamicRecord(value)) return false;
  const author = value.author;
  const status = value.status;
  return (
    isIdentifier(value.id) &&
    isString(value.text) &&
    isBoundedString(value.createdAt, 160) &&
    (author === "user" || author === "assistant" || author === "agent" || author === "system") &&
    (status === "streaming" || status === "completed" || status === "failed" || status === "interrupted") &&
    (value.turnId === undefined || isIdentifier(value.turnId)) &&
    (value.itemType === undefined || isBoundedString(value.itemType, INPUT_LIMITS.identifier)) &&
    (value.source === undefined ||
      value.source === "user" ||
      value.source === "assistant" ||
      value.source === "agent" ||
      value.source === "system" ||
      value.source === "routine") &&
    (value.senderBotId === undefined || isIdentifier(value.senderBotId)) &&
    (value.replyToMessageId === undefined || value.replyToMessageId === null || isIdentifier(value.replyToMessageId)) &&
    (value.attachments === undefined ||
      (Array.isArray(value.attachments) &&
        value.attachments.length <= INPUT_LIMITS.attachments &&
        value.attachments.every(isAttachmentSummary))) &&
    (value.delivery === undefined || isConversationDelivery(value.delivery)) &&
    (value.exchange === undefined || isAgentExchangeSummary(value.exchange)) &&
    (value.reaction === undefined || value.reaction === null || isMessageReaction(value.reaction)) &&
    (value.reactions === undefined ||
      (Array.isArray(value.reactions) &&
        value.reactions.length <= INPUT_LIMITS.teamMembers &&
        value.reactions.every(isConversationReaction))) &&
    (value.routine === undefined ||
      (isDynamicRecord(value.routine) &&
        isIdentifier(value.routine.routineId) &&
        isIdentifier(value.routine.runId) &&
        isBoundedString(value.routine.name, INPUT_LIMITS.routineName) &&
        isBoundedString(value.routine.scheduledFor, 160))) &&
    (value.imageGeneration === undefined || isImageGenerationInfo(value.imageGeneration)) &&
    (value.questionPrompt === undefined || isConversationQuestionPrompt(value.questionPrompt))
  );
}

function isConversationDelivery(value: unknown): boolean {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.id) &&
    isOneOf(
      ["queued", "starting", "running", "completed", "failed", "interrupted", "cancelled"] as const,
      value.status,
    ) &&
    (value.position === null || (isNumber(value.position) && Number.isInteger(value.position) && value.position >= 1))
  );
}

function isAgentExchangeSummary(value: unknown): value is AgentExchangeSummary {
  return (
    isDynamicRecord(value) &&
    isOneOf(["incoming", "outgoing"] as const, value.direction) &&
    isIdentifier(value.messageId) &&
    isIdentifier(value.senderBotId) &&
    Array.isArray(value.recipientBotIds) &&
    value.recipientBotIds.length <= INPUT_LIMITS.messageRecipients &&
    value.recipientBotIds.every(isIdentifier) &&
    (value.replyToMessageId === null || isIdentifier(value.replyToMessageId)) &&
    Array.isArray(value.deliveries) &&
    value.deliveries.length <= INPUT_LIMITS.messageRecipients &&
    value.deliveries.every(
      (delivery) =>
        isDynamicRecord(delivery) &&
        isIdentifier(delivery.id) &&
        isIdentifier(delivery.recipientBotId) &&
        isOneOf(
          ["queued", "starting", "running", "completed", "failed", "interrupted", "cancelled"] as const,
          delivery.status,
        ) &&
        (delivery.position === null ||
          (isNumber(delivery.position) && Number.isInteger(delivery.position) && delivery.position >= 1)) &&
        (delivery.error === null || isBoundedString(delivery.error, INPUT_LIMITS.messageText)),
    )
  );
}

export const MESSAGE_REACTIONS = ["👍", "👎", "❤️", "😂", "🎉", "😮"] as const;
export const MORE_MESSAGE_REACTIONS = ["🔥", "👏", "🙏", "🤔", "👀", "✅", "🚀", "💯"] as const;
export const ALL_MESSAGE_REACTIONS = [...MESSAGE_REACTIONS, ...MORE_MESSAGE_REACTIONS] as const;
export type MessageReaction = string;

export type ConversationReactionActor = { kind: "user" } | { kind: "bot"; botId: string };

export interface ConversationReaction {
  emoji: MessageReaction;
  actor: ConversationReactionActor;
}

// biome-ignore lint/complexity/useRegexLiterals: The v flag is supported at runtime but the contracts target predates ES2024.
const RGI_EMOJI_PATTERN = new RegExp("^(?:\\p{RGI_Emoji})$", "v");

export function isMessageReaction(value: unknown): value is MessageReaction {
  return isString(value) && RGI_EMOJI_PATTERN.test(value);
}

export function isConversationReaction(value: unknown): value is ConversationReaction {
  if (!isDynamicRecord(value) || !isMessageReaction(value.emoji) || !isDynamicRecord(value.actor)) return false;
  return (
    value.actor.kind === "user" ||
    (value.actor.kind === "bot" && isString(value.actor.botId) && value.actor.botId.length > 0)
  );
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

function isConversationSnapshot(value: unknown): value is ConversationSnapshot {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.botId) &&
    (value.threadId === null || isIdentifier(value.threadId)) &&
    (value.activeTurnId === null || isIdentifier(value.activeTurnId)) &&
    isNumber(value.revision) &&
    Number.isInteger(value.revision) &&
    value.revision >= 0 &&
    Array.isArray(value.messages) &&
    value.messages.every(isConversationMessage)
  );
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

export interface AcknowledgeFailedTurnInput {
  botId: string;
  turnId: string;
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

export interface RespondToPromptInput {
  requestId: string | number;
  answers: Record<string, string[]>;
}

export interface BrowserTakeoverRequest {
  requestId: string | number;
  botId: string;
  threadId: string;
  turnId: string;
  tabId: string;
}

export interface RespondToBrowserTakeoverInput {
  requestId: string | number;
  decision: "complete" | "cancel";
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

export interface AgentRuntimeSnapshot {
  bots: AgentRuntimeBotSummary[];
  activeTurns: Array<{ botId: string; threadId: string; turnId: string }>;
  work: AgentRuntimeWorkItem[];
  latestMessages: Array<{ botId: string; id: string; text: string; createdAt: string }>;
  pendingPrompts: Array<{
    requestId: string | number;
    botId: string;
    threadId: string;
    turnId: string;
    questions: AgentRuntimePromptQuestion[];
  }>;
  pendingApprovals: AgentRuntimeApproval[];
  pendingBrowserTakeovers: BrowserTakeoverRequest[];
  failedTurns: Array<{ botId: string; turnId: string }>;
}

export const AGENT_RUNTIME_TEXT_LIMIT = 240;
export const AGENT_RUNTIME_QUESTION_HEADER_LIMIT = 80;
export const AGENT_RUNTIME_QUESTION_DESCRIPTION_LIMIT = 120;
export const AGENT_RUNTIME_WORKING_ITEMS_LIMIT = 3;
export const AGENT_RUNTIME_ATTENTION_LIMIT = 4;
export const AGENT_RUNTIME_PERMISSION_PATHS_LIMIT = 3;
export const AGENT_RUNTIME_SNAPSHOT_BYTES_LIMIT = 256 * 1024;

export interface AgentRuntimeBotSummary {
  id: string;
  name: string;
  notifications: boolean;
  preview: string;
  updatedAt: string | null;
  avatarSeed: string;
  avatarHue: BotAvatarHue | null;
  avatarUrl: string | null;
}

export interface AgentRuntimeWorkItem {
  id: string;
  botId: string;
  turnId: string | null;
  status: "starting" | "running" | "failed";
  text: string;
  error: string | null;
}

export interface AgentRuntimePromptQuestion {
  id: string;
  header: string;
  question: string;
  isSecret: boolean;
  options: Array<{ label: string; description: string }> | null;
}

export interface AgentRuntimeApproval {
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

export type AgentTurnOrigin = "user" | "routine" | "bot" | "unknown";

export type AgentEvent =
  | { type: "status"; status: AgentStatus }
  | { type: "usage-changed"; usage: AccountUsage }
  | { type: "bots-changed"; bots: BotSummary[] }
  | { type: "memories-changed"; botId: string }
  | { type: "routines-changed"; botId: string }
  | { type: "sidebar-layout-changed"; layout: SidebarLayoutSnapshot }
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
  | { type: "turn-started"; botId: string; threadId: string; turnId: string; origin?: AgentTurnOrigin }
  | {
      type: "turn-completed";
      botId: string;
      threadId: string;
      turnId: string;
      status: string;
      origin?: AgentTurnOrigin;
    }
  | {
      type: "prompt";
      requestId: string | number;
      botId: string;
      threadId: string;
      turnId: string;
      questions: AgentPromptQuestion[];
    }
  | {
      type: "agent-input-resolved";
      kind: "prompt" | "approval";
      requestId: string | number;
      botId: string;
    }
  | { type: "browser-takeover-requested"; request: BrowserTakeoverRequest }
  | { type: "browser-takeover-resolved"; requestId: string | number; botId: string }
  | { type: "approval"; approval: AgentApproval }
  | { type: "runtime-snapshot"; snapshot: AgentRuntimeSnapshot }
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
      return Array.isArray(value.bots) && value.bots.length <= INPUT_LIMITS.agents && value.bots.every(isBotSummary);
    case "memories-changed":
      return isString(value.botId) && value.botId.length > 0 && value.botId.length <= INPUT_LIMITS.identifier;
    case "routines-changed":
      return isString(value.botId) && value.botId.length > 0 && value.botId.length <= INPUT_LIMITS.identifier;
    case "sidebar-layout-changed":
      return isSidebarLayoutSnapshot(value.layout);
    case "conversation":
      return isConversationSnapshot(value.snapshot);
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
      return isQueueSnapshot(value.snapshot);
    case "turn-started":
    case "turn-completed":
      return (
        isString(value.botId) &&
        isString(value.threadId) &&
        isString(value.turnId) &&
        (value.origin === undefined || isAgentTurnOrigin(value.origin))
      );
    case "prompt":
      return (
        (isString(value.requestId) || isNumber(value.requestId)) &&
        isString(value.botId) &&
        isString(value.threadId) &&
        isString(value.turnId) &&
        Array.isArray(value.questions) &&
        value.questions.length <= INPUT_LIMITS.promptQuestions &&
        value.questions.every(isAgentPromptQuestion)
      );
    case "agent-input-resolved":
      return (
        (value.kind === "prompt" || value.kind === "approval") &&
        (isString(value.requestId) || isNumber(value.requestId)) &&
        isString(value.botId)
      );
    case "browser-takeover-requested":
      return isBrowserTakeoverRequest(value.request);
    case "browser-takeover-resolved":
      return (isString(value.requestId) || isNumber(value.requestId)) && isString(value.botId);
    case "approval":
      return isAgentApproval(value.approval);
    case "runtime-snapshot":
      return isAgentRuntimeSnapshot(value.snapshot);
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

function isAgentRuntimeSnapshot(value: unknown): value is AgentRuntimeSnapshot {
  if (!isDynamicRecord(value)) return false;
  return (
    Array.isArray(value.bots) &&
    value.bots.length <= INPUT_LIMITS.agents &&
    value.bots.every(isAgentRuntimeBotSummary) &&
    Array.isArray(value.activeTurns) &&
    value.activeTurns.length <= INPUT_LIMITS.agents &&
    value.activeTurns.every(
      (turn) =>
        isDynamicRecord(turn) && isIdentifier(turn.botId) && isIdentifier(turn.threadId) && isIdentifier(turn.turnId),
    ) &&
    Array.isArray(value.work) &&
    value.work.length <= AGENT_RUNTIME_WORKING_ITEMS_LIMIT + AGENT_RUNTIME_ATTENTION_LIMIT &&
    value.work.every(isRuntimeWorkItem) &&
    Array.isArray(value.latestMessages) &&
    value.latestMessages.length <= INPUT_LIMITS.agents &&
    value.latestMessages.every(
      (message) =>
        isDynamicRecord(message) &&
        isIdentifier(message.botId) &&
        isIdentifier(message.id) &&
        isBoundedString(message.text, AGENT_RUNTIME_TEXT_LIMIT) &&
        isBoundedString(message.createdAt, 160),
    ) &&
    Array.isArray(value.pendingPrompts) &&
    value.pendingPrompts.length <= AGENT_RUNTIME_ATTENTION_LIMIT &&
    value.pendingPrompts.every(isRuntimePrompt) &&
    Array.isArray(value.pendingApprovals) &&
    value.pendingApprovals.length <= AGENT_RUNTIME_ATTENTION_LIMIT &&
    value.pendingApprovals.every(isRuntimeApproval) &&
    Array.isArray(value.pendingBrowserTakeovers) &&
    value.pendingBrowserTakeovers.length <= AGENT_RUNTIME_ATTENTION_LIMIT &&
    value.pendingBrowserTakeovers.every(isBrowserTakeoverRequest) &&
    value.pendingPrompts.length + value.pendingApprovals.length + value.pendingBrowserTakeovers.length <=
      AGENT_RUNTIME_ATTENTION_LIMIT &&
    Array.isArray(value.failedTurns) &&
    value.failedTurns.length <= INPUT_LIMITS.agents &&
    value.failedTurns.every((turn) => isDynamicRecord(turn) && isIdentifier(turn.botId) && isIdentifier(turn.turnId))
  );
}

function isAgentRuntimeBotSummary(value: unknown): value is AgentRuntimeBotSummary {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.id) &&
    isBoundedString(value.name, INPUT_LIMITS.agentName) &&
    isBoolean(value.notifications) &&
    isBoundedString(value.preview, AGENT_RUNTIME_TEXT_LIMIT) &&
    (value.updatedAt === null || isBoundedString(value.updatedAt, 160)) &&
    isAvatarSeed(value.avatarSeed) &&
    (value.avatarHue === null || isAvatarHue(value.avatarHue)) &&
    (value.avatarUrl === null || isBoundedString(value.avatarUrl, INPUT_LIMITS.avatarUrl))
  );
}

function isBotSummary(value: unknown): value is BotSummary {
  if (!isDynamicRecord(value)) return false;
  return (
    isIdentifier(value.id) &&
    isBoundedString(value.name, INPUT_LIMITS.agentName) &&
    isBoundedString(value.title, INPUT_LIMITS.agentTitle) &&
    isBoundedString(value.description, INPUT_LIMITS.agentDescription) &&
    isBoolean(value.notifications) &&
    isAgentProvider(value.provider) &&
    isAgentModel(value.model) &&
    isReasoningEffort(value.reasoningEffort) &&
    (value.threadId === null || isIdentifier(value.threadId)) &&
    isBoundedString(value.workspacePath, INPUT_LIMITS.path) &&
    isBoundedString(value.preview, INPUT_LIMITS.messageText) &&
    (value.updatedAt === null || isBoundedString(value.updatedAt, 160)) &&
    isAvatarSeed(value.avatarSeed) &&
    (value.avatarHue === null || isAvatarHue(value.avatarHue)) &&
    (value.avatarUrl === null || isBoundedString(value.avatarUrl, INPUT_LIMITS.avatarUrl)) &&
    (value.marketplaceSource === undefined || isMarketplaceSource(value.marketplaceSource))
  );
}

function isMarketplaceSource(value: unknown): value is NonNullable<BotSummary["marketplaceSource"]> {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.agentId) &&
    isIdentifier(value.versionId) &&
    isNumber(value.version) &&
    Number.isInteger(value.version) &&
    Array.isArray(value.skillIds) &&
    value.skillIds.length <= INPUT_LIMITS.agents &&
    value.skillIds.every(isIdentifier) &&
    Array.isArray(value.routineIds) &&
    value.routineIds.length <= INPUT_LIMITS.agentRoutines &&
    value.routineIds.every(isIdentifier)
  );
}

function isQueueSnapshot(value: unknown): value is QueueSnapshot {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.botId) &&
    Array.isArray(value.deliveries) &&
    value.deliveries.every(isQueueDelivery)
  );
}

function isRuntimeWorkItem(value: unknown): value is AgentRuntimeWorkItem {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.id) &&
    isIdentifier(value.botId) &&
    (value.turnId === null || isIdentifier(value.turnId)) &&
    isOneOf(["starting", "running", "failed"] as const, value.status) &&
    isBoundedString(value.text, AGENT_RUNTIME_TEXT_LIMIT) &&
    isNullableBoundedString(value.error, AGENT_RUNTIME_TEXT_LIMIT)
  );
}

function isQueueDelivery(value: unknown): value is QueueDelivery {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.id) &&
    isIdentifier(value.messageId) &&
    isIdentifier(value.recipientBotId) &&
    isQueueSender(value.sender) &&
    isBoundedString(value.text, INPUT_LIMITS.messageText) &&
    Array.isArray(value.attachments) &&
    value.attachments.length <= INPUT_LIMITS.attachments &&
    value.attachments.every(isAttachmentSummary) &&
    (value.replyToMessageId === null || isIdentifier(value.replyToMessageId)) &&
    isOneOf(
      ["queued", "starting", "running", "completed", "failed", "interrupted", "cancelled"] as const,
      value.status,
    ) &&
    (value.position === null ||
      (isNumber(value.position) && Number.isInteger(value.position) && value.position >= 1)) &&
    (value.turnId === null || isIdentifier(value.turnId)) &&
    (value.error === null || isBoundedString(value.error, INPUT_LIMITS.messageText)) &&
    isBoundedString(value.createdAt, 160)
  );
}

function isQueueSender(value: unknown): value is QueueDelivery["sender"] {
  if (!isDynamicRecord(value)) return false;
  if (value.kind === "user") return true;
  if (value.kind === "bot") return isIdentifier(value.botId);
  return (
    value.kind === "routine" &&
    isIdentifier(value.routineId) &&
    isIdentifier(value.runId) &&
    isBoundedString(value.routineName, INPUT_LIMITS.routineName) &&
    isBoundedString(value.scheduledFor, 160)
  );
}

function isAttachmentSummary(value: unknown): value is AttachmentSummary {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.id) &&
    isBoundedString(value.name, INPUT_LIMITS.attachmentName) &&
    isNumber(value.size) &&
    value.size >= 0 &&
    isOneOf(["image", "file"] as const, value.kind) &&
    isBoundedString(value.mimeType, INPUT_LIMITS.mimeType) &&
    isOneOf(["image", "pdf", "text", "none"] as const, value.previewKind) &&
    (value.previewUrl === null || isBoundedString(value.previewUrl, INPUT_LIMITS.avatarUrl))
  );
}

function isRuntimePrompt(value: unknown): value is AgentRuntimeSnapshot["pendingPrompts"][number] {
  return (
    isDynamicRecord(value) &&
    isRequestId(value.requestId) &&
    isIdentifier(value.botId) &&
    isIdentifier(value.threadId) &&
    isIdentifier(value.turnId) &&
    Array.isArray(value.questions) &&
    value.questions.length <= INPUT_LIMITS.promptQuestions &&
    value.questions.every(isRuntimePromptQuestion)
  );
}

function isRuntimePromptQuestion(value: unknown): value is AgentRuntimePromptQuestion {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.id) &&
    isBoundedString(value.header, AGENT_RUNTIME_QUESTION_HEADER_LIMIT) &&
    isBoundedString(value.question, AGENT_RUNTIME_TEXT_LIMIT) &&
    isBoolean(value.isSecret) &&
    (value.options === null ||
      (Array.isArray(value.options) &&
        value.options.length <= INPUT_LIMITS.promptOptions &&
        value.options.every(
          (option) =>
            isDynamicRecord(option) &&
            isBoundedString(option.label, INPUT_LIMITS.promptOptionLabel) &&
            isBoundedString(option.description, AGENT_RUNTIME_QUESTION_DESCRIPTION_LIMIT),
        )))
  );
}

function isRuntimeApproval(value: unknown): value is AgentRuntimeApproval {
  if (!isDynamicRecord(value)) return false;
  return (
    isRequestId(value.requestId) &&
    isIdentifier(value.botId) &&
    isIdentifier(value.threadId) &&
    isIdentifier(value.turnId) &&
    isOneOf(["command", "file-change", "permissions"] as const, value.kind) &&
    isNullableBoundedString(value.command, AGENT_RUNTIME_TEXT_LIMIT) &&
    isNullableBoundedString(value.cwd, AGENT_RUNTIME_TEXT_LIMIT) &&
    isNullableBoundedString(value.reason, AGENT_RUNTIME_TEXT_LIMIT) &&
    isNullableBoundedString(value.grantRoot, AGENT_RUNTIME_TEXT_LIMIT) &&
    (value.permissions === null || isRuntimeApprovalPermissions(value.permissions))
  );
}

function isRuntimeApprovalPermissions(value: unknown): value is AgentApprovalPermissions {
  return (
    isDynamicRecord(value) &&
    isDynamicRecord(value.fileSystem) &&
    isRuntimePathList(value.fileSystem.read) &&
    isRuntimePathList(value.fileSystem.write) &&
    isBoolean(value.network)
  );
}

function isRuntimePathList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= AGENT_RUNTIME_PERMISSION_PATHS_LIMIT &&
    value.every((path) => isBoundedString(path, AGENT_RUNTIME_TEXT_LIMIT))
  );
}

function isAgentApproval(value: unknown): value is AgentApproval {
  if (!isDynamicRecord(value)) return false;
  return (
    isRequestId(value.requestId) &&
    isIdentifier(value.botId) &&
    isIdentifier(value.threadId) &&
    isIdentifier(value.turnId) &&
    isOneOf(["command", "file-change", "permissions"] as const, value.kind) &&
    isNullableBoundedString(value.command, INPUT_LIMITS.messageText) &&
    isNullableBoundedString(value.cwd, INPUT_LIMITS.path) &&
    isNullableBoundedString(value.reason, INPUT_LIMITS.messageText) &&
    isNullableBoundedString(value.grantRoot, INPUT_LIMITS.path) &&
    (value.permissions === null || isAgentApprovalPermissions(value.permissions))
  );
}

function isAgentApprovalPermissions(value: unknown): value is AgentApprovalPermissions {
  return (
    isDynamicRecord(value) &&
    isDynamicRecord(value.fileSystem) &&
    isPathList(value.fileSystem.read) &&
    isPathList(value.fileSystem.write) &&
    isBoolean(value.network)
  );
}

function isBrowserTakeoverRequest(value: unknown): value is BrowserTakeoverRequest {
  return (
    isDynamicRecord(value) &&
    isRequestId(value.requestId) &&
    isIdentifier(value.botId) &&
    isIdentifier(value.threadId) &&
    isIdentifier(value.turnId) &&
    isIdentifier(value.tabId)
  );
}

function isPathList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= INPUT_LIMITS.agents &&
    value.every((path) => isBoundedString(path, INPUT_LIMITS.path))
  );
}

function isRequestId(value: unknown): value is string | number {
  return isNumber(value) || isIdentifier(value);
}

function isIdentifier(value: unknown): value is string {
  return isBoundedString(value, INPUT_LIMITS.identifier) && value.length > 0;
}

function isNullableBoundedString(value: unknown, maximum: number): value is string | null {
  return value === null || isBoundedString(value, maximum);
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return isString(value) && value.length <= maximum;
}

function isAgentTurnOrigin(value: unknown): value is AgentTurnOrigin {
  return value === "user" || value === "routine" || value === "bot" || value === "unknown";
}

export function isSidebarLayoutSnapshot(value: unknown): value is SidebarLayoutSnapshot {
  if (!isDynamicRecord(value) || !isNumber(value.revision) || !Number.isInteger(value.revision) || value.revision < 0) {
    return false;
  }
  if (
    !Array.isArray(value.sections) ||
    !Array.isArray(value.order) ||
    !isDynamicRecord(value.agentAssignments) ||
    !Array.isArray(value.agentOrder)
  ) {
    return false;
  }
  return (
    value.sections.every((section) => isDynamicRecord(section) && isString(section.id) && isString(section.name)) &&
    value.order.every(isString) &&
    Object.values(value.agentAssignments).every(isString) &&
    value.agentOrder.every(isString) &&
    new Set(value.agentOrder).size === value.agentOrder.length
  );
}

export interface ScopedAgentEvent {
  serverId: string;
  event: AgentEvent;
}

export interface AgentIpcRequest<T = unknown> {
  serverId: string;
  payload: T;
}
