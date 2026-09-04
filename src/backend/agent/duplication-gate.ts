import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentSummary, DuplicateAgentResult, SidebarLayoutSnapshot } from "@openbot/contracts/ipc";
import { type AgentStore, duplicationProfileSignature } from "../agent-store";
import type { MailboxStore } from "../mailbox-store";
import type { AgentMemories } from "./agent-memories";
import type { ConversationRuntime } from "./conversation-runtime";
import type { RoutineScheduler } from "./routine-scheduler";

export interface DuplicationHooks {
  emit(event: AgentEvent): void;
  listAgents(): AgentSummary[];
  /** Removes a half-written copy: its workspace, mailbox rows and provider sessions. */
  deleteAgentData(agent: AgentSummary): Promise<void>;
  /** A agent with an outstanding question is not idle, even with an empty queue. */
  hasAttentionFor(agentId: string): boolean;
  /** Re-arms a queue this gate held, so a message that waited out a copy is not stranded. */
  scheduleDrain(agentId: string): void;
}

export interface DuplicationGateOptions {
  store: AgentStore;
  mailbox: MailboxStore;
  conversation: ConversationRuntime;
  memories: AgentMemories;
  routines: RoutineScheduler;
  hooks: DuplicationHooks;
}

/**
 * Copying an agent, and the window between the copy existing and the user accepting it.
 *
 * A duplicate is created in the database before the user has confirmed where it goes, so for that
 * window it is a real row that must not behave like a real agent: it is hidden from `listAgents`, it
 * never drains its queue, its routines never fire, and `Unknown agent` is the honest answer for it.
 * Every path out of that window — commit, delete, or a failed copy — has to clear the same four
 * maps, which is why they live in one class rather than beside the code that happens to set them.
 *
 * The copy itself is guarded twice over. `#duplicatingAgents` refuses a second concurrent copy of one
 * source; `#commitQueue` serialises commits so two duplications cannot interleave their store
 * writes; and the source signature is re-compared after every step, so an agent edited mid-copy
 * aborts rather than producing a duplicate that matches neither state.
 */
export class DuplicationGate {
  readonly #store: AgentStore;
  readonly #mailbox: MailboxStore;
  readonly #conversation: ConversationRuntime;
  readonly #memories: AgentMemories;
  readonly #routines: RoutineScheduler;
  readonly #hooks: DuplicationHooks;
  readonly #duplicatingAgents = new Set<string>();
  readonly #pendingAgents = new Set<string>();
  readonly #pendingOperations = new Map<string, { operationId: string; sourceAgentId: string }>();
  readonly #pendingReleases = new Map<string, () => void>();
  #commitQueue: Promise<void> = Promise.resolve();

  constructor(options: DuplicationGateOptions) {
    this.#store = options.store;
    this.#mailbox = options.mailbox;
    this.#conversation = options.conversation;
    this.#memories = options.memories;
    this.#routines = options.routines;
    this.#hooks = options.hooks;
  }

  /**
   * The duplication clause in the drain mute registry. A pending copy never drains at all, and a
   * source holds its queue for the length of the copy.
   *
   * `assertAgentIdle` already refuses to start duplicating a busy agent, but it only looks once, and
   * copying a large workspace runs for seconds afterwards. Without this clause a message arriving
   * inside that window starts a turn that writes into the tree being copied, and the workspace
   * fingerprint then rejects the copy — correctly, but the user loses it. Holding the queue answers
   * the same message a few seconds later and keeps the copy.
   */
  mayDrain(agentId: string): boolean {
    return !this.#pendingAgents.has(agentId) && !this.#duplicatingAgents.has(agentId);
  }

  /** A pending duplicate is not yet an agent: it is hidden, and unknown to anything that looks up. */
  isPending(agentId: string): boolean {
    return this.#pendingAgents.has(agentId);
  }

  pendingAgents(): ReadonlySet<string> {
    return this.#pendingAgents;
  }

  visibleAgents(agents: AgentSummary[]): AgentSummary[] {
    return agents.filter((agent) => !this.#pendingAgents.has(agent.id));
  }

  async duplicate(sourceAgentId: string, operationId: string = randomUUID()): Promise<AgentSummary> {
    const releaseDuplication = await this.#acquireCommitLock();
    let releaseOnExit = true;
    let duplicate: AgentSummary | null = null;
    try {
      const source = this.#conversation.requireKnownAgent(sourceAgentId);
      if (this.#duplicatingAgents.has(sourceAgentId)) throw new Error("This agent is already being duplicated.");
      this.assertAgentIdle(sourceAgentId);
      const sourceSignature = this.#sourceSignature(sourceAgentId);
      this.#duplicatingAgents.add(sourceAgentId);
      duplicate = await this.#store.duplicateAgent(sourceAgentId, operationId);
      this.#pendingAgents.add(duplicate.id);
      this.#pendingOperations.set(duplicate.id, { operationId, sourceAgentId });
      this.#assertSourceUnchanged(sourceAgentId, sourceSignature);
      this.#memories.duplicate(sourceAgentId, duplicate.id);
      const routines = this.#routines.duplicate(sourceAgentId, duplicate.id, new Date());
      this.#assertSourceUnchanged(sourceAgentId, sourceSignature);
      if (source.marketplaceSource) {
        duplicate = this.#store.setMarketplaceSource(duplicate.id, {
          ...structuredClone(source.marketplaceSource),
          routineIds: source.marketplaceSource.routineIds.flatMap((routineId) => {
            const copied = routines.get(routineId);
            return copied ? [copied.id] : [];
          }),
        });
      }
      this.#assertSourceUnchanged(sourceAgentId, sourceSignature);
      const completedDuplicate = duplicate;
      this.#pendingReleases.set(completedDuplicate.id, releaseDuplication);
      releaseOnExit = false;
      return this.#store.list().find((candidate) => candidate.id === completedDuplicate.id) ?? completedDuplicate;
    } catch (error) {
      if (!duplicate) throw error;
      let rollbackError: unknown;
      try {
        await this.#hooks.deleteAgentData(duplicate);
        this.#pendingAgents.delete(duplicate.id);
        this.#pendingOperations.delete(duplicate.id);
      } catch (caught) {
        rollbackError = caught;
      }
      this.#routines.arm();
      if (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Agent duplication failed and the incomplete copy could not be removed.",
        );
      }
      throw error;
    } finally {
      this.#duplicatingAgents.delete(sourceAgentId);
      // The mute always lifts here, so whatever queued behind it drains now.
      this.#hooks.scheduleDrain(sourceAgentId);
      if (releaseOnExit) releaseDuplication();
    }
  }

  async commit(agentId: string, layout: SidebarLayoutSnapshot): Promise<DuplicateAgentResult> {
    if (!this.#pendingAgents.has(agentId)) throw new Error("This agent duplication is not pending.");
    const operation = this.#pendingOperations.get(agentId);
    if (!operation) throw new Error("This agent duplication operation is unavailable.");
    const releaseDuplication = this.#pendingReleases.get(agentId);
    try {
      const result = await this.#store.commitAgentDuplication(
        agentId,
        operation.operationId,
        operation.sourceAgentId,
        layout,
      );
      this.#pendingAgents.delete(agentId);
      this.#pendingOperations.delete(agentId);
      this.#hooks.emit({ type: "agents-changed", agents: this.#hooks.listAgents() });
      if (this.#memories.listFor(result.agent.id).length > 0) this.#memories.stateChanged(result.agent.id);
      if (this.#routines.listFor(result.agent.id).length > 0) this.#routines.stateChanged(result.agent.id);
      this.#routines.arm();
      return result;
    } finally {
      this.#pendingReleases.delete(agentId);
      releaseDuplication?.();
    }
  }

  /**
   * Hands a agent deletion the commit-lock release it must run, so deleting a duplicate the user
   * rejected does not leave the next duplication waiting on a lock nobody holds. Returns whether
   * the agent was pending, which is what decides if `agents-changed` still needs emitting.
   */
  releaseForDelete(agentId: string): { wasPending: boolean; release: () => void } {
    const wasPending = this.#pendingAgents.has(agentId);
    const release = this.#pendingReleases.get(agentId);
    return {
      wasPending,
      release: () => {
        if (!wasPending) return;
        this.#pendingReleases.delete(agentId);
        release?.();
      },
    };
  }

  forget(agentId: string): void {
    this.#pendingAgents.delete(agentId);
    this.#pendingOperations.delete(agentId);
  }

  /** The precondition for starting a copy: nothing is waiting, and nothing is in flight. */
  assertAgentIdle(agentId: string): void {
    const queued = this.#mailbox.listQueue(agentId).deliveries.some((delivery) => delivery.status === "queued");
    if (queued) throw new Error("Wait for the agent to finish and clear its queue before duplicating it.");
    this.#assertAgentQuiet(agentId);
  }

  /**
   * Nothing the copy could race is in flight.
   *
   * A message that arrived *after* the copy started is held queued by `mayDrain` and has changed
   * nothing a duplicate takes — the copy carries no conversation, and an unstarted delivery has not
   * touched the workspace. So it is deliberately not counted here: counting it would let any
   * incoming message destroy a copy that is seconds from finishing.
   */
  #assertAgentQuiet(agentId: string): void {
    const inFlight = this.#mailbox
      .listQueue(agentId)
      .deliveries.some((delivery) => delivery.status === "starting" || delivery.status === "running");
    if (inFlight || this.#hooks.hasAttentionFor(agentId) || this.#conversation.snapshot(agentId)?.activeTurnId) {
      throw new Error("Wait for the agent to finish and clear its queue before duplicating it.");
    }
  }

  async #acquireCommitLock(): Promise<() => void> {
    const previous = this.#commitQueue;
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#commitQueue = previous.then(() => current);
    await previous;
    return release;
  }

  /**
   * Signs the same profile the store signs, so the two layers cannot disagree about what "changed"
   * means — otherwise narrowing one of them just moves the identical error message one frame out.
   */
  #sourceSignature(agentId: string): string {
    return JSON.stringify({
      agent: duplicationProfileSignature(this.#conversation.requireKnownAgent(agentId)),
      memories: this.#memories.listFor(agentId),
      routines: this.#routines.listFor(agentId),
    });
  }

  #assertSourceUnchanged(agentId: string, signature: string): void {
    this.#assertAgentQuiet(agentId);
    if (this.#sourceSignature(agentId) !== signature) {
      throw new Error("The agent changed while it was being duplicated. Try again.");
    }
  }
}
