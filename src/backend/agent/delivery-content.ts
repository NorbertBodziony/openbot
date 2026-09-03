import { createHash } from "node:crypto";
import { expandAttachmentReferences } from "@openbot/contracts/attachment-references";
import { expandChatTagReferences } from "@openbot/contracts/chat-tag-references";
import type { BotSummary, ConversationSnapshot, QueueDeliveryStatus } from "@openbot/contracts/ipc";
import type { DeliveryContext } from "../mailbox-store";

export function responseAttachmentMessageId(threadId: string, turnId: string, callId: string): string {
  const digest = createHash("sha256").update(`${threadId}\0${turnId}\0${callId}`).digest("hex").slice(0, 32);
  return `agent-attachments:${digest}`;
}

export function conversationContentSignature(snapshot: ConversationSnapshot): string {
  return JSON.stringify({
    botId: snapshot.botId,
    threadId: snapshot.threadId,
    activeTurnId: snapshot.activeTurnId,
    messages: snapshot.messages,
  });
}

export function routineStatusForDelivery(status: QueueDeliveryStatus) {
  switch (status) {
    case "queued":
    case "starting":
      return "queued";
    case "running":
      return "running";
    case "completed":
      return "succeeded";
    case "failed":
      return "failed";
    case "interrupted":
      return "interrupted";
    case "cancelled":
      return "cancelled";
  }
}

export function deliveryInput(
  context: DeliveryContext,
  agentNames: ReadonlyMap<string, string>,
): Array<
  | { type: "text"; text: string }
  | { type: "localImage"; path: string }
  | { type: "mention"; name: string; path: string }
> {
  const { delivery, managedAttachments } = context;
  const displayText = displayMessageReferences(delivery.text, delivery.attachments, agentNames);
  const text = [
    displayText || (managedAttachments.length ? "The user shared attached local files." : ""),
    managedAttachments.length
      ? `Attached local files:\n${managedAttachments.map((item) => `- ${item.name}: ${item.path}`).join("\n")}`
      : null,
  ]
    .filter(Boolean)
    .join("\n\n");
  return [
    { type: "text", text },
    ...managedAttachments.map((attachment) =>
      attachment.kind === "image"
        ? { type: "localImage" as const, path: attachment.path }
        : { type: "mention" as const, name: attachment.name, path: attachment.path },
    ),
  ];
}

export function displayMessageReferences(
  text: string,
  attachments: Array<{ id: string; name: string }>,
  agentNames: ReadonlyMap<string, string>,
): string {
  const names = new Map(attachments.map((attachment) => [attachment.id, attachment.name]));
  return expandAttachmentReferences(
    expandChatTagReferences(text, (reference) =>
      reference.kind === "agent" ? agentNames.get(reference.id) : undefined,
    ),
    (reference) => names.get(reference.attachmentId),
  );
}

export function agentNamesById(bots: BotSummary[]): ReadonlyMap<string, string> {
  return new Map(bots.map((bot) => [bot.id, bot.name]));
}

export function lastUserPrompt(snapshot: ConversationSnapshot): string | null {
  return (
    [...snapshot.messages]
      .reverse()
      .find((message) => (message.author === "user" || message.source === "user") && message.text.trim())
      ?.text.trim() ?? null
  );
}

export function renderHandoffMessage(
  message: ConversationSnapshot["messages"][number],
  agentNames: ReadonlyMap<string, string>,
): string {
  const attachmentMetadata = (message.attachments ?? [])
    .map((attachment) => `[attachment: ${attachment.name}; ${attachment.mimeType}; ${attachment.size} bytes]`)
    .join("\n");
  const sender = message.senderBotId ? ` agent:${message.senderBotId}` : "";
  return [
    `[${message.createdAt}] ${message.author}${sender}:`,
    displayMessageReferences(message.text, message.attachments ?? [], agentNames),
    attachmentMetadata,
  ]
    .filter(Boolean)
    .join("\n");
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function summarizeOldMessages(
  messages: ConversationSnapshot["messages"],
  tokenBudget: number,
  agentNames: ReadonlyMap<string, string>,
): string {
  const maximumCharacters = Math.max(4_000, tokenBudget * 4);
  const lines = messages.map((message) => {
    const normalized = displayMessageReferences(message.text, message.attachments ?? [], agentNames)
      .replace(/\s+/g, " ")
      .trim();
    const excerpt = normalized.length > 600 ? `${normalized.slice(0, 597)}...` : normalized;
    const attachments = (message.attachments ?? []).map((item) => item.name).join(", ");
    return `- ${message.author}${message.senderBotId ? ` (${message.senderBotId})` : ""}: ${excerpt}${attachments ? ` [attachments: ${attachments}]` : ""}`;
  });
  const summary = [`Summary of ${messages.length} older user-visible messages:`, ...lines].join("\n");
  return summary.length > maximumCharacters
    ? `${summary.slice(0, maximumCharacters - 56)}\n[Summary shortened to fit the handoff budget.]`
    : summary;
}
