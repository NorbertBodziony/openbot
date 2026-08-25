import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import {
  type AgentIpcRequest,
  type CancelQueuedMessageInput,
  type ChooseAttachmentsInput,
  type CreateBotInput,
  type ImportAttachmentsInput,
  type InterruptTurnInput,
  isAgentModel,
  isAvatarHue,
  isAvatarSeed,
  isMessageReaction,
  isReasoningEffort,
  type MarkConversationReadInput,
  type OpenAttachmentInput,
  type OpenSharedFileInput,
  type OpenWorkspaceFileInput,
  type ReadConversationPageInput,
  type ReorderQueueInput,
  type RespondToApprovalInput,
  type RespondToPromptInput,
  type SearchConversationMessagesInput,
  type SendMessageInput,
  type SetAgentAvatarInput,
  type SetMessageReactionInput,
  type SteerQueuedMessageInput,
  type UpdateBotInput,
  type UpdateQueuedMessageInput,
} from "@openbot/contracts/ipc";
import { isBoolean, isNumber, isString } from "@openbot/contracts/runtime-values";
import { parseAvatarImage } from "./avatar-inputs";
import { isObject, requireString } from "./validation";

export function parseAgentRequest(value: unknown): AgentIpcRequest {
  if (!isObject(value)) throw new Error("Invalid agent request.");
  return {
    serverId: requireString(value.serverId, "serverId"),
    payload: value.payload,
  };
}

export function parseCreateBot(value: unknown): CreateBotInput {
  if (!isObject(value)) throw new Error("Invalid bot creation request.");
  const avatarHue = value.avatarHue;
  if (!isAvatarSeed(value.avatarSeed)) throw new Error("Invalid avatar seed.");
  if (avatarHue !== null && !isAvatarHue(avatarHue)) throw new Error("Invalid avatar hue.");
  return {
    name: requireString(value.name, "name", INPUT_LIMITS.agentName),
    description: requireString(value.description, "description", INPUT_LIMITS.agentDescription),
    avatarSeed: value.avatarSeed,
    avatarHue,
    initialMessage: requireString(value.initialMessage, "initialMessage", INPUT_LIMITS.messageText),
  };
}

export function parseReadConversationPage(value: unknown): ReadConversationPageInput {
  if (!isObject(value)) throw new Error("Invalid conversation page request.");
  return {
    botId: requireString(value.botId, "botId", INPUT_LIMITS.identifier),
    anchor: parsePageAnchor(value.anchor),
    limit: parsePageLimit(value.limit),
  };
}

export function parseSearchConversationMessages(value: unknown): SearchConversationMessagesInput {
  if (!isObject(value)) throw new Error("Invalid conversation search request.");
  const query = requireString(value.query, "query", INPUT_LIMITS.messageText);
  if (!query.trim()) throw new Error("A search query is required.");
  const limit = parsePageLimit(value.limit ?? 100);
  return {
    query,
    ...(value.botId === undefined ? {} : { botId: requireString(value.botId, "botId", INPUT_LIMITS.identifier) }),
    ...(value.cursor === undefined ? {} : { cursor: requireString(value.cursor, "cursor", 2048) }),
    limit,
  };
}

function parsePageAnchor(value: unknown): ReadConversationPageInput["anchor"] {
  if (value === undefined) return { type: "latest" };
  if (!isObject(value) || !isString(value.type)) throw new Error("Invalid conversation page anchor.");
  if (value.type === "latest") return { type: "latest" };
  if (value.type === "before") return { type: "before", cursor: requireString(value.cursor, "cursor", 2048) };
  if (value.type === "around") {
    return { type: "around", messageId: requireString(value.messageId, "messageId", INPUT_LIMITS.identifier) };
  }
  throw new Error("Invalid conversation page anchor.");
}

function parsePageLimit(value: unknown): number {
  if (value === undefined) return 50;
  if (!isNumber(value) || !Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error("The conversation page limit must be between 1 and 100.");
  }
  return value;
}

export function parseSendMessage(value: unknown): SendMessageInput {
  if (!isObject(value)) throw new Error("Invalid send message request.");
  const attachmentDraftIds = value.attachmentDraftIds ?? [];
  if (
    !Array.isArray(attachmentDraftIds) ||
    attachmentDraftIds.length > INPUT_LIMITS.attachments ||
    !attachmentDraftIds.every((item) => isString(item) && item.length <= INPUT_LIMITS.identifier)
  ) {
    throw new Error("Invalid attachment drafts.");
  }
  if (!isString(value.text)) throw new Error("text is required.");
  if (value.text.length > INPUT_LIMITS.messageText) throw new Error("Message is too long.");
  if (!value.text.trim() && attachmentDraftIds.length === 0) {
    throw new Error("A message or attachment is required.");
  }
  const replyToMessageId = value.replyToMessageId ?? null;
  if (replyToMessageId !== null && (!isString(replyToMessageId) || replyToMessageId.length > INPUT_LIMITS.identifier)) {
    throw new Error("Invalid reply target.");
  }
  return {
    botId: requireString(value.botId, "botId"),
    text: value.text,
    attachmentDraftIds,
    replyToMessageId: replyToMessageId?.trim() || null,
  };
}

export function parseMessageReaction(value: unknown): SetMessageReactionInput {
  if (!isObject(value)) throw new Error("Invalid message reaction request.");
  const emoji = value.emoji;
  if (emoji !== null && !isMessageReaction(emoji)) {
    throw new Error("Invalid message reaction.");
  }
  return {
    botId: requireString(value.botId, "botId"),
    messageId: requireString(value.messageId, "messageId"),
    emoji,
  };
}

export function parseMarkConversationRead(value: unknown): MarkConversationReadInput {
  if (!isObject(value)) throw new Error("Invalid conversation read request.");
  const throughMessageId = value.throughMessageId;
  if (throughMessageId !== null && !isString(throughMessageId)) {
    throw new Error("Invalid conversation read boundary.");
  }
  return {
    botId: requireString(value.botId, "botId", INPUT_LIMITS.identifier),
    throughMessageId:
      throughMessageId === null ? null : requireString(throughMessageId, "throughMessageId", INPUT_LIMITS.identifier),
  };
}

export function parseUpdateBot(value: unknown): UpdateBotInput {
  if (!isObject(value)) throw new Error("Invalid bot update request.");
  if (value.role !== undefined) throw new Error("Invalid role.");
  const result: UpdateBotInput = { botId: requireString(value.botId, "botId") };
  const limits = {
    name: INPUT_LIMITS.agentName,
    title: INPUT_LIMITS.agentTitle,
    description: INPUT_LIMITS.agentDescription,
  } as const;
  for (const field of ["name", "title", "description"] as const) {
    if (value[field] !== undefined && !isString(value[field])) {
      throw new Error(`Invalid ${field}.`);
    }
    if (isString(value[field])) {
      if (value[field].length > limits[field]) throw new Error(`${field} is too long.`);
      result[field] = value[field];
    }
  }
  if (value.notifications !== undefined) {
    if (!isBoolean(value.notifications)) throw new Error("Invalid notifications value.");
    result.notifications = value.notifications;
  }
  if (value.model !== undefined) {
    if (!isAgentModel(value.model)) throw new Error("Invalid agent model.");
    result.model = value.model;
  }
  if (value.reasoningEffort !== undefined) {
    if (!isReasoningEffort(value.reasoningEffort)) throw new Error("Invalid reasoning effort.");
    result.reasoningEffort = value.reasoningEffort;
  }
  if (value.avatarSeed !== undefined) {
    if (!isAvatarSeed(value.avatarSeed)) throw new Error("Invalid avatar seed.");
    result.avatarSeed = value.avatarSeed;
  }
  if (value.avatarHue !== undefined) {
    if (value.avatarHue !== null && !isAvatarHue(value.avatarHue)) {
      throw new Error("Invalid avatar hue.");
    }
    result.avatarHue = value.avatarHue;
  }
  return result;
}

export function parseSetAgentAvatar(value: unknown): SetAgentAvatarInput {
  if (!isObject(value)) throw new Error("Invalid agent avatar request.");
  return {
    botId: requireString(value.botId, "botId"),
    image: parseAvatarImage(value.image),
  };
}

export function parseImportAttachments(value: unknown): ImportAttachmentsInput {
  if (!isObject(value) || !Array.isArray(value.paths) || !Array.isArray(value.data)) {
    throw new Error("Invalid attachment import.");
  }
  if (value.paths.length + value.data.length > INPUT_LIMITS.attachments) {
    throw new Error(`Choose at most ${INPUT_LIMITS.attachments} files.`);
  }
  if (!value.paths.every((path) => isString(path) && path.length > 0 && path.length <= INPUT_LIMITS.path)) {
    throw new Error("Invalid attachment path.");
  }
  const data = value.data.map((item) => {
    if (
      !isObject(item) ||
      !isString(item.name) ||
      item.name.length > INPUT_LIMITS.attachmentName ||
      !isString(item.mimeType) ||
      item.mimeType.length > INPUT_LIMITS.mimeType ||
      !(item.bytes instanceof Uint8Array)
    ) {
      throw new Error("Invalid attachment data.");
    }
    return { name: item.name, mimeType: item.mimeType, bytes: item.bytes };
  });
  return { paths: value.paths, data };
}

export function parseChooseAttachments(value: unknown): ChooseAttachmentsInput {
  if (!isObject(value) || (value.filter !== "all" && value.filter !== "images")) {
    throw new Error("Invalid attachment picker filter.");
  }
  return { filter: value.filter };
}

export function parseOpenAttachment(value: unknown): OpenAttachmentInput {
  if (!isObject(value) || (value.action !== "open" && value.action !== "reveal" && value.action !== "download")) {
    throw new Error("Invalid attachment action.");
  }
  return {
    attachmentId: requireString(value.attachmentId, "attachmentId"),
    action: value.action,
  };
}

export function parseOpenSharedFile(value: unknown): OpenSharedFileInput {
  if (!isObject(value)) throw new Error("Invalid shared file request.");
  return { path: requireString(value.path, "path", INPUT_LIMITS.path) };
}

export function parseOpenWorkspaceFile(value: unknown): OpenWorkspaceFileInput {
  if (!isObject(value)) throw new Error("Invalid workspace file request.");
  return {
    botId: requireString(value.botId, "botId", INPUT_LIMITS.identifier),
    path: requireString(value.path, "path", INPUT_LIMITS.path),
  };
}

export function parseCancelQueuedMessage(value: unknown): CancelQueuedMessageInput {
  if (!isObject(value)) throw new Error("Invalid queue cancellation request.");
  return {
    botId: requireString(value.botId, "botId"),
    deliveryId: requireString(value.deliveryId, "deliveryId"),
  };
}

export function parseSteerQueuedMessage(value: unknown): SteerQueuedMessageInput {
  if (!isObject(value)) throw new Error("Invalid queued steer request.");
  return {
    botId: requireString(value.botId, "botId"),
    deliveryId: requireString(value.deliveryId, "deliveryId"),
    expectedTurnId: requireString(value.expectedTurnId, "expectedTurnId"),
  };
}

export function parseUpdateQueuedMessage(value: unknown): UpdateQueuedMessageInput {
  if (!isObject(value) || !isString(value.text)) {
    throw new Error("Invalid queued message update request.");
  }
  if (value.text.length > INPUT_LIMITS.messageText) throw new Error("Message is too long.");
  const keepAttachmentIds = parseIdentifierList(value.keepAttachmentIds, "attachment ids");
  const attachmentDraftIds = parseIdentifierList(value.attachmentDraftIds, "attachment drafts");
  if (!value.text.trim() && keepAttachmentIds.length === 0 && attachmentDraftIds.length === 0) {
    throw new Error("A message or attachment is required.");
  }
  return {
    botId: requireString(value.botId, "botId"),
    deliveryId: requireString(value.deliveryId, "deliveryId"),
    text: value.text,
    keepAttachmentIds,
    attachmentDraftIds,
  };
}

export function parseReorderQueue(value: unknown): ReorderQueueInput {
  if (!isObject(value)) throw new Error("Invalid queue reorder request.");
  return {
    botId: requireString(value.botId, "botId"),
    deliveryIds: parseIdentifierList(value.deliveryIds, "delivery ids"),
  };
}

function parseIdentifierList(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length > INPUT_LIMITS.messageRecipients ||
    !value.every((item) => isString(item) && item.length <= INPUT_LIMITS.identifier)
  ) {
    throw new Error(`Invalid ${label}.`);
  }
  if (new Set(value).size !== value.length) throw new Error(`Duplicate ${label}.`);
  return value;
}

export function parseInterrupt(value: unknown): InterruptTurnInput {
  if (!isObject(value)) throw new Error("Invalid interrupt request.");
  return {
    botId: requireString(value.botId, "botId"),
    turnId: requireString(value.turnId, "turnId"),
  };
}

export function parsePromptResponse(value: unknown): RespondToPromptInput {
  if (!isObject(value) || (!isString(value.requestId) && !isNumber(value.requestId))) {
    throw new Error("Invalid prompt response.");
  }
  if (
    (isString(value.requestId) && (value.requestId.length === 0 || value.requestId.length > INPUT_LIMITS.identifier)) ||
    (isNumber(value.requestId) && !Number.isSafeInteger(value.requestId))
  ) {
    throw new Error("Invalid prompt response.");
  }
  if (!isObject(value.answers)) throw new Error("Prompt answers are required.");
  const entries = Object.entries(value.answers);
  if (entries.length > INPUT_LIMITS.promptQuestions) throw new Error("Too many prompt answers.");
  const answers: Record<string, string[]> = {};
  for (const [key, answer] of entries) {
    if (
      key.length > INPUT_LIMITS.identifier ||
      !Array.isArray(answer) ||
      answer.length > INPUT_LIMITS.promptAnswersPerQuestion ||
      !answer.every((item) => isString(item) && item.length <= INPUT_LIMITS.promptAnswerText)
    ) {
      throw new Error("Invalid prompt answer.");
    }
    answers[key] = answer;
  }
  return { requestId: value.requestId, answers };
}

export function parseApprovalResponse(value: unknown): RespondToApprovalInput {
  if (!isObject(value) || (!isString(value.requestId) && !isNumber(value.requestId))) {
    throw new Error("Invalid approval response.");
  }
  if (
    (isString(value.requestId) && (value.requestId.length === 0 || value.requestId.length > INPUT_LIMITS.identifier)) ||
    (isNumber(value.requestId) && !Number.isSafeInteger(value.requestId))
  ) {
    throw new Error("Invalid approval response.");
  }
  if (value.decision !== "accept" && value.decision !== "decline") {
    throw new Error("Invalid approval decision.");
  }
  return { requestId: value.requestId, decision: value.decision };
}
