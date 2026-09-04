import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  AgentProviderId,
  BotSummary,
  ConversationMessage,
  ConversationPage,
  ConversationPageAnchor,
  ConversationSearchPage,
  ConversationSnapshot,
  HostedSiteConversationEventStatus,
} from "@openbot/contracts/ipc";
import { providerForLegacyModel } from "@openbot/contracts/ipc";
import { AgentRoster } from "./database/agent-roster";
import { ConversationQueries } from "./database/conversation-queries";
import { ConversationWriter } from "./database/conversation-writer";
import { DatabaseCore, type OrchestrationEventInput } from "./database/database-core";
import {
  type ActiveHostedSiteConversationEvent,
  HostedSiteEventLog,
  type PendingHostedSiteTerminalEvent,
} from "./database/hosted-site-event-log";
import { MailboxProjection, type MailboxProjectionState } from "./database/mailbox-projection";
import { type ProviderSession, ProviderSessions } from "./database/provider-sessions";
import { ThreadReplay } from "./database/thread-replay";
import { type StoredThreadSummary, ThreadSummaries } from "./database/thread-summaries";

// Declared in this module before the split and part of the frozen public surface, so it stays
// reachable from here rather than only from the controller that owns it now. Structural `Pick<...>`
// types over this class do not cover exported types.
export type { OrchestrationEventInput } from "./database/database-core";
export type {
  ActiveHostedSiteConversationEvent,
  PendingHostedSiteTerminalEvent,
} from "./database/hosted-site-event-log";
export type { ProviderSession } from "./database/provider-sessions";
export type { StoredThreadSummary } from "./database/thread-summaries";

/**
 * The local OpenBot event log and its read projections.
 *
 * A command appends events, changes projections, and stores its receipt in one
 * SQLite transaction. Providers never receive direct access to this database.
 */
export class OpenBotDatabase {
  readonly #core: DatabaseCore;
  readonly #conversations: ConversationQueries;
  readonly #roster: AgentRoster;
  readonly #conversationWrites: ConversationWriter;
  readonly #replay: ThreadReplay;
  readonly #hostedSiteEvents: HostedSiteEventLog;
  readonly #mailbox: MailboxProjection;
  readonly #sessions: ProviderSessions;
  readonly #summaries: ThreadSummaries;

  constructor(readonly userDataPath: string) {
    this.#core = new DatabaseCore({ userDataPath });
    this.#conversations = new ConversationQueries({ core: this.#core });
    this.#roster = new AgentRoster({ core: this.#core });
    this.#conversationWrites = new ConversationWriter({ core: this.#core, roster: this.#roster });
    this.#replay = new ThreadReplay({ core: this.#core, conversations: this.#conversations });
    this.#hostedSiteEvents = new HostedSiteEventLog({ core: this.#core });
    this.#mailbox = new MailboxProjection({ core: this.#core });
    this.#sessions = new ProviderSessions({ core: this.#core });
    this.#summaries = new ThreadSummaries({ core: this.#core });
  }

  get path(): string {
    return this.#core.path;
  }

  async initialize(): Promise<void> {
    await this.#core.initialize();
  }

  close(): void {
    this.#core.close();
  }

  get connection(): DatabaseSync {
    return this.#core.connection;
  }

  dispatch<T>(
    commandId: string,
    events: OrchestrationEventInput[],
    project: (db: DatabaseSync, sequences: number[]) => T,
  ): T {
    return this.#core.dispatch(commandId, events, project);
  }

  commandResult(commandId: string): unknown | undefined {
    return this.#core.commandResult(commandId);
  }

  hasAggregateEvents(aggregateType: string, aggregateId: string): boolean {
    return this.#core.hasAggregateEvents(aggregateType, aggregateId);
  }

  async backupLegacyFile(path: string): Promise<void> {
    await this.#core.backupLegacyFile(path);
  }

  recordPendingHostedSiteTerminalEvent(event: PendingHostedSiteTerminalEvent): void {
    this.#hostedSiteEvents.recordPendingHostedSiteTerminalEvent(event);
  }

  pendingHostedSiteTerminalEvents(): PendingHostedSiteTerminalEvent[] {
    return this.#hostedSiteEvents.pendingHostedSiteTerminalEvents();
  }

  deletePendingHostedSiteTerminalEvent(
    botId: string,
    operationId: string,
    status: Exclude<HostedSiteConversationEventStatus, "running">,
  ): void {
    this.#hostedSiteEvents.deletePendingHostedSiteTerminalEvent(botId, operationId, status);
  }

  recordActiveHostedSiteConversationEvent(event: ActiveHostedSiteConversationEvent): void {
    this.#hostedSiteEvents.recordActiveHostedSiteConversationEvent(event);
  }

  deleteActiveHostedSiteConversationEvent(botId: string, operationId: string): void {
    this.#hostedSiteEvents.deleteActiveHostedSiteConversationEvent(botId, operationId);
  }

  activeHostedSiteConversationEvents(): ActiveHostedSiteConversationEvent[] {
    return this.#hostedSiteEvents.activeHostedSiteConversationEvents();
  }

  listAgents(): BotSummary[] {
    return this.#roster.listAgents();
  }

  replaceAgents(commandId: string, agents: BotSummary[], eventType: string): void {
    this.#roster.replaceAgents(commandId, agents, eventType);
  }

  hardDeleteAgent(commandId: string, botId: string, threadId: string | null, remainingAgents: BotSummary[]): void {
    this.#roster.hardDeleteAgent(commandId, botId, threadId, remainingAgents);
  }

  readConversation(botId: string, threadId: string | null): ConversationSnapshot {
    return this.#conversations.readConversation(botId, threadId);
  }

  readConversationRuntime(
    botId: string,
    threadId: string | null,
  ): { activeTurnId: string | null; latestMessage: ConversationMessage | null } {
    return this.#conversations.readConversationRuntime(botId, threadId);
  }

  readConversationPage(
    botId: string,
    threadId: string | null,
    anchor: ConversationPageAnchor = { type: "latest" },
    requestedLimit = 50,
    options: {
      excludeRoutineEvents?: boolean;
      excludeRoutineRunEvents?: boolean;
      excludeHostedSiteEvents?: boolean;
    } = {},
  ): ConversationPage {
    return this.#conversations.readConversationPage(botId, threadId, anchor, requestedLimit, options);
  }

  supportedConversationCursor(
    threadId: string,
    throughMessageId: string | null,
    options: {
      excludeRoutineEvents?: boolean;
      excludeRoutineRunEvents?: boolean;
      excludeHostedSiteEvents?: boolean;
    } = {},
  ): string | null {
    return this.#conversations.supportedConversationCursor(threadId, throughMessageId, options);
  }

  searchConversationMessages(
    query: string,
    botId?: string,
    cursor?: string,
    requestedLimit = 100,
  ): ConversationSearchPage {
    return this.#conversations.searchConversationMessages(query, botId, cursor, requestedLimit);
  }

  persistConversation(
    snapshot: ConversationSnapshot,
    eventType: string,
    payload: unknown = {},
    commandId = `conversation:${eventType}:${randomUUID()}`,
  ): ConversationSnapshot {
    return this.#conversationWrites.persistConversation(snapshot, eventType, payload, commandId);
  }

  appendConversationMessage(input: {
    botId: string;
    threadId: string;
    activeTurnId: string | null;
    message: ConversationMessage;
    eventType: string;
    detail?: unknown;
    commandId?: string;
  }): number {
    return this.#conversationWrites.appendConversationMessage(input);
  }

  persistConversationAndMailbox(
    snapshot: ConversationSnapshot,
    eventType: string,
    payload: unknown,
    mailboxState: MailboxProjectionState,
    mailboxEventType: string,
  ): ConversationSnapshot {
    const db = this.connection;
    db.exec("BEGIN IMMEDIATE");
    try {
      this.replaceMailboxState(`mailbox:${mailboxEventType}:${randomUUID()}`, mailboxState, mailboxEventType);
      const persisted = this.#conversationWrites.persistConversation(
        snapshot,
        eventType,
        payload,
        `conversation:${eventType}:${randomUUID()}`,
      );
      db.exec("COMMIT");
      return persisted;
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  }

  activeProviderSession(threadId: string, provider: AgentProviderId): ProviderSession | null {
    return this.#sessions.activeProviderSession(threadId, provider);
  }

  listProviderSessions(threadId: string): ProviderSession[] {
    return this.#sessions.listProviderSessions(threadId);
  }

  bindProviderSession(input: {
    threadId: string;
    provider: AgentProviderId;
    externalSessionId: string;
    model: string;
    effort: string;
    resumeCursor?: string | null;
  }): ProviderSession {
    return this.#sessions.bindProviderSession(input);
  }

  deactivateProviderSessions(threadId: string): void {
    this.#sessions.deactivateProviderSessions(threadId);
  }

  updateProviderSessionConfig(sessionId: string, threadId: string, model: string, effort: string): void {
    this.#sessions.updateProviderSessionConfig(sessionId, threadId, model, effort);
  }

  saveThreadSummary(
    threadId: string,
    throughMessageId: string | null,
    text: string,
    estimatedTokens: number,
  ): StoredThreadSummary {
    return this.#summaries.saveThreadSummary(threadId, throughMessageId, text, estimatedTokens);
  }

  latestThreadSummary(threadId: string): StoredThreadSummary | null {
    return this.#summaries.latestThreadSummary(threadId);
  }

  rebuildThreadProjection(threadId: string): ConversationSnapshot {
    return this.#replay.rebuildThreadProjection(threadId);
  }

  replaceMailboxState(
    commandId: string,
    state: MailboxProjectionState,
    eventType: string,
    fileDeletions: string[] = [],
    rebaseHistory = false,
  ): void {
    this.#mailbox.replaceMailboxState(commandId, state, eventType, fileDeletions, rebaseHistory);
  }

  pendingFileDeletions(): Array<{ id: string; path: string }> {
    return this.#mailbox.pendingFileDeletions();
  }

  completeFileDeletion(id: string): void {
    this.#mailbox.completeFileDeletion(id);
  }

  failFileDeletion(id: string, error: string): void {
    this.#mailbox.failFileDeletion(id, error);
  }

  readMailboxState(): unknown | null {
    return this.#mailbox.readMailboxState();
  }
}

export function providerForStoredModel(model: BotSummary["model"]): AgentProviderId {
  return providerForLegacyModel(model);
}

export function stableThreadId(botId: string): string {
  return `openbot-thread-${botId}`;
}
