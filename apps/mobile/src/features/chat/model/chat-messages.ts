import type { ConversationMessage } from "@openbot/contracts/ipc";

export type ChatMessage =
  | { id: string; kind: "message"; author: "bot" | "user"; body: string; streaming: boolean }
  | { id: string; kind: "thinking"; turnId: string | undefined; steps: { id: string; text: string }[] };

export function projectChatMessages(messages: ConversationMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  const thinkingByTurn = new Map<string, Extract<ChatMessage, { kind: "thinking" }>>();
  for (const message of messages) {
    if (!message.text.trim() || message.author === "system") continue;
    if (message.author === "assistant" && message.itemType === "commentary") {
      const key = message.turnId ?? message.id;
      let thinking = thinkingByTurn.get(key);
      if (!thinking) {
        thinking = { id: `thinking:${key}`, kind: "thinking", turnId: message.turnId, steps: [] };
        thinkingByTurn.set(key, thinking);
        result.push(thinking);
      }
      thinking.steps.push({ id: message.id, text: message.text });
    } else {
      result.push({
        id: message.id,
        kind: "message",
        author: message.author === "user" ? "user" : "bot",
        body: message.text,
        streaming: message.status === "streaming",
      });
    }
  }
  return result;
}
