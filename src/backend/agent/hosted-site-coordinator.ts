import { randomUUID } from "node:crypto";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type {
  AgentApproval,
  AgentApprovalPermissions,
  ConversationMessage,
  HostedSiteConversationEventAction,
  HostedSiteConversationEventDetails,
  HostedSiteConversationEventStatus,
  HostedSiteSummary,
  PublishHostedSiteInput,
} from "@openbot/contracts/ipc";
import { hostedSiteConversationEventItemType, hostedSiteConversationEventText } from "@openbot/contracts/ipc";
import { isBoolean } from "@openbot/contracts/runtime-values";
import type { AgentClient } from "../agent-client";
import type { BotStore } from "../agent-store";
import { sortConversationMessages } from "../conversation-snapshots";
import type { PendingHostedSiteTerminalEvent } from "../openbot-database";
import { type AppServerRequest, type DynamicToolCallParams, isRecord, type RequestId } from "../protocol";
import type { ConversationRuntime } from "./conversation-runtime";
import {
  type HostedSiteMutationTool,
  hostedSiteAction,
  hostedSiteEventCommandId,
  hostedSiteEventDetails,
  hostedSiteEventMessageId,
  hostedSiteTool,
} from "./hosted-site-events";
import { type OpenBotToolResponse, openBotToolResult, siteToolString } from "./routine-tools";

/** The openbot.site host, injected so the backend never depends on the account Worker directly. */
export interface AgentHostedSites {
  list(): Promise<HostedSiteSummary[]>;
  publish(input: PublishHostedSiteInput, allowedRoots: readonly string[]): Promise<HostedSiteSummary>;
  replace(
    input: PublishHostedSiteInput & { siteId: string },
    allowedRoots: readonly string[],
  ): Promise<HostedSiteSummary>;
  delete(siteId: string): Promise<void>;
}

/**
 * Carried on the pending approval record rather than in a map keyed by request id: request ids come
 * from the provider process and are reused across client restarts, so a second map could hand a
 * stale mutation to an unrelated approval. The approval record is already the thing every cleanup
 * path drops.
 */
export interface HostedSiteMutationContext {
  botId: string;
  operationId: string;
  action: HostedSiteConversationEventAction;
  params: DynamicToolCallParams;
  eventDetails: HostedSiteConversationEventDetails;
}

export interface HostedSiteApprovalTarget {
  client: AgentClient;
  id: RequestId;
  botId: string;
}

export interface HostedSiteCoordinatorOptions {
  store: BotStore;
  conversation: ConversationRuntime;
  hostedSites: AgentHostedSites | null;
  emitError(code: string, error: unknown, botId?: string): void;
  isStopping(): boolean;
}

interface HostedSiteApprovalDetails {
  reason: string;
  permissions: AgentApprovalPermissions;
  eventDetails: HostedSiteConversationEventDetails;
}

interface HostedSiteMutationResult {
  response: OpenBotToolResponse;
  eventDetails: HostedSiteConversationEventDetails;
}

export const HOSTED_SITE_APPROVAL_METHOD = "openbot/hosted-site-mutation";

/**
 * Owns publishing to openbot.site: the approval a mutation needs, the mutation itself, and the
 * conversation markers that record it.
 *
 * The markers are the reason this is a class rather than a set of functions. A terminal marker
 * ("succeeded", "failed", "cancelled", "interrupted") is written to SQLite *before* the provider is
 * answered, so a crash between the two leaves a durable pending event that `restore()` replays; the
 * provider response rides along as the `deliver` callback and only fires once the marker is durable.
 */
export class HostedSiteCoordinator {
  readonly #store: BotStore;
  readonly #conversation: ConversationRuntime;
  readonly #hostedSites: AgentHostedSites | null;
  readonly #emitError: (code: string, error: unknown, botId?: string) => void;
  readonly #isStopping: () => boolean;
  readonly #pendingTerminalEvents = new Map<string, PendingHostedSiteTerminalEvent>();
  readonly #pendingTerminalDeliveries = new Map<string, () => void>();
  #terminalRetryTimer: NodeJS.Timeout | null = null;

  constructor(options: HostedSiteCoordinatorOptions) {
    this.#store = options.store;
    this.#conversation = options.conversation;
    this.#hostedSites = options.hostedSites;
    this.#emitError = options.emitError;
    this.#isStopping = options.isStopping;
  }

  /** Replays markers left behind by a crash, then closes out mutations that never terminated. */
  restore(): void {
    this.#restorePendingTerminalEvents();
    this.#reconcileEventsAfterRestart();
  }

  listSites(): Promise<HostedSiteSummary[]> {
    return this.#requireHostedSites().list();
  }

  async prepareApproval(
    client: AgentClient,
    request: AppServerRequest,
    params: DynamicToolCallParams,
    tool: HostedSiteMutationTool,
  ): Promise<{ approval: AgentApproval; mutation: HostedSiteMutationContext } | null> {
    const threadId = params.threadId;
    const turnId = params.turnId;
    const botId = this.#conversation.botForThread(threadId);
    if (!turnId || !botId) {
      client.respondError(request.id, {
        code: -32602,
        message: "OpenBot could not identify this hosted site request.",
      });
      return null;
    }
    const details = await this.#approvalDetails(params, tool);
    const mutation: HostedSiteMutationContext = {
      botId,
      operationId: randomUUID(),
      action: hostedSiteAction(tool),
      params,
      eventDetails: details.eventDetails,
    };
    const approval: AgentApproval = {
      requestId: request.id,
      botId,
      threadId: this.#conversation.publicThreadId(botId, threadId),
      turnId,
      kind: "permissions",
      command: null,
      cwd: null,
      reason: details.reason,
      grantRoot: null,
      permissions: details.permissions,
    };
    return { approval, mutation };
  }

  /**
   * Runs an approved mutation, or records the decline. Never throws: every failure becomes a
   * terminal marker plus an error event, because the provider is still waiting on a response.
   */
  async resolveApproval(
    mutation: HostedSiteMutationContext,
    target: HostedSiteApprovalTarget,
    decision: "accept" | "decline",
  ): Promise<void> {
    if (decision === "decline") {
      this.#recordTerminalEvent(mutation, "cancelled", mutation.eventDetails, () => {
        target.client.respondError(target.id, {
          code: -32001,
          message: "The user declined this hosted site change.",
        });
      });
      return;
    }
    try {
      this.#recordEvent(mutation, "running", mutation.eventDetails);
    } catch (error) {
      try {
        target.client.respondError(target.id, {
          code: -32603,
          message: "The hosted site change could not be recorded.",
        });
      } catch (responseError) {
        this.#emitError("server_response_failed", responseError, target.botId);
      }
      this.#emitError("hosted_site_marker_persistence_failed", error, target.botId);
      return;
    }
    let result: HostedSiteMutationResult | null = null;
    try {
      result = await this.#executeMutation(mutation);
    } catch (error) {
      this.#recordTerminalEvent(mutation, "failed", mutation.eventDetails, () => {
        target.client.respondError(target.id, { code: -32603, message: String(error) });
      });
      this.#emitError("server_request_failed", error, target.botId);
    }
    if (result) {
      const succeeded = result;
      this.#recordTerminalEvent(mutation, "succeeded", succeeded.eventDetails, () => {
        target.client.respond(target.id, succeeded.response);
      });
    }
  }

  forgetBot(botId: string): void {
    for (const [key, event] of this.#pendingTerminalEvents) {
      if (event.botId !== botId) continue;
      this.#pendingTerminalEvents.delete(key);
      this.#pendingTerminalDeliveries.delete(key);
    }
    if (this.#pendingTerminalEvents.size === 0 && this.#terminalRetryTimer) {
      clearTimeout(this.#terminalRetryTimer);
      this.#terminalRetryTimer = null;
    }
  }

  dispose(): void {
    if (this.#terminalRetryTimer) clearTimeout(this.#terminalRetryTimer);
    this.#terminalRetryTimer = null;
    this.#pendingTerminalEvents.clear();
    this.#pendingTerminalDeliveries.clear();
  }

  #requireHostedSites(): AgentHostedSites {
    if (!this.#hostedSites) throw new Error("OpenBot site hosting is unavailable.");
    return this.#hostedSites;
  }

  async #approvalDetails(
    params: DynamicToolCallParams,
    tool: HostedSiteMutationTool,
  ): Promise<HostedSiteApprovalDetails> {
    const args = params.arguments;
    if (!isRecord(args)) throw new Error("Hosted site arguments are required.");
    if (tool === "delete_site") {
      const siteId = siteToolString(args.siteId, "siteId", INPUT_LIMITS.identifier);
      const site = await this.#ownedSite(siteId);
      return {
        reason: `Delete ${site.hostname} from openbot.site.`,
        permissions: { fileSystem: { read: [], write: [] }, network: true },
        eventDetails: hostedSiteEventDetails(site, siteId),
      };
    }

    const sourcePath = siteToolString(args.sourcePath, "sourcePath", INPUT_LIMITS.path);
    const title = siteToolString(args.title, "title", 120);
    siteToolString(args.description, "description", 500);
    if (args.spaFallback !== undefined && !isBoolean(args.spaFallback)) {
      throw new Error("spaFallback must be a boolean.");
    }
    const permissions = { fileSystem: { read: [sourcePath], write: [] }, network: true };
    if (tool === "publish_site") {
      return {
        reason: `Publish ${JSON.stringify(title)} as a public site on openbot.site.`,
        permissions,
        eventDetails: { siteId: null, title, hostname: null, url: null },
      };
    }
    const siteId = siteToolString(args.siteId, "siteId", INPUT_LIMITS.identifier);
    const site = await this.#ownedSite(siteId);
    return {
      reason: `Replace ${site.hostname} with ${JSON.stringify(title)}.`,
      permissions,
      eventDetails: { ...hostedSiteEventDetails(site, siteId), title },
    };
  }

  async #ownedSite(siteId: string): Promise<HostedSiteSummary> {
    const sites = await this.#requireHostedSites().list();
    for (const site of sites) if (site.id === siteId) return site;
    throw new Error("The hosted site was not found.");
  }

  async #executeMutation(context: HostedSiteMutationContext): Promise<HostedSiteMutationResult> {
    const { params } = context;
    const args = params.arguments;
    if (!isRecord(args)) throw new Error("Hosted site arguments are required.");
    if (context.action === "delete") {
      const siteId = siteToolString(args.siteId, "siteId", INPUT_LIMITS.identifier);
      await this.#requireHostedSites().delete(siteId);
      return { response: openBotToolResult({ deleted: true, siteId }), eventDetails: context.eventDetails };
    }

    const sourcePath = siteToolString(args.sourcePath, "sourcePath", INPUT_LIMITS.path);
    const title = siteToolString(args.title, "title", 120);
    const description = siteToolString(args.description, "description", 500);
    if (args.spaFallback !== undefined && !isBoolean(args.spaFallback)) {
      throw new Error("spaFallback must be a boolean.");
    }
    const bot = this.#conversation.requireKnownBot(context.botId);
    const input = {
      sourcePath,
      title,
      description,
      ...(isBoolean(args.spaFallback) ? { spaFallback: args.spaFallback } : {}),
    };
    const roots = [bot.workspacePath, this.#store.sharedRoot];
    const siteId =
      context.action === "publish" ? undefined : siteToolString(args.siteId, "siteId", INPUT_LIMITS.identifier);
    const site = siteId
      ? await this.#requireHostedSites().replace({ ...input, siteId }, roots)
      : await this.#requireHostedSites().publish(input, roots);
    return { response: openBotToolResult(site), eventDetails: hostedSiteEventDetails(site, siteId) };
  }

  #recordEvent(
    context: HostedSiteMutationContext,
    status: HostedSiteConversationEventStatus,
    details: HostedSiteConversationEventDetails,
    createdAt = new Date().toISOString(),
  ): void {
    let failure: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        this.#appendEvent(context, status, details, createdAt);
        return;
      } catch (error) {
        failure = error;
      }
    }
    throw failure;
  }

  #tryRecordEvent(
    context: HostedSiteMutationContext,
    status: HostedSiteConversationEventStatus,
    details: HostedSiteConversationEventDetails,
    createdAt?: string,
  ): boolean {
    try {
      this.#recordEvent(context, status, details, createdAt);
      return true;
    } catch (error) {
      this.#emitError("hosted_site_marker_persistence_failed", error, context.botId);
      return false;
    }
  }

  #recordTerminalEvent(
    context: HostedSiteMutationContext,
    status: Exclude<HostedSiteConversationEventStatus, "running">,
    details: HostedSiteConversationEventDetails,
    deliver?: () => void,
  ): void {
    const event: PendingHostedSiteTerminalEvent = {
      botId: context.botId,
      threadId: this.#store.ensureThreadIdNow(context.botId),
      turnId: context.params.turnId,
      operationId: context.operationId,
      action: context.action,
      status,
      details,
      markerCommandId: hostedSiteEventCommandId(context.botId, context.operationId, status),
      createdAt: new Date().toISOString(),
    };
    hostedSiteConversationEventItemType(event.action, event.status, event.operationId);
    hostedSiteConversationEventText(event.details);
    this.#pendingTerminalEvents.set(event.markerCommandId, event);
    if (deliver) this.#pendingTerminalDeliveries.set(event.markerCommandId, deliver);
    this.#flushPendingTerminalEvents();
  }

  #restorePendingTerminalEvents(): void {
    for (const event of this.#store.database.pendingHostedSiteTerminalEvents()) {
      this.#pendingTerminalEvents.set(event.markerCommandId, event);
    }
    this.#flushPendingTerminalEvents();
  }

  #flushPendingTerminalEvents(): void {
    for (const [key, event] of this.#pendingTerminalEvents) {
      let durable = false;
      try {
        this.#store.database.recordPendingHostedSiteTerminalEvent(event);
        durable = true;
      } catch (error) {
        this.#emitError("hosted_site_marker_persistence_failed", error, event.botId);
      }
      const context: HostedSiteMutationContext = {
        botId: event.botId,
        operationId: event.operationId,
        action: event.action,
        params: {
          threadId: event.threadId,
          turnId: event.turnId,
          callId: event.operationId,
          namespace: "openbot",
          tool: hostedSiteTool(event.action),
          arguments: {},
        },
        eventDetails: event.details,
      };
      if (this.#tryRecordEvent(context, event.status, event.details, event.createdAt)) {
        this.#pendingTerminalEvents.delete(key);
        durable = true;
      }
      if (durable) {
        const deliver = this.#pendingTerminalDeliveries.get(key);
        this.#pendingTerminalDeliveries.delete(key);
        if (deliver) {
          try {
            deliver();
          } catch (error) {
            this.#emitError("server_response_failed", error, event.botId);
          }
        }
      }
    }
    if (this.#pendingTerminalEvents.size > 0) this.#scheduleTerminalRetry();
  }

  #scheduleTerminalRetry(): void {
    if (this.#terminalRetryTimer || this.#isStopping()) return;
    this.#terminalRetryTimer = setTimeout(() => {
      this.#terminalRetryTimer = null;
      this.#flushPendingTerminalEvents();
    }, 1_000);
    this.#terminalRetryTimer.unref?.();
  }

  #appendEvent(
    context: HostedSiteMutationContext,
    status: HostedSiteConversationEventStatus,
    details: HostedSiteConversationEventDetails,
    createdAt: string,
  ): void {
    const database = this.#store.database;
    this.#conversation.withConversationTransaction(context.botId, ({ threadId, snapshot: current }) => {
      const messageId = hostedSiteEventMessageId(context.operationId, status);
      if (!current.messages.some((message) => message.id === messageId)) {
        const message: ConversationMessage = {
          id: messageId,
          turnId: context.params.turnId,
          author: "system",
          source: "system",
          text: hostedSiteConversationEventText(details),
          createdAt,
          status: "completed",
          itemType: hostedSiteConversationEventItemType(context.action, status, context.operationId),
        };
        current.messages.push(message);
        sortConversationMessages(current.messages);
        current.revision = database.appendConversationMessage({
          botId: context.botId,
          threadId,
          activeTurnId: current.activeTurnId,
          message,
          eventType: `hosted-site.${context.action}-${status}`,
          commandId: hostedSiteEventCommandId(context.botId, context.operationId, status),
          detail: { action: context.action, status, operationId: context.operationId, siteId: details.siteId },
        });
      }
      if (status === "running") {
        database.recordActiveHostedSiteConversationEvent({
          botId: context.botId,
          threadId,
          turnId: context.params.turnId,
          createdAt,
          event: { action: context.action, status, operationId: context.operationId, ...details },
        });
      } else {
        database.deleteActiveHostedSiteConversationEvent(context.botId, context.operationId);
        database.deletePendingHostedSiteTerminalEvent(context.botId, context.operationId, status);
      }
      // The idempotency guard above means this can legitimately append nothing and still publish.
      return { result: undefined, snapshot: current };
    });
  }

  #reconcileEventsAfterRestart(): void {
    for (const { botId, threadId, turnId, event } of this.#store.database.activeHostedSiteConversationEvents()) {
      if (
        [...this.#pendingTerminalEvents.values()].some(
          (pending) => pending.botId === botId && pending.operationId === event.operationId,
        )
      ) {
        continue;
      }
      const context: HostedSiteMutationContext = {
        botId,
        operationId: event.operationId,
        action: event.action,
        params: {
          threadId,
          turnId: turnId ?? `hosted-site-${event.operationId}`,
          callId: event.operationId,
          namespace: "openbot",
          tool: hostedSiteTool(event.action),
          arguments: {},
        },
        eventDetails: {
          siteId: event.siteId,
          title: event.title,
          hostname: event.hostname,
          url: event.url,
        },
      };
      this.#recordTerminalEvent(context, "interrupted", context.eventDetails);
    }
  }
}
