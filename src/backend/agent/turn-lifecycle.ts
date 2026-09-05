import type {
  AgentEvent,
  AgentSummary,
  BrowserControlState,
  BrowserTab,
  ConversationSnapshot,
} from "@openbot/contracts/ipc";
import { isString } from "@openbot/contracts/runtime-values";
import type { AgentClient } from "../agent-client";
import type { AgentStore } from "../agent-store";
import { newAssistantMessage, normalizeCompletionStatus } from "../conversation-snapshots";
import type { DeliveryContext, MailboxStore } from "../mailbox-store";
import {
  type AppServerNotification,
  type DynamicToolCallParams,
  type DynamicToolResult,
  decodeAccountLoginCompletedResult,
  getRecord,
  getString,
  type ThreadItem,
} from "../protocol";
import type { AgentMemories } from "./agent-memories";
import type { AttentionRegistry } from "./attention-registry";
import type { ContextCompaction } from "./context-compaction";
import type { ConversationRuntime } from "./conversation-runtime";
import type { DeltaBuffer } from "./delta-buffer";
import type { ImageGenRuntime } from "./image-gen-runtime";
import { markIncompleteImageGeneration } from "./image-generation";
import type { MailboxSync } from "./mailbox-sync";
import type { ProviderRuntime } from "./provider-runtime";
import { isNonActionableCodexWarning, toolProgressText, toThreadItem } from "./thread-items";

export interface AgentBrowserHost {
  onChanged(listener: (tabs: BrowserTab[], activeTabId: string | null) => void): () => void;
  onControlChanged(listener: (state: BrowserControlState) => void): () => void;
  clearControls(): void;
  endControl(threadId: string, turnId: string): void;
  listTabs(): BrowserTab[];
  handleDynamicTool(params: DynamicToolCallParams): Promise<DynamicToolResult>;
}

export interface TurnHooks {
  emit(event: AgentEvent): void;
  emitError(code: string, error: unknown, agentId?: string): void;
  emitRuntimeSnapshot(): void;
  scheduleDrain(agentId: string): void;
  listAgents(): AgentSummary[];
}

export interface TurnLifecycleOptions {
  store: AgentStore;
  mailbox: MailboxStore;
  mailboxSync: MailboxSync;
  conversation: ConversationRuntime;
  providers: ProviderRuntime;
  memories: AgentMemories;
  attention: AttentionRegistry;
  browser: AgentBrowserHost;
  compaction: ContextCompaction;
  images: ImageGenRuntime;
  deltas: DeltaBuffer;
  hooks: TurnHooks;
}

/**
 * Turn lifecycle: provider notifications in, settled conversation out.
 *
 * Owns the failed-turn, item→turn and turn-association maps. Streaming items
 * fan out to `ImageGenRuntime` (image generations) and `DeltaBuffer`
 * (message deltas); anything else becomes a conversation message here.
 * Completion settles deliveries, relays agent-to-agent results, and either
 * arms context compaction or schedules the next drain via hooks.
 */
export class TurnLifecycle {
  readonly #store: AgentStore;
  readonly #mailbox: MailboxStore;
  readonly #mailboxSync: MailboxSync;
  readonly #conversation: ConversationRuntime;
  readonly #providers: ProviderRuntime;
  readonly #memories: AgentMemories;
  readonly #attention: AttentionRegistry;
  readonly #browser: AgentBrowserHost;
  readonly #compaction: ContextCompaction;
  readonly #images: ImageGenRuntime;
  readonly #deltas: DeltaBuffer;
  readonly #hooks: TurnHooks;
  readonly #failedTurns = new Map<string, string>();
  readonly #itemTurns = new Map<string, string>();
  readonly #turnAssociations = new Map<string, Promise<void>>();

  constructor(options: TurnLifecycleOptions) {
    this.#store = options.store;
    this.#mailbox = options.mailbox;
    this.#mailboxSync = options.mailboxSync;
    this.#conversation = options.conversation;
    this.#providers = options.providers;
    this.#memories = options.memories;
    this.#attention = options.attention;
    this.#browser = options.browser;
    this.#compaction = options.compaction;
    this.#images = options.images;
    this.#deltas = options.deltas;
    this.#hooks = options.hooks;
  }

  failedTurns(): ReadonlyMap<string, string> {
    return this.#failedTurns;
  }

  forgetAgent(agentId: string): void {
    this.#failedTurns.delete(agentId);
  }

  trackItem(itemId: string, turnId: string): void {
    this.#itemTurns.set(itemId, turnId);
  }

  acknowledgeFailedTurn(agentId: string, turnId: string): void {
    if (this.#failedTurns.get(agentId) !== turnId) return;
    this.#failedTurns.delete(agentId);
    this.#hooks.emitRuntimeSnapshot();
  }

  dispose(): void {
    this.#failedTurns.clear();
    this.#turnAssociations.clear();
  }

  handleNotification(notification: AppServerNotification, source: AgentClient): void {
    const params = notification.params;
    const threadId = getString(params, "threadId");
    const agentId = threadId ? this.#conversation.agentForThread(threadId) : undefined;

    switch (notification.method) {
      case "account/login/completed": {
        this.#providers.completeCodexLogin(params, source, decodeAccountLoginCompletedResult);
        return;
      }
      case "turn/started": {
        if (!threadId || !agentId) return;
        const turn = getRecord(params, "turn");
        const turnId = getString(turn, "id");
        if (!turnId) return;
        if (this.#compaction.claimTurn(agentId, threadId, turnId)) return;
        const publicThreadId = this.#conversation.publicThreadId(agentId, threadId);
        const snapshot = this.#conversation.ensureSnapshot(agentId, publicThreadId);
        snapshot.activeTurnId = turnId;
        this.#failedTurns.delete(agentId);
        const origin = this.#mailbox.startingDeliveryForAgent(agentId)?.delivery.sender.kind ?? "unknown";
        const association = this.#associateStartedTurn(agentId, turnId, snapshot);
        this.#turnAssociations.set(turnId, association);
        void association.finally(() => {
          if (this.#turnAssociations.get(turnId) === association) {
            this.#turnAssociations.delete(turnId);
          }
        });
        this.#hooks.emit({ type: "turn-started", agentId, threadId: publicThreadId, turnId, origin });
        this.#conversation.emitConversation(snapshot, "turn.started", { turnId });
        return;
      }
      case "item/started":
      case "item/completed": {
        if (!threadId || !agentId) return;
        const turnId = getString(params, "turnId");
        const item = getRecord(params, "item");
        if (!turnId || !item) return;
        const itemId = getString(item, "id");
        if (itemId) this.#itemTurns.set(itemId, turnId);
        if (item.type === "contextCompaction") {
          if (notification.method === "item/completed") {
            this.#compaction.markCompacted(threadId);
          }
          return;
        }
        if (notification.method === "item/completed" && itemId) {
          this.#deltas.flush(`${threadId}:${turnId}:${itemId}`);
        }
        const threadItem = toThreadItem(item);
        if (!threadItem) return;
        this.#applyItem(agentId, threadId, turnId, threadItem, notification.method === "item/completed");
        return;
      }
      case "item/agentMessage/delta": {
        if (!threadId || !agentId) return;
        const turnId = getString(params, "turnId");
        const itemId = getString(params, "itemId");
        const delta = getString(params, "delta");
        if (!turnId || !itemId || delta === null) return;
        this.#itemTurns.set(itemId, turnId);
        const publicThreadId = this.#conversation.publicThreadId(agentId, threadId);
        const snapshot = this.#conversation.ensureSnapshot(agentId, publicThreadId);
        let message = snapshot.messages.find((candidate) => candidate.id === itemId);
        if (!message) {
          message = newAssistantMessage(itemId, turnId);
          snapshot.messages.push(message);
        }
        message.text += delta;
        message.status = "streaming";
        this.#deltas.buffer({
          agentId,
          externalThreadId: threadId,
          publicThreadId,
          turnId,
          messageId: itemId,
          text: delta,
          createdAt: message.createdAt,
        });
        return;
      }
      case "turn/completed": {
        if (!threadId || !agentId) return;
        const turn = getRecord(params, "turn");
        const turnId = getString(turn, "id");
        if (!turnId) return;
        const status = getString(turn, "status") ?? "completed";
        this.#attention.clearForTurn(threadId, turnId);
        if (this.#compaction.isCompactionTurn(threadId, turnId)) {
          this.#compaction.finish(agentId, threadId, status);
          return;
        }
        void this.#completeTurn(agentId, threadId, turnId, status).catch((error) => {
          this.#hooks.emitError("turn_completion_failed", error, agentId);
        });
        return;
      }
      case "thread/tokenUsage/updated": {
        if (!threadId || !agentId) return;
        this.#compaction.updateBudget(threadId, params);
        return;
      }
      case "thread/archived": {
        if (threadId && this.#conversation.loadedClientFor(threadId) === source)
          this.#conversation.unloadThread(threadId);
        return;
      }
      case "mcpServer/startupStatus/updated": {
        if (getString(params, "name") !== "computer-use") return;
        const status = getString(params, "status");
        this.#providers.setComputerUseCapability(status === "ready" ? "ready" : "setup-required");
        return;
      }
      case "account/rateLimits/updated": {
        this.#providers.refreshCodexUsage();
        return;
      }
      case "error":
      case "warning": {
        const message = getString(params, "message") ?? notification.method;
        if (notification.method === "warning" && isNonActionableCodexWarning(message)) return;
        this.#hooks.emitError(`agent_${notification.method}`, message, agentId);
      }
    }
  }

  async #completeTurn(agentId: string, threadId: string, turnId: string, status: string): Promise<void> {
    this.#deltas.flushTurn(turnId);
    await this.#images.waitForOperations(threadId, turnId);
    await this.#turnAssociations.get(turnId)?.catch(() => undefined);
    this.#memories.finishTurn(turnId, status);
    const shouldCompact = this.#compaction.reserve(agentId, threadId);
    this.#browser.endControl(this.#conversation.publicThreadId(agentId, threadId), turnId);
    const snapshot = this.#conversation.ensureSnapshot(agentId, threadId);
    snapshot.activeTurnId = null;
    if (status === "failed") this.#failedTurns.set(agentId, turnId);
    else this.#failedTurns.delete(agentId);
    for (const message of snapshot.messages) {
      if (this.#itemTurns.get(message.id) !== turnId || message.status !== "streaming") continue;
      message.status = normalizeCompletionStatus(status);
      markIncompleteImageGeneration(message, message.status);
    }
    const deliveries = this.#mailbox.findDeliveriesByTurn(agentId, turnId);
    const latestAssistant = [...snapshot.messages]
      .reverse()
      .find(
        (message) =>
          message.author === "assistant" &&
          message.turnId === turnId &&
          message.itemType !== "commentary" &&
          message.itemType !== "question_prompt" &&
          message.text.trim(),
      );
    if (deliveries.length > 0) {
      const terminal = status === "failed" ? "failed" : status === "interrupted" ? "interrupted" : "completed";
      for (const delivery of deliveries) {
        await this.#mailbox.markTerminal(delivery.delivery.id, terminal);
        this.#mailboxSync.syncDeliveryMessage(snapshot, delivery.delivery.id);
      }
      const relayDelivery = deliveries.find((delivery) => delivery.delivery.sender.kind === "agent");
      if (terminal === "completed" && latestAssistant && relayDelivery) {
        await this.#relayAgentResult(agentId, turnId, relayDelivery, latestAssistant.text);
      }
    }
    if (latestAssistant) {
      await this.#store.updatePreview(agentId, latestAssistant.text);
      this.#hooks.emit({ type: "agents-changed", agents: this.#hooks.listAgents() });
    }
    this.#conversation.emitConversation(snapshot, "turn.completed", { turnId, status });
    if (deliveries.length > 0) {
      try {
        this.#mailboxSync.emitQueue(agentId);
      } catch (error) {
        this.#hooks.emitError("delivery_reconciliation_pending", error, agentId);
        this.#mailboxSync.retryDeliveryReconciliation(agentId);
      }
    }
    this.#hooks.emit({
      type: "turn-completed",
      agentId,
      threadId: this.#conversation.publicThreadId(agentId, threadId),
      turnId,
      status,
      origin: deliveries[0]?.delivery.sender.kind ?? "unknown",
    });
    if (shouldCompact) await this.#compaction.request(agentId, threadId);
    else this.#hooks.scheduleDrain(agentId);
  }

  async #associateStartedTurn(agentId: string, turnId: string, snapshot: ConversationSnapshot): Promise<void> {
    const delivery = this.#mailbox.startingDeliveryForAgent(agentId);
    if (!delivery) return;
    try {
      await this.#mailbox.markRunning(delivery.delivery.id, turnId);
      this.#mailboxSync.syncDeliveryMessage(snapshot, delivery.delivery.id);
      this.#mailboxSync.emitQueue(agentId);
    } catch (error) {
      this.#hooks.emitError("delivery_turn_association_failed", error, agentId);
    }
  }

  async #relayAgentResult(agentId: string, turnId: string, delivery: DeliveryContext, text: string): Promise<void> {
    if (delivery.delivery.sender.kind !== "agent") return;
    const messageId = delivery.delivery.messageId;
    const originAgentId = this.#mailbox.chainOriginAgentId(messageId);
    const recipientAgentId = delivery.delivery.sender.agentId;
    if (
      !originAgentId ||
      originAgentId === agentId ||
      this.#mailbox.hasReplyFrom(agentId, messageId) ||
      this.#mailbox.hasAgentMessageFromTurnTo(agentId, turnId, recipientAgentId)
    )
      return;

    await this.#mailbox.enqueue({
      sender: { kind: "agent", agentId },
      recipientAgentIds: [recipientAgentId],
      text,
      replyToMessageId: messageId,
      idempotencyKey: `auto-result:${turnId}:${messageId}`,
    });
    const senderSnapshot = this.#conversation.snapshot(agentId);
    if (senderSnapshot) {
      this.#mailboxSync.syncMailboxMessages(senderSnapshot);
      this.#conversation.emitConversation(senderSnapshot);
    }
    this.#mailboxSync.emitQueue(recipientAgentId);
    this.#hooks.scheduleDrain(recipientAgentId);
  }

  #applyItem(agentId: string, threadId: string, turnId: string, item: ThreadItem, completed: boolean): void {
    if (this.#images.handleItem(agentId, threadId, turnId, item, completed)) return;
    const toolProgress = toolProgressText(item, completed);
    if (toolProgress) {
      this.#emitTurnProgress(agentId, this.#conversation.publicThreadId(agentId, threadId), turnId, toolProgress);
      return;
    }
    if (item.type !== "agentMessage" || !isString(item.id)) return;
    const snapshot = this.#conversation.ensureSnapshot(agentId, threadId);
    let message = snapshot.messages.find((candidate) => candidate.id === item.id);
    if (!message) {
      message = newAssistantMessage(item.id, turnId);
      snapshot.messages.push(message);
    }
    if (isString(item.text)) message.text = item.text;
    if (isString(item.phase)) message.itemType = item.phase;
    message.status = completed ? "completed" : "streaming";
    this.#itemTurns.set(item.id, turnId);
    this.#conversation.emitConversation(snapshot);
  }

  #emitTurnProgress(agentId: string, threadId: string, turnId: string, text: string): void {
    this.#hooks.emit({
      type: "turn-progress",
      agentId,
      threadId,
      turnId,
      detail: text,
    });
  }
}
