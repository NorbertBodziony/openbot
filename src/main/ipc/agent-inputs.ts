import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import {
  type AgentIpcRequest,
  type CancelQueuedMessageInput,
  type ImportAttachmentsInput,
  type InterruptTurnInput,
  isAgentModel,
  isAvatarHue,
  isAvatarSeed,
  isMessageReaction,
  isReasoningEffort,
  type OpenAttachmentInput,
  type RespondToPromptInput,
  type SendMessageInput,
  type SetMessageReactionInput,
  type SetQueuePausedInput,
  type UpdateBotInput,
} from "@openbot/contracts/ipc";
import { isObject, requireString } from "./validation";

export function parseAgentRequest(value: unknown): AgentIpcRequest {
  if (!isObject(value)) throw new Error("Invalid agent request.");
  return {
    serverId: requireString(value.serverId, "serverId"),
    payload: value.payload,
  };
}

export function parseSendMessage(value: unknown): SendMessageInput {
  if (!isObject(value)) throw new Error("Invalid send message request.");
  const attachmentDraftIds = value.attachmentDraftIds ?? [];
  if (
    !Array.isArray(attachmentDraftIds) ||
    attachmentDraftIds.length > INPUT_LIMITS.attachments ||
    !attachmentDraftIds.every(
      (item) => typeof item === "string" && item.length <= INPUT_LIMITS.identifier,
    )
  ) {
    throw new Error("Invalid attachment drafts.");
  }
  if (typeof value.text !== "string") throw new Error("text is required.");
  if (value.text.length > INPUT_LIMITS.messageText) throw new Error("Message is too long.");
  if (!value.text.trim() && attachmentDraftIds.length === 0) {
    throw new Error("A message or attachment is required.");
  }
  const replyToMessageId = value.replyToMessageId ?? null;
  if (
    replyToMessageId !== null &&
    (typeof replyToMessageId !== "string" || replyToMessageId.length > INPUT_LIMITS.identifier)
  ) {
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

export function parseUpdateBot(value: unknown): UpdateBotInput {
  if (!isObject(value)) throw new Error("Invalid bot update request.");
  const result: UpdateBotInput = { botId: requireString(value.botId, "botId") };
  const limits = {
    name: INPUT_LIMITS.agentName,
    role: INPUT_LIMITS.agentTitle,
    description: INPUT_LIMITS.agentDescription,
  } as const;
  for (const field of ["name", "role", "description"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      throw new Error(`Invalid ${field}.`);
    }
    if (typeof value[field] === "string") {
      if (value[field].length > limits[field]) throw new Error(`${field} is too long.`);
      result[field] = value[field];
    }
  }
  if (value.notifications !== undefined) {
    if (typeof value.notifications !== "boolean") throw new Error("Invalid notifications value.");
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

export function parseImportAttachments(value: unknown): ImportAttachmentsInput {
  if (!isObject(value) || !Array.isArray(value.paths) || !Array.isArray(value.data)) {
    throw new Error("Invalid attachment import.");
  }
  if (value.paths.length + value.data.length > INPUT_LIMITS.attachments) {
    throw new Error(`Choose at most ${INPUT_LIMITS.attachments} files.`);
  }
  if (
    !value.paths.every(
      (path) => typeof path === "string" && path.length > 0 && path.length <= INPUT_LIMITS.path,
    )
  ) {
    throw new Error("Invalid attachment path.");
  }
  const data = value.data.map((item) => {
    if (
      !isObject(item) ||
      typeof item.name !== "string" ||
      item.name.length > INPUT_LIMITS.attachmentName ||
      typeof item.mimeType !== "string" ||
      item.mimeType.length > INPUT_LIMITS.mimeType ||
      !(item.bytes instanceof Uint8Array)
    ) {
      throw new Error("Invalid attachment data.");
    }
    return { name: item.name, mimeType: item.mimeType, bytes: item.bytes };
  });
  return { paths: value.paths, data };
}

export function parseOpenAttachment(value: unknown): OpenAttachmentInput {
  if (!isObject(value) || (value.action !== "open" && value.action !== "reveal")) {
    throw new Error("Invalid attachment action.");
  }
  return {
    attachmentId: requireString(value.attachmentId, "attachmentId"),
    action: value.action,
  };
}

export function parseCancelQueuedMessage(value: unknown): CancelQueuedMessageInput {
  if (!isObject(value)) throw new Error("Invalid queue cancellation request.");
  return {
    botId: requireString(value.botId, "botId"),
    deliveryId: requireString(value.deliveryId, "deliveryId"),
  };
}

export function parseSetQueuePaused(value: unknown): SetQueuePausedInput {
  if (!isObject(value) || typeof value.paused !== "boolean") {
    throw new Error("Invalid queue pause request.");
  }
  return { botId: requireString(value.botId, "botId"), paused: value.paused };
}

export function parseInterrupt(value: unknown): InterruptTurnInput {
  if (!isObject(value)) throw new Error("Invalid interrupt request.");
  return {
    botId: requireString(value.botId, "botId"),
    turnId: requireString(value.turnId, "turnId"),
  };
}

export function parsePromptResponse(value: unknown): RespondToPromptInput {
  if (
    !isObject(value) ||
    (typeof value.requestId !== "string" && typeof value.requestId !== "number")
  ) {
    throw new Error("Invalid prompt response.");
  }
  if (
    (typeof value.requestId === "string" &&
      (value.requestId.length === 0 || value.requestId.length > INPUT_LIMITS.identifier)) ||
    (typeof value.requestId === "number" && !Number.isSafeInteger(value.requestId))
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
      !answer.every(
        (item) => typeof item === "string" && item.length <= INPUT_LIMITS.promptAnswerText,
      )
    ) {
      throw new Error("Invalid prompt answer.");
    }
    answers[key] = answer;
  }
  return { requestId: value.requestId, answers };
}
