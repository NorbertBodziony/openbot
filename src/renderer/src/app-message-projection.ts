import type { BotSummary, ConversationMessage, ConversationReadState } from "@openbot/contracts/ipc";
import type { BotMessage, BotProfile } from "./data";

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

export function toBotMessage(message: ConversationMessage): BotMessage {
  const exchangeSenderId = message.senderBotId ?? message.exchange?.senderBotId;
  return {
    id: message.id,
    turnId: message.turnId,
    author: message.author === "user" ? "you" : "bot",
    body: message.text,
    time: formatTime(message.createdAt),
    createdAt: message.createdAt,
    streaming: message.status === "streaming",
    itemType: message.itemType,
    kind: message.questionPrompt ? "question" : message.exchange ? "exchange" : "text",
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
    status: message.exchange
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

export function toBotMessages(messages: ConversationMessage[]): BotMessage[] {
  const result: BotMessage[] = [];
  const thinkingByTurn = new Map<string, BotMessage>();
  for (const message of messages) {
    if (message.delivery?.status === "queued" || message.delivery?.status === "cancelled") continue;
    if (message.author !== "assistant" || message.itemType !== "commentary") {
      result.push(toBotMessage(message));
      continue;
    }

    const key = message.turnId ?? message.id;
    const existing = thinkingByTurn.get(key);
    if (existing) {
      if (message.text.trim()) existing.items = [...(existing.items ?? []), message.text];
      existing.streaming = existing.streaming || message.status === "streaming";
      continue;
    }

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
      items: message.text.trim() ? [message.text] : [],
    };
    thinkingByTurn.set(key, thinking);
    result.push(thinking);
  }
  return result;
}

export function readStateForMessages(
  state: ConversationReadState,
  messages: ConversationMessage[],
): ConversationReadState {
  const throughIndex = state.throughMessageId
    ? messages.findIndex((message) => message.id === state.throughMessageId)
    : -1;
  const unread = messages
    .slice(throughIndex + 1)
    .filter((message) => message.author !== "user" && message.itemType !== "commentary");
  return {
    ...state,
    unreadCount: unread.length,
    firstUnreadMessageId: unread[0]?.id ?? null,
  };
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
    JSON.stringify(left.items) === JSON.stringify(right.items)
  );
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
  const cleaned = preview
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
