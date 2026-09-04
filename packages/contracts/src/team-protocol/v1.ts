import { type DynamicRecord, isBoolean, isDynamicRecord, isNumber, isString } from "../runtime-values";

export const TEAM_PROTOCOL_V1 = 1;
export const TEAM_PROTOCOL_VERSION_HEADER = "OpenBot-Protocol-Version";
export const TEAM_APP_VERSION_HEADER = "OpenBot-App-Version";
export const TEAM_CAPABILITIES_HEADER = "OpenBot-Capabilities";
export const TEAM_PROTOCOL_V1_WEBSOCKET = "openbot-team-v1";

export const TEAM_PROTOCOL_V1_CAPABILITIES = [
  "agent-runtime-snapshots",
  "browser-control",
  "conversation-pagination",
  "direct-messages",
  "hosted-site-event-markers",
  "remote-desktop",
  "routine-event-markers",
  "routine-run-event-markers",
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
  const projected = projectTeamProtocolV1Event(value);
  if (isTeamProtocolV1KnownEvent(projected)) return { kind: "known", event: projected };
  return { kind: "invalid", type: value.type };
}

export function encodeTeamProtocolV1Event(event: TeamProtocolV1Event): string | null {
  const decoded = decodeTeamProtocolV1Event(event);
  return decoded.kind === "known" ? JSON.stringify(decoded.event) : null;
}

const TEAM_PROTOCOL_V1_EVENT_KEYS = {
  status: ["type", "status"],
  "usage-changed": ["type", "usage"],
  "bots-changed": ["type", "bots"],
  "memories-changed": ["type", "botId"],
  "routines-changed": ["type", "botId"],
  "sidebar-layout-changed": ["type", "layout"],
  conversation: ["type", "snapshot"],
  "conversation-invalidated": ["type", "botId", "revision"],
  "conversation-page": ["type", "page"],
  "conversation-delta": ["type", "botId", "threadId", "turnId", "messageId", "delta", "createdAt", "revision"],
  "queue-invalidated": ["type", "botId"],
  "queue-changed": ["type", "snapshot"],
  "turn-started": ["type", "botId", "threadId", "turnId", "origin"],
  "turn-completed": ["type", "botId", "threadId", "turnId", "status", "origin"],
  prompt: ["type", "requestId", "botId", "threadId", "turnId", "questions"],
  "agent-input-resolved": ["type", "kind", "requestId", "botId"],
  "browser-takeover-requested": ["type", "request"],
  "browser-takeover-resolved": ["type", "requestId", "botId"],
  approval: ["type", "approval"],
  "runtime-snapshot": ["type", "snapshot"],
  "browser-changed": ["type", "tabs", "activeTabId"],
  "browser-control-changed": ["type", "state"],
  error: ["type", "botId", "code", "message"],
  "team-identity": ["type", "serverId", "serverName", "logoVersion"],
  "team-presence": ["type", "snapshot"],
  "team-direct-message": ["type", "message", "memberIds"],
  "team-direct-typing": ["type", "senderMemberId", "recipientMemberId", "typing"],
} as const satisfies Record<(typeof TEAM_PROTOCOL_V1_EVENT_TYPES)[number], readonly string[]>;

function projectTeamProtocolV1Event(value: DynamicRecord): DynamicRecord {
  if (!isString(value.type) || !isTeamProtocolV1EventType(value.type)) return value;
  const eventType = value.type;
  const projected = projectV1Object(value, TEAM_PROTOCOL_V1_EVENT_KEYS[eventType]);
  switch (eventType) {
    case "status":
      if (isDynamicRecord(projected.status)) {
        projected.status = projectTeamProtocolV1HttpResponse("GET agent-status", projected.status);
      }
      break;
    case "usage-changed":
      if (isDynamicRecord(projected.usage)) {
        projected.usage = projectTeamProtocolV1HttpResponse("GET agent-usage", projected.usage);
      }
      break;
    case "bots-changed":
      if (Array.isArray(projected.bots)) projected.bots = projected.bots.map(projectV1Bot);
      break;
    case "sidebar-layout-changed":
      if (isDynamicRecord(projected.layout)) {
        projected.layout = projectV1SidebarLayout(projected.layout);
      }
      break;
    case "conversation":
      if (isDynamicRecord(projected.snapshot)) {
        projected.snapshot = projectV1Conversation(projected.snapshot, false, false);
      }
      break;
    case "conversation-page":
      if (isDynamicRecord(projected.page)) {
        projected.page = projectTeamProtocolV1HttpResponse("GET conversation-page", projected.page);
      }
      break;
    case "queue-changed":
      if (isDynamicRecord(projected.snapshot)) {
        projected.snapshot = projectV1QueueSnapshot(projected.snapshot);
      }
      break;
    case "prompt":
      if (Array.isArray(projected.questions)) projected.questions = projected.questions.map(projectV1PromptQuestion);
      break;
    case "browser-takeover-requested":
      if (isDynamicRecord(projected.request)) projected.request = projectV1BrowserTakeover(projected.request);
      break;
    case "approval":
      if (isDynamicRecord(projected.approval)) projected.approval = projectV1Approval(projected.approval, false);
      break;
    case "runtime-snapshot":
      if (isDynamicRecord(projected.snapshot)) {
        projected.snapshot = projectV1RuntimeSnapshot(projected.snapshot);
      }
      break;
    case "browser-changed":
      if (Array.isArray(projected.tabs)) {
        projected.tabs = projected.tabs.map((tab) => projectV1Object(tab, V1_BROWSER_TAB_KEYS));
      }
      break;
    case "browser-control-changed":
      if (isDynamicRecord(projected.state)) {
        projected.state = projectV1BrowserControl(projected.state);
      }
      break;
    case "team-presence":
      if (isDynamicRecord(projected.snapshot)) {
        projected.snapshot = projectTeamProtocolV1HttpResponse("GET team-presence", projected.snapshot);
      }
      break;
    case "team-direct-message":
      if (isDynamicRecord(projected.message)) {
        projected.message = projectV1Object(projected.message, V1_DIRECT_MESSAGE_KEYS);
      }
      break;
  }
  return projected;
}

function isTeamProtocolV1EventType(value: string): value is keyof typeof TEAM_PROTOCOL_V1_EVENT_KEYS {
  return TEAM_PROTOCOL_V1_EVENT_TYPE_SET.has(value);
}

// This is the frozen v1 wire validator. Do not replace its nested checks with current IPC validators.
function isTeamProtocolV1KnownEvent(value: DynamicRecord): value is TeamProtocolV1Event {
  switch (value.type) {
    case "status":
      return isV1AgentStatus(value.status);
    case "usage-changed":
      return isV1AccountUsage(value.usage);
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
        value.tabs.every(isV1BrowserTab) &&
        (value.activeTabId === null || isString(value.activeTabId))
      );
    case "browser-control-changed":
      return isV1BrowserControl(value.state);
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
    (value.exchange === undefined || isV1Exchange(value.exchange)) &&
    (value.reaction === undefined || value.reaction === null || isV1BoundedString(value.reaction, 32)) &&
    (value.reactions === undefined ||
      (Array.isArray(value.reactions) && value.reactions.length <= 100 && value.reactions.every(isV1Reaction))) &&
    (value.routine === undefined || isV1RoutineReference(value.routine)) &&
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

function isV1Exchange(value: unknown): boolean {
  return (
    isDynamicRecord(value) &&
    isV1OneOf(["incoming", "outgoing"], value.direction) &&
    isV1Identifier(value.messageId) &&
    isV1Identifier(value.senderBotId) &&
    isV1IdentifierList(value.recipientBotIds, 100) &&
    (value.replyToMessageId === null || isV1Identifier(value.replyToMessageId)) &&
    Array.isArray(value.deliveries) &&
    value.deliveries.length <= 100 &&
    value.deliveries.every(
      (delivery) =>
        isDynamicRecord(delivery) &&
        isV1Identifier(delivery.id) &&
        isV1Identifier(delivery.recipientBotId) &&
        isV1QueueStatus(delivery.status) &&
        isV1QueuePosition(delivery.position) &&
        (delivery.error === null || isV1BoundedString(delivery.error, 100_000)),
    )
  );
}

function isV1Reaction(value: unknown): boolean {
  return (
    isDynamicRecord(value) &&
    isV1BoundedString(value.emoji, 32) &&
    isDynamicRecord(value.actor) &&
    (value.actor.kind === "user" || (value.actor.kind === "bot" && isV1Identifier(value.actor.botId)))
  );
}

function isV1RoutineReference(value: unknown): boolean {
  return (
    isDynamicRecord(value) &&
    isV1Identifier(value.routineId) &&
    isV1Identifier(value.runId) &&
    isV1LimitedString(value.name, 160) &&
    isV1Timestamp(value.scheduledFor)
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
    (value.resolution === null || isV1PromptResolution(value.resolution))
  );
}

function isV1PromptResolution(value: unknown): boolean {
  if (!isDynamicRecord(value)) return false;
  if (value.status === "cancelled" || value.status === "expired") return true;
  return (
    value.status === "answered" &&
    isDynamicRecord(value.responses) &&
    Object.values(value.responses).every(
      (response) =>
        isDynamicRecord(response) &&
        (response.status === "skipped" ||
          (response.status === "answered" &&
            (response.answers === undefined || (Array.isArray(response.answers) && response.answers.every(isString))))),
    )
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

export type TeamProtocolV1HttpMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";

type TeamProtocolV1HttpPayloadKind = "array" | "nullable-object" | "object";

interface TeamProtocolV1HttpContract {
  request: "none" | "object";
  response: TeamProtocolV1HttpPayloadKind;
}

// This registry is the frozen v1 HTTP surface. A new route or a changed payload must use a new protocol.
const TEAM_PROTOCOL_V1_HTTP_CONTRACTS = {
  "GET compatibility": { request: "none", response: "object" },
  "GET identity": { request: "none", response: "nullable-object" },
  "POST invitation-preview": { request: "object", response: "object" },
  "POST join": { request: "object", response: "object" },
  "POST join-account": { request: "object", response: "object" },
  "POST auth-login": { request: "object", response: "object" },
  "POST auth-account": { request: "object", response: "object" },
  "POST auth-password": { request: "object", response: "object" },
  "GET me": { request: "none", response: "object" },
  "GET team-presence": { request: "none", response: "object" },
  "GET remote-capabilities": { request: "none", response: "object" },
  "POST remote-session": { request: "object", response: "object" },
  "PUT remote-display": { request: "object", response: "object" },
  "GET direct-threads": { request: "none", response: "array" },
  "GET message-search": { request: "none", response: "object" },
  "POST direct-message": { request: "object", response: "object" },
  "GET direct-conversation": { request: "none", response: "object" },
  "GET direct-conversation-page": { request: "none", response: "object" },
  "POST direct-conversation-read": { request: "object", response: "object" },
  "GET browser-tabs": { request: "none", response: "array" },
  "GET browser-control": { request: "none", response: "object" },
  "POST browser-open": { request: "object", response: "object" },
  "POST browser-activate": { request: "object", response: "object" },
  "POST browser-navigate": { request: "object", response: "object" },
  "POST browser-reload": { request: "object", response: "object" },
  "POST browser-close": { request: "object", response: "object" },
  "POST browser-preview": { request: "object", response: "object" },
  "POST browser-visible": { request: "object", response: "object" },
  "POST attachment-upload": { request: "none", response: "object" },
  "GET team-members": { request: "none", response: "array" },
  "PATCH team-member": { request: "object", response: "object" },
  "POST team-invites": { request: "object", response: "object" },
  "GET team-invites": { request: "none", response: "array" },
  "GET team-sessions": { request: "none", response: "array" },
  "GET agent-status": { request: "none", response: "object" },
  "GET sidebar-layout": { request: "none", response: "object" },
  "POST sidebar-action": { request: "object", response: "object" },
  "GET agent-usage": { request: "none", response: "object" },
  "GET agent-models": { request: "none", response: "array" },
  "GET agents": { request: "none", response: "array" },
  "POST agents": { request: "object", response: "object" },
  "GET conversation-reads": { request: "none", response: "object" },
  "PATCH agent": { request: "object", response: "object" },
  "GET memories": { request: "none", response: "array" },
  "POST memories": { request: "object", response: "object" },
  "PATCH memory": { request: "object", response: "object" },
  "GET routines": { request: "none", response: "array" },
  "POST routines": { request: "object", response: "object" },
  "PATCH routine": { request: "object", response: "object" },
  "POST routine-test": { request: "none", response: "object" },
  "GET routine-runs": { request: "none", response: "array" },
  "PUT agent-avatar": { request: "none", response: "object" },
  "DELETE agent-avatar": { request: "none", response: "object" },
  "GET conversation": { request: "none", response: "object" },
  "GET conversation-page": { request: "none", response: "object" },
  "POST conversation-read": { request: "object", response: "object" },
  "POST messages": { request: "object", response: "object" },
  "GET queue": { request: "none", response: "object" },
  "POST failure-acknowledge": { request: "object", response: "object" },
  "POST reaction": { request: "object", response: "object" },
  "POST queue-cancel": { request: "object", response: "object" },
  "POST queue-steer": { request: "object", response: "object" },
  "POST queue-update": { request: "object", response: "object" },
  "POST queue-reorder": { request: "object", response: "object" },
  "POST interrupt": { request: "object", response: "object" },
  "POST prompt-response": { request: "object", response: "object" },
  "POST approval-response": { request: "object", response: "object" },
  "POST browser-takeover-response": { request: "object", response: "object" },
} as const satisfies Record<string, TeamProtocolV1HttpContract>;

type TeamProtocolV1HttpRoute = keyof typeof TEAM_PROTOCOL_V1_HTTP_CONTRACTS;

const V1_MEMBER_KEYS = ["id", "username", "email", "name", "avatarUrl", "role", "createdAt", "disabled"] as const;
const V1_BOT_KEYS = [
  "id",
  "provider",
  "name",
  "title",
  "description",
  "notifications",
  "model",
  "reasoningEffort",
  "threadId",
  "workspacePath",
  "preview",
  "updatedAt",
  "avatarSeed",
  "avatarHue",
  "avatarUrl",
  "marketplaceSource",
] as const;
const V1_DIRECT_MESSAGE_KEYS = [
  "id",
  "threadId",
  "senderMemberId",
  "recipientMemberId",
  "text",
  "createdAt",
  "sequence",
] as const;
const V1_BROWSER_TAB_KEYS = ["id", "title", "url", "loading", "ownerThreadId", "ownerBotId"] as const;

const TEAM_PROTOCOL_V1_HTTP_REQUEST_KEYS = {
  "POST invitation-preview": ["inviteToken"],
  "POST join": ["inviteToken", "username", "password"],
  "POST join-account": ["inviteToken", "accountTicket"],
  "POST auth-login": ["username", "password"],
  "POST auth-account": ["accountTicket"],
  "POST auth-password": ["currentPassword", "newPassword"],
  "POST remote-session": [],
  "PUT remote-display": ["displayId"],
  "POST direct-message": ["memberId", "text", "clientMessageId"],
  "POST direct-conversation-read": ["throughSequence"],
  "POST browser-open": ["url", "ownerThreadId", "ownerBotId", "focus"],
  "POST browser-activate": ["tabId"],
  "POST browser-navigate": ["tabId", "direction"],
  "POST browser-reload": ["tabId"],
  "POST browser-close": ["tabId"],
  "POST browser-preview": ["tabId"],
  "POST browser-visible": ["visible", "bounds"],
  "PATCH team-member": ["role", "disabled"],
  "POST team-invites": ["role", "email"],
  "POST sidebar-action": ["type", "name", "agentId", "sectionId", "direction", "steps", "beforeAgentId"],
  "POST agents": ["name", "description", "avatarSeed", "avatarHue", "initialMessage"],
  "PATCH agent": [
    "name",
    "title",
    "description",
    "notifications",
    "provider",
    "model",
    "reasoningEffort",
    "avatarSeed",
    "avatarHue",
  ],
  "POST memories": ["text"],
  "PATCH memory": ["text"],
  "POST routines": ["botId", "name", "instruction", "active", "timezone", "schedule"],
  "PATCH routine": ["botId", "routineId", "name", "instruction", "active", "timezone", "schedule"],
  "POST conversation-read": ["throughMessageId"],
  "POST messages": ["text", "attachmentDraftIds", "replyToMessageId"],
  "POST failure-acknowledge": ["turnId"],
  "POST reaction": ["messageId", "emoji"],
  "POST queue-cancel": ["deliveryId"],
  "POST queue-steer": ["deliveryId", "expectedTurnId"],
  "POST queue-update": ["deliveryId", "text", "keepAttachmentIds", "attachmentDraftIds"],
  "POST queue-reorder": ["deliveryIds"],
  "POST interrupt": ["turnId"],
  "POST prompt-response": ["requestId", "answers"],
  "POST approval-response": ["requestId", "decision"],
  "POST browser-takeover-response": ["requestId", "decision"],
} as const satisfies Partial<Record<TeamProtocolV1HttpRoute, readonly string[]>>;

const TEAM_PROTOCOL_V1_HTTP_RESPONSE_KEYS = {
  "GET compatibility": ["appVersion", "protocol", "capabilities"],
  "GET identity": [
    "serverId",
    "serverName",
    "fingerprint",
    "publicKey",
    "enabledOnLaunch",
    "logoVersion",
    "challenge",
    "signature",
  ],
  "POST invitation-preview": ["role", "expiresAt", "emailBound"],
  "POST join": ["member", "sessionToken", "sessionExpiresAt"],
  "POST join-account": ["member", "sessionToken", "sessionExpiresAt"],
  "POST auth-login": ["member", "sessionToken", "sessionExpiresAt"],
  "POST auth-account": ["member", "sessionToken", "sessionExpiresAt"],
  "GET me": V1_MEMBER_KEYS,
  "GET team-presence": ["serverId", "members", "updatedAt"],
  "GET remote-capabilities": [
    "ready",
    "platform",
    "unattended",
    "runtime",
    "protocolVersion",
    "displays",
    "selectedDisplayId",
    "activeSessions",
    "maxSessions",
  ],
  "POST remote-session": [
    "id",
    "serverId",
    "viewerUrl",
    "viewerGrant",
    "displays",
    "selectedDisplayId",
    "phase",
    "transport",
    "errorCode",
    "message",
    "createdAt",
    "grantExpiresAt",
  ],
  "GET direct-threads": ["threadId", "otherMemberId", "lastMessage", "unreadCount", "updatedAt"],
  "POST direct-message": V1_DIRECT_MESSAGE_KEYS,
  "GET direct-conversation": ["threadId", "otherMemberId", "messages", "revision", "readState"],
  "GET direct-conversation-page": ["threadId", "otherMemberId", "messages", "revision", "pageInfo", "readState"],
  "POST direct-conversation-read": ["unreadCount", "firstUnreadMessageId", "throughSequence"],
  "GET browser-tabs": V1_BROWSER_TAB_KEYS,
  "GET browser-control": ["sessions"],
  "POST browser-open": V1_BROWSER_TAB_KEYS,
  "POST browser-preview": ["dataUrl", "width", "height"],
  "POST attachment-upload": ["id", "name", "size", "kind", "mimeType", "previewKind", "previewUrl"],
  "GET team-members": V1_MEMBER_KEYS,
  "PATCH team-member": V1_MEMBER_KEYS,
  "POST team-invites": ["id", "role", "expiresAt", "usedAt", "inviteUrl", "email"],
  "GET team-invites": ["id", "role", "expiresAt", "usedAt", "email"],
  "GET team-sessions": ["id", "memberId", "username", "createdAt", "expiresAt"],
  "GET agent-status": ["phase", "cliVersion", "auth", "providers", "capabilities", "message", "fullAccess"],
  "GET sidebar-layout": ["revision", "sections", "order", "agentAssignments", "agentOrder"],
  "POST sidebar-action": ["revision", "sections", "order", "agentAssignments", "agentOrder"],
  "GET agent-usage": ["limits"],
  "GET agent-models": ["provider", "id", "name", "description", "defaultReasoningEffort", "supportedReasoningEfforts"],
  "GET agents": V1_BOT_KEYS,
  "POST agents": V1_BOT_KEYS,
  "PATCH agent": V1_BOT_KEYS,
  "PUT agent-avatar": V1_BOT_KEYS,
  "DELETE agent-avatar": V1_BOT_KEYS,
  "GET conversation-reads": [],
  "GET memories": ["id", "botId", "text", "origin", "sourceTurnId", "createdAt", "updatedAt"],
  "POST memories": ["id", "botId", "text", "origin", "sourceTurnId", "createdAt", "updatedAt"],
  "PATCH memory": ["id", "botId", "text", "origin", "sourceTurnId", "createdAt", "updatedAt"],
  "GET routines": ["id", "botId", "name", "instruction", "active", "timezone", "trigger", "createdAt", "updatedAt"],
  "POST routines": ["id", "botId", "name", "instruction", "active", "timezone", "trigger", "createdAt", "updatedAt"],
  "PATCH routine": ["id", "botId", "name", "instruction", "active", "timezone", "trigger", "createdAt", "updatedAt"],
  "POST routine-test": [
    "id",
    "routineId",
    "botId",
    "triggerId",
    "kind",
    "scheduledFor",
    "routineName",
    "instruction",
    "deliveryId",
    "status",
    "error",
    "createdAt",
    "updatedAt",
  ],
  "GET routine-runs": [
    "id",
    "routineId",
    "botId",
    "triggerId",
    "kind",
    "scheduledFor",
    "routineName",
    "instruction",
    "deliveryId",
    "status",
    "error",
    "createdAt",
    "updatedAt",
  ],
  "GET conversation": ["botId", "threadId", "activeTurnId", "revision", "messages", "readState"],
  "GET conversation-page": [
    "botId",
    "threadId",
    "activeTurnId",
    "revision",
    "messages",
    "references",
    "pageInfo",
    "readState",
  ],
  "GET message-search": ["results", "total", "nextCursor"],
  "POST conversation-read": ["unreadCount", "firstUnreadMessageId", "throughMessageId"],
  "POST messages": ["messageId", "deliveries"],
  "GET queue": ["botId", "deliveries"],
} as const satisfies Partial<Record<TeamProtocolV1HttpRoute, readonly string[]>>;

export function decodeTeamProtocolV1HttpRequest(
  method: string,
  path: string,
  value: unknown,
): TeamProtocolV1JsonObject {
  const route = teamProtocolV1HttpRoute(method, path);
  if (!route) throw new Error("Invalid Team protocol v1 HTTP request.");
  const contract = TEAM_PROTOCOL_V1_HTTP_CONTRACTS[route];
  if (contract.request !== "object" || !isTeamProtocolV1JsonObject(value)) {
    throw new Error("Invalid Team protocol v1 HTTP request.");
  }
  const projected = projectTeamProtocolV1HttpRequest(route, value);
  validateTeamProtocolV1HttpRequest(route, projected);
  return projected;
}

export function decodeTeamProtocolV1HttpResponse(
  method: string,
  path: string,
  status: number,
  value: unknown,
): TeamProtocolV1JsonValue {
  if (status >= 400) {
    if (!isTeamProtocolV1JsonObject(value) || !isString(value.error)) {
      throw new Error("Invalid Team protocol v1 HTTP error response.");
    }
    return projectTeamProtocolV1Error(value);
  }
  const route = teamProtocolV1HttpRoute(method, path);
  if (!route) throw new Error("Invalid Team protocol v1 HTTP response.");
  const contract = TEAM_PROTOCOL_V1_HTTP_CONTRACTS[route];
  if (!matchesTeamProtocolV1HttpShape(contract.response, value)) {
    throw new Error("Invalid Team protocol v1 HTTP response.");
  }
  const projected = projectTeamProtocolV1HttpResponse(route, value);
  validateTeamProtocolV1HttpResponse(route, projected);
  return projected;
}

function projectTeamProtocolV1HttpRequest(
  route: TeamProtocolV1HttpRoute,
  value: TeamProtocolV1JsonObject,
): TeamProtocolV1JsonObject {
  if (!hasTeamProtocolV1HttpRequestProjection(route)) {
    throw new Error("Team protocol v1 HTTP request projection is missing.");
  }
  const wireKeys = TEAM_PROTOCOL_V1_HTTP_REQUEST_KEYS[route];
  const projected = projectV1Object(value, wireKeys);
  if (route === "POST browser-visible" && isDynamicRecord(projected.bounds)) {
    projected.bounds = projectV1Object(projected.bounds, ["x", "y", "width", "height"]);
  }
  if ((route === "POST routines" || route === "PATCH routine") && isDynamicRecord(projected.schedule)) {
    projected.schedule = projectV1RoutineSchedule(projected.schedule);
  }
  return projected;
}

function projectTeamProtocolV1HttpResponse(
  route: TeamProtocolV1HttpRoute,
  value: TeamProtocolV1JsonValue,
): TeamProtocolV1JsonValue {
  if (route === "GET conversation-reads" && isDynamicRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([botId, state]) => [
        botId,
        isDynamicRecord(state)
          ? projectV1Object(state, ["unreadCount", "firstUnreadMessageId", "throughMessageId"])
          : null,
      ]),
    );
  }
  if (!hasTeamProtocolV1HttpResponseProjection(route)) {
    throw new Error("Team protocol v1 HTTP response projection is missing.");
  }
  const wireKeys = TEAM_PROTOCOL_V1_HTTP_RESPONSE_KEYS[route];
  if (Array.isArray(value)) {
    return value.map((item) => {
      const projected = route === "GET agents" ? projectV1Bot(item) : projectV1Object(item, wireKeys);
      if (route === "GET direct-threads" && isDynamicRecord(projected.lastMessage)) {
        projected.lastMessage = projectV1Object(projected.lastMessage, V1_DIRECT_MESSAGE_KEYS);
      } else if (route === "GET agent-usage") {
        return projectV1UsageLimit(item);
      } else if (route === "GET routines" || route === "GET routine-runs") {
        return projectV1RoutineValue(projected);
      }
      return projected;
    });
  }
  if (value === null) return null;
  const projected =
    route === "POST agents" || route === "PATCH agent" || route.endsWith("agent-avatar")
      ? projectV1Bot(value)
      : projectV1Object(value, wireKeys);
  if (["POST join", "POST join-account", "POST auth-login", "POST auth-account"].includes(route)) {
    if (isDynamicRecord(projected.member)) projected.member = projectV1Object(projected.member, V1_MEMBER_KEYS);
  } else if (route === "GET team-presence" && Array.isArray(projected.members)) {
    projected.members = projected.members.map((member) =>
      projectV1Object(member, [...V1_MEMBER_KEYS, "online", "typingBotId"]),
    );
  } else if (
    (route === "GET direct-conversation" || route === "GET direct-conversation-page") &&
    Array.isArray(projected.messages)
  ) {
    projected.messages = projected.messages.map((message) => projectV1Object(message, V1_DIRECT_MESSAGE_KEYS));
    if (isDynamicRecord(projected.readState)) projected.readState = projectV1DirectReadState(projected.readState);
    if (isDynamicRecord(projected.pageInfo)) projected.pageInfo = projectV1PageInfo(projected.pageInfo);
  } else if (route === "GET compatibility" && isDynamicRecord(projected.protocol)) {
    projected.protocol = projectV1Object(projected.protocol, ["minimum", "maximum"]);
  } else if (route === "GET agent-status") {
    if (isDynamicRecord(projected.auth)) {
      projected.auth = projectV1Object(projected.auth, ["kind", "accountType", "email"]);
    }
    if (Array.isArray(projected.providers)) {
      projected.providers = projected.providers.map(projectV1ProviderStatus);
    }
    if (isDynamicRecord(projected.capabilities)) {
      projected.capabilities = projectV1Object(projected.capabilities, ["chat", "browser", "computerUse"]);
    }
  } else if (route === "GET agent-usage" && Array.isArray(projected.limits)) {
    projected.limits = projected.limits.map(projectV1UsageLimit);
  } else if (route === "GET sidebar-layout" || route === "POST sidebar-action") {
    return projectV1SidebarLayout(projected);
  } else if (route === "GET remote-capabilities" && Array.isArray(projected.displays)) {
    projected.displays = projected.displays.map(projectV1RemoteDisplay);
  } else if (route === "POST remote-session") {
    if (Array.isArray(projected.displays)) projected.displays = projected.displays.map(projectV1RemoteDisplay);
  } else if (route === "GET browser-control") {
    return projectV1BrowserControl(projected);
  } else if (route === "POST routines" || route === "PATCH routine" || route === "POST routine-test") {
    return projectV1RoutineValue(projected);
  } else if (route === "GET conversation") {
    return projectV1Conversation(projected, false, true);
  } else if (route === "GET conversation-page") {
    return projectV1Conversation(projected, true);
  } else if (route === "GET message-search") {
    return projectV1ConversationSearch(projected);
  } else if (route === "GET queue") {
    return projectV1QueueSnapshot(projected);
  } else if (route === "POST messages") {
    return projectV1QueuedMessageReceipt(projected);
  }
  return projected;
}

function hasTeamProtocolV1HttpRequestProjection(
  route: TeamProtocolV1HttpRoute,
): route is keyof typeof TEAM_PROTOCOL_V1_HTTP_REQUEST_KEYS {
  return Object.hasOwn(TEAM_PROTOCOL_V1_HTTP_REQUEST_KEYS, route);
}

function hasTeamProtocolV1HttpResponseProjection(
  route: TeamProtocolV1HttpRoute,
): route is keyof typeof TEAM_PROTOCOL_V1_HTTP_RESPONSE_KEYS {
  return Object.hasOwn(TEAM_PROTOCOL_V1_HTTP_RESPONSE_KEYS, route);
}

const V1_HTTP_ERROR_CODES = new Set([
  "client_update_required",
  "host_update_required",
  "protocol_error",
  "host_unavailable",
  "host_permissions_required",
  "session_capacity_reached",
  "session_expired",
  "session_revoked",
  "protocol_mismatch",
  "connection_failed",
]);

function projectTeamProtocolV1Error(value: TeamProtocolV1JsonObject): TeamProtocolV1JsonObject {
  const projected = projectV1Object(value, ["error", "code", "host", "client"]);
  if (!isV1BoundedString(projected.error, 100_000)) throw new Error("Invalid Team protocol v1 HTTP error response.");
  if (projected.code !== undefined && (!isString(projected.code) || !V1_HTTP_ERROR_CODES.has(projected.code))) {
    throw new Error("Invalid Team protocol v1 HTTP error response.");
  }
  if (projected.host !== undefined) {
    if (!isDynamicRecord(projected.host)) throw new Error("Invalid Team protocol v1 HTTP error response.");
    const host = projectV1Object(projected.host, ["appVersion", "protocol", "capabilities"]);
    if (isDynamicRecord(host.protocol)) host.protocol = projectV1Object(host.protocol, ["minimum", "maximum"]);
    try {
      const decoded = decodeTeamProtocolSupportV1(host);
      projected.host = {
        appVersion: decoded.appVersion,
        protocol: { minimum: decoded.protocol.minimum, maximum: decoded.protocol.maximum },
        capabilities: decoded.capabilities,
      };
    } catch {
      throw new Error("Invalid Team protocol v1 HTTP error response.");
    }
  }
  if (projected.client !== undefined) {
    if (!isDynamicRecord(projected.client)) throw new Error("Invalid Team protocol v1 HTTP error response.");
    const client = projectV1Object(projected.client, ["appVersion", "protocol"]);
    if (!isV1BoundedString(client.appVersion, 64) || !isProtocolVersion(client.protocol)) {
      throw new Error("Invalid Team protocol v1 HTTP error response.");
    }
    projected.client = client;
  }
  return projected;
}

function projectV1Bot(value: unknown): TeamProtocolV1JsonObject {
  const projected = projectV1Object(value, V1_BOT_KEYS);
  if (isDynamicRecord(projected.marketplaceSource)) {
    projected.marketplaceSource = projectV1Object(projected.marketplaceSource, [
      "agentId",
      "versionId",
      "version",
      "skillIds",
      "routineIds",
    ]);
  }
  return projected;
}

function projectV1SidebarLayout(value: unknown): TeamProtocolV1JsonObject {
  const projected = projectV1Object(value, TEAM_PROTOCOL_V1_HTTP_RESPONSE_KEYS["GET sidebar-layout"]);
  if (Array.isArray(projected.sections)) {
    projected.sections = projected.sections.map((section) => projectV1Object(section, ["id", "name"]));
  }
  return projected;
}

function projectV1Conversation(value: unknown, page: boolean, includeReadState = true): TeamProtocolV1JsonObject {
  const projected = projectV1Object(
    value,
    page
      ? TEAM_PROTOCOL_V1_HTTP_RESPONSE_KEYS["GET conversation-page"]
      : TEAM_PROTOCOL_V1_HTTP_RESPONSE_KEYS["GET conversation"],
  );
  if (Array.isArray(projected.messages)) projected.messages = projected.messages.map(projectV1ConversationMessage);
  if (!includeReadState) delete projected.readState;
  else if (isDynamicRecord(projected.readState))
    projected.readState = projectV1ConversationReadState(projected.readState);
  if (page && isDynamicRecord(projected.references)) {
    projected.references = Object.fromEntries(
      Object.entries(projected.references).map(([id, message]) => [id, projectV1ConversationMessage(message)]),
    );
  }
  if (page && isDynamicRecord(projected.pageInfo)) projected.pageInfo = projectV1PageInfo(projected.pageInfo);
  return projected;
}

function projectV1ConversationMessage(value: unknown): TeamProtocolV1JsonObject {
  const projected = projectV1Object(value, [
    "id",
    "turnId",
    "author",
    "text",
    "createdAt",
    "status",
    "itemType",
    "source",
    "senderBotId",
    "replyToMessageId",
    "attachments",
    "imageGeneration",
    "delivery",
    "exchange",
    "reaction",
    "reactions",
    "routine",
    "questionPrompt",
  ]);
  if (Array.isArray(projected.attachments)) projected.attachments = projected.attachments.map(projectV1Attachment);
  if (isDynamicRecord(projected.delivery)) {
    projected.delivery = projectV1Object(projected.delivery, ["id", "status", "position"]);
  }
  if (isDynamicRecord(projected.exchange)) projected.exchange = projectV1Exchange(projected.exchange);
  if (Array.isArray(projected.reactions)) projected.reactions = projected.reactions.map(projectV1Reaction);
  if (isDynamicRecord(projected.routine)) {
    projected.routine = projectV1Object(projected.routine, ["routineId", "runId", "name", "scheduledFor"]);
  }
  if (isDynamicRecord(projected.imageGeneration)) {
    projected.imageGeneration = projectV1Object(projected.imageGeneration, [
      "prompt",
      "resolution",
      "aspectRatio",
      "error",
    ]);
  }
  if (isDynamicRecord(projected.questionPrompt)) {
    projected.questionPrompt = projectV1ConversationQuestionPrompt(projected.questionPrompt);
  }
  return projected;
}

function projectV1Exchange(value: DynamicRecord): TeamProtocolV1JsonObject {
  const projected = projectV1Object(value, [
    "direction",
    "messageId",
    "senderBotId",
    "recipientBotIds",
    "replyToMessageId",
    "deliveries",
  ]);
  if (Array.isArray(projected.deliveries)) {
    projected.deliveries = projected.deliveries.map((delivery) =>
      projectV1Object(delivery, ["id", "recipientBotId", "status", "position", "error"]),
    );
  }
  return projected;
}

function projectV1Reaction(value: unknown): TeamProtocolV1JsonObject {
  const projected = projectV1Object(value, ["emoji", "actor"]);
  if (isDynamicRecord(projected.actor)) projected.actor = projectV1Object(projected.actor, ["kind", "botId"]);
  return projected;
}

function projectV1ConversationQuestionPrompt(value: DynamicRecord): TeamProtocolV1JsonObject {
  const projected = projectV1Object(value, ["requestId", "questions", "resolution"]);
  if (Array.isArray(projected.questions)) projected.questions = projected.questions.map(projectV1PromptQuestion);
  if (isDynamicRecord(projected.resolution)) {
    const resolution = projectV1Object(projected.resolution, ["status", "responses"]);
    if (isDynamicRecord(resolution.responses)) {
      resolution.responses = Object.fromEntries(
        Object.entries(resolution.responses).map(([id, response]) => [
          id,
          projectV1Object(response, ["status", "answers"]),
        ]),
      );
    }
    projected.resolution = resolution;
  }
  return projected;
}

function projectV1PromptQuestion(value: unknown): TeamProtocolV1JsonObject {
  const projected = projectV1Object(value, ["id", "header", "question", "isSecret", "options"]);
  if (Array.isArray(projected.options)) {
    projected.options = projected.options.map((option) => projectV1Object(option, ["label", "description"]));
  }
  return projected;
}

function projectV1ConversationReadState(value: DynamicRecord): TeamProtocolV1JsonObject {
  return projectV1Object(value, ["unreadCount", "firstUnreadMessageId", "throughMessageId"]);
}

function projectV1DirectReadState(value: DynamicRecord): TeamProtocolV1JsonObject {
  return projectV1Object(value, ["unreadCount", "firstUnreadMessageId", "throughSequence"]);
}

function projectV1PageInfo(value: DynamicRecord): TeamProtocolV1JsonObject {
  return projectV1Object(value, ["hasOlder", "olderCursor"]);
}

function projectV1QueueSnapshot(value: unknown): TeamProtocolV1JsonObject {
  const projected = projectV1Object(value, TEAM_PROTOCOL_V1_HTTP_RESPONSE_KEYS["GET queue"]);
  if (Array.isArray(projected.deliveries)) projected.deliveries = projected.deliveries.map(projectV1QueueDelivery);
  return projected;
}

function projectV1QueueDelivery(value: unknown): TeamProtocolV1JsonObject {
  const projected = projectV1Object(value, [
    "id",
    "messageId",
    "recipientBotId",
    "sender",
    "text",
    "attachments",
    "replyToMessageId",
    "status",
    "position",
    "turnId",
    "error",
    "createdAt",
  ]);
  if (isDynamicRecord(projected.sender)) {
    projected.sender = projectV1Object(projected.sender, [
      "kind",
      "botId",
      "routineId",
      "runId",
      "routineName",
      "scheduledFor",
    ]);
  }
  if (Array.isArray(projected.attachments)) projected.attachments = projected.attachments.map(projectV1Attachment);
  return projected;
}

function projectV1Attachment(value: unknown): TeamProtocolV1JsonObject {
  return projectV1Object(value, ["id", "name", "size", "kind", "mimeType", "previewKind", "previewUrl"]);
}

function projectV1BrowserTakeover(value: unknown): TeamProtocolV1JsonObject {
  return projectV1Object(value, ["requestId", "botId", "threadId", "turnId", "tabId"]);
}

function projectV1Approval(value: unknown, runtime: boolean): TeamProtocolV1JsonObject {
  const keys = [
    "requestId",
    "botId",
    "threadId",
    "turnId",
    "kind",
    "command",
    "cwd",
    "reason",
    "grantRoot",
    "permissions",
  ];
  const projected = projectV1Object(value, runtime ? [...keys, "truncated"] : keys);
  if (isDynamicRecord(projected.permissions)) {
    const permissions = projectV1Object(projected.permissions, ["fileSystem", "network"]);
    if (isDynamicRecord(permissions.fileSystem)) {
      permissions.fileSystem = projectV1Object(permissions.fileSystem, ["read", "write"]);
    }
    projected.permissions = permissions;
  }
  return projected;
}

function projectV1RuntimeSnapshot(value: unknown): TeamProtocolV1JsonObject {
  const projected = projectV1Object(value, [
    "bots",
    "activeTurns",
    "work",
    "latestMessages",
    "attentionComplete",
    "pendingPrompts",
    "pendingApprovals",
    "pendingBrowserTakeovers",
    "failedTurns",
  ]);
  if (Array.isArray(projected.bots)) {
    projected.bots = projected.bots.map((bot) =>
      projectV1Object(bot, [
        "id",
        "name",
        "notifications",
        "preview",
        "updatedAt",
        "avatarSeed",
        "avatarHue",
        "avatarUrl",
      ]),
    );
  }
  if (Array.isArray(projected.activeTurns)) {
    projected.activeTurns = projected.activeTurns.map((turn) => projectV1Object(turn, ["botId", "threadId", "turnId"]));
  }
  if (Array.isArray(projected.work)) {
    projected.work = projected.work.map((work) =>
      projectV1Object(work, ["id", "botId", "turnId", "status", "text", "error"]),
    );
  }
  if (Array.isArray(projected.latestMessages)) {
    projected.latestMessages = projected.latestMessages.map((message) =>
      projectV1Object(message, ["botId", "id", "text", "createdAt"]),
    );
  }
  if (Array.isArray(projected.pendingPrompts)) {
    projected.pendingPrompts = projected.pendingPrompts.map((prompt) => {
      const item = projectV1Object(prompt, ["requestId", "botId", "threadId", "turnId", "questions"]);
      if (Array.isArray(item.questions)) item.questions = item.questions.map(projectV1PromptQuestion);
      return item;
    });
  }
  if (Array.isArray(projected.pendingApprovals)) {
    projected.pendingApprovals = projected.pendingApprovals.map((approval) => projectV1Approval(approval, true));
  }
  if (Array.isArray(projected.pendingBrowserTakeovers)) {
    projected.pendingBrowserTakeovers = projected.pendingBrowserTakeovers.map(projectV1BrowserTakeover);
  }
  if (Array.isArray(projected.failedTurns)) {
    projected.failedTurns = projected.failedTurns.map((turn) => projectV1Object(turn, ["botId", "turnId"]));
  }
  return projected;
}

function projectV1BrowserControl(value: unknown): TeamProtocolV1JsonObject {
  const projected = projectV1Object(value, TEAM_PROTOCOL_V1_HTTP_RESPONSE_KEYS["GET browser-control"]);
  if (Array.isArray(projected.sessions)) {
    projected.sessions = projected.sessions.map((session) =>
      projectV1Object(session, ["id", "threadId", "turnId", "callId", "tabId", "action", "phase", "startedAt"]),
    );
  }
  return projected;
}

function projectV1RemoteDisplay(value: unknown): TeamProtocolV1JsonObject {
  return projectV1Object(value, ["id", "label", "width", "height", "primary"]);
}

function projectV1ConversationSearch(value: unknown): TeamProtocolV1JsonObject {
  const projected = projectV1Object(value, TEAM_PROTOCOL_V1_HTTP_RESPONSE_KEYS["GET message-search"]);
  if (Array.isArray(projected.results)) {
    projected.results = projected.results.map((result) => {
      const item = projectV1Object(result, ["botId", "message"]);
      if (isDynamicRecord(item.message)) item.message = projectV1ConversationMessage(item.message);
      return item;
    });
  }
  return projected;
}

function projectV1QueuedMessageReceipt(value: unknown): TeamProtocolV1JsonObject {
  const projected = projectV1Object(value, TEAM_PROTOCOL_V1_HTTP_RESPONSE_KEYS["POST messages"]);
  if (Array.isArray(projected.deliveries)) {
    projected.deliveries = projected.deliveries.map((delivery) =>
      projectV1Object(delivery, ["id", "recipientBotId", "status", "position"]),
    );
  }
  return projected;
}

function projectV1ProviderStatus(value: unknown): TeamProtocolV1JsonObject {
  return projectV1Object(value, ["id", "state", "version", "message", "email", "connectionState", "checkError"]);
}

function projectV1UsageLimit(value: unknown): TeamProtocolV1JsonObject {
  const projected = projectV1Object(value, ["id", "primary", "secondary"]);
  for (const key of ["primary", "secondary"] as const) {
    if (isDynamicRecord(projected[key])) {
      projected[key] = projectV1Object(projected[key], ["usedPercent", "windowDurationMins", "resetsAt"]);
    }
  }
  return projected;
}

function projectV1RoutineValue(value: TeamProtocolV1JsonObject): TeamProtocolV1JsonObject {
  const projected = { ...value };
  const trigger = projected.trigger;
  if (isDynamicRecord(trigger)) {
    const projectedTrigger = projectV1Object(trigger, [
      "id",
      "routineId",
      "schedule",
      "nextRunAt",
      "createdAt",
      "updatedAt",
    ]);
    if (isDynamicRecord(projectedTrigger.schedule)) {
      projectedTrigger.schedule = projectV1RoutineSchedule(projectedTrigger.schedule);
    }
    projected.trigger = projectedTrigger;
  }
  return projected;
}

function projectV1Object(value: unknown, wireKeys: readonly string[]): TeamProtocolV1JsonObject {
  if (!isDynamicRecord(value)) return {};
  const projected: TeamProtocolV1JsonObject = {};
  for (const key of wireKeys) {
    const item = value[key];
    if (item !== undefined && isTeamProtocolV1JsonValue(item)) projected[key] = item;
  }
  return projected;
}

function projectV1RoutineSchedule(value: DynamicRecord): TeamProtocolV1JsonObject {
  const common = ["kind"];
  switch (value.kind) {
    case "hourly":
      return projectV1Object(value, [...common, "minute"]);
    case "daily":
    case "weekdays":
      return projectV1Object(value, [...common, "time"]);
    case "weekly":
      return projectV1Object(value, [...common, "weekday", "time"]);
    case "monthly":
      return projectV1Object(value, [...common, "day", "time"]);
    case "interval":
      return projectV1Object(value, [...common, "amount", "unit", "anchorAt"]);
    case "advanced":
      return projectV1Object(value, [...common, "months", "days", "time"]);
    case "custom":
      return projectV1Object(value, [...common, "expression"]);
    default:
      return projectV1Object(value, common);
  }
}

// Exported for the shared route table's coverage case in `src/main/team-api-server.test.ts`. The host
// encodes every JSON response through this adapter, so a path `TEAM_API_ROUTES` builds that this
// frozen list cannot name is a route no client can be answered on. Classification only: it reads the
// list below and decides nothing, so exporting it leaves every released response meaning what it did.
export function teamProtocolV1HttpRoute(method: string, path: string): TeamProtocolV1HttpRoute | null {
  const pathname = new URL(path, "http://openbot.invalid").pathname;
  const exact: Record<string, TeamProtocolV1HttpRoute> = {
    "GET /v1/compatibility": "GET compatibility",
    "GET /v1/identity": "GET identity",
    "POST /v1/invitations/preview": "POST invitation-preview",
    "POST /v1/join": "POST join",
    "POST /v1/join/account": "POST join-account",
    "POST /v1/auth/login": "POST auth-login",
    "POST /v1/auth/account": "POST auth-account",
    "POST /v1/auth/password": "POST auth-password",
    "GET /v1/me": "GET me",
    "GET /v1/team/presence": "GET team-presence",
    "GET /v1/remote-screen/capabilities": "GET remote-capabilities",
    "POST /v1/remote-screen/sessions": "POST remote-session",
    "PUT /v1/remote-screen/display": "PUT remote-display",
    "GET /v1/direct/threads": "GET direct-threads",
    "GET /v1/messages/search": "GET message-search",
    "POST /v1/direct/messages": "POST direct-message",
    "GET /v1/browser/tabs": "GET browser-tabs",
    "GET /v1/browser/control": "GET browser-control",
    "POST /v1/browser/open": "POST browser-open",
    "POST /v1/browser/activate": "POST browser-activate",
    "POST /v1/browser/navigate": "POST browser-navigate",
    "POST /v1/browser/reload": "POST browser-reload",
    "POST /v1/browser/close": "POST browser-close",
    "POST /v1/browser/preview": "POST browser-preview",
    "POST /v1/browser/visible": "POST browser-visible",
    "POST /v1/attachments": "POST attachment-upload",
    "GET /v1/team/members": "GET team-members",
    "POST /v1/team/invites": "POST team-invites",
    "GET /v1/team/invites": "GET team-invites",
    "GET /v1/team/sessions": "GET team-sessions",
    "GET /v1/agents/status": "GET agent-status",
    "GET /v1/sidebar-layout": "GET sidebar-layout",
    "POST /v1/sidebar-layout/actions": "POST sidebar-action",
    "GET /v1/agents/usage": "GET agent-usage",
    "GET /v1/agents/models": "GET agent-models",
    "GET /v1/agents": "GET agents",
    "POST /v1/agents": "POST agents",
    "GET /v1/agents/conversation-reads": "GET conversation-reads",
    "POST /v1/prompts/respond": "POST prompt-response",
    "POST /v1/approvals/respond": "POST approval-response",
    "POST /v1/browser-takeovers/respond": "POST browser-takeover-response",
  };
  const direct = exact[`${method} ${pathname}`];
  if (direct) return direct;
  if (/^\/v1\/team\/members\/[^/]+$/u.test(pathname) && method === "PATCH") return "PATCH team-member";
  const directConversation = pathname.match(/^\/v1\/direct\/conversations\/[^/]+(?:\/(read|page))?$/u);
  if (directConversation && method === "GET") {
    return directConversation[1] === "page" ? "GET direct-conversation-page" : "GET direct-conversation";
  }
  if (directConversation?.[1] === "read" && method === "POST") return "POST direct-conversation-read";
  const agent = pathname.match(/^\/v1\/agents\/[^/]+(?:\/(.*))?$/u);
  if (!agent) return null;
  const action = agent[1] ?? "";
  if (!action && method === "PATCH") return "PATCH agent";
  if (action === "memories") return method === "GET" ? "GET memories" : method === "POST" ? "POST memories" : null;
  if (/^memories\/[^/]+$/u.test(action) && method === "PATCH") return "PATCH memory";
  if (action === "routines") return method === "GET" ? "GET routines" : method === "POST" ? "POST routines" : null;
  if (/^routines\/[^/]+$/u.test(action) && method === "PATCH") return "PATCH routine";
  if (/^routines\/[^/]+\/test$/u.test(action) && method === "POST") return "POST routine-test";
  if (/^routines\/[^/]+\/runs$/u.test(action) && method === "GET") return "GET routine-runs";
  if (action === "avatar" && (method === "PUT" || method === "DELETE")) return `${method} agent-avatar`;
  if (action === "conversation" && method === "GET") return "GET conversation";
  if (action === "conversation-page" && method === "GET") return "GET conversation-page";
  if (action === "conversation/read" && method === "POST") return "POST conversation-read";
  if (action === "messages" && method === "POST") return "POST messages";
  if (action === "queue" && method === "GET") return "GET queue";
  if (method === "POST" && action === "failures/acknowledge") return "POST failure-acknowledge";
  if (method === "POST" && action === "reactions") return "POST reaction";
  if (method === "POST" && action === "queue/cancel") return "POST queue-cancel";
  if (method === "POST" && action === "queue/steer") return "POST queue-steer";
  if (method === "POST" && action === "queue/update") return "POST queue-update";
  if (method === "POST" && action === "queue/reorder") return "POST queue-reorder";
  if (method === "POST" && action === "interrupt") return "POST interrupt";
  return null;
}

function matchesTeamProtocolV1HttpShape(
  payloadKind: TeamProtocolV1HttpPayloadKind,
  value: unknown,
): value is TeamProtocolV1JsonValue {
  if (payloadKind === "array") return Array.isArray(value) && value.every(isTeamProtocolV1JsonValue);
  if (payloadKind === "nullable-object" && value === null) return true;
  return isTeamProtocolV1JsonObject(value);
}

function validateTeamProtocolV1HttpRequest(route: TeamProtocolV1HttpRoute, value: TeamProtocolV1JsonObject): void {
  let valid = false;
  switch (route) {
    case "POST invitation-preview":
      valid = isV1Identifier(value.inviteToken);
      break;
    case "POST join":
      valid =
        isV1Identifier(value.inviteToken) &&
        isV1LimitedString(value.username, 64) &&
        isV1LimitedString(value.password, 256);
      break;
    case "POST join-account":
      valid = isV1Identifier(value.inviteToken) && isV1Identifier(value.accountTicket);
      break;
    case "POST auth-login":
      valid = isV1LimitedString(value.username, 64) && isV1LimitedString(value.password, 256);
      break;
    case "POST auth-account":
      valid = isV1Identifier(value.accountTicket);
      break;
    case "POST auth-password":
      valid = isV1LimitedString(value.currentPassword, 256) && isV1LimitedString(value.newPassword, 256);
      break;
    case "POST remote-session":
      valid = Object.keys(value).length === 0;
      break;
    case "PUT remote-display":
      valid = isV1Identifier(value.displayId);
      break;
    case "POST direct-message":
      valid =
        isV1Identifier(value.memberId) &&
        isV1LimitedString(value.text, 20_000) &&
        isV1Identifier(value.clientMessageId);
      break;
    case "POST direct-conversation-read":
      valid = isV1NonNegativeInteger(value.throughSequence);
      break;
    case "POST browser-open":
      valid =
        isV1HttpUrl(value.url, 8_192) &&
        isV1OptionalNullableIdentifier(value.ownerThreadId) &&
        isV1OptionalNullableIdentifier(value.ownerBotId) &&
        (value.focus === undefined || isBoolean(value.focus));
      break;
    case "POST browser-activate":
    case "POST browser-reload":
    case "POST browser-close":
    case "POST browser-preview":
      valid = isV1Identifier(value.tabId);
      break;
    case "POST browser-navigate":
      valid = isV1Identifier(value.tabId) && isV1OneOf(["back", "forward"], value.direction);
      break;
    case "POST browser-visible":
      valid = isBoolean(value.visible) && (value.bounds === undefined || isV1BrowserBounds(value.bounds));
      break;
    case "PATCH team-member":
      valid =
        (value.role === undefined || value.role === "admin" || value.role === "member") &&
        (value.disabled === undefined || isBoolean(value.disabled)) &&
        (value.role !== undefined || value.disabled !== undefined);
      break;
    case "POST team-invites":
      valid =
        (value.role === "admin" || value.role === "member") &&
        (value.email === undefined || isV1LimitedString(value.email, 254));
      break;
    case "POST sidebar-action":
      valid = isV1SidebarAction(value);
      break;
    case "POST agents":
      valid =
        isV1LimitedString(value.name, 80) &&
        isV1BoundedString(value.description, 2_000) &&
        isString(value.avatarSeed) &&
        (value.avatarHue === null || isV1OneOf([0, 30, 55, 100, 150, 185, 215, 245, 280, 320], value.avatarHue)) &&
        isV1BoundedString(value.initialMessage, 100_000);
      break;
    case "PATCH agent":
      valid = isV1BotUpdate(value);
      break;
    case "POST memories":
    case "PATCH memory":
      valid = isV1BoundedString(value.text, 20_000);
      break;
    case "POST routines":
      valid = isV1RoutineMutation(value, true);
      break;
    case "PATCH routine":
      valid = isV1RoutineMutation(value, false);
      break;
    case "POST conversation-read":
      valid = value.throughMessageId === null || isV1Identifier(value.throughMessageId);
      break;
    case "POST messages":
      valid =
        isV1BoundedString(value.text, 100_000) &&
        (value.attachmentDraftIds === undefined || isV1IdentifierList(value.attachmentDraftIds, 10)) &&
        isV1OptionalNullableIdentifier(value.replyToMessageId);
      break;
    case "POST failure-acknowledge":
    case "POST interrupt":
      valid = isV1Identifier(value.turnId);
      break;
    case "POST reaction":
      valid = isV1Identifier(value.messageId) && (value.emoji === null || isV1BoundedString(value.emoji, 32));
      break;
    case "POST queue-cancel":
      valid = isV1Identifier(value.deliveryId);
      break;
    case "POST queue-steer":
      valid = isV1Identifier(value.deliveryId) && isV1Identifier(value.expectedTurnId);
      break;
    case "POST queue-update":
      valid =
        isV1Identifier(value.deliveryId) &&
        isV1BoundedString(value.text, 100_000) &&
        isV1IdentifierList(value.keepAttachmentIds, 10) &&
        isV1IdentifierList(value.attachmentDraftIds, 10);
      break;
    case "POST queue-reorder":
      valid = isV1IdentifierList(value.deliveryIds, 100);
      break;
    case "POST prompt-response":
      valid = isV1RequestId(value.requestId) && isV1PromptAnswers(value.answers);
      break;
    case "POST approval-response":
      valid = isV1RequestId(value.requestId) && isV1OneOf(["accept", "decline"], value.decision);
      break;
    case "POST browser-takeover-response":
      valid = isV1RequestId(value.requestId) && isV1OneOf(["complete", "cancel"], value.decision);
      break;
    default:
      valid = TEAM_PROTOCOL_V1_HTTP_CONTRACTS[route].request === "none";
  }
  if (!valid) throw new Error("Invalid Team protocol v1 HTTP request.");
}

function validateTeamProtocolV1HttpResponse(route: TeamProtocolV1HttpRoute, value: TeamProtocolV1JsonValue): void {
  let valid = false;
  switch (route) {
    case "GET compatibility":
      try {
        decodeTeamProtocolSupportV1(value);
        valid = true;
      } catch {
        valid = false;
      }
      break;
    case "GET identity":
      valid = value === null || isV1Identity(value);
      break;
    case "POST invitation-preview":
      valid = isV1InvitePreview(value);
      break;
    case "POST join":
    case "POST join-account":
    case "POST auth-login":
    case "POST auth-account":
      valid = isV1JoinResult(value);
      break;
    case "GET me":
    case "PATCH team-member":
      valid = isV1TeamMember(value);
      break;
    case "GET team-presence":
      valid = isTeamProtocolV1PresenceSnapshot(value);
      break;
    case "GET remote-capabilities":
      valid = isV1RemoteCapabilities(value);
      break;
    case "POST remote-session":
      valid = isV1RemoteSession(value);
      break;
    case "GET direct-threads":
      valid = Array.isArray(value) && value.every(isV1DirectThread);
      break;
    case "POST direct-message":
      valid = isTeamProtocolV1DirectMessage(value);
      break;
    case "GET direct-conversation":
      valid = isV1DirectConversation(value, false);
      break;
    case "GET direct-conversation-page":
      valid = isV1DirectConversation(value, true);
      break;
    case "POST direct-conversation-read":
      valid = isV1DirectReadState(value);
      break;
    case "GET browser-tabs":
      valid = Array.isArray(value) && value.every(isV1BrowserTab);
      break;
    case "GET browser-control":
      valid = isV1BrowserControl(value);
      break;
    case "POST browser-open":
      valid = isV1BrowserTab(value);
      break;
    case "POST browser-preview":
      valid = isV1BrowserPreview(value);
      break;
    case "POST attachment-upload":
      valid = isV1Attachment(value);
      break;
    case "GET team-members":
      valid = Array.isArray(value) && value.every(isV1TeamMember);
      break;
    case "POST team-invites":
      valid = isV1TeamInvite(value, true);
      break;
    case "GET team-invites":
      valid = Array.isArray(value) && value.every((invite) => isV1TeamInvite(invite, false));
      break;
    case "GET team-sessions":
      valid = Array.isArray(value) && value.every(isV1TeamSession);
      break;
    case "GET agent-status":
      valid = isV1AgentStatus(value);
      break;
    case "GET sidebar-layout":
    case "POST sidebar-action":
      valid = isV1SidebarLayout(value);
      break;
    case "GET agent-usage":
      valid = isV1AccountUsage(value);
      break;
    case "GET agent-models":
      valid = Array.isArray(value) && value.every(isV1AgentModelOption);
      break;
    case "GET agents":
      valid = Array.isArray(value) && value.every(isV1BotSummary);
      break;
    case "POST agents":
    case "PATCH agent":
    case "PUT agent-avatar":
    case "DELETE agent-avatar":
      valid = isV1BotSummary(value);
      break;
    case "GET conversation-reads":
      valid = isV1ConversationReadStates(value);
      break;
    case "GET memories":
      valid = Array.isArray(value) && value.every(isV1Memory);
      break;
    case "POST memories":
    case "PATCH memory":
      valid = isV1Memory(value);
      break;
    case "GET routines":
      valid = Array.isArray(value) && value.every(isV1Routine);
      break;
    case "POST routines":
    case "PATCH routine":
      valid = isV1Routine(value);
      break;
    case "POST routine-test":
      valid = isV1RoutineRun(value);
      break;
    case "GET routine-runs":
      valid = Array.isArray(value) && value.every(isV1RoutineRun);
      break;
    case "GET conversation":
      valid = isV1ConversationSnapshot(value) && isV1ConversationReadState(value.readState);
      break;
    case "GET conversation-page":
      valid = isV1ConversationPage(value);
      break;
    case "GET message-search":
      valid = isV1ConversationSearch(value);
      break;
    case "POST conversation-read":
      valid = isV1ConversationReadState(value);
      break;
    case "POST messages":
      valid = isV1QueuedMessageReceipt(value);
      break;
    case "GET queue":
      valid = isV1QueueSnapshot(value);
      break;
    default:
      valid = false;
  }
  if (!valid) throw new Error("Invalid Team protocol v1 HTTP response.");
}

function isV1Identity(value: unknown): boolean {
  return (
    isDynamicRecord(value) &&
    isV1Identifier(value.serverId) &&
    isV1LimitedString(value.serverName, 120) &&
    isV1LimitedString(value.fingerprint, 256) &&
    isV1BoundedString(value.publicKey, 8_192) &&
    isBoolean(value.enabledOnLaunch) &&
    (value.logoVersion === null || isV1Identifier(value.logoVersion)) &&
    (value.challenge === undefined || isV1BoundedString(value.challenge, 256)) &&
    (value.signature === undefined || isV1BoundedString(value.signature, 512))
  );
}

function isV1InvitePreview(value: unknown): boolean {
  return (
    isDynamicRecord(value) &&
    isV1OneOf(["admin", "member"], value.role) &&
    isV1Timestamp(value.expiresAt) &&
    isBoolean(value.emailBound)
  );
}

function isV1JoinResult(value: unknown): boolean {
  return (
    isDynamicRecord(value) &&
    isV1TeamMember(value.member) &&
    isV1LimitedString(value.sessionToken, 512) &&
    isV1Timestamp(value.sessionExpiresAt)
  );
}

function isV1TeamMember(value: unknown): boolean {
  return (
    isDynamicRecord(value) &&
    isV1Identifier(value.id) &&
    isV1LimitedString(value.username, 254) &&
    (value.email === null || isV1LimitedString(value.email, 254)) &&
    (value.name === null || isV1LimitedString(value.name, 120)) &&
    (value.avatarUrl === null || isV1HttpUrl(value.avatarUrl, 2_048)) &&
    isV1OneOf(["owner", "admin", "member"], value.role) &&
    isV1Timestamp(value.createdAt) &&
    isBoolean(value.disabled)
  );
}

function isV1RemoteDisplay(value: unknown): boolean {
  return (
    isDynamicRecord(value) &&
    isV1Identifier(value.id) &&
    isV1LimitedString(value.label, 160) &&
    isV1PositiveInteger(value.width) &&
    isV1PositiveInteger(value.height) &&
    isBoolean(value.primary)
  );
}

function isV1RemoteCapabilities(value: unknown): boolean {
  return (
    isDynamicRecord(value) &&
    isBoolean(value.ready) &&
    isV1OneOf(["darwin", "win32", "linux"], value.platform) &&
    isBoolean(value.unattended) &&
    value.runtime === "sunshine-moonlight" &&
    value.protocolVersion === 2 &&
    Array.isArray(value.displays) &&
    value.displays.every(isV1RemoteDisplay) &&
    (value.selectedDisplayId === null || isV1Identifier(value.selectedDisplayId)) &&
    isV1NonNegativeInteger(value.activeSessions) &&
    isV1PositiveInteger(value.maxSessions)
  );
}

function isV1RemoteSession(value: unknown): boolean {
  return (
    isDynamicRecord(value) &&
    isV1Identifier(value.id) &&
    isV1Identifier(value.serverId) &&
    isV1HttpUrl(value.viewerUrl, 8_192) &&
    isV1LimitedString(value.viewerGrant, 512) &&
    Array.isArray(value.displays) &&
    value.displays.every(isV1RemoteDisplay) &&
    (value.selectedDisplayId === null || isV1Identifier(value.selectedDisplayId)) &&
    isV1OneOf(["starting_host", "connecting", "connected", "disconnecting", "error"], value.phase) &&
    isV1OneOf(["unknown", "p2p", "relay"], value.transport) &&
    (value.errorCode === null ||
      isV1OneOf(
        [
          "host_unavailable",
          "host_permissions_required",
          "session_capacity_reached",
          "session_expired",
          "session_revoked",
          "protocol_mismatch",
          "connection_failed",
        ],
        value.errorCode,
      )) &&
    (value.message === null || isV1BoundedString(value.message, 2_000)) &&
    isV1Timestamp(value.createdAt) &&
    isV1Timestamp(value.grantExpiresAt)
  );
}

function isV1DirectThread(value: unknown): boolean {
  return (
    isDynamicRecord(value) &&
    isV1Identifier(value.threadId) &&
    isV1Identifier(value.otherMemberId) &&
    isTeamProtocolV1DirectMessage(value.lastMessage) &&
    isV1NonNegativeInteger(value.unreadCount) &&
    isV1Timestamp(value.updatedAt)
  );
}

function isV1DirectConversation(value: unknown, paged: boolean): boolean {
  return (
    isDynamicRecord(value) &&
    isV1Identifier(value.threadId) &&
    isV1Identifier(value.otherMemberId) &&
    Array.isArray(value.messages) &&
    value.messages.every(isTeamProtocolV1DirectMessage) &&
    isV1Revision(value.revision) &&
    (value.readState === undefined || isV1DirectReadState(value.readState)) &&
    (!paged || isV1PageInfo(value.pageInfo))
  );
}

function isV1DirectReadState(value: unknown): boolean {
  return (
    isDynamicRecord(value) &&
    isV1NonNegativeInteger(value.unreadCount) &&
    (value.firstUnreadMessageId === null || isV1Identifier(value.firstUnreadMessageId)) &&
    isV1NonNegativeInteger(value.throughSequence)
  );
}

function isV1BrowserTab(value: unknown): boolean {
  return (
    isDynamicRecord(value) &&
    isV1Identifier(value.id) &&
    isV1BoundedString(value.title, 2_000) &&
    isV1BoundedString(value.url, 8_192) &&
    isBoolean(value.loading) &&
    (value.ownerThreadId === null || isV1Identifier(value.ownerThreadId)) &&
    (value.ownerBotId === null || isV1Identifier(value.ownerBotId))
  );
}

function isV1BrowserControl(value: unknown): boolean {
  return (
    isDynamicRecord(value) &&
    Array.isArray(value.sessions) &&
    value.sessions.every(
      (session) =>
        isDynamicRecord(session) &&
        isV1Identifier(session.id) &&
        isV1Identifier(session.threadId) &&
        isV1Identifier(session.turnId) &&
        isV1Identifier(session.callId) &&
        (session.tabId === null || isV1Identifier(session.tabId)) &&
        isV1OneOf(
          [
            "open",
            "list-tabs",
            "snapshot",
            "click",
            "type",
            "key",
            "scroll",
            "back",
            "forward",
            "reload",
            "screenshot",
            "close-tab",
          ],
          session.action,
        ) &&
        isV1OneOf(["acting", "waiting"], session.phase) &&
        isV1Timestamp(session.startedAt),
    )
  );
}

function isV1BrowserPreview(value: unknown): boolean {
  return (
    isDynamicRecord(value) &&
    isV1BoundedString(value.dataUrl, 2_000_000) &&
    /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/u.test(value.dataUrl) &&
    isV1PositiveInteger(value.width) &&
    value.width <= 960 &&
    isV1PositiveInteger(value.height) &&
    value.height <= 600
  );
}

function isV1TeamInvite(value: unknown, includeUrl: boolean): boolean {
  return (
    isDynamicRecord(value) &&
    isV1Identifier(value.id) &&
    isV1OneOf(["admin", "member"], value.role) &&
    isV1Timestamp(value.expiresAt) &&
    (value.usedAt === null || isV1Timestamp(value.usedAt)) &&
    (value.email === null || isV1LimitedString(value.email, 254)) &&
    (!includeUrl || isV1BoundedString(value.inviteUrl, 8_192))
  );
}

function isV1TeamSession(value: unknown): boolean {
  return (
    isDynamicRecord(value) &&
    isV1Identifier(value.id) &&
    isV1Identifier(value.memberId) &&
    isV1LimitedString(value.username, 254) &&
    isV1Timestamp(value.createdAt) &&
    isV1Timestamp(value.expiresAt)
  );
}

function isV1AgentStatus(value: unknown): boolean {
  return (
    isDynamicRecord(value) &&
    isV1OneOf(["idle", "starting", "ready", "restarting", "blocked", "stopped"], value.phase) &&
    (value.cliVersion === null || isV1BoundedString(value.cliVersion, 160)) &&
    isV1AgentAuth(value.auth) &&
    (value.providers === undefined || (Array.isArray(value.providers) && value.providers.every(isV1ProviderStatus))) &&
    isDynamicRecord(value.capabilities) &&
    isV1CapabilityState(value.capabilities.chat) &&
    isV1CapabilityState(value.capabilities.browser) &&
    isV1CapabilityState(value.capabilities.computerUse) &&
    (value.message === null || isV1BoundedString(value.message, 2_000)) &&
    value.fullAccess === true
  );
}

function isV1AgentAuth(value: unknown): boolean {
  if (!isDynamicRecord(value)) return false;
  if (value.kind === "unknown" || value.kind === "signed-out") return true;
  if (value.kind === "unsupported") return isV1BoundedString(value.accountType, 160);
  return (
    (value.kind === "chatgpt" || value.kind === "claude" || value.kind === "grok") &&
    (value.email === null || isV1BoundedString(value.email, 254))
  );
}

function isV1ProviderStatus(value: unknown): boolean {
  return (
    isDynamicRecord(value) &&
    isV1OneOf(["codex", "claude", "grok"], value.id) &&
    isV1OneOf(
      ["not-started", "checking", "available", "sign-in-required", "not-installed", "outdated", "error"],
      value.state,
    ) &&
    (value.version === null || isV1BoundedString(value.version, 160)) &&
    (value.message === null || isV1BoundedString(value.message, 2_000)) &&
    (value.email === undefined || value.email === null || isV1BoundedString(value.email, 254)) &&
    (value.connectionState === undefined || value.connectionState === "connecting") &&
    (value.checkError === undefined || value.checkError === null || isV1BoundedString(value.checkError, 2_000))
  );
}

function isV1CapabilityState(value: unknown): boolean {
  return isV1OneOf(["ready", "setup-required", "unavailable"], value);
}

function isV1AccountUsage(value: unknown): boolean {
  return (
    isDynamicRecord(value) &&
    Array.isArray(value.limits) &&
    value.limits.every(
      (limit) =>
        isDynamicRecord(limit) &&
        isV1Identifier(limit.id) &&
        (limit.primary === null || isV1UsageWindow(limit.primary)) &&
        (limit.secondary === null || isV1UsageWindow(limit.secondary)),
    )
  );
}

function isV1UsageWindow(value: unknown): boolean {
  return (
    isDynamicRecord(value) &&
    isNumber(value.usedPercent) &&
    Number.isFinite(value.usedPercent) &&
    (value.windowDurationMins === null || isV1NonNegativeInteger(value.windowDurationMins)) &&
    (value.resetsAt === null || (isNumber(value.resetsAt) && Number.isFinite(value.resetsAt)))
  );
}

function isV1AgentModelOption(value: unknown): boolean {
  return (
    isDynamicRecord(value) &&
    isV1OneOf(["codex", "claude", "grok"], value.provider) &&
    isV1BoundedString(value.id, 160) &&
    isV1LimitedString(value.name, 160) &&
    isV1BoundedString(value.description, 2_000) &&
    isV1OneOf(["low", "medium", "high", "xhigh", "max"], value.defaultReasoningEffort) &&
    Array.isArray(value.supportedReasoningEfforts) &&
    value.supportedReasoningEfforts.every((effort) => isV1OneOf(["low", "medium", "high", "xhigh", "max"], effort))
  );
}

function isV1ConversationReadStates(value: unknown): boolean {
  return isDynamicRecord(value) && Object.values(value).every(isV1ConversationReadState);
}

function isV1Memory(value: unknown): boolean {
  return (
    isDynamicRecord(value) &&
    isV1Identifier(value.id) &&
    isV1Identifier(value.botId) &&
    isV1BoundedString(value.text, 20_000) &&
    isV1OneOf(["automatic", "manual"], value.origin) &&
    (value.sourceTurnId === null || isV1Identifier(value.sourceTurnId)) &&
    isV1Timestamp(value.createdAt) &&
    isV1Timestamp(value.updatedAt)
  );
}

function isV1Routine(value: unknown): boolean {
  return (
    isDynamicRecord(value) &&
    isV1Identifier(value.id) &&
    isV1Identifier(value.botId) &&
    isV1LimitedString(value.name, 160) &&
    isV1BoundedString(value.instruction, 100_000) &&
    isBoolean(value.active) &&
    isV1LimitedString(value.timezone, 128) &&
    isDynamicRecord(value.trigger) &&
    isV1Identifier(value.trigger.id) &&
    isV1Identifier(value.trigger.routineId) &&
    isV1RoutineSchedule(value.trigger.schedule) &&
    isV1Timestamp(value.trigger.nextRunAt) &&
    isV1Timestamp(value.trigger.createdAt) &&
    isV1Timestamp(value.trigger.updatedAt) &&
    isV1Timestamp(value.createdAt) &&
    isV1Timestamp(value.updatedAt)
  );
}

function isV1RoutineRun(value: unknown): boolean {
  return (
    isDynamicRecord(value) &&
    isV1Identifier(value.id) &&
    isV1Identifier(value.routineId) &&
    isV1Identifier(value.botId) &&
    (value.triggerId === null || isV1Identifier(value.triggerId)) &&
    isV1OneOf(["scheduled", "manual"], value.kind) &&
    isV1Timestamp(value.scheduledFor) &&
    isV1LimitedString(value.routineName, 160) &&
    isV1BoundedString(value.instruction, 100_000) &&
    (value.deliveryId === null || isV1Identifier(value.deliveryId)) &&
    isV1OneOf(
      ["queued", "running", "needs-attention", "succeeded", "failed", "interrupted", "cancelled"],
      value.status,
    ) &&
    (value.error === null || isV1BoundedString(value.error, 100_000)) &&
    isV1Timestamp(value.createdAt) &&
    isV1Timestamp(value.updatedAt)
  );
}

function isV1ConversationSearch(value: unknown): boolean {
  return (
    isDynamicRecord(value) &&
    Array.isArray(value.results) &&
    value.results.every(
      (result) => isDynamicRecord(result) && isV1Identifier(result.botId) && isV1ConversationMessage(result.message),
    ) &&
    isV1NonNegativeInteger(value.total) &&
    (value.nextCursor === null || isV1BoundedString(value.nextCursor, 512))
  );
}

function isV1QueuedMessageReceipt(value: unknown): boolean {
  return (
    isDynamicRecord(value) &&
    isV1Identifier(value.messageId) &&
    Array.isArray(value.deliveries) &&
    value.deliveries.every(
      (delivery) =>
        isDynamicRecord(delivery) &&
        isV1Identifier(delivery.id) &&
        isV1Identifier(delivery.recipientBotId) &&
        isV1QueueStatus(delivery.status) &&
        isV1QueuePosition(delivery.position),
    )
  );
}

function isV1SidebarAction(value: TeamProtocolV1JsonObject): boolean {
  if (!isString(value.type)) return false;
  if (value.type === "create")
    return isV1LimitedString(value.name, 40) && (value.agentId === undefined || isV1Identifier(value.agentId));
  if (value.type === "rename") return isV1Identifier(value.sectionId) && isV1LimitedString(value.name, 40);
  if (value.type === "delete") return isV1Identifier(value.sectionId);
  if (value.type === "move") {
    return (
      isV1Identifier(value.sectionId) &&
      isV1OneOf(["up", "down"], value.direction) &&
      (value.steps === undefined || isV1PositiveInteger(value.steps))
    );
  }
  if (value.type === "assign")
    return isV1Identifier(value.agentId) && (value.sectionId === null || isV1Identifier(value.sectionId));
  return (
    value.type === "move-agent" &&
    isV1Identifier(value.agentId) &&
    (value.sectionId === null || isV1Identifier(value.sectionId)) &&
    (value.beforeAgentId === null || isV1Identifier(value.beforeAgentId))
  );
}

function isV1BotUpdate(value: TeamProtocolV1JsonObject): boolean {
  const fields = [
    "name",
    "title",
    "description",
    "notifications",
    "provider",
    "model",
    "reasoningEffort",
    "avatarSeed",
    "avatarHue",
  ];
  if (!fields.some((field) => value[field] !== undefined)) return false;
  return (
    (value.name === undefined || isV1BoundedString(value.name, 80)) &&
    (value.title === undefined || isV1BoundedString(value.title, 120)) &&
    (value.description === undefined || isV1BoundedString(value.description, 2_000)) &&
    (value.notifications === undefined || isBoolean(value.notifications)) &&
    (value.provider === undefined || isV1OneOf(["codex", "claude", "grok"], value.provider)) &&
    (value.model === undefined || isV1BoundedString(value.model, 160)) &&
    (value.reasoningEffort === undefined ||
      isV1OneOf(["low", "medium", "high", "xhigh", "max"], value.reasoningEffort)) &&
    (value.avatarSeed === undefined || isV1BoundedString(value.avatarSeed, 128)) &&
    (value.avatarHue === undefined ||
      value.avatarHue === null ||
      isV1OneOf([0, 30, 55, 100, 150, 185, 215, 245, 280, 320], value.avatarHue))
  );
}

function isV1RoutineMutation(value: TeamProtocolV1JsonObject, create: boolean): boolean {
  return (
    (!create ||
      (isV1LimitedString(value.name, 160) &&
        isV1BoundedString(value.instruction, 100_000) &&
        isBoolean(value.active) &&
        isV1LimitedString(value.timezone, 128) &&
        isV1RoutineSchedule(value.schedule))) &&
    (value.name === undefined || isV1LimitedString(value.name, 160)) &&
    (value.instruction === undefined || isV1BoundedString(value.instruction, 100_000)) &&
    (value.active === undefined || isBoolean(value.active)) &&
    (value.timezone === undefined || isV1LimitedString(value.timezone, 128)) &&
    (value.schedule === undefined || isV1RoutineSchedule(value.schedule))
  );
}

function isV1RoutineSchedule(value: unknown): boolean {
  if (!isDynamicRecord(value) || !isString(value.kind)) return false;
  switch (value.kind) {
    case "hourly":
      return isV1IntegerInRange(value.minute, 0, 59);
    case "daily":
    case "weekdays":
      return isV1RoutineTime(value.time);
    case "weekly":
      return isV1IntegerInRange(value.weekday, 0, 6) && isV1RoutineTime(value.time);
    case "monthly":
      return isV1IntegerInRange(value.day, 1, 31) && isV1RoutineTime(value.time);
    case "interval":
      return (
        isV1IntegerInRange(value.amount, 1, 100_000) &&
        isV1OneOf(["minutes", "hours", "days"], value.unit) &&
        isV1Timestamp(value.anchorAt)
      );
    case "advanced":
      return (
        Array.isArray(value.months) &&
        value.months.length > 0 &&
        value.months.every((month) => isV1IntegerInRange(month, 1, 12)) &&
        isV1RoutineDays(value.days) &&
        isV1RoutineTimeSelection(value.time)
      );
    case "custom":
      return isV1LimitedString(value.expression, 512);
    default:
      return false;
  }
}

function isV1RoutineDays(value: unknown): boolean {
  if (!isDynamicRecord(value) || !isString(value.kind)) return false;
  if (value.kind === "every-day") return true;
  if (!Array.isArray(value.days) || value.days.length === 0) return false;
  if (value.kind === "days-of-week") return value.days.every((day) => isV1IntegerInRange(day, 0, 6));
  return value.kind === "days-of-month" && value.days.every((day) => isV1IntegerInRange(day, 1, 31));
}

function isV1RoutineTimeSelection(value: unknown): boolean {
  return (
    isDynamicRecord(value) &&
    ((value.kind === "at-time" && isV1RoutineTime(value.time)) ||
      (value.kind === "every" &&
        isV1IntegerInRange(value.amount, 1, 100_000) &&
        isV1OneOf(["minutes", "hours"], value.unit)))
  );
}

function isV1RoutineTime(value: unknown): boolean {
  return isString(value) && /^([01]\d|2[0-3]):[0-5]\d$/u.test(value);
}

function isV1PromptAnswers(value: unknown): boolean {
  return (
    isDynamicRecord(value) &&
    Object.keys(value).length <= 32 &&
    Object.values(value).every(
      (answers) => Array.isArray(answers) && answers.every((answer) => isV1BoundedString(answer, 20_000)),
    )
  );
}

function isV1BrowserBounds(value: unknown): boolean {
  return (
    isDynamicRecord(value) &&
    [value.x, value.y, value.width, value.height].every((item) => isNumber(item) && Number.isFinite(item))
  );
}

function isV1PageInfo(value: unknown): boolean {
  return (
    isDynamicRecord(value) &&
    isBoolean(value.hasOlder) &&
    (value.olderCursor === null || isV1BoundedString(value.olderCursor, 512))
  );
}

function isV1OptionalNullableIdentifier(value: unknown): boolean {
  return value === undefined || value === null || isV1Identifier(value);
}

function isV1NonNegativeInteger(value: unknown): value is number {
  return isNumber(value) && Number.isSafeInteger(value) && value >= 0;
}

function isV1PositiveInteger(value: unknown): value is number {
  return isNumber(value) && Number.isSafeInteger(value) && value > 0;
}

function isV1IntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return isNumber(value) && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
