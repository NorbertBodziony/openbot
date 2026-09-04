import type { AgentEvent, BotSummary, ConversationSnapshot } from "@openbot/contracts/ipc";
import type { AgentClient } from "../agent-client";
import type { BotStore } from "../bot-store";
import { sortConversationMessages } from "../conversation-snapshots";
import type { OpenBotDatabase } from "../openbot-database";
import { conversationContentSignature } from "./delivery-content";

/**
 * Runs `work` inside a SQLite transaction, opening one only when the caller is not already inside
 * another. Nesting is load-bearing: `deleteRoutine` drives a routine mutation whose `beforeMutate`
 * hook appends a run transition in the same transaction, and an approval response can append a
 * hosted-site event inside an outer one. This is the only `BEGIN IMMEDIATE` under `src/backend/agent`.
 */
export function withDatabaseTransaction<T>(database: OpenBotDatabase, work: () => T, onRollback?: () => void): T {
  const ownsTransaction = !database.connection.isTransaction;
  if (ownsTransaction) database.connection.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    if (ownsTransaction) database.connection.exec("COMMIT");
    return result;
  } catch (error) {
    if (ownsTransaction && database.connection.isTransaction) database.connection.exec("ROLLBACK");
    onRollback?.();
    throw error;
  }
}

export interface ConversationTransaction {
  threadId: string;
  snapshot: ConversationSnapshot;
}

export interface ConversationTransactionResult<T> {
  result: T;
  snapshot: ConversationSnapshot;
}

/**
 * Owns the live conversation projection and the provider-thread routing index.
 *
 * The four maps are one bidirectional index, which is why they are one class: `threadToBot` and
 * `loadedThreads` are keyed by the *external* provider thread id, `snapshots` and
 * `conversationSignatures` by bot id, and every conversion between those keyspaces runs through
 * `publicThreadId` or `ensureSnapshot`.
 */
export class ConversationRuntime {
  readonly #store: BotStore;
  readonly #emit: (event: AgentEvent) => void;
  /**
   * Deliberately not `store.list()`: the service filters out bots that are mid-duplication, and
   * `requireKnownBot` must keep throwing for those so a transaction on one rolls back.
   */
  readonly #listBots: () => BotSummary[];
  readonly #snapshots = new Map<string, ConversationSnapshot>();
  readonly #conversationSignatures = new Map<string, string>();
  readonly #threadToBot = new Map<string, string>();
  readonly #loadedThreads = new Map<string, AgentClient>();

  constructor(store: BotStore, emit: (event: AgentEvent) => void, listBots: () => BotSummary[]) {
    this.#store = store;
    this.#emit = emit;
    this.#listBots = listBots;
  }

  snapshot(botId: string): ConversationSnapshot | undefined {
    return this.#snapshots.get(botId);
  }

  setSnapshot(botId: string, snapshot: ConversationSnapshot): void {
    this.#snapshots.set(botId, snapshot);
  }

  dropSnapshot(botId: string): void {
    this.#snapshots.delete(botId);
  }

  activeSnapshots(): IterableIterator<[string, ConversationSnapshot]> {
    return this.#snapshots.entries();
  }

  ensureSnapshot(botId: string, threadId: string | null): ConversationSnapshot {
    let snapshot = this.#snapshots.get(botId);
    if (!snapshot) {
      const bot = this.#store.list().find((candidate) => candidate.id === botId);
      const publicThreadId = bot?.threadId ?? threadId;
      snapshot = this.#store.database.readConversation(botId, publicThreadId);
      this.#snapshots.set(botId, snapshot);
    } else if (threadId && !snapshot.threadId) {
      snapshot.threadId = threadId;
    }
    return snapshot;
  }

  publicThreadId(botId: string, fallback: string): string {
    return this.#store.list().find((candidate) => candidate.id === botId)?.threadId ?? fallback;
  }

  hasPublishedConversation(botId: string): boolean {
    return this.#conversationSignatures.has(botId);
  }

  emitConversation(
    snapshot: ConversationSnapshot,
    eventType = "conversation.snapshot-updated",
    detail: unknown = {
      activeTurnId: snapshot.activeTurnId,
      messageCount: snapshot.messages.length,
    },
  ): void {
    sortConversationMessages(snapshot.messages);
    const signature = conversationContentSignature(snapshot);
    if (this.#conversationSignatures.get(snapshot.botId) === signature) return;
    if (snapshot.threadId) {
      const persisted = this.#store.database.persistConversation(snapshot, eventType, detail);
      snapshot.revision = persisted.revision;
    }
    this.publishConversation(snapshot);
  }

  publishConversation(snapshot: ConversationSnapshot): void {
    this.#conversationSignatures.set(snapshot.botId, conversationContentSignature(snapshot));
    this.#emit({ type: "conversation", snapshot: structuredClone(snapshot) });
  }

  rememberConversationSignature(snapshot: ConversationSnapshot): void {
    this.#conversationSignatures.set(snapshot.botId, conversationContentSignature(snapshot));
  }

  botForThread(externalThreadId: string): string | undefined {
    return this.#threadToBot.get(externalThreadId);
  }

  bindThread(externalThreadId: string, botId: string): void {
    this.#threadToBot.set(externalThreadId, botId);
  }

  unbindThread(externalThreadId: string): void {
    this.#threadToBot.delete(externalThreadId);
  }

  loadedClientFor(externalThreadId: string): AgentClient | undefined {
    return this.#loadedThreads.get(externalThreadId);
  }

  markThreadLoaded(externalThreadId: string, client: AgentClient): void {
    this.#loadedThreads.set(externalThreadId, client);
  }

  unloadThread(externalThreadId: string): void {
    this.#loadedThreads.delete(externalThreadId);
  }

  clearLoadedThreads(): void {
    this.#loadedThreads.clear();
  }

  forgetBot(botId: string): void {
    this.#snapshots.delete(botId);
    this.#conversationSignatures.delete(botId);
  }

  /**
   * The one conversation-mutating transaction. Callers supply the work and the snapshot they want
   * published; the wrapper owns all three rollback mechanisms, which only compose correctly
   * together: `ROLLBACK` undoes rows, restoring `snapshots` undoes the in-memory projection, and
   * `restoreThreadIdentity` undoes `ensureThreadIdNow`, whose effect on the store's in-memory bot
   * list happens outside the transaction. The `previousBot.threadId === null` guard means it undoes
   * thread *creation*, never a thread change.
   */
  withConversationTransaction<T>(
    botId: string,
    work: (transaction: ConversationTransaction) => ConversationTransactionResult<T>,
    onRollback?: () => void,
  ): T {
    // Throws before BEGIN IMMEDIATE: an error raised inside an open transaction would leave
    // isTransaction true for the next caller, on a database that has no backup.
    const previousBot = this.requireKnownBot(botId);
    const previousSnapshot = this.#snapshots.get(botId);
    const previousSnapshotState = previousSnapshot ? structuredClone(previousSnapshot) : undefined;
    const restorePreviousState = () => {
      onRollback?.();
      if (previousBot.threadId === null) {
        this.#store.restoreThreadIdentity(botId, previousBot.threadId, previousBot.updatedAt);
      }
      if (previousSnapshotState) this.#snapshots.set(botId, previousSnapshotState);
      else this.#snapshots.delete(botId);
    };
    const { result, snapshot } = withDatabaseTransaction(
      this.#store.database,
      () => {
        const threadId = this.#store.ensureThreadIdNow(botId);
        const next = structuredClone(this.ensureSnapshot(botId, threadId));
        next.threadId = threadId;
        return work({ threadId, snapshot: next });
      },
      restorePreviousState,
    );
    this.#snapshots.set(botId, snapshot);
    this.publishConversation(snapshot);
    return result;
  }

  requireKnownBot(botId: string): BotSummary {
    const bot = this.#listBots().find((candidate) => candidate.id === botId);
    if (!bot) throw new Error(`Unknown bot: ${botId}`);
    return bot;
  }
}
