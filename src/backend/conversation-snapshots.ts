import type { ConversationMessage, ConversationSnapshot } from "@openbot/contracts/ipc";
import { isImageGenerationAspectRatio } from "@openbot/contracts/ipc";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import type { DeliveryContext } from "./mailbox-store";
import type { ThreadItem, ThreadResponse } from "./protocol";

export function snapshotFromThread(
  agentId: string,
  thread: ThreadResponse["thread"],
  findDelivery: (deliveryId: string) => DeliveryContext | null,
): ConversationSnapshot {
  const messages: ConversationMessage[] = [];
  for (const turn of thread.turns ?? []) {
    const items = turn.items ?? [];
    const firstUserItem = items.find((item) => item.type === "userMessage" && isString(item.clientId));
    const firstDelivery = firstUserItem?.clientId ? findDelivery(firstUserItem.clientId) : null;
    const deliveryTime = firstDelivery ? Date.parse(firstDelivery.delivery.createdAt) : Number.NaN;
    const turnStartedAt = turn.startedAt ? turn.startedAt * 1_000 : Number.NaN;
    const baseTime = Number.isFinite(deliveryTime)
      ? deliveryTime
      : Number.isFinite(turnStartedAt)
        ? turnStartedAt
        : Date.now();
    for (const [itemIndex, item] of items.entries()) {
      const createdAt = new Date(baseTime + itemIndex).toISOString();
      if (item.type === "userMessage" && isString(item.id)) {
        const delivery = item.clientId ? findDelivery(item.clientId) : null;
        const text = (item.content ?? [])
          .filter((part) => part.type === "text" && isString(part.text))
          .map((part) => part.text)
          .join("\n");
        if (text) {
          messages.push({
            id: delivery?.delivery.id ?? item.id,
            turnId: turn.id,
            author: delivery?.delivery.sender.kind === "agent" ? "agent" : "user",
            source: delivery?.delivery.sender.kind === "agent" ? "agent" : "user",
            senderAgentId: delivery?.delivery.sender.kind === "agent" ? delivery.delivery.sender.agentId : undefined,
            replyToMessageId: delivery?.delivery.replyToMessageId,
            attachments: delivery?.delivery.attachments,
            delivery: delivery
              ? {
                  id: delivery.delivery.id,
                  status: delivery.delivery.status,
                  position: delivery.delivery.position,
                }
              : undefined,
            text: delivery?.delivery.text ?? text,
            createdAt: delivery?.delivery.createdAt ?? createdAt,
            status: "completed",
          });
        }
      }
      if (item.type === "agentMessage" && isString(item.id) && item.text) {
        messages.push({
          id: item.id,
          turnId: turn.id,
          author: "assistant",
          text: item.text,
          createdAt,
          status: normalizeCompletionStatus(turn.status ?? "completed"),
          itemType: isString(item.phase) ? item.phase : "agentMessage",
        });
      }
      if (isImageGenerationItem(item) && isString(item.id)) {
        const providerStatus = isString(item.status) ? item.status : turn.status;
        const failed = providerStatus === "failed";
        const failure = imageGenerationFailure(item);
        messages.push({
          id: item.id,
          turnId: turn.id,
          author: "assistant",
          text: "",
          createdAt,
          status: failed ? "failed" : providerStatus === "interrupted" ? "interrupted" : "completed",
          itemType: "image_generation",
          imageGeneration: {
            ...(isString(item.revised_prompt) ? { prompt: item.revised_prompt } : {}),
            resolution: isString(item.resolution) ? item.resolution : "1024 × 1024",
            aspectRatio: isImageGenerationAspectRatio(item.aspectRatio) ? item.aspectRatio : "square",
            ...(failure ? { error: failure } : {}),
          },
        });
      }
    }
  }
  sortConversationMessages(messages);
  return { agentId, threadId: thread.id, activeTurnId: null, revision: 0, messages };
}

export function mergeConversationSnapshots(
  stored: ConversationSnapshot,
  live: ConversationSnapshot,
): ConversationSnapshot {
  const messages = new Map(stored.messages.map((message) => [message.id, message]));
  for (const message of live.messages) {
    const previous = messages.get(message.id);
    messages.set(
      message.id,
      previous
        ? {
            ...previous,
            ...message,
            attachments: message.attachments ?? previous.attachments,
            imageGeneration: message.imageGeneration ?? previous.imageGeneration,
          }
        : message,
    );
  }
  const merged: ConversationSnapshot = {
    agentId: live.agentId,
    threadId: live.threadId ?? stored.threadId,
    activeTurnId: live.activeTurnId,
    revision: live.revision,
    messages: [...messages.values()],
  };
  sortConversationMessages(merged.messages);
  return merged;
}

export function mergeProviderHistory(
  stored: ConversationSnapshot,
  imported: ConversationSnapshot,
): ConversationSnapshot {
  const importedIds = new Set(imported.messages.map((message) => message.id));
  const importedAssistantMessages = new Set(
    imported.messages.filter(isProviderAssistantMessage).map(providerMessageIdentity),
  );
  const reconciledStored = {
    ...stored,
    messages: stored.messages.filter(
      (message) =>
        importedIds.has(message.id) ||
        !isProviderAssistantMessage(message) ||
        !importedAssistantMessages.has(providerMessageIdentity(message)),
    ),
  };
  return mergeConversationSnapshots(reconciledStored, imported);
}

function isProviderAssistantMessage(message: ConversationMessage): boolean {
  return message.author === "assistant" && Boolean(message.turnId) && Boolean(message.text || message.imageGeneration);
}

function providerMessageIdentity(message: ConversationMessage): string {
  return JSON.stringify([message.turnId, message.itemType ?? null, message.text, message.imageGeneration ?? null]);
}

export function sortConversationMessages(messages: ConversationMessage[]): void {
  const originalIndexes = new Map(messages.map((message, index) => [message, index]));
  const groupKeys = new Map<ConversationMessage, string>();
  const groups = new Map<string, { startedAt: number; firstIndex: number }>();

  for (const [index, message] of messages.entries()) {
    const groupKey = message.turnId ? `turn:${message.turnId}` : `message:${index}`;
    const createdAt = messageTime(message);
    const group = groups.get(groupKey);
    groupKeys.set(message, groupKey);
    if (group) {
      group.startedAt = Math.min(group.startedAt, createdAt);
      group.firstIndex = Math.min(group.firstIndex, index);
    } else {
      groups.set(groupKey, { startedAt: createdAt, firstIndex: index });
    }
  }

  messages.sort((left, right) => {
    const leftGroup = groups.get(groupKeys.get(left) ?? "");
    const rightGroup = groups.get(groupKeys.get(right) ?? "");
    if (leftGroup && rightGroup && leftGroup !== rightGroup) {
      if (leftGroup.startedAt !== rightGroup.startedAt) return leftGroup.startedAt - rightGroup.startedAt;
      if (leftGroup.firstIndex !== rightGroup.firstIndex) return leftGroup.firstIndex - rightGroup.firstIndex;
    }

    if (left.turnId && left.turnId === right.turnId) {
      const rankDifference = turnMessageRank(left) - turnMessageRank(right);
      if (rankDifference !== 0) return rankDifference;
    }
    const timeDifference = messageTime(left) - messageTime(right);
    if (timeDifference !== 0) return timeDifference;
    return (originalIndexes.get(left) ?? 0) - (originalIndexes.get(right) ?? 0);
  });
}

function messageTime(message: ConversationMessage): number {
  const timestamp = Date.parse(message.createdAt);
  return Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER;
}

function turnMessageRank(message: ConversationMessage): 0 | 1 | 2 | 3 {
  if (message.exchange?.direction === "incoming" || message.author === "user") return 0;
  if (message.author === "assistant" && message.itemType === "commentary") return 1;
  if (message.exchange?.direction === "outgoing") return 2;
  if (message.author === "assistant") return 3;
  return 2;
}

function isImageGenerationItem(item: { type: string }): boolean {
  return item.type === "image_generation_call" || item.type === "imageGeneration";
}

function imageGenerationFailure(item: ThreadItem): string | null {
  const failure = item.failure;
  if (isDynamicRecord(failure)) {
    const message = failure.message;
    if (isString(message)) return message;
  }
  return isString(item.error) ? item.error : isString(failure) ? failure : null;
}

export function newAssistantMessage(id: string, turnId: string): ConversationMessage {
  return {
    id,
    turnId,
    author: "assistant",
    text: "",
    createdAt: new Date().toISOString(),
    status: "streaming",
    itemType: "agentMessage",
  };
}

export function normalizeCompletionStatus(status: string): ConversationMessage["status"] {
  if (status === "failed") return "failed";
  if (status === "interrupted") return "interrupted";
  return "completed";
}
