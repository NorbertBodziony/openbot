import { type DynamicRecord, isBoolean, isDynamicRecord, isNumber, isString } from "../runtime-values";

export const TEAM_PROTOCOL_V1 = 1;
export const TEAM_PROTOCOL_VERSION_HEADER = "OpenBot-Protocol-Version";
export const TEAM_APP_VERSION_HEADER = "OpenBot-App-Version";
export const TEAM_PROTOCOL_V1_WEBSOCKET = "openbot-team-v1";

export const TEAM_PROTOCOL_V1_CAPABILITIES = [
  "agent-runtime-snapshots",
  "browser-control",
  "conversation-pagination",
  "direct-messages",
  "remote-desktop",
  "sidebar-layout",
] as const;

export type TeamProtocolV1Capability = (typeof TEAM_PROTOCOL_V1_CAPABILITIES)[number];

const TEAM_PROTOCOL_V1_CAPABILITY_SET = new Set<string>(TEAM_PROTOCOL_V1_CAPABILITIES);

export type TeamProtocolV1EventDecodeResult =
  | { kind: "known"; event: TeamProtocolV1Event }
  | { kind: "unknown"; type: string }
  | { kind: "invalid"; type: string | null };

export type TeamProtocolV1JsonValue =
  | null
  | boolean
  | number
  | string
  | TeamProtocolV1JsonValue[]
  | TeamProtocolV1JsonObject;

export interface TeamProtocolV1JsonObject {
  [key: string]: TeamProtocolV1JsonValue;
}

interface TeamProtocolV1PresenceMember {
  id: string;
  username: string;
  email: string | null;
  name: string | null;
  avatarUrl?: string | null;
  role: "owner" | "admin" | "member";
  createdAt: string;
  disabled: boolean;
  online: boolean;
  typingBotId: string | null;
}

interface TeamProtocolV1PresenceSnapshot {
  serverId: string | null;
  members: TeamProtocolV1PresenceMember[];
  updatedAt: string;
}

interface TeamProtocolV1DirectMessage {
  id: string;
  threadId: string;
  senderMemberId: string;
  recipientMemberId: string;
  text: string;
  createdAt: string;
  sequence: number;
}

export type TeamProtocolV1Event =
  | { type: "status"; status: TeamProtocolV1JsonObject }
  | { type: "usage-changed"; usage: TeamProtocolV1JsonObject }
  | { type: "bots-changed"; bots: TeamProtocolV1JsonObject[] }
  | { type: "memories-changed"; botId: string }
  | { type: "routines-changed"; botId: string }
  | { type: "sidebar-layout-changed"; layout: TeamProtocolV1JsonObject }
  | { type: "conversation"; snapshot: TeamProtocolV1JsonObject }
  | { type: "conversation-invalidated"; botId: string; revision: number }
  | { type: "conversation-page"; page: TeamProtocolV1JsonObject }
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
  | { type: "queue-changed"; snapshot: TeamProtocolV1JsonObject }
  | { type: "turn-started"; botId: string; threadId: string; turnId: string; origin?: string }
  | { type: "turn-completed"; botId: string; threadId: string; turnId: string; status: string; origin?: string }
  | {
      type: "prompt";
      requestId: string | number;
      botId: string;
      threadId: string;
      turnId: string;
      questions: TeamProtocolV1JsonObject[];
    }
  | { type: "agent-input-resolved"; kind: "prompt" | "approval"; requestId: string | number; botId: string }
  | { type: "browser-takeover-requested"; request: TeamProtocolV1JsonObject }
  | { type: "browser-takeover-resolved"; requestId: string | number; botId: string }
  | { type: "approval"; approval: TeamProtocolV1JsonObject }
  | { type: "runtime-snapshot"; snapshot: TeamProtocolV1JsonObject }
  | { type: "browser-changed"; tabs: TeamProtocolV1JsonObject[]; activeTabId: string | null }
  | { type: "browser-control-changed"; state: TeamProtocolV1JsonObject }
  | { type: "error"; botId?: string; code: string; message: string }
  | { type: "team-identity"; serverId: string; serverName: string; logoVersion: string | null }
  | { type: "team-presence"; snapshot: TeamProtocolV1PresenceSnapshot }
  | { type: "team-direct-message"; message: TeamProtocolV1DirectMessage; memberIds: [string, string] }
  | { type: "team-direct-typing"; senderMemberId: string; recipientMemberId: string; typing: boolean };

export type TeamProtocolV1ClientEvent =
  | { type: "runtime-snapshot-request" }
  | { type: "agent-event-scope"; includeConversations: boolean; capabilities?: readonly string[] }
  | { type: "team-typing"; botId: string | null; typing: boolean }
  | { type: "team-direct-typing"; recipientMemberId: string; typing: boolean };

const AGENT_EVENT_TYPES = [
  "status",
  "usage-changed",
  "bots-changed",
  "memories-changed",
  "routines-changed",
  "sidebar-layout-changed",
  "conversation",
  "conversation-invalidated",
  "conversation-page",
  "conversation-delta",
  "queue-invalidated",
  "queue-changed",
  "turn-started",
  "turn-completed",
  "prompt",
  "agent-input-resolved",
  "browser-takeover-requested",
  "browser-takeover-resolved",
  "approval",
  "runtime-snapshot",
  "browser-changed",
  "browser-control-changed",
  "error",
] as const;

const TEAM_EVENT_TYPES = ["team-identity", "team-presence", "team-direct-message", "team-direct-typing"] as const;
const TEAM_PROTOCOL_V1_EVENT_TYPES = [...AGENT_EVENT_TYPES, ...TEAM_EVENT_TYPES] as const;
const TEAM_PROTOCOL_V1_EVENT_TYPE_SET = new Set<string>(TEAM_PROTOCOL_V1_EVENT_TYPES);

export function decodeTeamProtocolV1Event(value: unknown): TeamProtocolV1EventDecodeResult {
  if (!isDynamicRecord(value) || !isString(value.type)) return { kind: "invalid", type: null };
  if (!TEAM_PROTOCOL_V1_EVENT_TYPE_SET.has(value.type)) {
    return { kind: "unknown", type: value.type };
  }
  if (isTeamProtocolV1KnownEvent(value)) return { kind: "known", event: value };
  return { kind: "invalid", type: value.type };
}

export function encodeTeamProtocolV1Event(event: TeamProtocolV1Event): string | null {
  const decoded = decodeTeamProtocolV1Event(event);
  return decoded.kind === "known" ? JSON.stringify(decoded.event) : null;
}

// This is the frozen v1 wire validator. Do not replace its nested checks with current IPC validators.
function isTeamProtocolV1KnownEvent(value: DynamicRecord): value is TeamProtocolV1Event {
  switch (value.type) {
    case "status":
      return isTeamProtocolV1JsonObject(value.status);
    case "usage-changed":
      return isTeamProtocolV1JsonObject(value.usage);
    case "bots-changed":
      return Array.isArray(value.bots) && value.bots.length <= 100 && value.bots.every(isV1BotSummary);
    case "memories-changed":
    case "routines-changed":
    case "queue-invalidated":
      return isString(value.botId);
    case "sidebar-layout-changed":
      return isV1SidebarLayout(value.layout);
    case "conversation":
      return isV1ConversationSnapshot(value.snapshot);
    case "queue-changed":
      return isV1QueueSnapshot(value.snapshot);
    case "conversation-invalidated":
      return isString(value.botId) && isNumber(value.revision);
    case "conversation-page":
      return isV1ConversationPage(value.page);
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
    case "turn-started":
      return (
        isString(value.botId) &&
        isString(value.threadId) &&
        isString(value.turnId) &&
        (value.origin === undefined || isV1OneOf(["user", "routine", "bot", "unknown"], value.origin))
      );
    case "turn-completed":
      return (
        isString(value.botId) &&
        isString(value.threadId) &&
        isString(value.turnId) &&
        isString(value.status) &&
        (value.origin === undefined || isV1OneOf(["user", "routine", "bot", "unknown"], value.origin))
      );
    case "prompt":
      return (
        (isString(value.requestId) || isNumber(value.requestId)) &&
        isString(value.botId) &&
        isString(value.threadId) &&
        isString(value.turnId) &&
        Array.isArray(value.questions) &&
        value.questions.length <= 32 &&
        value.questions.every(isV1PromptQuestion)
      );
    case "agent-input-resolved":
      return (
        (value.kind === "prompt" || value.kind === "approval") &&
        (isString(value.requestId) || isNumber(value.requestId)) &&
        isString(value.botId)
      );
    case "browser-takeover-requested":
      return isV1BrowserTakeover(value.request);
    case "browser-takeover-resolved":
      return (isString(value.requestId) || isNumber(value.requestId)) && isString(value.botId);
    case "approval":
      return isV1Approval(value.approval, false);
    case "runtime-snapshot":
      return isV1RuntimeSnapshot(value.snapshot);
    case "browser-changed":
      return (
        Array.isArray(value.tabs) &&
        value.tabs.every(isTeamProtocolV1JsonObject) &&
        (value.activeTabId === null || isString(value.activeTabId))
      );
    case "browser-control-changed":
      return isTeamProtocolV1JsonObject(value.state);
    case "error":
      return isString(value.code) && isString(value.message);
    case "team-identity":
      return (
        isString(value.serverId) &&
        isString(value.serverName) &&
        (value.logoVersion === null || isString(value.logoVersion))
      );
    case "team-presence":
      return isTeamProtocolV1PresenceSnapshot(value.snapshot);
    case "team-direct-message":
      return (
        isTeamProtocolV1DirectMessage(value.message) &&
        Array.isArray(value.memberIds) &&
        value.memberIds.length === 2 &&
        value.memberIds[0] === value.message.senderMemberId &&
        value.memberIds[1] === value.message.recipientMemberId
      );
    case "team-direct-typing":
      return isString(value.senderMemberId) && isString(value.recipientMemberId) && isBoolean(value.typing);
    default:
      return false;
  }
}

function isTeamProtocolV1JsonValue(value: unknown): value is TeamProtocolV1JsonValue {
  return (
    value === null ||
    isString(value) ||
    isBoolean(value) ||
    (isNumber(value) && Number.isFinite(value)) ||
    (Array.isArray(value) && value.every(isTeamProtocolV1JsonValue)) ||
    isTeamProtocolV1JsonObject(value)
  );
}

function isTeamProtocolV1JsonObject(value: unknown): value is TeamProtocolV1JsonObject {
  return isDynamicRecord(value) && Object.values(value).every(isTeamProtocolV1JsonValue);
}

function isV1BotSummary(value: unknown): value is TeamProtocolV1JsonObject {
  return (
    isTeamProtocolV1JsonObject(value) &&
    isV1Identifier(value.id) &&
    isV1BoundedString(value.name, 80) &&
    isV1BoundedString(value.title, 120) &&
    isV1BoundedString(value.description, 2_000) &&
    isBoolean(value.notifications) &&
    (value.provider === "codex" || value.provider === "claude" || value.provider === "grok") &&
    isString(value.model) &&
    /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/u.test(value.model) &&
    isV1OneOf(["low", "medium", "high", "xhigh", "max"], value.reasoningEffort) &&
    (value.threadId === null || isV1Identifier(value.threadId)) &&
    isV1BoundedString(value.workspacePath, 4_096) &&
    isV1BoundedString(value.preview, 100_000) &&
    (value.updatedAt === null || isV1BoundedString(value.updatedAt, 160)) &&
    isString(value.avatarSeed) &&
    /^[a-z0-9:-]{1,128}$/u.test(value.avatarSeed) &&
    (value.avatarHue === null || isV1OneOf([0, 30, 55, 100, 150, 185, 215, 245, 280, 320], value.avatarHue)) &&
    (value.avatarUrl === null || isV1BoundedString(value.avatarUrl, 2_048)) &&
    (value.marketplaceSource === undefined || isV1MarketplaceSource(value.marketplaceSource))
  );
}

function isV1MarketplaceSource(value: unknown): boolean {
  return (
    isDynamicRecord(value) &&
    isV1Identifier(value.agentId) &&
    isV1Identifier(value.versionId) &&
    isNumber(value.version) &&
    Number.isInteger(value.version) &&
    isV1IdentifierList(value.skillIds, 100) &&
    isV1IdentifierList(value.routineIds, 64)
  );
}

function isV1SidebarLayout(value: unknown): value is TeamProtocolV1JsonObject {
  if (
    !isTeamProtocolV1JsonObject(value) ||
    !isNumber(value.revision) ||
    !Number.isInteger(value.revision) ||
    value.revision < 0 ||
    !Array.isArray(value.sections) ||
    !Array.isArray(value.order) ||
    !isDynamicRecord(value.agentAssignments) ||
    !Array.isArray(value.agentOrder)
  ) {
    return false;
  }
  return (
    value.sections.length <= 100 &&
    value.sections.every(
      (section) =>
        isDynamicRecord(section) &&
        isV1Identifier(section.id) &&
        isV1BoundedString(section.name, 40) &&
        section.name.length > 0,
    ) &&
    value.order.every(isV1Identifier) &&
    Object.values(value.agentAssignments).every(isV1Identifier) &&
    value.agentOrder.every(isV1Identifier) &&
    new Set(value.agentOrder).size === value.agentOrder.length
  );
}

function isV1ConversationSnapshot(value: unknown): value is TeamProtocolV1JsonObject {
  return (
    isTeamProtocolV1JsonObject(value) &&
    isV1Identifier(value.botId) &&
    (value.threadId === null || isV1Identifier(value.threadId)) &&
    (value.activeTurnId === null || isV1Identifier(value.activeTurnId)) &&
    isV1Revision(value.revision) &&
    Array.isArray(value.messages) &&
    value.messages.every(isV1ConversationMessage)
  );
}

function isV1ConversationPage(value: unknown): value is TeamProtocolV1JsonObject {
  if (!isV1ConversationSnapshot(value) || !Array.isArray(value.messages) || value.messages.length > 100) return false;
  return (
    isDynamicRecord(value.references) &&
    Object.values(value.references).every(isV1ConversationMessage) &&
    isDynamicRecord(value.pageInfo) &&
    isBoolean(value.pageInfo.hasOlder) &&
    (value.pageInfo.olderCursor === null || isString(value.pageInfo.olderCursor)) &&
    (value.readState === undefined || isV1ConversationReadState(value.readState))
  );
}

function isV1ConversationMessage(value: unknown): boolean {
  if (!isTeamProtocolV1JsonObject(value)) return false;
  return (
    isV1Identifier(value.id) &&
    isString(value.text) &&
    isV1BoundedString(value.createdAt, 160) &&
    isV1OneOf(["user", "assistant", "agent", "system"], value.author) &&
    isV1OneOf(["streaming", "completed", "failed", "interrupted"], value.status) &&
    (value.turnId === undefined || isV1Identifier(value.turnId)) &&
    (value.itemType === undefined || isV1BoundedString(value.itemType, 128)) &&
    (value.source === undefined || isV1OneOf(["user", "assistant", "agent", "system", "routine"], value.source)) &&
    (value.senderBotId === undefined || isV1Identifier(value.senderBotId)) &&
    (value.replyToMessageId === undefined ||
      value.replyToMessageId === null ||
      isV1Identifier(value.replyToMessageId)) &&
    (value.attachments === undefined || isV1Attachments(value.attachments)) &&
    (value.delivery === undefined || isV1ConversationDelivery(value.delivery)) &&
    (value.exchange === undefined || isTeamProtocolV1JsonObject(value.exchange)) &&
    (value.reaction === undefined || value.reaction === null || isV1BoundedString(value.reaction, 32)) &&
    (value.reactions === undefined ||
      (Array.isArray(value.reactions) &&
        value.reactions.length <= 100 &&
        value.reactions.every(isTeamProtocolV1JsonObject))) &&
    (value.routine === undefined || isTeamProtocolV1JsonObject(value.routine)) &&
    (value.imageGeneration === undefined || isV1ImageGeneration(value.imageGeneration)) &&
    (value.questionPrompt === undefined || isV1ConversationQuestionPrompt(value.questionPrompt))
  );
}

function isV1ConversationDelivery(value: unknown): boolean {
  return (
    isDynamicRecord(value) &&
    isV1Identifier(value.id) &&
    isV1QueueStatus(value.status) &&
    isV1QueuePosition(value.position)
  );
}

function isV1ImageGeneration(value: unknown): boolean {
  return (
    isDynamicRecord(value) &&
    (value.prompt === undefined || isString(value.prompt)) &&
    isString(value.resolution) &&
    isV1OneOf(["square", "portrait", "landscape"], value.aspectRatio) &&
    (value.error === undefined || isString(value.error))
  );
}

function isV1ConversationQuestionPrompt(value: unknown): boolean {
  return (
    isDynamicRecord(value) &&
    isV1RequestId(value.requestId) &&
    Array.isArray(value.questions) &&
    value.questions.length <= 32 &&
    value.questions.every(isV1PromptQuestion) &&
    (value.resolution === null || isTeamProtocolV1JsonObject(value.resolution))
  );
}

function isV1ConversationReadState(value: unknown): boolean {
  return (
    isDynamicRecord(value) &&
    isNumber(value.unreadCount) &&
    Number.isInteger(value.unreadCount) &&
    value.unreadCount >= 0 &&
    (value.firstUnreadMessageId === null || isV1Identifier(value.firstUnreadMessageId)) &&
    (value.throughMessageId === null || isV1Identifier(value.throughMessageId))
  );
}

function isV1QueueSnapshot(value: unknown): value is TeamProtocolV1JsonObject {
  return (
    isTeamProtocolV1JsonObject(value) &&
    isV1Identifier(value.botId) &&
    Array.isArray(value.deliveries) &&
    value.deliveries.every(isV1QueueDelivery)
  );
}

function isV1QueueDelivery(value: unknown): boolean {
  return (
    isDynamicRecord(value) &&
    isV1Identifier(value.id) &&
    isV1Identifier(value.messageId) &&
    isV1Identifier(value.recipientBotId) &&
    isV1QueueSender(value.sender) &&
    isV1BoundedString(value.text, 100_000) &&
    isV1Attachments(value.attachments) &&
    (value.replyToMessageId === null || isV1Identifier(value.replyToMessageId)) &&
    isV1QueueStatus(value.status) &&
    isV1QueuePosition(value.position) &&
    (value.turnId === null || isV1Identifier(value.turnId)) &&
    (value.error === null || isV1BoundedString(value.error, 100_000)) &&
    isV1BoundedString(value.createdAt, 160)
  );
}

function isV1QueueSender(value: unknown): boolean {
  if (!isDynamicRecord(value)) return false;
  if (value.kind === "user") return true;
  if (value.kind === "bot") return isV1Identifier(value.botId);
  return (
    value.kind === "routine" &&
    isV1Identifier(value.routineId) &&
    isV1Identifier(value.runId) &&
    isV1BoundedString(value.routineName, 80) &&
    isV1BoundedString(value.scheduledFor, 160)
  );
}

function isV1Attachments(value: unknown): boolean {
  return Array.isArray(value) && value.length <= 10 && value.every(isV1Attachment);
}

function isV1Attachment(value: unknown): boolean {
  return (
    isDynamicRecord(value) &&
    isV1Identifier(value.id) &&
    isV1BoundedString(value.name, 255) &&
    isNumber(value.size) &&
    value.size >= 0 &&
    isV1OneOf(["image", "file"], value.kind) &&
    isV1BoundedString(value.mimeType, 255) &&
    isV1OneOf(["image", "pdf", "text", "none"], value.previewKind) &&
    (value.previewUrl === null || isV1BoundedString(value.previewUrl, 2_048))
  );
}

function isV1PromptQuestion(value: unknown): value is TeamProtocolV1JsonObject {
  return (
    isTeamProtocolV1JsonObject(value) &&
    isV1BoundedString(value.id, 128) &&
    isV1BoundedString(value.header, 120) &&
    isV1BoundedString(value.question, 2_000) &&
    isBoolean(value.isSecret) &&
    (value.options === null ||
      (Array.isArray(value.options) &&
        value.options.length <= 5 &&
        value.options.every(
          (option) =>
            isDynamicRecord(option) &&
            isV1BoundedString(option.label, 120) &&
            isV1BoundedString(option.description, 2_000),
        )))
  );
}

function isV1BrowserTakeover(value: unknown): value is TeamProtocolV1JsonObject {
  return (
    isTeamProtocolV1JsonObject(value) &&
    isV1RequestId(value.requestId) &&
    isV1Identifier(value.botId) &&
    isV1Identifier(value.threadId) &&
    isV1Identifier(value.turnId) &&
    isV1Identifier(value.tabId)
  );
}

function isV1Approval(value: unknown, runtime: boolean): value is TeamProtocolV1JsonObject {
  return (
    isTeamProtocolV1JsonObject(value) &&
    isV1RequestId(value.requestId) &&
    isV1Identifier(value.botId) &&
    isV1Identifier(value.threadId) &&
    isV1Identifier(value.turnId) &&
    isV1OneOf(["command", "file-change", "permissions"], value.kind) &&
    isV1NullableString(value.command, runtime ? 240 : 100_000) &&
    isV1NullableString(value.cwd, runtime ? 240 : 4_096) &&
    isV1NullableString(value.reason, runtime ? 240 : 100_000) &&
    isV1NullableString(value.grantRoot, runtime ? 240 : 4_096) &&
    (!runtime || isBoolean(value.truncated)) &&
    (value.permissions === null || isV1ApprovalPermissions(value.permissions, runtime))
  );
}

function isV1ApprovalPermissions(value: unknown, runtime: boolean): boolean {
  const maximumItems = runtime ? 3 : 100;
  const maximumPath = runtime ? 240 : 4_096;
  return (
    isDynamicRecord(value) &&
    isDynamicRecord(value.fileSystem) &&
    isV1StringList(value.fileSystem.read, maximumItems, maximumPath) &&
    isV1StringList(value.fileSystem.write, maximumItems, maximumPath) &&
    isBoolean(value.network)
  );
}

function isV1RuntimeSnapshot(value: unknown): value is TeamProtocolV1JsonObject {
  return (
    isTeamProtocolV1JsonObject(value) &&
    Array.isArray(value.bots) &&
    value.bots.length <= 100 &&
    value.bots.every(isV1RuntimeBot) &&
    Array.isArray(value.activeTurns) &&
    value.activeTurns.length <= 100 &&
    value.activeTurns.every(isV1RuntimeTurn) &&
    Array.isArray(value.work) &&
    value.work.length <= 7 &&
    value.work.every(isV1RuntimeWork) &&
    Array.isArray(value.latestMessages) &&
    value.latestMessages.length <= 100 &&
    value.latestMessages.every(isV1RuntimeMessage) &&
    isBoolean(value.attentionComplete) &&
    Array.isArray(value.pendingPrompts) &&
    value.pendingPrompts.length <= 4 &&
    value.pendingPrompts.every(isV1RuntimePrompt) &&
    Array.isArray(value.pendingApprovals) &&
    value.pendingApprovals.length <= 4 &&
    value.pendingApprovals.every((approval) => isV1Approval(approval, true)) &&
    Array.isArray(value.pendingBrowserTakeovers) &&
    value.pendingBrowserTakeovers.length <= 4 &&
    value.pendingBrowserTakeovers.every(isV1BrowserTakeover) &&
    value.pendingPrompts.length + value.pendingApprovals.length + value.pendingBrowserTakeovers.length <= 4 &&
    Array.isArray(value.failedTurns) &&
    value.failedTurns.length <= 100 &&
    value.failedTurns.every(isV1FailedTurn)
  );
}

function isV1RuntimeBot(value: unknown): boolean {
  return (
    isDynamicRecord(value) &&
    isV1Identifier(value.id) &&
    isV1BoundedString(value.name, 80) &&
    isBoolean(value.notifications) &&
    isV1BoundedString(value.preview, 240) &&
    (value.updatedAt === null || isV1BoundedString(value.updatedAt, 160)) &&
    isString(value.avatarSeed) &&
    /^[a-z0-9:-]{1,128}$/u.test(value.avatarSeed) &&
    (value.avatarHue === null || isV1OneOf([0, 30, 55, 100, 150, 185, 215, 245, 280, 320], value.avatarHue)) &&
    (value.avatarUrl === null || isV1BoundedString(value.avatarUrl, 2_048))
  );
}

function isV1RuntimeTurn(value: unknown): boolean {
  return (
    isDynamicRecord(value) &&
    isV1Identifier(value.botId) &&
    isV1Identifier(value.threadId) &&
    isV1Identifier(value.turnId)
  );
}

function isV1FailedTurn(value: unknown): boolean {
  return isDynamicRecord(value) && isV1Identifier(value.botId) && isV1Identifier(value.turnId);
}

function isV1RuntimeWork(value: unknown): boolean {
  return (
    isDynamicRecord(value) &&
    isV1Identifier(value.id) &&
    isV1Identifier(value.botId) &&
    (value.turnId === null || isV1Identifier(value.turnId)) &&
    isV1OneOf(["starting", "running", "failed"], value.status) &&
    isV1BoundedString(value.text, 240) &&
    isV1NullableString(value.error, 240)
  );
}

function isV1RuntimeMessage(value: unknown): boolean {
  return (
    isDynamicRecord(value) &&
    isV1Identifier(value.botId) &&
    isV1Identifier(value.id) &&
    isV1BoundedString(value.text, 240) &&
    isV1BoundedString(value.createdAt, 160)
  );
}

function isV1RuntimePrompt(value: unknown): boolean {
  return (
    isDynamicRecord(value) &&
    isV1RequestId(value.requestId) &&
    isV1Identifier(value.botId) &&
    isV1Identifier(value.threadId) &&
    isV1Identifier(value.turnId) &&
    Array.isArray(value.questions) &&
    value.questions.length <= 32 &&
    value.questions.every(isV1RuntimePromptQuestion)
  );
}

function isV1RuntimePromptQuestion(value: unknown): boolean {
  return (
    isDynamicRecord(value) &&
    isV1Identifier(value.id) &&
    isV1BoundedString(value.header, 80) &&
    isV1BoundedString(value.question, 240) &&
    isBoolean(value.isSecret) &&
    (value.options === null ||
      (Array.isArray(value.options) &&
        value.options.length <= 5 &&
        value.options.every(
          (option) =>
            isDynamicRecord(option) &&
            isV1BoundedString(option.label, 120) &&
            isV1BoundedString(option.description, 120),
        )))
  );
}

function isV1QueueStatus(value: unknown): boolean {
  return isV1OneOf(["queued", "starting", "running", "completed", "failed", "interrupted", "cancelled"], value);
}

function isV1QueuePosition(value: unknown): boolean {
  return value === null || (isNumber(value) && Number.isInteger(value) && value >= 1);
}

function isV1Revision(value: unknown): boolean {
  return isNumber(value) && Number.isInteger(value) && value >= 0;
}

function isV1RequestId(value: unknown): value is string | number {
  return isNumber(value) || isV1Identifier(value);
}

function isV1IdentifierList(value: unknown, limit: number): boolean {
  return Array.isArray(value) && value.length <= limit && value.every(isV1Identifier);
}

function isV1StringList(value: unknown, count: number, length: number): boolean {
  return Array.isArray(value) && value.length <= count && value.every((item) => isV1BoundedString(item, length));
}

function isV1NullableString(value: unknown, limit: number): boolean {
  return value === null || isV1BoundedString(value, limit);
}

function isV1BoundedString(value: unknown, limit: number): value is string {
  return isString(value) && value.length <= limit;
}

function isV1OneOf<T extends string | number>(values: readonly T[], value: unknown): value is T {
  return values.some((candidate) => candidate === value);
}

function isTeamProtocolV1PresenceSnapshot(value: unknown): value is TeamProtocolV1PresenceSnapshot {
  return (
    isDynamicRecord(value) &&
    (value.serverId === null || isV1Identifier(value.serverId)) &&
    Array.isArray(value.members) &&
    value.members.length <= 100 &&
    value.members.every(isTeamProtocolV1PresenceMember) &&
    isV1Timestamp(value.updatedAt)
  );
}

function isTeamProtocolV1PresenceMember(value: unknown): value is TeamProtocolV1PresenceMember {
  return (
    isDynamicRecord(value) &&
    isV1Identifier(value.id) &&
    isV1LimitedString(value.username, 254) &&
    (value.email === null || isV1LimitedString(value.email, 254)) &&
    (value.name === null || isV1LimitedString(value.name, 120)) &&
    (value.avatarUrl === undefined || value.avatarUrl === null || isV1HttpUrl(value.avatarUrl, 2_048)) &&
    (value.role === "owner" || value.role === "admin" || value.role === "member") &&
    isV1Timestamp(value.createdAt) &&
    isBoolean(value.disabled) &&
    isBoolean(value.online) &&
    (value.typingBotId === null || isV1Identifier(value.typingBotId))
  );
}

function isTeamProtocolV1DirectMessage(value: unknown): value is TeamProtocolV1DirectMessage {
  return (
    isDynamicRecord(value) &&
    isV1Identifier(value.id) &&
    isV1Identifier(value.threadId) &&
    isV1Identifier(value.senderMemberId) &&
    isV1Identifier(value.recipientMemberId) &&
    value.senderMemberId !== value.recipientMemberId &&
    isV1LimitedString(value.text, 20_000) &&
    isV1Timestamp(value.createdAt) &&
    isNumber(value.sequence) &&
    Number.isSafeInteger(value.sequence) &&
    value.sequence >= 0
  );
}

function isV1Identifier(value: unknown): value is string {
  return isV1LimitedString(value, 128);
}

function isV1Timestamp(value: unknown): value is string {
  return isV1LimitedString(value, 64) && Number.isFinite(Date.parse(value));
}

function isV1HttpUrl(value: unknown, limit: number): value is string {
  if (!isV1LimitedString(value, limit)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function isV1LimitedString(value: unknown, limit: number): value is string {
  return isString(value) && value.length > 0 && value.length <= limit;
}

export function encodeTeamProtocolV1ClientEvent(event: TeamProtocolV1ClientEvent): string {
  return JSON.stringify(event);
}

export function decodeTeamProtocolV1ClientEvent(value: unknown): TeamProtocolV1ClientEvent {
  if (!isDynamicRecord(value) || !isString(value.type)) throw new Error("Invalid Team protocol v1 client event.");
  if (value.type === "runtime-snapshot-request") return { type: value.type };
  if (value.type === "agent-event-scope") {
    if (!isBoolean(value.includeConversations)) throw new Error("Invalid Team protocol v1 client event.");
    if (
      value.capabilities !== undefined &&
      (!Array.isArray(value.capabilities) || !value.capabilities.every(isCapability))
    ) {
      throw new Error("Invalid Team protocol v1 client event.");
    }
    const event: Extract<TeamProtocolV1ClientEvent, { type: "agent-event-scope" }> = {
      type: value.type,
      includeConversations: value.includeConversations,
    };
    if (value.capabilities) event.capabilities = [...value.capabilities];
    return event;
  }
  if (value.type === "team-typing") {
    if (!isBoolean(value.typing) || (value.botId !== null && !isString(value.botId))) {
      throw new Error("Invalid Team protocol v1 client event.");
    }
    return { type: value.type, botId: value.botId, typing: value.typing };
  }
  if (value.type === "team-direct-typing" && isString(value.recipientMemberId) && isBoolean(value.typing)) {
    return { type: value.type, recipientMemberId: value.recipientMemberId, typing: value.typing };
  }
  throw new Error("Invalid Team protocol v1 client event.");
}

export function encodeTeamProtocolV1Http(value: object | null): string {
  return JSON.stringify(value);
}

export function isTeamProtocolV1Capability(value: string): value is TeamProtocolV1Capability {
  return TEAM_PROTOCOL_V1_CAPABILITY_SET.has(value);
}

export interface TeamProtocolSupportV1 {
  appVersion: string;
  protocol: {
    minimum: number;
    maximum: number;
  };
  capabilities: string[];
}

export function decodeTeamProtocolSupportV1(value: unknown): TeamProtocolSupportV1 {
  if (!isDynamicRecord(value) || !isString(value.appVersion) || value.appVersion.length > 64) {
    throw new Error("Invalid Team API compatibility response.");
  }
  const protocol = value.protocol;
  if (
    !isDynamicRecord(protocol) ||
    !isProtocolVersion(protocol.minimum) ||
    !isProtocolVersion(protocol.maximum) ||
    protocol.minimum > protocol.maximum ||
    !Array.isArray(value.capabilities) ||
    value.capabilities.length > 64 ||
    !value.capabilities.every(isCapability)
  ) {
    throw new Error("Invalid Team API compatibility response.");
  }
  return {
    appVersion: value.appVersion,
    protocol: { minimum: protocol.minimum, maximum: protocol.maximum },
    capabilities: [...new Set(value.capabilities)],
  };
}

export function highestCommonTeamProtocol(
  local: TeamProtocolSupportV1["protocol"],
  remote: TeamProtocolSupportV1["protocol"],
): number | null {
  const minimum = Math.max(local.minimum, remote.minimum);
  const maximum = Math.min(local.maximum, remote.maximum);
  return minimum <= maximum ? maximum : null;
}

export function teamProtocolUpdateDirection(
  local: TeamProtocolSupportV1["protocol"],
  remote: TeamProtocolSupportV1["protocol"],
): "client_update_required" | "host_update_required" | null {
  if (highestCommonTeamProtocol(local, remote) !== null) return null;
  return local.maximum < remote.minimum ? "client_update_required" : "host_update_required";
}

function isProtocolVersion(value: unknown): value is number {
  return isNumber(value) && Number.isSafeInteger(value) && value >= 1 && value <= 65_535;
}

function isCapability(value: unknown): value is string {
  return isString(value) && value.length > 0 && value.length <= 64 && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(value);
}
