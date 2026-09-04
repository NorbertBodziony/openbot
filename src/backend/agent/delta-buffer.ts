import type { AgentEvent } from "@openbot/contracts/ipc";
import type { OpenBotDatabase } from "../openbot-database";
import type { ConversationRuntime } from "./conversation-runtime";

export interface PendingDeltaInput {
  botId: string;
  externalThreadId: string;
  publicThreadId: string;
  turnId: string;
  messageId: string;
  text: string;
  createdAt: string;
}

interface BufferedDelta extends PendingDeltaInput {
  timer: NodeJS.Timeout | null;
}

export interface DeltaBufferHooks {
  emit(event: AgentEvent): void;
}

export interface DeltaBufferOptions {
  conversation: ConversationRuntime;
  database: OpenBotDatabase;
  hooks: DeltaBufferHooks;
}

/**
 * Coalesces `item/agentMessage/delta` notifications into `conversation-delta`
 * events. Deltas accumulate per message and flush on a 100 ms debounce, an
 * 8 KiB cap, item completion, or turn completion — whichever comes first.
 *
 * Owns the pending map and its timers. Persistence goes through the database,
 * snapshots through the conversation runtime, delivery through `emit`; the
 * class never imports the facade.
 */
export class DeltaBuffer {
  readonly #conversation: ConversationRuntime;
  readonly #database: OpenBotDatabase;
  readonly #hooks: DeltaBufferHooks;
  readonly #pending = new Map<string, BufferedDelta>();

  constructor(options: DeltaBufferOptions) {
    this.#conversation = options.conversation;
    this.#database = options.database;
    this.#hooks = options.hooks;
  }

  buffer(delta: PendingDeltaInput): void {
    const key = `${delta.externalThreadId}:${delta.turnId}:${delta.messageId}`;
    const existing = this.#pending.get(key);
    if (existing) {
      existing.text += delta.text;
      if (Buffer.byteLength(existing.text, "utf8") >= 8 * 1024) this.flush(key);
      return;
    }
    const pending: BufferedDelta = { ...delta, timer: null };
    pending.timer = setTimeout(() => this.flush(key), 100);
    this.#pending.set(key, pending);
  }

  flush(key: string): void {
    const pending = this.#pending.get(key);
    if (!pending) return;
    this.#pending.delete(key);
    if (pending.timer) clearTimeout(pending.timer);
    const snapshot = this.#conversation.ensureSnapshot(pending.botId, pending.publicThreadId);
    const persisted = this.#database.persistConversation(snapshot, "response.delta-flushed", {
      turnId: pending.turnId,
      messageId: pending.messageId,
      bytes: Buffer.byteLength(pending.text, "utf8"),
    });
    snapshot.revision = persisted.revision;
    this.#hooks.emit({
      type: "conversation-delta",
      botId: pending.botId,
      threadId: pending.publicThreadId,
      turnId: pending.turnId,
      messageId: pending.messageId,
      delta: pending.text,
      createdAt: pending.createdAt,
      revision: snapshot.revision,
    });
  }

  flushTurn(turnId: string): void {
    for (const [key, pending] of this.#pending) {
      if (pending.turnId === turnId) this.flush(key);
    }
  }

  dispose(): void {
    for (const pending of this.#pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
    }
    this.#pending.clear();
  }
}
