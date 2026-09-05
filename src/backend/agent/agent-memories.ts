import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type {
  AgentEvent,
  AgentMemory,
  CreateAgentMemoryInput,
  DeleteAgentMemoryInput,
  UpdateAgentMemoryInput,
} from "@openbot/contracts/ipc";
import { isString } from "@openbot/contracts/runtime-values";
import { AgentMemoryStore } from "../agent-memory-store";
import type { AgentStore } from "../agent-store";
import { type DynamicToolCallParams, isRecord } from "../protocol";
import type { ConversationRuntime } from "./conversation-runtime";
import { type OpenBotToolResponse, openBotToolResult } from "./routine-tools";

type PendingMemoryMutation =
  | {
      callId: string;
      type: "remember";
      agentId: string;
      epoch: number;
      memoryId?: string;
      text: string;
      sourceTurnId: string;
      expectedUpdatedAt?: string | null;
    }
  | {
      callId: string;
      type: "forget";
      agentId: string;
      epoch: number;
      memoryId: string;
      expectedUpdatedAt: string;
    };

export interface AgentMemoriesOptions {
  store: AgentStore;
  conversation: ConversationRuntime;
  emit(event: AgentEvent): void;
  emitError(code: string, error: unknown, agentId?: string): void;
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
  readonly #store: AgentStore;
  readonly #conversation: ConversationRuntime;
  readonly #emit: (event: AgentEvent) => void;
  readonly #emitError: (code: string, error: unknown, agentId?: string) => void;
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

  list(agentId: string): AgentMemory[] {
    this.#conversation.requireKnownAgent(agentId);
    return this.#memories.list(agentId);
  }

  /** Unchecked read for callers that already hold the agent, such as the developer instructions. */
  listFor(agentId: string): AgentMemory[] {
    return this.#memories.list(agentId);
  }

  create(input: CreateAgentMemoryInput): AgentMemory {
    this.#conversation.requireKnownAgent(input.agentId);
    const memory = this.#memories.createManual(input.agentId, input.text);
    this.stateChanged(input.agentId);
    return memory;
  }

  update(input: UpdateAgentMemoryInput): AgentMemory {
    this.#conversation.requireKnownAgent(input.agentId);
    const memory = this.#memories.updateManual(input.agentId, input.memoryId, input.text);
    this.stateChanged(input.agentId);
    return memory;
  }

  delete(input: DeleteAgentMemoryInput): void {
    this.#conversation.requireKnownAgent(input.agentId);
    if (!this.#memories.delete(input.agentId, input.memoryId)) {
      throw new Error("This memory no longer exists.");
    }
    this.stateChanged(input.agentId);
  }

  clear(agentId: string): void {
    this.#conversation.requireKnownAgent(agentId);
    this.#epochs.set(agentId, this.#epoch(agentId) + 1);
    if (this.#memories.clear(agentId) > 0) this.stateChanged(agentId);
  }

  duplicate(sourceAgentId: string, targetAgentId: string): void {
    this.#memories.duplicate(sourceAgentId, targetAgentId);
  }

  /** The two `openbot` memory tools. Returns null when `tool` is not one of them. */
  handleTool(params: DynamicToolCallParams, senderAgentId: string): OpenBotToolResponse | null {
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
      const current = memoryId ? this.#memories.get(senderAgentId, memoryId) : null;
      if (memoryId && !current) throw new Error("This memory does not belong to the current agent.");
      this.#stage(params.turnId, {
        callId: params.callId,
        type: "remember",
        agentId: senderAgentId,
        epoch: this.#epoch(senderAgentId),
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
      const current = this.#memories.get(senderAgentId, args.memoryId);
      if (!current) throw new Error("This memory does not belong to the current agent.");
      this.#stage(params.turnId, {
        callId: params.callId,
        type: "forget",
        agentId: senderAgentId,
        epoch: this.#epoch(senderAgentId),
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

    const affectedAgents = new Set<string>();
    for (const mutation of pending) {
      if (mutation.epoch !== this.#epoch(mutation.agentId)) continue;
      const before = JSON.stringify(this.#memories.list(mutation.agentId));
      try {
        if (mutation.type === "remember") this.#memories.saveAutomatic(mutation);
        else this.#memories.delete(mutation.agentId, mutation.memoryId, mutation.expectedUpdatedAt);
      } catch (error) {
        this.#emitError("memory_commit_failed", error, mutation.agentId);
        continue;
      }
      if (JSON.stringify(this.#memories.list(mutation.agentId)) !== before) affectedAgents.add(mutation.agentId);
    }
    for (const agentId of affectedAgents) this.stateChanged(agentId);
  }

  clearPending(): void {
    this.#pending.clear();
  }

  /**
   * A memory change invalidates the developer instructions the provider was started with, so the
   * thread is unloaded and the next turn rebuilds them.
   */
  stateChanged(agentId: string): void {
    const agent = this.#conversation.requireKnownAgent(agentId);
    const session = this.#store.activeProviderSession(agent.id);
    if (session) this.#conversation.unloadThread(session.externalSessionId);
    this.#emit({ type: "memories-changed", agentId });
  }

  #stage(turnId: string, mutation: PendingMemoryMutation): void {
    const pending = this.#pending.get(turnId) ?? [];
    if (!pending.some((candidate) => candidate.callId === mutation.callId)) pending.push(mutation);
    this.#pending.set(turnId, pending);
  }

  #epoch(agentId: string): number {
    return this.#epochs.get(agentId) ?? 0;
  }
}
