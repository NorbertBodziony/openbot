import { randomUUID } from "node:crypto";
import type { AgentEvent, BotSummary, DuplicateBotResult, SidebarLayoutSnapshot } from "@openbot/contracts/ipc";
import type { BotStore } from "../bot-store";
import type { MailboxStore } from "../mailbox-store";
import type { AgentMemories } from "./agent-memories";
import type { ConversationRuntime } from "./conversation-runtime";
import type { RoutineScheduler } from "./routine-scheduler";

export interface DuplicationHooks {
  emit(event: AgentEvent): void;
  listBots(): BotSummary[];
  /** Removes a half-written copy: its workspace, mailbox rows and provider sessions. */
  deleteBotData(bot: BotSummary): Promise<void>;
  /** A bot with an outstanding question is not idle, even with an empty queue. */
  hasAttentionFor(botId: string): boolean;
}

export interface DuplicationGateOptions {
  store: BotStore;
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
 * window it is a real row that must not behave like a real agent: it is hidden from `listBots`, it
 * never drains its queue, its routines never fire, and `Unknown bot` is the honest answer for it.
 * Every path out of that window — commit, delete, or a failed copy — has to clear the same four
 * maps, which is why they live in one class rather than beside the code that happens to set them.
 *
 * The copy itself is guarded twice over. `#duplicatingBots` refuses a second concurrent copy of one
 * source; `#commitQueue` serialises commits so two duplications cannot interleave their store
 * writes; and the source signature is re-compared after every step, so an agent edited mid-copy
 * aborts rather than producing a duplicate that matches neither state.
 */
export class DuplicationGate {
  readonly #store: BotStore;
  readonly #mailbox: MailboxStore;
  readonly #conversation: ConversationRuntime;
  readonly #memories: AgentMemories;
  readonly #routines: RoutineScheduler;
  readonly #hooks: DuplicationHooks;
  readonly #duplicatingBots = new Set<string>();
  readonly #pendingBots = new Set<string>();
  readonly #pendingOperations = new Map<string, { operationId: string; sourceBotId: string }>();
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

  /** The duplication clause in the drain mute registry. */
  mayDrain(botId: string): boolean {
    return !this.#pendingBots.has(botId);
  }

  /** A pending duplicate is not yet an agent: it is hidden, and unknown to anything that looks up. */
  isPending(botId: string): boolean {
    return this.#pendingBots.has(botId);
  }

  pendingBots(): ReadonlySet<string> {
    return this.#pendingBots;
  }

  visibleBots(bots: BotSummary[]): BotSummary[] {
    return bots.filter((bot) => !this.#pendingBots.has(bot.id));
  }

  async duplicate(sourceBotId: string, operationId: string = randomUUID()): Promise<BotSummary> {
    const releaseDuplication = await this.#acquireCommitLock();
    let releaseOnExit = true;
    let duplicate: BotSummary | null = null;
    try {
      const source = this.#conversation.requireKnownBot(sourceBotId);
      if (this.#duplicatingBots.has(sourceBotId)) throw new Error("This agent is already being duplicated.");
      this.assertBotIdle(sourceBotId);
      const sourceSignature = this.#sourceSignature(sourceBotId);
      this.#duplicatingBots.add(sourceBotId);
      duplicate = await this.#store.duplicateBot(sourceBotId, operationId);
      this.#pendingBots.add(duplicate.id);
      this.#pendingOperations.set(duplicate.id, { operationId, sourceBotId });
      this.#assertSourceUnchanged(sourceBotId, sourceSignature);
      this.#memories.duplicate(sourceBotId, duplicate.id);
      const routines = this.#routines.duplicate(sourceBotId, duplicate.id, new Date());
      this.#assertSourceUnchanged(sourceBotId, sourceSignature);
      if (source.marketplaceSource) {
        duplicate = this.#store.setMarketplaceSource(duplicate.id, {
          ...structuredClone(source.marketplaceSource),
          routineIds: source.marketplaceSource.routineIds.flatMap((routineId) => {
            const copied = routines.get(routineId);
            return copied ? [copied.id] : [];
          }),
        });
      }
      this.#assertSourceUnchanged(sourceBotId, sourceSignature);
      const completedDuplicate = duplicate;
      this.#pendingReleases.set(completedDuplicate.id, releaseDuplication);
      releaseOnExit = false;
      return this.#store.list().find((candidate) => candidate.id === completedDuplicate.id) ?? completedDuplicate;
    } catch (error) {
      if (!duplicate) throw error;
      let rollbackError: unknown;
      try {
        await this.#hooks.deleteBotData(duplicate);
        this.#pendingBots.delete(duplicate.id);
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
      this.#duplicatingBots.delete(sourceBotId);
      if (releaseOnExit) releaseDuplication();
    }
  }

  async commit(botId: string, layout: SidebarLayoutSnapshot): Promise<DuplicateBotResult> {
    if (!this.#pendingBots.has(botId)) throw new Error("This agent duplication is not pending.");
    const operation = this.#pendingOperations.get(botId);
    if (!operation) throw new Error("This agent duplication operation is unavailable.");
    const releaseDuplication = this.#pendingReleases.get(botId);
    try {
      const result = await this.#store.commitBotDuplication(
        botId,
        operation.operationId,
        operation.sourceBotId,
        layout,
      );
      this.#pendingBots.delete(botId);
      this.#pendingOperations.delete(botId);
      this.#hooks.emit({ type: "bots-changed", bots: this.#hooks.listBots() });
      if (this.#memories.listFor(result.bot.id).length > 0) this.#memories.stateChanged(result.bot.id);
      if (this.#routines.listFor(result.bot.id).length > 0) this.#routines.stateChanged(result.bot.id);
      this.#routines.arm();
      return result;
    } finally {
      this.#pendingReleases.delete(botId);
      releaseDuplication?.();
    }
  }

  /**
   * Hands a bot deletion the commit-lock release it must run, so deleting a duplicate the user
   * rejected does not leave the next duplication waiting on a lock nobody holds. Returns whether
   * the bot was pending, which is what decides if `bots-changed` still needs emitting.
   */
  releaseForDelete(botId: string): { wasPending: boolean; release: () => void } {
    const wasPending = this.#pendingBots.has(botId);
    const release = this.#pendingReleases.get(botId);
    return {
      wasPending,
      release: () => {
        if (!wasPending) return;
        this.#pendingReleases.delete(botId);
        release?.();
      },
    };
  }

  forget(botId: string): void {
    this.#pendingBots.delete(botId);
    this.#pendingOperations.delete(botId);
  }

  assertBotIdle(botId: string): void {
    const hasPendingWork = this.#mailbox
      .listQueue(botId)
      .deliveries.some((delivery) => ["queued", "starting", "running"].includes(delivery.status));
    if (hasPendingWork || this.#hooks.hasAttentionFor(botId) || this.#conversation.snapshot(botId)?.activeTurnId) {
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

  #sourceSignature(botId: string): string {
    return JSON.stringify({
      bot: this.#conversation.requireKnownBot(botId),
      memories: this.#memories.listFor(botId),
      routines: this.#routines.listFor(botId),
    });
  }

  #assertSourceUnchanged(botId: string, signature: string): void {
    this.assertBotIdle(botId);
    if (this.#sourceSignature(botId) !== signature) {
      throw new Error("The agent changed while it was being duplicated. Try again.");
    }
  }
}
