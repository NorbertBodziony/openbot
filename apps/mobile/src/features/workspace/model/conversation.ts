import { type ConversationMessage, type ConversationSnapshot, isConversationMessage } from "@openbot/contracts/ipc";
import { isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";

export function decodeConversation(value: unknown): ConversationSnapshot {
  if (
    !isDynamicRecord(value) ||
    !isString(value.botId) ||
    (value.threadId !== null && !isString(value.threadId)) ||
    (value.activeTurnId !== null && !isString(value.activeTurnId)) ||
    !isNumber(value.revision) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !Array.isArray(value.messages)
  ) {
    throw new Error("The server returned an invalid conversation.");
  }
  return {
    botId: value.botId,
    threadId: value.threadId,
    activeTurnId: value.activeTurnId,
    revision: value.revision,
    messages: value.messages.map(decodeConversationMessage),
  };
}

function decodeConversationMessage(value: unknown): ConversationMessage {
  if (!isConversationMessage(value)) throw new Error("The server returned an invalid conversation message.");
  return value;
}
