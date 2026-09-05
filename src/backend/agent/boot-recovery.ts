import type { AgentStore } from "../agent-store";
import { mergeProviderHistory, snapshotFromThread } from "../conversation-snapshots";
import type { MailboxStore } from "../mailbox-store";
import { decodeThreadResponse } from "../protocol";
import type { ConversationRuntime } from "./conversation-runtime";
import { conversationContentSignature } from "./delivery-content";
import { markIncompleteImageGeneration } from "./image-generation";
import type { MailboxSync } from "./mailbox-sync";
import type { ProviderRuntime } from "./provider-runtime";

export interface BootRecoveryHooks {
  emitError(code: string, error: unknown, agentId?: string): void;
}

export interface BootRecoveryOptions {
  store: AgentStore;
  mailbox: MailboxStore;
  providers: ProviderRuntime;
  conversation: ConversationRuntime;
  mailboxSync: MailboxSync;
  hooks: BootRecoveryHooks;
}

/**
 * Restart recovery: settles what the previous process left mid-flight.
 *
 * - `recoverPersistedTurns` runs at startup before providers start: clears
 *   stale active turns, expires unanswered prompts, marks streaming messages
 *   interrupted.
 * - `reconcileUnresolvedDeliveries` runs once providers are ready: asks the
 *   provider what really happened to each unsettled delivery instead of
 *   assuming, and conservatively keeps `interrupted` on any doubt — never
 *   repeats uncertain side effects.
 * - `backfillProviderHistory` merges provider-side turns that happened while
 *   OpenBot was down into the persisted conversation.
 *
 * Reads the store/mailbox/provider and writes the database plus in-memory
 * snapshots; delivery to the renderer goes through `mailboxSync` and
 * `emitError`. Never imports the facade.
 */
export class BootRecovery {
  readonly #store: AgentStore;
  readonly #mailbox: MailboxStore;
  readonly #providers: ProviderRuntime;
  readonly #conversation: ConversationRuntime;
  readonly #mailboxSync: MailboxSync;
  readonly #hooks: BootRecoveryHooks;

  constructor(options: BootRecoveryOptions) {
    this.#store = options.store;
    this.#mailbox = options.mailbox;
    this.#providers = options.providers;
    this.#conversation = options.conversation;
    this.#mailboxSync = options.mailboxSync;
    this.#hooks = options.hooks;
  }

  async reconcileUnresolvedDeliveries(): Promise<void> {
    for (const context of this.#mailbox.unresolvedDeliveries()) {
      const { delivery } = context;
      let terminal: "completed" | "failed" | "interrupted" = "interrupted";
      let reason = "OpenBot restarted before this delivery reached a confirmed terminal state.";
      try {
        const agent = this.#store.list().find((candidate) => candidate.id === delivery.recipientAgentId);
        const client = agent ? this.#providers.clientForAgent(agent) : null;
        const session = agent ? this.#store.activeProviderSession(agent.id) : null;
        if (session && client) {
          const response = await client.request(
            "thread/read",
            { threadId: session.externalSessionId, includeTurns: true },
            decodeThreadResponse,
          );
          const turn = response.thread.turns?.find(
            (candidate) =>
              candidate.id === delivery.turnId ||
              candidate.items?.some((item) => item.type === "userMessage" && item.clientId === delivery.id),
          );
          if (turn && !delivery.turnId) {
            await this.#mailbox.markRunning(delivery.id, turn.id);
          }
          if (turn?.status === "completed") {
            terminal = "completed";
            reason = "Recovered completed delivery after restart.";
          } else if (turn?.status === "failed") {
            terminal = "failed";
            reason = "The recovered Codex turn failed.";
          }
        }
      } catch {
        // Conservatively keep the interrupted result; never repeat uncertain side effects.
      }
      await this.#mailbox.markTerminal(delivery.id, terminal, terminal === "completed" ? null : reason);
      const agent = this.#store.list().find((candidate) => candidate.id === delivery.recipientAgentId);
      if (agent?.threadId) {
        const snapshot = this.#store.database.readConversation(agent.id, agent.threadId);
        snapshot.activeTurnId = null;
        for (const message of snapshot.messages) {
          if (message.turnId === delivery.turnId && message.status === "streaming") {
            message.status = terminal;
            markIncompleteImageGeneration(message, terminal);
          }
        }
        this.#store.database.persistConversation(snapshot, "turn.reconciled-after-restart", {
          turnId: delivery.turnId,
          status: terminal,
        });
      }
      this.#mailboxSync.emitQueue(delivery.recipientAgentId);
    }
  }

  recoverPersistedTurns(): void {
    for (const agent of this.#store.list()) {
      if (!agent.threadId) continue;
      const snapshot = this.#store.database.readConversation(agent.id, agent.threadId);
      const turnId = snapshot.activeTurnId;
      let changed = false;
      if (turnId) {
        snapshot.activeTurnId = null;
        changed = true;
      }
      for (const message of snapshot.messages) {
        if (message.questionPrompt?.resolution === null) {
          message.questionPrompt.resolution = { status: "expired" };
          changed = true;
        }
        if (turnId && message.turnId === turnId && message.status === "streaming") {
          message.status = "interrupted";
          markIncompleteImageGeneration(message, "interrupted");
          changed = true;
        }
      }
      if (!changed) continue;
      const persisted = this.#store.database.persistConversation(snapshot, "turn.interrupted-by-restart", { turnId });
      this.#conversation.setSnapshot(agent.id, persisted);
    }
  }

  async backfillProviderHistory(): Promise<void> {
    for (const agent of this.#store.list()) {
      if (!agent.threadId) continue;
      const session = this.#store.activeProviderSession(agent.id);
      const client = this.#providers.clientForAgent(agent);
      if (!session || !client) continue;
      try {
        const response = await client.request(
          "thread/read",
          { threadId: session.externalSessionId, includeTurns: true },
          decodeThreadResponse,
        );
        const imported = snapshotFromThread(agent.id, response.thread, (deliveryId) =>
          this.#mailbox.getDelivery(deliveryId),
        );
        imported.threadId = agent.threadId;
        const current = this.#store.database.readConversation(agent.id, agent.threadId);
        const merged = mergeProviderHistory(current, imported);
        this.#mailboxSync.syncMailboxMessages(merged);
        if (conversationContentSignature(merged) === conversationContentSignature(current)) {
          const live = this.#conversation.snapshot(agent.id);
          if (!live?.activeTurnId) this.#conversation.setSnapshot(agent.id, current);
          continue;
        }
        const persisted = this.#store.database.persistConversation(merged, "provider-history.backfilled", {
          provider: session.provider,
          externalSessionId: session.externalSessionId,
        });
        const live = this.#conversation.snapshot(agent.id);
        if (!live?.activeTurnId) this.#conversation.setSnapshot(agent.id, persisted);
      } catch (error) {
        this.#hooks.emitError("provider_history_backfill_pending", error, agent.id);
      }
    }
  }
}
