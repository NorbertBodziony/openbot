import type { BotSummary, ConversationMessage, QueueDeliveryStatus } from "@openbot/contracts/ipc";
import {
  hostedSiteConversationEvent,
  routineConversationEvent,
  routineRunConversationEvent,
} from "@openbot/contracts/ipc";
import { cleanAgentMessageText } from "./agent-message-text";
import { isRoutineEventItem } from "./conversation-read-state";
import type { AgentDeliveryMarkerStatus, BotMessage, BotProfile, ChatActionMarkerModel } from "./data";

export function toBotProfile(stored: BotSummary): BotProfile {
  return {
    id: stored.id,
    name: stored.name,
    title: stored.title,
    description: stored.description,
    notifications: stored.notifications,
    provider: stored.provider,
    model: stored.model,
    reasoningEffort: stored.reasoningEffort,
    threadId: stored.threadId,
    avatarSeed: stored.avatarSeed,
    avatarHue: stored.avatarHue,
    avatarUrl: stored.avatarUrl,
    marketplaceSource: stored.marketplaceSource,
    updatedAt: stored.updatedAt,
    time: stored.updatedAt ? formatTime(stored.updatedAt) : "now",
    preview: cleanPreview(stored.preview),
  };
}

export function toBotMessage(message: ConversationMessage, ownerAgentId?: string): BotMessage {
  const exchangeSenderId = message.senderBotId ?? message.exchange?.senderBotId;
  const routineEvent = routineConversationEvent(message);
  const routineRunEvent = routineRunConversationEvent(message);
  const hostedSiteEvent = hostedSiteConversationEvent(message);
  const actionMarker = chatActionMarker(message, ownerAgentId, routineEvent, routineRunEvent, hostedSiteEvent);
  return {
    id: message.id,
    turnId: message.turnId,
    author: message.author === "user" ? "you" : "bot",
    body: message.author === "user" ? message.text : cleanAgentMessageText(message.text),
    time: formatTime(message.createdAt),
    createdAt: message.createdAt,
    streaming: message.status === "streaming",
    itemType: message.itemType,
    kind: message.questionPrompt ? "question" : actionMarker ? "action-marker" : "text",
    senderBotId: exchangeSenderId,
    replyToMessageId: message.replyToMessageId,
    attachments: message.attachments,
    imageGeneration: message.imageGeneration,
    questionPrompt: message.questionPrompt,
    exchange: message.exchange,
    reaction: message.reaction,
    reactions:
      message.reactions ?? (message.reaction ? [{ emoji: message.reaction, actor: { kind: "user" as const } }] : []),
    routine: message.routine,
    actionMarker: actionMarker ?? undefined,
    status:
      message.exchange || message.routine
        ? undefined
        : message.delivery?.status === "queued"
          ? `Queued #${message.delivery.position}`
          : message.delivery?.status === "cancelled"
            ? "Cancelled"
            : message.status === "failed"
              ? "Failed"
              : message.status === "interrupted"
                ? "Stopped"
                : undefined,
  };
}

export function toBotMessages(messages: ConversationMessage[], ownerAgentId?: string): BotMessage[] {
  const result: BotMessage[] = [];
  const thinkingByTurn = new Map<string, BotMessage>();
  for (const message of messages) {
    if ((message.delivery?.status === "queued" || message.delivery?.status === "cancelled") && !message.routine) {
      continue;
    }
    if (message.author !== "assistant" || message.itemType !== "commentary") {
      result.push(toBotMessage(message, ownerAgentId));
      continue;
    }

    const key = message.turnId ?? message.id;
    const existing = thinkingByTurn.get(key);
    if (existing) {
      const text = cleanAgentMessageText(message.text);
      existing.items = [...(existing.items ?? []), text];
      existing.itemIds = [...(existing.itemIds ?? []), message.id];
      existing.streaming = existing.streaming || message.status === "streaming";
      continue;
    }

    const text = cleanAgentMessageText(message.text);
    const thinking: BotMessage = {
      id: `thinking:${key}`,
      turnId: message.turnId,
      author: "bot",
      body: "",
      time: formatTime(message.createdAt),
      createdAt: message.createdAt,
      streaming: message.status === "streaming",
      itemType: "commentary",
      kind: "thinking",
      items: [text],
      itemIds: [message.id],
    };
    thinkingByTurn.set(key, thinking);
    result.push(thinking);
  }
  for (const [key, thinking] of thinkingByTurn) {
    const duration = thinkingDurationMs(messages, key, thinking.createdAt);
    if (duration !== null) thinking.thinkingDurationMs = duration;
  }
  return result;
}

/* How long the agent spent reasoning: from its first commentary to whatever ended the reasoning —
   the turn's answer, or the last commentary when the answer has not started yet. */
function thinkingDurationMs(
  messages: ConversationMessage[],
  turnKey: string,
  startedAt: string | undefined,
): number | null {
  const started = startedAt ? Date.parse(startedAt) : Number.NaN;
  if (Number.isNaN(started)) return null;
  const turnMessages = messages.filter((message) => (message.turnId ?? message.id) === turnKey);
  const answer = turnMessages.find((message) => message.author === "assistant" && message.itemType !== "commentary");
  const lastCommentary = turnMessages.filter((message) => message.itemType === "commentary").at(-1);
  const endedAt = answer?.createdAt ?? lastCommentary?.createdAt;
  const ended = endedAt ? Date.parse(endedAt) : Number.NaN;
  if (Number.isNaN(ended) || ended < started) return null;
  return ended - started;
}

export function botProfilesEqual(left: BotProfile, right: BotProfile): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.title === right.title &&
    left.description === right.description &&
    left.notifications === right.notifications &&
    left.provider === right.provider &&
    left.model === right.model &&
    left.reasoningEffort === right.reasoningEffort &&
    left.threadId === right.threadId &&
    left.avatarSeed === right.avatarSeed &&
    left.avatarHue === right.avatarHue &&
    left.avatarUrl === right.avatarUrl &&
    marketplaceSourcesEqual(left.marketplaceSource, right.marketplaceSource) &&
    left.updatedAt === right.updatedAt &&
    left.time === right.time &&
    left.preview === right.preview
  );
}

function marketplaceSourcesEqual(
  left: BotProfile["marketplaceSource"],
  right: BotProfile["marketplaceSource"],
): boolean {
  if (!left || !right) return left === right;
  return (
    left.agentId === right.agentId &&
    left.versionId === right.versionId &&
    left.version === right.version &&
    stringArraysEqual(left.skillIds, right.skillIds) &&
    stringArraysEqual(left.routineIds, right.routineIds)
  );
}

function stringArraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function botMessagesEqual(left: BotMessage, right: BotMessage): boolean {
  return (
    left.id === right.id &&
    left.turnId === right.turnId &&
    left.author === right.author &&
    left.body === right.body &&
    left.time === right.time &&
    left.kind === right.kind &&
    left.streaming === right.streaming &&
    left.itemType === right.itemType &&
    left.status === right.status &&
    left.senderBotId === right.senderBotId &&
    left.replyToMessageId === right.replyToMessageId &&
    left.reaction === right.reaction &&
    JSON.stringify(left.reactions) === JSON.stringify(right.reactions) &&
    JSON.stringify(left.reactionSummary) === JSON.stringify(right.reactionSummary) &&
    JSON.stringify(left.attachments) === JSON.stringify(right.attachments) &&
    JSON.stringify(left.questionPrompt) === JSON.stringify(right.questionPrompt) &&
    JSON.stringify(left.exchange) === JSON.stringify(right.exchange) &&
    JSON.stringify(left.routine) === JSON.stringify(right.routine) &&
    JSON.stringify(left.actionMarker) === JSON.stringify(right.actionMarker) &&
    JSON.stringify(left.items) === JSON.stringify(right.items) &&
    JSON.stringify(left.itemIds) === JSON.stringify(right.itemIds) &&
    left.thinkingDurationMs === right.thinkingDurationMs
  );
}

function chatActionMarker(
  message: ConversationMessage,
  ownerAgentId: string | undefined,
  routineEvent: ReturnType<typeof routineConversationEvent>,
  routineRunEvent: ReturnType<typeof routineRunConversationEvent>,
  hostedSiteEvent: ReturnType<typeof hostedSiteConversationEvent>,
): ChatActionMarkerModel | null {
  if (message.exchange) {
    const targetDeliveries = message.exchange.deliveries.map((delivery) => ({
      agentId: delivery.recipientBotId,
      status: delivery.status,
    }));
    const status =
      message.exchange.direction === "incoming"
        ? deliveryStatus(message.delivery?.status ?? targetDeliveries[0]?.status)
        : aggregateDeliveryStatus(targetDeliveries.map((delivery) => delivery.status));
    return {
      kind: "agent-message",
      direction: message.exchange.direction,
      sourceAgentId: message.exchange.senderBotId,
      targetDeliveries,
      status,
      timestamp: message.createdAt,
      messageId: message.exchange.messageId,
      replyToMessageId: message.exchange.replyToMessageId,
    };
  }
  if (routineEvent) {
    return {
      kind: "routine-lifecycle",
      action: routineEvent.action,
      sourceAgentId: ownerAgentId ?? null,
      routineId: routineEvent.routineId,
      routineName: routineEvent.routineName,
      status: "completed",
      timestamp: message.createdAt,
    };
  }
  if (routineRunEvent) {
    return {
      kind: "routine-run",
      sourceAgentId: ownerAgentId ?? null,
      routineId: routineRunEvent.routineId,
      runId: routineRunEvent.runId,
      routineName: routineRunEvent.routineName,
      status: routineRunEvent.status,
      timestamp: message.createdAt,
    };
  }
  if (message.routine) {
    return {
      kind: "routine-run",
      sourceAgentId: ownerAgentId ?? null,
      routineId: message.routine.routineId,
      runId: message.routine.runId,
      routineName: message.routine.name,
      status: "queued",
      timestamp: message.createdAt,
    };
  }
  if (hostedSiteEvent) {
    return {
      kind: "hosted-site",
      sourceAgentId: ownerAgentId ?? null,
      action: hostedSiteEvent.action,
      status: hostedSiteEvent.status,
      operationId: hostedSiteEvent.operationId,
      siteId: hostedSiteEvent.siteId,
      title: hostedSiteEvent.title,
      hostname: hostedSiteEvent.hostname,
      url: hostedSiteEvent.url,
      timestamp: message.createdAt,
    };
  }
  if (isRoutineEventItem(message)) {
    return { kind: "unavailable", label: "Action unavailable", timestamp: message.createdAt };
  }
  return null;
}

function aggregateDeliveryStatus(statuses: QueueDeliveryStatus[]): AgentDeliveryMarkerStatus {
  if (statuses.length === 0) return "unavailable";
  const normalized = statuses.map(deliveryStatus);
  if (normalized.every((status) => status === "queued")) return "queued";
  if (normalized.some((status) => status === "in-progress")) return "in-progress";
  if (normalized.every((status) => status === "completed")) return "completed";
  if (normalized.every((status) => status === "failed")) return "failed";
  if (normalized.every((status) => status === "interrupted")) return "interrupted";
  if (normalized.every((status) => status === "cancelled")) return "cancelled";
  if (normalized.every((status) => ["completed", "failed", "interrupted", "cancelled"].includes(status))) {
    return "partial";
  }
  return "in-progress";
}

function deliveryStatus(status: QueueDeliveryStatus | undefined): Exclude<AgentDeliveryMarkerStatus, "partial"> {
  if (!status) return "unavailable";
  if (status === "starting" || status === "running") return "in-progress";
  return status;
}

export function retainThinkingMessages(previous: BotMessage[], next: BotMessage[]): BotMessage[] {
  const result = [...next];
  const nextIds = new Set(result.map((message) => message.id));
  for (const thinking of previous) {
    if (thinking.kind !== "thinking" || nextIds.has(thinking.id) || !thinking.turnId) continue;
    const sameTurnIndexes = result.flatMap((message, index) => (message.turnId === thinking.turnId ? [index] : []));
    if (sameTurnIndexes.length === 0) continue;
    const finalAnswerIndex = result.findIndex(
      (message) => message.turnId === thinking.turnId && message.author === "bot" && message.kind !== "thinking",
    );
    const insertionIndex = finalAnswerIndex >= 0 ? finalAnswerIndex : (sameTurnIndexes.at(-1) ?? result.length - 1) + 1;
    result.splice(insertionIndex, 0, { ...thinking, streaming: false });
    nextIds.add(thinking.id);
  }
  return result;
}

export function withoutBot<T>(values: Record<string, T>, botId: string): Record<string, T> {
  const next = { ...values };
  delete next[botId];
  return next;
}

function cleanPreview(preview: string): string {
  const cleaned = cleanAgentMessageText(preview)
    .replace(/\binbox\s+at\s+zero\b[:,]?\s*/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return cleaned || "No messages yet";
}

export function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "now";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
