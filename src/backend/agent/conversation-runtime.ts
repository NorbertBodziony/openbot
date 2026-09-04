import type { AgentEvent, BotSummary, ConversationSnapshot } from "@openbot/contracts/ipc";
import type { AgentClient } from "../agent-client";
import type { BotStore } from "../agent-store";
import { sortConversationMessages } from "../conversation-snapshots";
import type { OpenBotDatabase } from "../openbot-database";
import { conversationContentSignature } from "./delivery-content";

interface TransactionScope {
  readonly rollback: (() => void)[];
  readonly commit: (() => void)[];
}

/** Only the caller that opened the transaction holds a scope, so a nested call finds the owner's. */
const openTransactions = new WeakMap<OpenBotDatabase, TransactionScope>();

/**
 * Runs `work` inside a SQLite transaction, opening one only when the caller is not already inside
 * another. Nesting is load-bearing: `deleteRoutine` drives a routine mutation whose `beforeMutate`
 * hook appends a run transition in the same transaction, and an approval response can append a
 * hosted-site event inside an outer one. This is the only `BEGIN IMMEDIATE` under `src/backend/agent`.
 *
 * `onCommit` exists because a nested caller must not publish in-memory state the owner can still
 * discard: there is no partial rollback here, so effects that make rows visible to the rest of the
 * app are queued on the owner and run once, after `COMMIT`. `onRollback` is queued the same way, so
 * an owner that fails *after* a nested call succeeded still undoes that call's in-memory slice.
 */
export function withDatabaseTransaction<T>(
  database: OpenBotDatabase,
  work: () => T,
  onRollback?: () => void,
  onCommit?: () => void,
): T {
  // `isTransaction`, not the map, decides who opens one: a transaction started anywhere else would
  // otherwise make this call BEGIN IMMEDIATE inside it, which SQLite rejects.
  if (database.connection.isTransaction) {
    const owner = openTransactions.get(database);
    let result: T;
    try {
      result = work();
    } catch (error) {
      // Our own work failed, so undo our in-memory slice now rather than queueing it: the owner's
      // ROLLBACK will undo the rows, and a queued restorer would run a second time.
      onRollback?.();
      throw error;
    }
    if (owner) {
      if (onRollback) owner.rollback.push(onRollback);
      if (onCommit) owner.commit.push(onCommit);
    } else {
      // An ambient transaction this helper did not open has no queue to defer onto, so the
      // effects run as they always did.
      onCommit?.();
    }
    return result;
  }
  database.connection.exec("BEGIN IMMEDIATE");
  const scope: TransactionScope = { rollback: [], commit: [] };
  openTransactions.set(database, scope);
  let result: T;
  try {
    result = work();
    database.connection.exec("COMMIT");
  } catch (error) {
    if (database.connection.isTransaction) database.connection.exec("ROLLBACK");
    openTransactions.delete(database);
    // Innermost first, so each restorer sees the state the one after it has already put back.
    for (const restore of [...scope.rollback].reverse()) restore();
    onRollback?.();
    throw error;
  }
  // Past COMMIT the rows are durable, so the effects run outside the block above: a listener that
  // throws while a conversation is published must not reach the restorers, which would put the
  // in-memory projection back to a state SQLite no longer holds. Only `work` and `COMMIT` roll back.
  //
  // The scope is cleared first because publishing can re-enter this function, which must then open
  // its own transaction instead of joining one that is already committed.
  openTransactions.delete(database);
  for (const effect of scope.commit) effect();
  onCommit?.();
  return result;
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
   *
   * The snapshot is published once the transaction that owns it commits, which is immediately when
   * this call opened it and later when it joined one, so no caller can see a conversation built on
   * rows a surrounding transaction still discards.
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
    let published: ConversationSnapshot | undefined;
    return withDatabaseTransaction(
      this.#store.database,
      () => {
        const threadId = this.#store.ensureThreadIdNow(botId);
        const next = structuredClone(this.ensureSnapshot(botId, threadId));
        next.threadId = threadId;
        const outcome = work({ threadId, snapshot: next });
        published = outcome.snapshot;
        return outcome.result;
      },
      restorePreviousState,
      () => {
        if (!published) return;
        this.#snapshots.set(botId, published);
        this.publishConversation(published);
      },
    );
  }

  requireKnownBot(botId: string): BotSummary {
    const bot = this.#listBots().find((candidate) => candidate.id === botId);
    if (!bot) throw new Error(`Unknown bot: ${botId}`);
    return bot;
  }
}
