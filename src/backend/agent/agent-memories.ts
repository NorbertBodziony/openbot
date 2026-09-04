import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type {
  AgentEvent,
  BotMemory,
  CreateBotMemoryInput,
  DeleteBotMemoryInput,
  UpdateBotMemoryInput,
} from "@openbot/contracts/ipc";
import { isString } from "@openbot/contracts/runtime-values";
import { AgentMemoryStore } from "../agent-memory-store";
import type { BotStore } from "../bot-store";
import { type DynamicToolCallParams, isRecord } from "../protocol";
import type { ConversationRuntime } from "./conversation-runtime";
import { type OpenBotToolResponse, openBotToolResult } from "./routine-tools";

type PendingMemoryMutation =
  | {
      callId: string;
      type: "remember";
      botId: string;
      epoch: number;
      memoryId?: string;
      text: string;
      sourceTurnId: string;
      expectedUpdatedAt?: string | null;
    }
  | {
      callId: string;
      type: "forget";
      botId: string;
      epoch: number;
      memoryId: string;
      expectedUpdatedAt: string;
    };

export interface AgentMemoriesOptions {
  store: BotStore;
  conversation: ConversationRuntime;
  emit(event: AgentEvent): void;
  emitError(code: string, error: unknown, botId?: string): void;
}

/**
 * What an agent remembers about its work between turns.
 *
 * The staging half is the reason this is a class and not a store wrapper. An agent's `remember` and
 * `forget_memory` calls do not take effect when the model makes them: they are held against the
 * turn and committed only if that turn completes, so a turn the user interrupts or that fails
 * leaves nothing behind. The epoch counter is what makes that safe against a concurrent manual
 * edit — `clearMemories` bumps it, and a staged mutation whose epoch has moved is dropped rather
 * than resurrecting a memory the user just deleted.
 */
export class AgentMemories {
  readonly #store: BotStore;
  readonly #conversation: ConversationRuntime;
  readonly #emit: (event: AgentEvent) => void;
  readonly #emitError: (code: string, error: unknown, botId?: string) => void;
  readonly #memories: AgentMemoryStore;
  readonly #pending = new Map<string, PendingMemoryMutation[]>();
  readonly #epochs = new Map<string, number>();

  constructor(options: AgentMemoriesOptions) {
    this.#store = options.store;
    this.#conversation = options.conversation;
    this.#emit = options.emit;
    this.#emitError = options.emitError;
    this.#memories = new AgentMemoryStore(options.store.database);
  }

  list(botId: string): BotMemory[] {
    this.#conversation.requireKnownBot(botId);
    return this.#memories.list(botId);
  }

  /** Unchecked read for callers that already hold the bot, such as the developer instructions. */
  listFor(botId: string): BotMemory[] {
    return this.#memories.list(botId);
  }

  create(input: CreateBotMemoryInput): BotMemory {
    this.#conversation.requireKnownBot(input.botId);
    const memory = this.#memories.createManual(input.botId, input.text);
    this.stateChanged(input.botId);
    return memory;
  }

  update(input: UpdateBotMemoryInput): BotMemory {
    this.#conversation.requireKnownBot(input.botId);
    const memory = this.#memories.updateManual(input.botId, input.memoryId, input.text);
    this.stateChanged(input.botId);
    return memory;
  }

  delete(input: DeleteBotMemoryInput): void {
    this.#conversation.requireKnownBot(input.botId);
    if (!this.#memories.delete(input.botId, input.memoryId)) {
      throw new Error("This memory no longer exists.");
    }
    this.stateChanged(input.botId);
  }

  clear(botId: string): void {
    this.#conversation.requireKnownBot(botId);
    this.#epochs.set(botId, this.#epoch(botId) + 1);
    if (this.#memories.clear(botId) > 0) this.stateChanged(botId);
  }

  duplicate(sourceBotId: string, targetBotId: string): void {
    this.#memories.duplicate(sourceBotId, targetBotId);
  }

  /** The two `openbot` memory tools. Returns null when `tool` is not one of them. */
  handleTool(params: DynamicToolCallParams, senderBotId: string): OpenBotToolResponse | null {
    if (params.tool === "remember") {
      const args = params.arguments;
      if (!isRecord(args) || !isString(args.text)) throw new Error("Memory text is required.");
      const text = args.text.trim();
      if (!text) throw new Error("Memory text is required.");
      if (text.length > INPUT_LIMITS.agentMemoryText) throw new Error("Memory text is too long.");
      const memoryId = args.memoryId;
      if (
        memoryId !== undefined &&
        (!isString(memoryId) || memoryId.length === 0 || memoryId.length > INPUT_LIMITS.identifier)
      ) {
        throw new Error("memoryId is invalid.");
      }
      const current = memoryId ? this.#memories.get(senderBotId, memoryId) : null;
      if (memoryId && !current) throw new Error("This memory does not belong to the current agent.");
      this.#stage(params.turnId, {
        callId: params.callId,
        type: "remember",
        botId: senderBotId,
        epoch: this.#epoch(senderBotId),
        ...(memoryId ? { memoryId } : {}),
        text,
        sourceTurnId: params.turnId,
        ...(memoryId ? { expectedUpdatedAt: current?.updatedAt ?? null } : {}),
      });
      return openBotToolResult({ status: "staged", memoryId: memoryId ?? null });
    }

    if (params.tool === "forget_memory") {
      const args = params.arguments;
      if (
        !isRecord(args) ||
        !isString(args.memoryId) ||
        args.memoryId.length === 0 ||
        args.memoryId.length > INPUT_LIMITS.identifier
      ) {
        throw new Error("memoryId is required.");
      }
      const current = this.#memories.get(senderBotId, args.memoryId);
      if (!current) throw new Error("This memory does not belong to the current agent.");
      this.#stage(params.turnId, {
        callId: params.callId,
        type: "forget",
        botId: senderBotId,
        epoch: this.#epoch(senderBotId),
        memoryId: current.id,
        expectedUpdatedAt: current.updatedAt,
      });
      return openBotToolResult({ status: "staged", memoryId: current.id });
    }

    return null;
  }

  /** Commits a turn's staged mutations, or discards them when the turn did not complete. */
  finishTurn(turnId: string, status: string): void {
    const pending = this.#pending.get(turnId) ?? [];
    this.#pending.delete(turnId);
    if (status !== "completed" || pending.length === 0) return;

    const affectedBots = new Set<string>();
    for (const mutation of pending) {
      if (mutation.epoch !== this.#epoch(mutation.botId)) continue;
      const before = JSON.stringify(this.#memories.list(mutation.botId));
      try {
        if (mutation.type === "remember") this.#memories.saveAutomatic(mutation);
        else this.#memories.delete(mutation.botId, mutation.memoryId, mutation.expectedUpdatedAt);
      } catch (error) {
        this.#emitError("memory_commit_failed", error, mutation.botId);
        continue;
      }
      if (JSON.stringify(this.#memories.list(mutation.botId)) !== before) affectedBots.add(mutation.botId);
    }
    for (const botId of affectedBots) this.stateChanged(botId);
  }

  clearPending(): void {
    this.#pending.clear();
  }

  /**
   * A memory change invalidates the developer instructions the provider was started with, so the
   * thread is unloaded and the next turn rebuilds them.
   */
  stateChanged(botId: string): void {
    const bot = this.#conversation.requireKnownBot(botId);
    const session = this.#store.activeProviderSession(bot.id);
    if (session) this.#conversation.unloadThread(session.externalSessionId);
    this.#emit({ type: "memories-changed", botId });
  }

  #stage(turnId: string, mutation: PendingMemoryMutation): void {
    const pending = this.#pending.get(turnId) ?? [];
    if (!pending.some((candidate) => candidate.callId === mutation.callId)) pending.push(mutation);
    this.#pending.set(turnId, pending);
  }

  #epoch(botId: string): number {
    return this.#epochs.get(botId) ?? 0;
  }
}
