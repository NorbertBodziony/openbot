import type {
  AgentEvent,
  BotSummary,
  BrowserControlState,
  BrowserTab,
  ConversationSnapshot,
} from "@openbot/contracts/ipc";
import { isString } from "@openbot/contracts/runtime-values";
import type { AgentClient } from "../agent-client";
import type { BotStore } from "../agent-store";
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
  emitError(code: string, error: unknown, botId?: string): void;
  emitRuntimeSnapshot(): void;
  scheduleDrain(botId: string): void;
  listBots(): BotSummary[];
}

export interface TurnLifecycleOptions {
  store: BotStore;
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
  readonly #store: BotStore;
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

  forgetBot(botId: string): void {
    this.#failedTurns.delete(botId);
  }

  trackItem(itemId: string, turnId: string): void {
    this.#itemTurns.set(itemId, turnId);
  }

  acknowledgeFailedTurn(botId: string, turnId: string): void {
    if (this.#failedTurns.get(botId) !== turnId) return;
    this.#failedTurns.delete(botId);
    this.#hooks.emitRuntimeSnapshot();
  }

  dispose(): void {
    this.#failedTurns.clear();
    this.#turnAssociations.clear();
  }

  handleNotification(notification: AppServerNotification, source: AgentClient): void {
    const params = notification.params;
    const threadId = getString(params, "threadId");
    const botId = threadId ? this.#conversation.botForThread(threadId) : undefined;

    switch (notification.method) {
      case "account/login/completed": {
        this.#providers.completeCodexLogin(params, source, decodeAccountLoginCompletedResult);
        return;
      }
      case "turn/started": {
        if (!threadId || !botId) return;
        const turn = getRecord(params, "turn");
        const turnId = getString(turn, "id");
        if (!turnId) return;
        if (this.#compaction.claimTurn(botId, threadId, turnId)) return;
        const publicThreadId = this.#conversation.publicThreadId(botId, threadId);
        const snapshot = this.#conversation.ensureSnapshot(botId, publicThreadId);
        snapshot.activeTurnId = turnId;
        this.#failedTurns.delete(botId);
        const origin = this.#mailbox.startingDeliveryForBot(botId)?.delivery.sender.kind ?? "unknown";
        const association = this.#associateStartedTurn(botId, turnId, snapshot);
        this.#turnAssociations.set(turnId, association);
        void association.finally(() => {
          if (this.#turnAssociations.get(turnId) === association) {
            this.#turnAssociations.delete(turnId);
          }
        });
        this.#hooks.emit({ type: "turn-started", botId, threadId: publicThreadId, turnId, origin });
        this.#conversation.emitConversation(snapshot, "turn.started", { turnId });
        return;
      }
      case "item/started":
      case "item/completed": {
        if (!threadId || !botId) return;
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
        this.#applyItem(botId, threadId, turnId, threadItem, notification.method === "item/completed");
        return;
      }
      case "item/agentMessage/delta": {
        if (!threadId || !botId) return;
        const turnId = getString(params, "turnId");
        const itemId = getString(params, "itemId");
        const delta = getString(params, "delta");
        if (!turnId || !itemId || delta === null) return;
        this.#itemTurns.set(itemId, turnId);
        const publicThreadId = this.#conversation.publicThreadId(botId, threadId);
        const snapshot = this.#conversation.ensureSnapshot(botId, publicThreadId);
        let message = snapshot.messages.find((candidate) => candidate.id === itemId);
        if (!message) {
          message = newAssistantMessage(itemId, turnId);
          snapshot.messages.push(message);
        }
        message.text += delta;
        message.status = "streaming";
        this.#deltas.buffer({
          botId,
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
        if (!threadId || !botId) return;
        const turn = getRecord(params, "turn");
        const turnId = getString(turn, "id");
        if (!turnId) return;
        const status = getString(turn, "status") ?? "completed";
        this.#attention.clearForTurn(threadId, turnId);
        if (this.#compaction.isCompactionTurn(threadId, turnId)) {
          this.#compaction.finish(botId, threadId, status);
          return;
        }
        void this.#completeTurn(botId, threadId, turnId, status).catch((error) => {
          this.#hooks.emitError("turn_completion_failed", error, botId);
        });
        return;
      }
      case "thread/tokenUsage/updated": {
        if (!threadId || !botId) return;
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
        this.#hooks.emitError(`agent_${notification.method}`, message, botId);
      }
    }
  }

  async #completeTurn(botId: string, threadId: string, turnId: string, status: string): Promise<void> {
    this.#deltas.flushTurn(turnId);
    await this.#images.waitForOperations(threadId, turnId);
    await this.#turnAssociations.get(turnId)?.catch(() => undefined);
    this.#memories.finishTurn(turnId, status);
    const shouldCompact = this.#compaction.reserve(botId, threadId);
    this.#browser.endControl(this.#conversation.publicThreadId(botId, threadId), turnId);
    const snapshot = this.#conversation.ensureSnapshot(botId, threadId);
    snapshot.activeTurnId = null;
    if (status === "failed") this.#failedTurns.set(botId, turnId);
    else this.#failedTurns.delete(botId);
    for (const message of snapshot.messages) {
      if (this.#itemTurns.get(message.id) !== turnId || message.status !== "streaming") continue;
      message.status = normalizeCompletionStatus(status);
      markIncompleteImageGeneration(message, message.status);
    }
    const deliveries = this.#mailbox.findDeliveriesByTurn(botId, turnId);
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
      const relayDelivery = deliveries.find((delivery) => delivery.delivery.sender.kind === "bot");
      if (terminal === "completed" && latestAssistant && relayDelivery) {
        await this.#relayAgentResult(botId, turnId, relayDelivery, latestAssistant.text);
      }
    }
    if (latestAssistant) {
      await this.#store.updatePreview(botId, latestAssistant.text);
      this.#hooks.emit({ type: "bots-changed", bots: this.#hooks.listBots() });
    }
    this.#conversation.emitConversation(snapshot, "turn.completed", { turnId, status });
    if (deliveries.length > 0) {
      try {
        this.#mailboxSync.emitQueue(botId);
      } catch (error) {
        this.#hooks.emitError("delivery_reconciliation_pending", error, botId);
        this.#mailboxSync.retryDeliveryReconciliation(botId);
      }
    }
    this.#hooks.emit({
      type: "turn-completed",
      botId,
      threadId: this.#conversation.publicThreadId(botId, threadId),
      turnId,
      status,
      origin: deliveries[0]?.delivery.sender.kind ?? "unknown",
    });
    if (shouldCompact) await this.#compaction.request(botId, threadId);
    else this.#hooks.scheduleDrain(botId);
  }

  async #associateStartedTurn(botId: string, turnId: string, snapshot: ConversationSnapshot): Promise<void> {
    const delivery = this.#mailbox.startingDeliveryForBot(botId);
    if (!delivery) return;
    try {
      await this.#mailbox.markRunning(delivery.delivery.id, turnId);
      this.#mailboxSync.syncDeliveryMessage(snapshot, delivery.delivery.id);
      this.#mailboxSync.emitQueue(botId);
    } catch (error) {
      this.#hooks.emitError("delivery_turn_association_failed", error, botId);
    }
  }

  async #relayAgentResult(botId: string, turnId: string, delivery: DeliveryContext, text: string): Promise<void> {
    if (delivery.delivery.sender.kind !== "bot") return;
    const messageId = delivery.delivery.messageId;
    const originBotId = this.#mailbox.chainOriginBotId(messageId);
    const recipientBotId = delivery.delivery.sender.botId;
    if (
      !originBotId ||
      originBotId === botId ||
      this.#mailbox.hasReplyFrom(botId, messageId) ||
      this.#mailbox.hasBotMessageFromTurnTo(botId, turnId, recipientBotId)
    )
      return;

    await this.#mailbox.enqueue({
      sender: { kind: "bot", botId },
      recipientBotIds: [recipientBotId],
      text,
      replyToMessageId: messageId,
      idempotencyKey: `auto-result:${turnId}:${messageId}`,
    });
    const senderSnapshot = this.#conversation.snapshot(botId);
    if (senderSnapshot) {
      this.#mailboxSync.syncMailboxMessages(senderSnapshot);
      this.#conversation.emitConversation(senderSnapshot);
    }
    this.#mailboxSync.emitQueue(recipientBotId);
    this.#hooks.scheduleDrain(recipientBotId);
  }

  #applyItem(botId: string, threadId: string, turnId: string, item: ThreadItem, completed: boolean): void {
    if (this.#images.handleItem(botId, threadId, turnId, item, completed)) return;
    const toolProgress = toolProgressText(item, completed);
    if (toolProgress) {
      this.#emitTurnProgress(botId, this.#conversation.publicThreadId(botId, threadId), turnId, toolProgress);
      return;
    }
    if (item.type !== "agentMessage" || !isString(item.id)) return;
    const snapshot = this.#conversation.ensureSnapshot(botId, threadId);
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

  #emitTurnProgress(botId: string, threadId: string, turnId: string, text: string): void {
    this.#hooks.emit({
      type: "turn-progress",
      botId,
      threadId,
      turnId,
      detail: text,
    });
  }
}
