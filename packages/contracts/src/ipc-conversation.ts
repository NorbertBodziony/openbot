import emojiRegex from "emoji-regex";

import { INPUT_LIMITS } from "./input-limits";
import type { BrowserControlState, BrowserTab } from "./ipc-browser";
import { isBoolean, isDynamicRecord, isNumber, isOneOf, isString } from "./runtime-values";

export const AGENT_PHASES = ["idle", "starting", "ready", "restarting", "blocked", "stopped"] as const;
export type AgentPhase = (typeof AGENT_PHASES)[number];

export const CAPABILITY_STATES = ["ready", "setup-required", "unavailable"] as const;
export type CapabilityState = (typeof CAPABILITY_STATES)[number];

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
  /**
   * One of `AgentProviderId`, but treated as an open string at the trust boundary for the same
   * reason as `state`. Consumers look this up in a map or compare it, so one they do not know
   * misses rather than throws.
   */
  id: AgentProviderId;
  /**
   * One of `AgentProviderState`, but treated as an open string at the trust boundary: a remote
   * server one release ahead may send a member we do not know yet.
   */
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

// `isNumber` alone certifies NaN and the infinities, which reach AccountDock as "NaN% remaining".
// The released Team v1 validator already rejects them for this very payload, so accepting them here
// would be the shared guard drifting from the wire one it is supposed to agree with.
function isFiniteNumber(value: unknown): value is number {
  return isNumber(value) && Number.isFinite(value);
}

function isAccountUsageWindow(value: unknown): value is AccountUsageWindow {
  return (
    isDynamicRecord(value) &&
    isFiniteNumber(value.usedPercent) &&
    (value.windowDurationMins === null ||
      (isFiniteNumber(value.windowDurationMins) &&
        Number.isInteger(value.windowDurationMins) &&
        value.windowDurationMins >= 0)) &&
    (value.resetsAt === null || isFiniteNumber(value.resetsAt))
  );
}

export function isAccountUsage(value: unknown): value is AccountUsage {
  return (
    isDynamicRecord(value) &&
    Array.isArray(value.limits) &&
    value.limits.every(
      (limit) =>
        isDynamicRecord(limit) &&
        isBoundedString(limit.id, INPUT_LIMITS.identifier) &&
        (limit.primary === null || isAccountUsageWindow(limit.primary)) &&
        (limit.secondary === null || isAccountUsageWindow(limit.secondary)),
    )
  );
}

export interface AgentStatus {
  phase: AgentPhase;
  cliVersion: string | null;
  /**
   * `kind` is one of the members above, but treated as an open string at the trust boundary: a
   * remote server one release ahead may send a member we do not know yet, and rejecting the whole
   * status would stop every update from it.
   */
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

// `phase` and `capabilities` are narrowed because the main process has always narrowed them, so no
// shipped server depends on the looser reading. `providers` is deliberately unchecked: a `value is T`
// predicate is all-or-nothing, so validating an entry would let one unrecognized `state` or
// `connectionState` from a newer server reject `phase`, `auth` and `message` along with it. Nothing
// branches on a provider field — the renderer looks one up by `id` and falls back when it misses.
// Deleting this outright went too far. Its problem was two closed unions — `isAgentProvider(id)` and
// `connectionState === "connecting"` — either of which rejected a whole status over one member a
// newer peer is entitled to send. The rest was already open, and dropping it too left the guard
// certifying `AgentProviderStatus[]` for anything array-shaped, `[null]` included, which
// `providers.tsx` dereferences per entry. Shape is checked; every value stays an open string.
function isAgentProviderStatus(value: unknown): value is AgentProviderStatus {
  return (
    isDynamicRecord(value) &&
    isBoundedString(value.id, INPUT_LIMITS.identifier) &&
    isBoundedString(value.state, INPUT_LIMITS.identifier) &&
    isNullableBoundedString(value.version, 160) &&
    isNullableBoundedString(value.message, INPUT_LIMITS.messageText) &&
    (value.email === undefined || isNullableBoundedString(value.email, INPUT_LIMITS.email)) &&
    (value.connectionState === undefined || isBoundedString(value.connectionState, INPUT_LIMITS.identifier)) &&
    (value.checkError === undefined || isNullableBoundedString(value.checkError, INPUT_LIMITS.messageText))
  );
}

export function isAgentStatus(value: unknown): value is AgentStatus {
  if (!isDynamicRecord(value) || !isDynamicRecord(value.auth) || !isDynamicRecord(value.capabilities)) {
    return false;
  }
  return (
    isOneOf(AGENT_PHASES, value.phase) &&
    isNullableBoundedString(value.cliVersion, 160) &&
    isBoundedString(value.auth.kind, INPUT_LIMITS.identifier) &&
    isOneOf(CAPABILITY_STATES, value.capabilities.chat) &&
    isOneOf(CAPABILITY_STATES, value.capabilities.browser) &&
    isOneOf(CAPABILITY_STATES, value.capabilities.computerUse) &&
    (value.providers === undefined ||
      (Array.isArray(value.providers) && value.providers.every(isAgentProviderStatus))) &&
    isNullableBoundedString(value.message, INPUT_LIMITS.messageText) &&
    value.fullAccess === true
  );
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

export function isAgentModelOption(value: unknown): value is AgentModelOption {
  return (
    isDynamicRecord(value) &&
    isAgentProvider(value.provider) &&
    isAgentModel(value.id) &&
    isBoundedString(value.name, INPUT_LIMITS.modelName) &&
    isBoundedString(value.description, INPUT_LIMITS.agentDescription) &&
    isReasoningEffort(value.defaultReasoningEffort) &&
    Array.isArray(value.supportedReasoningEfforts) &&
    value.supportedReasoningEfforts.every(isReasoningEffort)
  );
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

export interface DuplicateBotResult {
  bot: BotSummary;
  layout: SidebarLayoutSnapshot;
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
  | { type: "started"; requestId: string; serverId: string }
  | { type: "completed"; requestId: string; serverId: string; attachments: DraftAttachment[] }
  | { type: "error"; requestId: string; serverId: string; message: string };

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

export const QUEUE_DELIVERY_STATUSES = [
  "queued",
  "starting",
  "running",
  "completed",
  "failed",
  "interrupted",
  "cancelled",
] as const;
export type QueueDeliveryStatus = (typeof QUEUE_DELIVERY_STATUSES)[number];

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

export const ROUTINE_EVENT_ITEM_TYPE_PREFIX = "routine-event:";

export type RoutineConversationEventAction = "created" | "updated" | "deleted";

export interface RoutineConversationEvent {
  action: RoutineConversationEventAction;
  routineId: string;
  routineName: string;
}

export const ROUTINE_RUN_EVENT_ITEM_TYPE_PREFIX = "routine-run-event:";

export type RoutineRunConversationEventStatus = Exclude<RoutineRunStatus, "queued">;

export interface RoutineRunConversationEvent {
  status: RoutineRunConversationEventStatus;
  routineId: string;
  runId: string;
  routineName: string;
}

export const HOSTED_SITE_EVENT_ITEM_TYPE_PREFIX = "hosted-site-event:";

export type HostedSiteConversationEventAction = "publish" | "replace" | "delete";

export type HostedSiteConversationEventStatus = "running" | "succeeded" | "failed" | "interrupted" | "cancelled";

export interface HostedSiteConversationEventDetails {
  siteId: string | null;
  title: string;
  hostname: string | null;
  url: string | null;
}

export interface HostedSiteConversationEvent extends HostedSiteConversationEventDetails {
  action: HostedSiteConversationEventAction;
  status: HostedSiteConversationEventStatus;
  operationId: string;
}

export function routineConversationEventItemType(action: RoutineConversationEventAction, routineId: string): string {
  if (!isIdentifier(routineId)) throw new Error("A valid routine id is required.");
  const itemType = `${ROUTINE_EVENT_ITEM_TYPE_PREFIX}${action}:${routineId}`;
  if (itemType.length > INPUT_LIMITS.identifier) throw new Error("The routine event item type is too long.");
  return itemType;
}

export function parseRoutineConversationEventItemType(
  itemType: string | undefined,
): Pick<RoutineConversationEvent, "action" | "routineId"> | null {
  if (!itemType?.startsWith(ROUTINE_EVENT_ITEM_TYPE_PREFIX)) return null;
  const separator = itemType.indexOf(":", ROUTINE_EVENT_ITEM_TYPE_PREFIX.length);
  if (separator < 0) return null;
  const action = itemType.slice(ROUTINE_EVENT_ITEM_TYPE_PREFIX.length, separator);
  const routineId = itemType.slice(separator + 1);
  if ((action !== "created" && action !== "updated" && action !== "deleted") || !isIdentifier(routineId)) {
    return null;
  }
  return { action, routineId };
}

export function routineConversationEvent(message: ConversationMessage): RoutineConversationEvent | null {
  if (message.author !== "system" || message.source !== "system" || message.status !== "completed") return null;
  const event = parseRoutineConversationEventItemType(message.itemType);
  const routineName = message.text.trim();
  if (!event || !routineName || routineName.length > INPUT_LIMITS.routineName) return null;
  return { ...event, routineName };
}

export function routineRunConversationEventItemType(
  status: RoutineRunConversationEventStatus,
  routineId: string,
  runId: string,
): string {
  if (!isIdentifier(routineId)) throw new Error("A valid routine id is required.");
  if (!isIdentifier(runId)) throw new Error("A valid routine run id is required.");
  const itemType = `${ROUTINE_RUN_EVENT_ITEM_TYPE_PREFIX}${status}:${routineId}:${runId}`;
  if (itemType.length > INPUT_LIMITS.identifier) throw new Error("The routine run event item type is too long.");
  return itemType;
}

export function parseRoutineRunConversationEventItemType(
  itemType: string | undefined,
): Pick<RoutineRunConversationEvent, "status" | "routineId" | "runId"> | null {
  if (!itemType?.startsWith(ROUTINE_RUN_EVENT_ITEM_TYPE_PREFIX)) return null;
  const [status, routineId, runId, ...extra] = itemType.slice(ROUTINE_RUN_EVENT_ITEM_TYPE_PREFIX.length).split(":");
  if (
    extra.length > 0 ||
    !isRoutineRunConversationEventStatus(status) ||
    !isIdentifier(routineId) ||
    !isIdentifier(runId)
  ) {
    return null;
  }
  return { status, routineId, runId };
}

export function routineRunConversationEvent(message: ConversationMessage): RoutineRunConversationEvent | null {
  if (message.author !== "system" || message.source !== "system" || message.status !== "completed") return null;
  const event = parseRoutineRunConversationEventItemType(message.itemType);
  const routineName = message.text.trim();
  if (!event || !routineName || routineName.length > INPUT_LIMITS.routineName) return null;
  return { ...event, routineName };
}

export function isRoutineRunConversationEventMarker(itemType: string | undefined): boolean {
  return itemType?.startsWith(ROUTINE_RUN_EVENT_ITEM_TYPE_PREFIX) === true;
}

export function hostedSiteConversationEventItemType(
  action: HostedSiteConversationEventAction,
  status: HostedSiteConversationEventStatus,
  operationId: string,
): string {
  if (!isIdentifier(operationId)) throw new Error("A valid hosted site operation id is required.");
  const itemType = `${HOSTED_SITE_EVENT_ITEM_TYPE_PREFIX}${action}:${status}:${operationId}`;
  if (itemType.length > INPUT_LIMITS.identifier) throw new Error("The hosted site event item type is too long.");
  return itemType;
}

export function hostedSiteConversationEventText(details: HostedSiteConversationEventDetails): string {
  if (!isHostedSiteConversationEventDetails(details)) throw new Error("Valid hosted site event details are required.");
  return JSON.stringify(details);
}

export function parseHostedSiteConversationEventItemType(
  itemType: string | undefined,
): Pick<HostedSiteConversationEvent, "action" | "status" | "operationId"> | null {
  if (!itemType?.startsWith(HOSTED_SITE_EVENT_ITEM_TYPE_PREFIX)) return null;
  const [action, status, operationId, ...extra] = itemType.slice(HOSTED_SITE_EVENT_ITEM_TYPE_PREFIX.length).split(":");
  if (
    extra.length > 0 ||
    !isHostedSiteConversationEventAction(action) ||
    !isHostedSiteConversationEventStatus(status) ||
    !isIdentifier(operationId)
  ) {
    return null;
  }
  return { action, status, operationId };
}

export function hostedSiteConversationEvent(message: ConversationMessage): HostedSiteConversationEvent | null {
  if (message.author !== "system" || message.source !== "system" || message.status !== "completed") return null;
  const event = parseHostedSiteConversationEventItemType(message.itemType);
  if (!event) return null;
  let details: unknown;
  try {
    details = JSON.parse(message.text);
  } catch {
    return null;
  }
  if (!isHostedSiteConversationEventDetails(details) || !hostedSiteDetailsMatchEvent(event, details)) return null;
  return { ...event, ...details };
}

export function isHostedSiteConversationEventMarker(itemType: string | undefined): boolean {
  return itemType?.startsWith(HOSTED_SITE_EVENT_ITEM_TYPE_PREFIX) === true;
}

function isRoutineRunConversationEventStatus(value: unknown): value is RoutineRunConversationEventStatus {
  return (
    value === "running" ||
    value === "needs-attention" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "interrupted" ||
    value === "cancelled"
  );
}

function isHostedSiteConversationEventAction(value: unknown): value is HostedSiteConversationEventAction {
  return value === "publish" || value === "replace" || value === "delete";
}

function isHostedSiteConversationEventStatus(value: unknown): value is HostedSiteConversationEventStatus {
  return (
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "interrupted" ||
    value === "cancelled"
  );
}

function isHostedSiteConversationEventDetails(value: unknown): value is HostedSiteConversationEventDetails {
  if (
    !isDynamicRecord(value) ||
    (value.siteId !== null && !isIdentifier(value.siteId)) ||
    !isBoundedString(value.title, 120) ||
    value.title.trim().length === 0 ||
    (value.hostname !== null && (!isString(value.hostname) || !isHostedSiteHostname(value.hostname))) ||
    (value.url !== null && !isHostedSiteConversationEventUrl(value.url, value.hostname))
  ) {
    return false;
  }
  return value.hostname !== null || value.url === null;
}

function hostedSiteDetailsMatchEvent(
  event: Pick<HostedSiteConversationEvent, "action" | "status">,
  details: HostedSiteConversationEventDetails,
): boolean {
  if (event.action === "publish" && event.status !== "succeeded") {
    return details.siteId === null && details.hostname === null && details.url === null;
  }
  return details.siteId !== null;
}

function isHostedSiteHostname(value: string): boolean {
  if (value.length === 0 || value.length > INPUT_LIMITS.hostname || value !== value.toLowerCase()) return false;
  try {
    const parsed = new URL(`https://${value}`);
    return (
      parsed.hostname === value &&
      parsed.port === "" &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      value.endsWith(".openbot.site")
    );
  } catch {
    return false;
  }
}

export function isHostedSiteConversationEventUrl(value: unknown, hostname: unknown): value is string {
  if (!isBoundedString(value, INPUT_LIMITS.browserUrl) || !isString(hostname) || !isHostedSiteHostname(hostname)) {
    return false;
  }
  try {
    const parsed = new URL(value);
    if (
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      return false;
    }
    if (parsed.protocol === "https:") return parsed.hostname === hostname && parsed.port === "";
    if (parsed.protocol !== "http:" || !parsed.port) return false;
    const port = Number(parsed.port);
    const label = hostname.slice(0, -".openbot.site".length);
    return (
      Number.isInteger(port) && port >= 1_024 && port <= 65_535 && parsed.hostname === `${label}.openbot.localhost`
    );
  } catch {
    return false;
  }
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
    isOneOf(QUEUE_DELIVERY_STATUSES, value.status) &&
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
        isOneOf(QUEUE_DELIVERY_STATUSES, delivery.status) &&
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

const RGI_EMOJI_PATTERN = emojiRegex();

export function isMessageReaction(value: unknown): value is MessageReaction {
  if (!isString(value)) return false;
  const matches = value.match(RGI_EMOJI_PATTERN);
  return matches?.length === 1 && matches[0] === value;
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

export function isConversationReadState(value: unknown): value is ConversationReadState {
  return (
    isDynamicRecord(value) &&
    isNumber(value.unreadCount) &&
    Number.isInteger(value.unreadCount) &&
    value.unreadCount >= 0 &&
    (value.firstUnreadMessageId === null || isIdentifier(value.firstUnreadMessageId)) &&
    (value.throughMessageId === null || isIdentifier(value.throughMessageId))
  );
}

export interface ConversationWithReadState extends ConversationSnapshot {
  readState?: ConversationReadState;
}

export function isConversationWithReadState(value: unknown): value is ConversationWithReadState {
  return (
    isDynamicRecord(value) &&
    isConversationSnapshot(value) &&
    (value.readState === undefined || isConversationReadState(value.readState))
  );
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

export function isQueuedMessageReceipt(value: unknown): value is QueuedMessageReceipt {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.messageId) &&
    Array.isArray(value.deliveries) &&
    value.deliveries.every(
      (delivery) =>
        isDynamicRecord(delivery) &&
        isIdentifier(delivery.id) &&
        isIdentifier(delivery.recipientBotId) &&
        isOneOf(QUEUE_DELIVERY_STATUSES, delivery.status) &&
        (delivery.position === null ||
          (isNumber(delivery.position) && Number.isInteger(delivery.position) && delivery.position >= 1)),
    )
  );
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
  attentionComplete: boolean;
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

export interface AgentRuntimeApproval extends AgentApproval {
  truncated: boolean;
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
  | { type: "conversation-invalidated"; botId: string; revision: number }
  | { type: "conversation-page"; page: ConversationPage }
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
  | { type: "queue-invalidated"; botId: string }
  | { type: "queue-changed"; snapshot: QueueSnapshot }
  | { type: "turn-progress"; botId: string; threadId: string; turnId: string; detail: string }
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
    case "conversation-invalidated":
      return (
        isIdentifier(value.botId) && isNumber(value.revision) && Number.isInteger(value.revision) && value.revision >= 0
      );
    case "conversation-page": {
      const page = value.page;
      if (!isDynamicRecord(page)) return false;
      const references = page.references;
      const pageInfo = page.pageInfo;
      const readState = page.readState;
      return (
        isConversationSnapshot(page) &&
        page.messages.length <= 100 &&
        isDynamicRecord(references) &&
        Object.values(references).every(isConversationMessage) &&
        isDynamicRecord(pageInfo) &&
        isBoolean(pageInfo.hasOlder) &&
        (pageInfo.olderCursor === null || isString(pageInfo.olderCursor)) &&
        (readState === undefined || isConversationReadState(readState))
      );
    }
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
    case "queue-invalidated":
      return isIdentifier(value.botId);
    case "queue-changed":
      return isQueueSnapshot(value.snapshot);
    case "turn-progress":
      return (
        isIdentifier(value.botId) &&
        isIdentifier(value.threadId) &&
        isIdentifier(value.turnId) &&
        isString(value.detail) &&
        value.detail.length > 0 &&
        value.detail.length <= INPUT_LIMITS.promptQuestion
      );
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
    isBoolean(value.attentionComplete) &&
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

export function isBotSummary(value: unknown): value is BotSummary {
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

export function isQueueSnapshot(value: unknown): value is QueueSnapshot {
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
    isOneOf(QUEUE_DELIVERY_STATUSES, value.status) &&
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

export function isAttachmentSummary(value: unknown): value is AttachmentSummary {
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
    isBoolean(value.truncated) &&
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
  bufferedLive?: boolean;
}

export interface AgentIpcRequest<T = unknown> {
  serverId: string;
  payload: T;
}
