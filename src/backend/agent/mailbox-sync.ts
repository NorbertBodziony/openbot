import type { AgentEvent, AgentSummary, ConversationSnapshot } from "@openbot/contracts/ipc";
import { sortConversationMessages } from "../conversation-snapshots";
import type { MailboxStore } from "../mailbox-store";
import type { OpenBotDatabase } from "../openbot-database";
import type { ConversationRuntime } from "./conversation-runtime";
import { conversationContentSignature } from "./delivery-content";
import type { RoutineScheduler } from "./routine-scheduler";

export interface MailboxSyncHooks {
  emit(event: AgentEvent): void;
  emitError(code: string, error: unknown, agentId?: string): void;
}

export interface MailboxSyncOptions {
  database: OpenBotDatabase;
  mailbox: MailboxStore;
  conversation: ConversationRuntime;
  routines: RoutineScheduler;
  hooks: MailboxSyncHooks;
}

/**
 * Keeps conversation snapshots merged with mailbox rows, and fans queue
 * state out to the renderer.
 *
 * Owns no durable state — every method reads the mailbox/database and writes
 * the in-memory snapshot. The facade keeps no wrappers: call sites use this
 * directly, and later extractions (drain, turn lifecycle) take it as a dep
 * instead of reaching into the mailbox themselves.
 */
export class MailboxSync {
  readonly #database: OpenBotDatabase;
  readonly #mailbox: MailboxStore;
  readonly #conversation: ConversationRuntime;
  readonly #routines: RoutineScheduler;
  readonly #hooks: MailboxSyncHooks;

  constructor(options: MailboxSyncOptions) {
    this.#database = options.database;
    this.#mailbox = options.mailbox;
    this.#conversation = options.conversation;
    this.#routines = options.routines;
    this.#hooks = options.hooks;
  }

  syncDeliveryMessage(snapshot: ConversationSnapshot, deliveryId: string): void {
    const context = this.#mailbox.getDelivery(deliveryId);
    const message = snapshot.messages.find((candidate) => candidate.id === deliveryId);
    if (!context || !message) return;
    message.turnId = context.delivery.turnId ?? undefined;
    message.delivery = {
      id: context.delivery.id,
      status: context.delivery.status,
      position: context.delivery.position,
    };
  }

  syncMailboxMessages(snapshot: ConversationSnapshot): void {
    const indexes = new Map(snapshot.messages.map((message, index) => [message.id, index]));
    for (const mailboxMessage of this.#mailbox.conversationMessages(snapshot.agentId)) {
      const index = indexes.get(mailboxMessage.id);
      if (index !== undefined) snapshot.messages[index] = mailboxMessage;
      else {
        indexes.set(mailboxMessage.id, snapshot.messages.length);
        snapshot.messages.push(mailboxMessage);
      }
    }
    const reactions = this.#mailbox.reactionsFor(snapshot.agentId);
    for (const message of snapshot.messages) {
      message.reactions = reactions.get(message.id) ?? [];
      message.reaction = message.reactions.find((reaction) => reaction.actor.kind === "user")?.emoji ?? null;
    }
    sortConversationMessages(snapshot.messages);
  }

  reconcilePersistedMailboxMessages(agent: AgentSummary): void {
    if (!agent.threadId) return;
    const persisted = this.#database.readConversation(agent.id, agent.threadId);
    const previousSignature = conversationContentSignature(persisted);
    this.syncMailboxMessages(persisted);
    if (conversationContentSignature(persisted) === previousSignature) return;
    this.#database.persistConversation(persisted, "conversation.mailbox-reconciled", {
      messageCount: persisted.messages.length,
    });
    const live = this.#conversation.snapshot(agent.id);
    if (live) this.syncMailboxMessages(live);
  }

  emitQueue(agentId: string): void {
    const queue = this.#mailbox.listQueue(agentId);
    let routinesChanged = false;
    for (const delivery of queue.deliveries) {
      if (this.#routines.reconcileDelivery(delivery)) routinesChanged = true;
    }
    this.#hooks.emit({ type: "queue-changed", snapshot: queue });
    if (routinesChanged) this.#routines.stateChanged(agentId);
    const affectedAgents = new Set([agentId, ...this.#mailbox.senderAgentIdsForRecipient(agentId)]);
    for (const affectedAgentId of affectedAgents) {
      const snapshot = this.#conversation.snapshot(affectedAgentId);
      if (!snapshot) continue;
      const previousSignature = conversationContentSignature(snapshot);
      this.syncMailboxMessages(snapshot);
      if (conversationContentSignature(snapshot) !== previousSignature) this.#conversation.emitConversation(snapshot);
      else if (!this.#conversation.hasPublishedConversation(affectedAgentId))
        this.#conversation.publishConversation(snapshot);
    }
  }

  retryDeliveryReconciliation(agentId: string): void {
    queueMicrotask(() => {
      try {
        this.emitQueue(agentId);
        const snapshot = this.#conversation.snapshot(agentId);
        if (snapshot) this.#conversation.emitConversation(snapshot);
      } catch (error) {
        this.#hooks.emitError("delivery_reconciliation_pending", error, agentId);
      }
    });
  }
}
