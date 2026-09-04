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
import {
  HOSTED_SITE_EVENT_ITEM_TYPE_PREFIX,
  isAgentProvider,
  isConversationMessage,
  providerForLegacyModel,
  ROUTINE_EVENT_ITEM_TYPE_PREFIX,
  ROUTINE_RUN_EVENT_ITEM_TYPE_PREFIX,
} from "@openbot/contracts/ipc";
import { type DynamicRecord, isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import { DatabaseCore, deleteOrphanReceipts, type OrchestrationEventInput } from "./database/database-core";
import {
  databaseRow,
  databaseRows,
  decodeConversationMessageJson,
  decodeConversationThreadRow,
  decodeThreadAgentRow,
  objectValue,
  optionalStringColumn,
  requiredEventRow,
  requiredNumberColumn,
  requiredStringColumn,
} from "./database/database-rows";
import {
  type ActiveHostedSiteConversationEvent,
  HostedSiteEventLog,
  type PendingHostedSiteTerminalEvent,
} from "./database/hosted-site-event-log";

export interface ProviderSession {
  id: string;
  threadId: string;
  provider: AgentProviderId;
  externalSessionId: string;
  model: string;
  effort: string;
  state: "active" | "inactive" | "failed";
  createdAt: string;
  updatedAt: string;
  resumeCursor: string | null;
}

export interface StoredThreadSummary {
  id: string;
  threadId: string;
  throughMessageId: string | null;
  text: string;
  estimatedTokens: number;
  createdAt: string;
}

interface SessionRow {
  id: string;
  thread_id: string;
  provider: AgentProviderId;
  external_session_id: string;
  model: string;
  effort: string;
  state: ProviderSession["state"];
  created_at: string;
  updated_at: string;
  resume_cursor: string | null;
}

interface MailboxProjectionAttachment {
  id: string;
  name: string;
  path: string;
}

interface MailboxProjectionMessage {
  id: string;
  sender: {
    kind: string;
    botId?: string;
    routineId?: string;
    runId?: string;
    routineName?: string;
    scheduledFor?: string;
  };
  text: string;
  replyToMessageId: string | null;
  createdAt: string;
  attachments: MailboxProjectionAttachment[];
}

interface MailboxProjectionDelivery {
  id: string;
  messageId: string;
  recipientBotId: string;
  status: string;
  turnId: string | null;
  error: string | null;
  createdAt: string;
}

interface MailboxProjectionDraft extends MailboxProjectionAttachment {
  createdAt: string;
}

interface MailboxProjectionGeneratedAttachment extends MailboxProjectionAttachment {
  size: number;
  kind: string;
  mimeType: string;
  previewKind: string;
  previewUrl: string | null;
  sha256: string;
}

interface MailboxProjectionReaction {
  botId: string;
  messageId: string;
  emoji: string;
  actor: { kind: "user" } | { kind: "bot"; botId: string };
  updatedAt: string;
}

interface MailboxProjectionState {
  messages: MailboxProjectionMessage[];
  deliveries: MailboxProjectionDelivery[];
  drafts: MailboxProjectionDraft[];
  generatedAttachments: MailboxProjectionGeneratedAttachment[];
  pausedBotIds: string[];
  idempotency: Record<string, string>;
  reactions: MailboxProjectionReaction[];
}

// Declared in this module before the split and part of the frozen public surface, so it stays
// reachable from here rather than only from the controller that owns it now. Structural `Pick<...>`
// types over this class do not cover exported types.
export type { OrchestrationEventInput } from "./database/database-core";
export type {
  ActiveHostedSiteConversationEvent,
  PendingHostedSiteTerminalEvent,
} from "./database/hosted-site-event-log";

/**
 * The local OpenBot event log and its read projections.
 *
 * A command appends events, changes projections, and stores its receipt in one
 * SQLite transaction. Providers never receive direct access to this database.
 */
export class OpenBotDatabase {
  readonly #core: DatabaseCore;
  readonly #hostedSiteEvents: HostedSiteEventLog;

  constructor(readonly userDataPath: string) {
    this.#core = new DatabaseCore({ userDataPath });
    this.#hostedSiteEvents = new HostedSiteEventLog({ core: this.#core });
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
    return databaseRows(
      this.connection.prepare("SELECT agent_json FROM projection_agents ORDER BY sort_order, agent_id").all(),
    ).map((row) => JSON.parse(requiredStringColumn(row, "agent_json")));
  }

  replaceAgents(commandId: string, agents: BotSummary[], eventType: string): void {
    this.dispatch(
      commandId,
      [
        {
          aggregateType: "agents",
          aggregateId: "agents",
          eventType,
          payload: { agents },
        },
      ],
      (db, sequences) => {
        db.exec("DELETE FROM projection_agents");
        const insert = db.prepare(`
          INSERT INTO projection_agents
            (agent_id, thread_id, model, updated_at, sort_order, agent_json, last_event_sequence)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        agents.forEach((agent, index) => {
          insert.run(
            agent.id,
            agent.threadId,
            agent.model,
            agent.updatedAt,
            index,
            JSON.stringify(agent),
            sequences[0],
          );
          if (agent.threadId) this.#ensureThreadProjection(db, agent, sequences[0] ?? 0);
        });
        return null;
      },
    );
  }

  hardDeleteAgent(commandId: string, botId: string, threadId: string | null, remainingAgents: BotSummary[]): void {
    this.dispatch(
      commandId,
      [
        {
          aggregateType: "agents",
          aggregateId: "agents",
          eventType: "agents.rebased-after-delete",
          payload: { agents: remainingAgents },
        },
      ],
      (db, sequences) => {
        const sequence = sequences[0] ?? 0;
        const memoryIds = databaseRows(
          db.prepare("SELECT memory_id FROM projection_agent_memories WHERE agent_id = ?").all(botId),
        ).map((row) => requiredStringColumn(row, "memory_id"));
        const routineIds = databaseRows(
          db.prepare("SELECT routine_id FROM projection_agent_routines WHERE agent_id = ?").all(botId),
        ).map((row) => requiredStringColumn(row, "routine_id"));
        if (memoryIds.length > 0) {
          const placeholders = memoryIds.map(() => "?").join(", ");
          db.prepare(
            `DELETE FROM orchestration_command_receipts WHERE command_id IN (
               SELECT DISTINCT command_id
               FROM orchestration_events
               WHERE aggregate_type = 'agent-memory' AND aggregate_id IN (${placeholders})
             )`,
          ).run(...memoryIds);
          db.prepare(
            `DELETE FROM orchestration_events
             WHERE aggregate_type = 'agent-memory' AND aggregate_id IN (${placeholders})`,
          ).run(...memoryIds);
        }
        if (routineIds.length > 0) {
          const placeholders = routineIds.map(() => "?").join(", ");
          db.prepare(
            `DELETE FROM orchestration_command_receipts WHERE command_id IN (
               SELECT DISTINCT command_id FROM orchestration_events
               WHERE aggregate_type IN ('agent-routine', 'routine-run') AND aggregate_id IN (${placeholders})
             )`,
          ).run(...routineIds);
          db.prepare(
            `DELETE FROM orchestration_events
             WHERE aggregate_type IN ('agent-routine', 'routine-run') AND aggregate_id IN (${placeholders})`,
          ).run(...routineIds);
        }
        db.prepare(
          `DELETE FROM orchestration_command_receipts WHERE command_id IN (
             SELECT DISTINCT command_id FROM orchestration_events
             WHERE aggregate_type = 'hosted-site-terminal'
               AND event_type = 'hosted-site.terminal-pending'
               AND json_extract(payload_json, '$.botId') = ?
           )`,
        ).run(botId);
        db.prepare(
          `DELETE FROM orchestration_events
           WHERE aggregate_type = 'hosted-site-terminal'
             AND event_type = 'hosted-site.terminal-pending'
             AND json_extract(payload_json, '$.botId') = ?`,
        ).run(botId);
        const sensitiveFilter = threadId
          ? `(aggregate_id = ? OR aggregate_id = ? OR
              (aggregate_type = 'agents' AND aggregate_id = 'agents' AND sequence < ?))`
          : `(aggregate_id = ? OR
              (aggregate_type = 'agents' AND aggregate_id = 'agents' AND sequence < ?))`;
        const sensitiveParameters = threadId ? ([botId, threadId, sequence] as const) : ([botId, sequence] as const);
        db.prepare(
          `DELETE FROM orchestration_command_receipts WHERE command_id IN (
             SELECT DISTINCT command_id FROM orchestration_events WHERE ${sensitiveFilter}
           )`,
        ).run(...sensitiveParameters);
        db.prepare(`DELETE FROM orchestration_events WHERE ${sensitiveFilter}`).run(...sensitiveParameters);
        db.prepare("DELETE FROM projection_agents WHERE agent_id = ?").run(botId);
        db.prepare("DELETE FROM projection_agent_memories WHERE agent_id = ?").run(botId);
        db.prepare("DELETE FROM projection_agent_routines WHERE agent_id = ?").run(botId);
        db.prepare("DELETE FROM projection_reactions WHERE agent_id = ?").run(botId);
        db.prepare("DELETE FROM projection_deliveries WHERE recipient_agent_id = ?").run(botId);
        db.prepare("DELETE FROM projection_queue_state WHERE agent_id = ?").run(botId);
        if (threadId) {
          db.prepare("DELETE FROM projection_threads WHERE thread_id = ?").run(threadId);
        }
        return null;
      },
    );
  }

  readConversation(botId: string, threadId: string | null): ConversationSnapshot {
    if (!threadId) return { botId, threadId: null, activeTurnId: null, revision: 0, messages: [] };
    const thread = decodeConversationThreadRow(
      this.connection
        .prepare(
          `SELECT active_turn_id, last_event_sequence
           FROM projection_threads WHERE thread_id = ? AND agent_id = ?`,
        )
        .get(threadId, botId),
    );
    const rows = databaseRows(
      this.connection
        .prepare(
          `SELECT message_json FROM projection_thread_messages
           WHERE thread_id = ? ORDER BY created_at, ordinal, message_id`,
        )
        .all(threadId),
    );
    return {
      botId,
      threadId,
      activeTurnId: thread?.active_turn_id ?? null,
      revision: thread?.last_event_sequence ?? 0,
      messages: rows.map((row) => JSON.parse(requiredStringColumn(row, "message_json"))),
    };
  }

  readConversationRuntime(
    botId: string,
    threadId: string | null,
  ): { activeTurnId: string | null; latestMessage: ConversationMessage | null } {
    if (!threadId) return { activeTurnId: null, latestMessage: null };
    const row = databaseRow(
      this.connection
        .prepare(
          `SELECT thread.active_turn_id,
                  (SELECT message.message_json
                   FROM projection_thread_messages message
                   WHERE message.thread_id = thread.thread_id
                     AND json_extract(message.message_json, '$.author') IN ('assistant', 'agent')
                     AND COALESCE(json_extract(message.message_json, '$.itemType'), '') != 'commentary'
                     AND COALESCE(json_extract(message.message_json, '$.itemType'), '') != 'question_prompt'
                     AND COALESCE(json_extract(message.message_json, '$.itemType'), '') != 'agent_attachment'
                   ORDER BY message.created_at DESC, message.ordinal DESC, message.message_id DESC
                   LIMIT 1) AS latest_message_json
           FROM projection_threads thread
           WHERE thread.thread_id = ? AND thread.agent_id = ?`,
        )
        .get(threadId, botId),
    );
    if (!row) return { activeTurnId: null, latestMessage: null };
    const latestMessage = optionalStringColumn(row, "latest_message_json");
    return {
      activeTurnId: optionalStringColumn(row, "active_turn_id"),
      latestMessage: latestMessage ? decodeConversationMessageJson(latestMessage) : null,
    };
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
    if (!threadId) {
      return {
        botId,
        threadId: null,
        activeTurnId: null,
        revision: 0,
        messages: [],
        references: {},
        pageInfo: { hasOlder: false, olderCursor: null },
      };
    }
    const limit = pageLimit(requestedLimit);
    const thread = decodeConversationThreadRow(
      this.connection
        .prepare(
          `SELECT active_turn_id, last_event_sequence
           FROM projection_threads WHERE thread_id = ? AND agent_id = ?`,
        )
        .get(threadId, botId),
    );
    const rows = this.#conversationPageRows(
      threadId,
      anchor,
      limit,
      options.excludeRoutineEvents === true,
      options.excludeRoutineRunEvents === true,
      options.excludeHostedSiteEvents === true,
    );
    const messages = rows.map((row) => decodeConversationMessageJson(requiredStringColumn(row, "message_json")));
    const messageIds = new Set(messages.map((message) => message.id));
    const referenceIdSet = new Set<string>();
    for (const message of messages) {
      const referenceId = message.replyToMessageId;
      if (referenceId && !messageIds.has(referenceId)) referenceIdSet.add(referenceId);
    }
    const referenceIds = [...referenceIdSet];
    const references: Record<string, ConversationMessage> = {};
    if (referenceIds.length > 0) {
      const placeholders = referenceIds.map(() => "?").join(", ");
      const referenceRows = databaseRows(
        this.connection
          .prepare(
            `SELECT message_id, message_json FROM projection_thread_messages
             WHERE thread_id = ? AND message_id IN (${placeholders})
             ${conversationMarkerSqlFilter(
               options.excludeRoutineEvents === true,
               options.excludeRoutineRunEvents === true,
               options.excludeHostedSiteEvents === true,
             )}`,
          )
          .all(threadId, ...referenceIds),
      );
      for (const row of referenceRows) {
        references[requiredStringColumn(row, "message_id")] = decodeConversationMessageJson(
          requiredStringColumn(row, "message_json"),
        );
      }
    }
    const first = rows[0];
    const hasOlder = first
      ? this.#hasConversationRowsBefore(
          threadId,
          conversationRowCursor(first),
          options.excludeRoutineEvents === true,
          options.excludeRoutineRunEvents === true,
          options.excludeHostedSiteEvents === true,
        )
      : false;
    return {
      botId,
      threadId,
      activeTurnId: thread?.active_turn_id ?? null,
      revision: thread?.last_event_sequence ?? 0,
      messages,
      references,
      pageInfo: {
        hasOlder,
        olderCursor: hasOlder && first ? encodePageCursor(conversationRowCursor(first)) : null,
      },
    };
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
    if (!throughMessageId) return null;
    const boundary = databaseRow(
      this.connection
        .prepare(
          `SELECT created_at, ordinal, message_id FROM projection_thread_messages
           WHERE thread_id = ? AND message_id = ?`,
        )
        .get(threadId, throughMessageId),
    );
    if (!boundary) return null;
    const createdAt = requiredStringColumn(boundary, "created_at");
    const ordinal = requiredNumberColumn(boundary, "ordinal");
    const messageId = requiredStringColumn(boundary, "message_id");
    const row = databaseRow(
      this.connection
        .prepare(
          `SELECT message_id FROM projection_thread_messages
           WHERE thread_id = ?
             AND (created_at, ordinal, message_id) <= (?, ?, ?)
             ${conversationMarkerSqlFilter(
               options.excludeRoutineEvents === true,
               options.excludeRoutineRunEvents === true,
               options.excludeHostedSiteEvents === true,
             )}
           ORDER BY created_at DESC, ordinal DESC, message_id DESC
           LIMIT 1`,
        )
        .get(threadId, createdAt, ordinal, messageId),
    );
    return row ? requiredStringColumn(row, "message_id") : null;
  }

  searchConversationMessages(
    query: string,
    botId?: string,
    cursor?: string,
    requestedLimit = 100,
  ): ConversationSearchPage {
    const normalized = query.trim().replace(/\s+/g, " ").toLocaleLowerCase();
    if (!normalized) return { results: [], total: 0, nextCursor: null };
    const limit = pageLimit(requestedLimit);
    const offset = cursor ? decodeSearchCursor(cursor) : 0;
    const pattern = `%${escapeLike(normalized)}%`;
    const filter = botId ? "AND thread.agent_id = ?" : "";
    const parameters = botId ? [pattern, botId] : [pattern];
    const countRow = databaseRow(
      this.connection
        .prepare(
          `SELECT COUNT(*) AS count
           FROM projection_thread_messages message
           JOIN projection_threads thread ON thread.thread_id = message.thread_id
           WHERE LOWER(json_extract(message.message_json, '$.text')) LIKE ? ESCAPE '\\'
             AND COALESCE(json_extract(message.message_json, '$.delivery.status'), '') NOT IN ('queued', 'cancelled')
             AND COALESCE(message.item_type, '') NOT LIKE '${ROUTINE_EVENT_ITEM_TYPE_PREFIX}%'
             AND COALESCE(message.item_type, '') NOT LIKE '${ROUTINE_RUN_EVENT_ITEM_TYPE_PREFIX}%'
             AND COALESCE(message.item_type, '') NOT LIKE '${HOSTED_SITE_EVENT_ITEM_TYPE_PREFIX}%'
             ${filter}`,
        )
        .get(...parameters),
    );
    const total = countRow ? requiredNumberColumn(countRow, "count") : 0;
    const rows = databaseRows(
      this.connection
        .prepare(
          `SELECT thread.agent_id, message.message_json
           FROM projection_thread_messages message
           JOIN projection_threads thread ON thread.thread_id = message.thread_id
           WHERE LOWER(json_extract(message.message_json, '$.text')) LIKE ? ESCAPE '\\'
             AND COALESCE(json_extract(message.message_json, '$.delivery.status'), '') NOT IN ('queued', 'cancelled')
             AND COALESCE(message.item_type, '') NOT LIKE '${ROUTINE_EVENT_ITEM_TYPE_PREFIX}%'
             AND COALESCE(message.item_type, '') NOT LIKE '${ROUTINE_RUN_EVENT_ITEM_TYPE_PREFIX}%'
             AND COALESCE(message.item_type, '') NOT LIKE '${HOSTED_SITE_EVENT_ITEM_TYPE_PREFIX}%'
             ${filter}
           ORDER BY message.created_at DESC, message.ordinal DESC, message.message_id DESC
           LIMIT ? OFFSET ?`,
        )
        .all(...parameters, limit, offset),
    );
    const results = rows.map((row) => ({
      botId: requiredStringColumn(row, "agent_id"),
      message: decodeConversationMessageJson(requiredStringColumn(row, "message_json")),
    }));
    const nextOffset = offset + results.length;
    return {
      results,
      total,
      nextCursor: nextOffset < total ? encodeSearchCursor(nextOffset) : null,
    };
  }

  #conversationPageRows(
    threadId: string,
    anchor: ConversationPageAnchor,
    limit: number,
    excludeRoutineEvents: boolean,
    excludeRoutineRunEvents: boolean,
    excludeHostedSiteEvents: boolean,
  ): DynamicRecord[] {
    const columns = "created_at, ordinal, message_id, message_json";
    const routineFilter = conversationMarkerSqlFilter(
      excludeRoutineEvents,
      excludeRoutineRunEvents,
      excludeHostedSiteEvents,
    );
    if (anchor.type === "latest") {
      return databaseRows(
        this.connection
          .prepare(
            `SELECT ${columns} FROM projection_thread_messages
             WHERE thread_id = ?
             ${routineFilter}
             ORDER BY created_at DESC, ordinal DESC, message_id DESC LIMIT ?`,
          )
          .all(threadId, limit),
      ).reverse();
    }
    if (anchor.type === "before") {
      const cursor = decodeConversationCursor(anchor.cursor);
      return databaseRows(
        this.connection
          .prepare(
            `SELECT ${columns} FROM projection_thread_messages
             WHERE thread_id = ? AND (
               created_at < ? OR
               (created_at = ? AND ordinal < ?) OR
               (created_at = ? AND ordinal = ? AND message_id < ?)
             )
             ${routineFilter}
             ORDER BY created_at DESC, ordinal DESC, message_id DESC LIMIT ?`,
          )
          .all(
            threadId,
            cursor.createdAt,
            cursor.createdAt,
            cursor.ordinal,
            cursor.createdAt,
            cursor.ordinal,
            cursor.messageId,
            limit,
          ),
      ).reverse();
    }
    const anchorRow = databaseRow(
      this.connection
        .prepare(
          `SELECT created_at, ordinal, message_id FROM projection_thread_messages
           WHERE thread_id = ? AND message_id = ?
           ${routineFilter}`,
        )
        .get(threadId, anchor.messageId),
    );
    if (!anchorRow) return [];
    const cursor = conversationRowCursor(anchorRow);
    const olderLimit = Math.floor(limit / 2);
    const older = databaseRows(
      this.connection
        .prepare(
          `SELECT ${columns} FROM projection_thread_messages
           WHERE thread_id = ? AND (
             created_at < ? OR
             (created_at = ? AND ordinal < ?) OR
             (created_at = ? AND ordinal = ? AND message_id <= ?)
           )
           ${routineFilter}
           ORDER BY created_at DESC, ordinal DESC, message_id DESC LIMIT ?`,
        )
        .all(
          threadId,
          cursor.createdAt,
          cursor.createdAt,
          cursor.ordinal,
          cursor.createdAt,
          cursor.ordinal,
          cursor.messageId,
          olderLimit + 1,
        ),
    ).reverse();
    const newer = databaseRows(
      this.connection
        .prepare(
          `SELECT ${columns} FROM projection_thread_messages
           WHERE thread_id = ? AND (
             created_at > ? OR
             (created_at = ? AND ordinal > ?) OR
             (created_at = ? AND ordinal = ? AND message_id > ?)
           )
           ${routineFilter}
           ORDER BY created_at, ordinal, message_id LIMIT ?`,
        )
        .all(
          threadId,
          cursor.createdAt,
          cursor.createdAt,
          cursor.ordinal,
          cursor.createdAt,
          cursor.ordinal,
          cursor.messageId,
          limit - older.length,
        ),
    );
    return [...older, ...newer];
  }

  #hasConversationRowsBefore(
    threadId: string,
    cursor: ConversationPageCursor,
    excludeRoutineEvents: boolean,
    excludeRoutineRunEvents: boolean,
    excludeHostedSiteEvents: boolean,
  ): boolean {
    const routineFilter = conversationMarkerSqlFilter(
      excludeRoutineEvents,
      excludeRoutineRunEvents,
      excludeHostedSiteEvents,
    );
    return Boolean(
      this.connection
        .prepare(
          `SELECT 1 FROM projection_thread_messages
           WHERE thread_id = ? AND (
             created_at < ? OR
             (created_at = ? AND ordinal < ?) OR
             (created_at = ? AND ordinal = ? AND message_id < ?)
           )
           ${routineFilter}
           LIMIT 1`,
        )
        .get(
          threadId,
          cursor.createdAt,
          cursor.createdAt,
          cursor.ordinal,
          cursor.createdAt,
          cursor.ordinal,
          cursor.messageId,
        ),
    );
  }

  persistConversation(
    snapshot: ConversationSnapshot,
    eventType: string,
    payload: unknown = {},
    commandId = `conversation:${eventType}:${randomUUID()}`,
  ): ConversationSnapshot {
    if (!snapshot.threadId) return structuredClone(snapshot);
    const threadId = snapshot.threadId;
    const recovery = conversationRecoveryState(this.connection, threadId, snapshot.activeTurnId);
    const result = this.dispatch(
      commandId,
      [
        {
          aggregateType: "thread",
          aggregateId: threadId,
          eventType,
          payload: { detail: payload, snapshot, recovery },
        },
      ],
      (db, sequences) => {
        const sequence = sequences[0] ?? snapshot.revision;
        const agent = this.listAgents().find((candidate) => candidate.id === snapshot.botId);
        if (!agent) throw new Error(`Unknown agent for conversation: ${snapshot.botId}`);
        this.#ensureThreadProjection(db, agent, sequence);
        db.prepare(
          `UPDATE projection_threads
           SET active_turn_id = ?, updated_at = ?, last_event_sequence = ? WHERE thread_id = ?`,
        ).run(snapshot.activeTurnId, new Date().toISOString(), sequence, snapshot.threadId);
        const messageIds = new Set(snapshot.messages.map((message) => message.id));
        const staleMessageIds = databaseRows(
          db.prepare("SELECT message_id FROM projection_thread_messages WHERE thread_id = ?").all(threadId),
        )
          .map((row) => requiredStringColumn(row, "message_id"))
          .filter((messageId) => !messageIds.has(messageId));
        const deleteMessage = db.prepare(
          "DELETE FROM projection_thread_messages WHERE thread_id = ? AND message_id = ?",
        );
        const deleteAttachments = db.prepare(
          "DELETE FROM projection_attachments WHERE owner_kind = 'thread-message' AND owner_id = ?",
        );
        for (const messageId of staleMessageIds) {
          deleteAttachments.run(`${threadId}:${messageId}`);
          deleteMessage.run(threadId, messageId);
        }
        const upsert = db.prepare(`
          INSERT INTO projection_thread_messages (
            thread_id, message_id, turn_id, author, status, item_type, created_at,
            ordinal, message_json, last_event_sequence
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(thread_id, message_id) DO UPDATE SET
            turn_id = excluded.turn_id,
            author = excluded.author,
            status = excluded.status,
            item_type = excluded.item_type,
            created_at = excluded.created_at,
            ordinal = excluded.ordinal,
            message_json = excluded.message_json,
            last_event_sequence = excluded.last_event_sequence
        `);
        snapshot.messages.forEach((message, ordinal) => {
          upsert.run(
            snapshot.threadId,
            message.id,
            message.turnId ?? null,
            message.author,
            message.status,
            message.itemType ?? null,
            message.createdAt,
            ordinal,
            JSON.stringify(message),
            sequence,
          );
          for (const attachment of message.attachments ?? []) {
            db.prepare(`
              INSERT OR REPLACE INTO projection_attachments
                (attachment_id, owner_kind, owner_id, name, path, metadata_json, created_at, last_event_sequence)
              VALUES (?, 'thread-message', ?, ?, '', ?, ?, ?)
            `).run(
              `${snapshot.threadId}:${message.id}:${attachment.id}`,
              `${snapshot.threadId}:${message.id}`,
              attachment.name,
              JSON.stringify(attachment),
              message.createdAt,
              sequence,
            );
          }
        });
        db.prepare(`
          INSERT INTO projection_thread_activities
            (activity_id, thread_id, turn_id, activity_type, payload_json, created_at, last_event_sequence)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          snapshot.threadId,
          snapshot.activeTurnId,
          eventType,
          JSON.stringify(payload),
          new Date().toISOString(),
          sequence,
        );
        if (snapshot.activeTurnId) {
          db.prepare(`
            INSERT INTO projection_turns
              (turn_id, thread_id, provider_session_id, status, started_at, completed_at, last_event_sequence)
            VALUES (?, ?, (
              SELECT id FROM projection_provider_sessions
              WHERE thread_id = ? AND state = 'active' ORDER BY created_at DESC LIMIT 1
            ), 'running', ?, NULL, ?)
            ON CONFLICT(turn_id) DO UPDATE SET status = 'running', last_event_sequence = excluded.last_event_sequence
          `).run(snapshot.activeTurnId, snapshot.threadId, snapshot.threadId, new Date().toISOString(), sequence);
        }
        if (
          ["turn.completed", "turn.reconciled-after-restart", "turn.interrupted-by-restart"].includes(eventType) &&
          isDynamicRecord(payload) &&
          "turnId" in payload &&
          isString(payload.turnId)
        ) {
          const status =
            "status" in payload && isString(payload.status)
              ? payload.status
              : eventType === "turn.interrupted-by-restart"
                ? "interrupted"
                : "completed";
          db.prepare(
            `UPDATE projection_turns
             SET status = ?, completed_at = ?, last_event_sequence = ?
             WHERE thread_id = ? AND turn_id = ?`,
          ).run(status, new Date().toISOString(), sequence, snapshot.threadId, payload.turnId);
        }
        pruneConversationSnapshots(db, threadId, sequence);
        return { revision: sequence };
      },
    );
    return { ...structuredClone(snapshot), revision: result.revision };
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
    const result = this.dispatch(
      input.commandId ?? `conversation:${input.eventType}:${randomUUID()}`,
      [
        {
          aggregateType: "thread",
          aggregateId: input.threadId,
          eventType: input.eventType,
          occurredAt: input.message.createdAt,
          payload: {
            detail: input.detail ?? {},
            appendedMessage: input.message,
            activeTurnId: input.activeTurnId,
          },
        },
      ],
      (db, sequences) => {
        const sequence = sequences[0] ?? 0;
        const agent = this.listAgents().find((candidate) => candidate.id === input.botId);
        if (!agent || agent.threadId !== input.threadId) {
          throw new Error(`Unknown agent thread for conversation append: ${input.botId}`);
        }
        this.#ensureThreadProjection(db, agent, sequence);
        const ordinalRow = databaseRow(
          db
            .prepare(
              `SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal
               FROM projection_thread_messages WHERE thread_id = ?`,
            )
            .get(input.threadId),
        );
        const ordinal = ordinalRow ? requiredNumberColumn(ordinalRow, "ordinal") : 0;
        db.prepare(
          `INSERT INTO projection_thread_messages (
             thread_id, message_id, turn_id, author, status, item_type, created_at,
             ordinal, message_json, last_event_sequence
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          input.threadId,
          input.message.id,
          input.message.turnId ?? null,
          input.message.author,
          input.message.status,
          input.message.itemType ?? null,
          input.message.createdAt,
          ordinal,
          JSON.stringify(input.message),
          sequence,
        );
        for (const attachment of input.message.attachments ?? []) {
          db.prepare(
            `INSERT INTO projection_attachments
               (attachment_id, owner_kind, owner_id, name, path, metadata_json, created_at, last_event_sequence)
             VALUES (?, 'thread-message', ?, ?, '', ?, ?, ?)`,
          ).run(
            `${input.threadId}:${input.message.id}:${attachment.id}`,
            `${input.threadId}:${input.message.id}`,
            attachment.name,
            JSON.stringify(attachment),
            input.message.createdAt,
            sequence,
          );
        }
        db.prepare(
          `UPDATE projection_threads
           SET active_turn_id = ?, updated_at = ?, last_event_sequence = ? WHERE thread_id = ?`,
        ).run(input.activeTurnId, input.message.createdAt, sequence, input.threadId);
        db.prepare(
          `INSERT INTO projection_thread_activities
             (activity_id, thread_id, turn_id, activity_type, payload_json, created_at, last_event_sequence)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          randomUUID(),
          input.threadId,
          input.message.turnId ?? input.activeTurnId,
          input.eventType,
          JSON.stringify(input.detail ?? {}),
          input.message.createdAt,
          sequence,
        );
        return { revision: sequence };
      },
    );
    return result.revision;
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
      const persisted = this.persistConversation(
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
    const row = decodeSessionRow(
      this.connection
        .prepare(
          `SELECT id, thread_id, provider, external_session_id, model, effort, state,
                  created_at, updated_at, resume_cursor
           FROM projection_provider_sessions
           WHERE thread_id = ? AND provider = ? AND state = 'active'
           ORDER BY created_at DESC, last_event_sequence DESC LIMIT 1`,
        )
        .get(threadId, provider),
    );
    return row ? toProviderSession(row) : null;
  }

  listProviderSessions(threadId: string): ProviderSession[] {
    return databaseRows(
      this.connection
        .prepare(
          `SELECT id, thread_id, provider, external_session_id, model, effort, state,
                  created_at, updated_at, resume_cursor
           FROM projection_provider_sessions
           WHERE thread_id = ?
           ORDER BY created_at, last_event_sequence`,
        )
        .all(threadId),
    ).map((row) => toProviderSession(requiredSessionRow(row)));
  }

  bindProviderSession(input: {
    threadId: string;
    provider: AgentProviderId;
    externalSessionId: string;
    model: string;
    effort: string;
    resumeCursor?: string | null;
  }): ProviderSession {
    const now = new Date().toISOString();
    const session: ProviderSession = {
      id: randomUUID(),
      threadId: input.threadId,
      provider: input.provider,
      externalSessionId: input.externalSessionId,
      model: input.model,
      effort: input.effort,
      state: "active",
      createdAt: now,
      updatedAt: now,
      resumeCursor: input.resumeCursor ?? input.externalSessionId,
    };
    return this.dispatch(
      `provider-session:bind:${input.threadId}:${input.provider}:${input.externalSessionId}`,
      [
        {
          aggregateType: "thread",
          aggregateId: input.threadId,
          eventType: "provider-session.bound",
          payload: session,
        },
      ],
      (db, sequences) => {
        db.prepare(
          `UPDATE projection_provider_sessions SET state = 'inactive', updated_at = ?
           WHERE thread_id = ? AND state = 'active'`,
        ).run(now, input.threadId);
        db.prepare(`
          INSERT INTO projection_provider_sessions (
            id, thread_id, provider, external_session_id, model, effort, state,
            created_at, updated_at, resume_cursor, last_event_sequence
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          session.id,
          session.threadId,
          session.provider,
          session.externalSessionId,
          session.model,
          session.effort,
          session.state,
          session.createdAt,
          session.updatedAt,
          session.resumeCursor,
          sequences[0],
        );
        return session;
      },
    );
  }

  deactivateProviderSessions(threadId: string): void {
    const active = this.listProviderSessions(threadId).filter((session) => session.state === "active");
    if (active.length === 0) return;
    this.dispatch(
      `provider-session:deactivate:${threadId}:${randomUUID()}`,
      [
        {
          aggregateType: "thread",
          aggregateId: threadId,
          eventType: "provider-session.deactivated",
          payload: { sessionIds: active.map((session) => session.id) },
        },
      ],
      (db, sequences) => {
        db.prepare(
          `UPDATE projection_provider_sessions
           SET state = 'inactive', updated_at = ?, last_event_sequence = ?
           WHERE thread_id = ? AND state = 'active'`,
        ).run(new Date().toISOString(), sequences[0], threadId);
        return null;
      },
    );
  }

  updateProviderSessionConfig(sessionId: string, threadId: string, model: string, effort: string): void {
    this.dispatch(
      `provider-session:config:${sessionId}:${model}:${effort}`,
      [
        {
          aggregateType: "thread",
          aggregateId: threadId,
          eventType: "provider-session.config-updated",
          payload: { sessionId, model, effort },
        },
      ],
      (db, sequences) => {
        db.prepare(
          `UPDATE projection_provider_sessions
           SET model = ?, effort = ?, updated_at = ?, last_event_sequence = ? WHERE id = ?`,
        ).run(model, effort, new Date().toISOString(), sequences[0], sessionId);
        return null;
      },
    );
  }

  saveThreadSummary(
    threadId: string,
    throughMessageId: string | null,
    text: string,
    estimatedTokens: number,
  ): StoredThreadSummary {
    const summary: StoredThreadSummary = {
      id: randomUUID(),
      threadId,
      throughMessageId,
      text,
      estimatedTokens,
      createdAt: new Date().toISOString(),
    };
    return this.dispatch(
      `thread-summary:${summary.id}`,
      [
        {
          aggregateType: "thread",
          aggregateId: threadId,
          eventType: "thread.summary-created",
          payload: summary,
        },
      ],
      (db, sequences) => {
        db.prepare(`
          INSERT INTO projection_thread_summaries
            (summary_id, thread_id, through_message_id, summary_text, estimated_tokens, created_at, last_event_sequence)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(summary.id, threadId, throughMessageId, text, estimatedTokens, summary.createdAt, sequences[0]);
        return summary;
      },
    );
  }

  latestThreadSummary(threadId: string): StoredThreadSummary | null {
    const row = decodeSummaryRow(
      this.connection
        .prepare(
          `SELECT summary_id, thread_id, through_message_id, summary_text, estimated_tokens, created_at
           FROM projection_thread_summaries WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1`,
        )
        .get(threadId),
    );
    return row
      ? {
          id: row.summary_id,
          threadId: row.thread_id,
          throughMessageId: row.through_message_id,
          text: row.summary_text,
          estimatedTokens: row.estimated_tokens,
          createdAt: row.created_at,
        }
      : null;
  }

  rebuildThreadProjection(threadId: string): ConversationSnapshot {
    const db = this.connection;
    const events = databaseRows(
      db
        .prepare(
          `SELECT sequence, event_type, occurred_at, payload_json
           FROM orchestration_events
           WHERE aggregate_type = 'thread' AND aggregate_id = ? ORDER BY sequence`,
        )
        .all(threadId),
    ).map(requiredEventRow);
    const thread = decodeThreadAgentRow(
      db.prepare("SELECT agent_id FROM projection_threads WHERE thread_id = ?").get(threadId),
    );
    if (!thread) throw new Error(`Unknown OpenBot thread: ${threadId}`);

    let latest: ConversationSnapshot | null = null;
    let latestSequence = 0;
    const sessions = new Map<string, ProviderSession & { sequence: number }>();
    const summaries: Array<StoredThreadSummary & { sequence: number }> = [];
    const turnSessions = new Map<string, string | null>();
    for (const event of events) {
      const payload = JSON.parse(event.payload_json);
      const record = objectValue(payload);
      if (event.event_type === "provider-session.bound") {
        const session = providerSessionValue(record);
        if (session) {
          for (const current of sessions.values()) current.state = "inactive";
          sessions.set(session.id, { ...session, sequence: event.sequence });
        }
      } else if (event.event_type === "provider-session.deactivated") {
        const ids = Array.isArray(record?.sessionIds) ? record.sessionIds : [];
        for (const id of ids) {
          if (isString(id)) {
            const session = sessions.get(id);
            if (session) session.state = "inactive";
          }
        }
      } else if (event.event_type === "provider-session.config-updated") {
        const session = isString(record?.sessionId) ? sessions.get(record.sessionId) : null;
        if (session) {
          if (isString(record?.model)) session.model = record.model;
          if (isString(record?.effort)) session.effort = record.effort;
          session.sequence = event.sequence;
        }
      } else if (event.event_type === "thread.summary-created") {
        const summary = summaryValue(record);
        if (summary) summaries.push({ ...summary, sequence: event.sequence });
      }
      const snapshot = conversationSnapshotValue(objectValue(record?.snapshot));
      const appendedMessage = record?.appendedMessage;
      const appendedActiveTurnId = record?.activeTurnId;
      if (snapshot) {
        latest = snapshot;
        latestSequence = event.sequence;
        for (const [turnId, sessionId] of turnProviderSessionIdsValue(record?.recovery)) {
          turnSessions.set(turnId, sessionId);
        }
        if (snapshot.activeTurnId && !turnSessions.has(snapshot.activeTurnId)) {
          const activeSession = [...sessions.values()].find((session) => session.state === "active");
          turnSessions.set(snapshot.activeTurnId, activeSession?.id ?? null);
        }
      } else if (latest && isConversationMessage(appendedMessage)) {
        if (!latest.messages.some((message) => message.id === appendedMessage.id)) {
          latest.messages.push(structuredClone(appendedMessage));
        }
        if (isString(appendedActiveTurnId) || appendedActiveTurnId === null) {
          latest.activeTurnId = appendedActiveTurnId;
        }
        latestSequence = event.sequence;
      }
    }
    if (!latest) throw new Error(`Thread ${threadId} has no conversation events to replay.`);

    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("DELETE FROM projection_thread_activities WHERE thread_id = ?").run(threadId);
      db.prepare("DELETE FROM projection_turns WHERE thread_id = ?").run(threadId);
      db.prepare("DELETE FROM projection_thread_messages WHERE thread_id = ?").run(threadId);
      db.prepare("DELETE FROM projection_thread_summaries WHERE thread_id = ?").run(threadId);
      db.prepare("DELETE FROM projection_provider_sessions WHERE thread_id = ?").run(threadId);
      db.prepare("DELETE FROM projection_attachments WHERE owner_kind = 'thread-message' AND owner_id LIKE ?").run(
        `${threadId}:%`,
      );
      const sessionInsert = db.prepare(`
        INSERT INTO projection_provider_sessions (
          id, thread_id, provider, external_session_id, model, effort, state,
          created_at, updated_at, resume_cursor, last_event_sequence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const session of sessions.values()) {
        sessionInsert.run(
          session.id,
          threadId,
          session.provider,
          session.externalSessionId,
          session.model,
          session.effort,
          session.state,
          session.createdAt,
          session.updatedAt,
          session.resumeCursor,
          session.sequence,
        );
      }
      const messageInsert = db.prepare(`
        INSERT INTO projection_thread_messages (
          thread_id, message_id, turn_id, author, status, item_type, created_at,
          ordinal, message_json, last_event_sequence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      latest.messages.forEach((message, ordinal) => {
        messageInsert.run(
          threadId,
          message.id,
          message.turnId ?? null,
          message.author,
          message.status,
          message.itemType ?? null,
          message.createdAt,
          ordinal,
          JSON.stringify(message),
          latestSequence,
        );
        for (const attachment of message.attachments ?? []) {
          db.prepare(`
            INSERT INTO projection_attachments
              (attachment_id, owner_kind, owner_id, name, path, metadata_json, created_at, last_event_sequence)
            VALUES (?, 'thread-message', ?, ?, '', ?, ?, ?)
          `).run(
            `${threadId}:${message.id}:${attachment.id}`,
            `${threadId}:${message.id}`,
            attachment.name,
            JSON.stringify(attachment),
            message.createdAt,
            latestSequence,
          );
        }
      });
      const messagesByTurn = new Map<string, ConversationMessage[]>();
      for (const message of latest.messages) {
        if (!message.turnId) continue;
        const messages = messagesByTurn.get(message.turnId) ?? [];
        messages.push(message);
        messagesByTurn.set(message.turnId, messages);
      }
      const turnInsert = db.prepare(`
        INSERT INTO projection_turns (
          turn_id, thread_id, provider_session_id, status, started_at, completed_at, last_event_sequence
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const [turnId, messages] of messagesByTurn) {
        const running = latest.activeTurnId === turnId;
        const status = running
          ? "running"
          : messages.some((message) => message.status === "failed")
            ? "failed"
            : messages.some((message) => message.status === "interrupted")
              ? "interrupted"
              : "completed";
        turnInsert.run(
          turnId,
          threadId,
          turnSessions.get(turnId) ?? null,
          status,
          messages[0]?.createdAt ?? new Date().toISOString(),
          running ? null : (messages.at(-1)?.createdAt ?? new Date().toISOString()),
          latestSequence,
        );
      }
      const summaryInsert = db.prepare(`
        INSERT INTO projection_thread_summaries (
          summary_id, thread_id, through_message_id, summary_text,
          estimated_tokens, created_at, last_event_sequence
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const summary of summaries) {
        summaryInsert.run(
          summary.id,
          threadId,
          summary.throughMessageId,
          summary.text,
          summary.estimatedTokens,
          summary.createdAt,
          summary.sequence,
        );
      }
      const activityInsert = db.prepare(`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, activity_type,
          payload_json, created_at, last_event_sequence
        ) VALUES (?, ?, NULL, ?, ?, ?, ?)
      `);
      for (const event of events) {
        const eventPayload = JSON.parse(event.payload_json);
        const eventRecord = objectValue(eventPayload);
        const activityPayload =
          conversationSnapshotValue(objectValue(eventRecord?.snapshot)) ||
          isConversationMessage(eventRecord?.appendedMessage)
            ? (eventRecord?.detail ?? {})
            : eventPayload;
        activityInsert.run(
          randomUUID(),
          threadId,
          event.event_type,
          JSON.stringify(activityPayload),
          event.occurred_at,
          event.sequence,
        );
      }
      db.prepare(
        `UPDATE projection_threads
         SET active_turn_id = ?, updated_at = ?, last_event_sequence = ? WHERE thread_id = ?`,
      ).run(latest.activeTurnId, new Date().toISOString(), latestSequence, threadId);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return this.readConversation(thread.agent_id, threadId);
  }

  replaceMailboxState(
    commandId: string,
    state: MailboxProjectionState,
    eventType: string,
    fileDeletions: string[] = [],
    _rebaseHistory = false,
  ): void {
    this.dispatch(
      commandId,
      [
        {
          aggregateType: "mailbox",
          aggregateId: "mailbox",
          eventType,
          payload: state,
        },
      ],
      (db, sequences) => {
        const sequence = sequences[0] ?? 0;
        db.prepare(
          `DELETE FROM orchestration_events
           WHERE aggregate_type = 'mailbox' AND aggregate_id = 'mailbox' AND sequence < ?`,
        ).run(sequence);
        deleteOrphanReceipts(db);
        const value = state;
        db.exec("DELETE FROM projection_deliveries");
        db.exec("DELETE FROM projection_mailbox_messages");
        db.exec("DELETE FROM projection_queue_state");
        db.exec("DELETE FROM projection_reactions");
        db.exec("DELETE FROM projection_attachments WHERE owner_kind IN ('mailbox-message', 'draft', 'generated')");
        const messageInsert = db.prepare(`
          INSERT INTO projection_mailbox_messages
            (message_id, sender_kind, sender_agent_id, text, reply_to_message_id, created_at, message_json, last_event_sequence)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const attachmentInsert = db.prepare(`
          INSERT INTO projection_attachments
            (attachment_id, owner_kind, owner_id, name, path, metadata_json, created_at, last_event_sequence)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const message of value.messages) {
          const sender = message.sender;
          messageInsert.run(
            String(message.id),
            sender.kind,
            sender.botId ?? null,
            String(message.text),
            isString(message.replyToMessageId) ? message.replyToMessageId : null,
            String(message.createdAt),
            JSON.stringify(message),
            sequence,
          );
          for (const attachment of message.attachments) {
            attachmentInsert.run(
              String(attachment.id),
              "mailbox-message",
              String(message.id),
              String(attachment.name),
              String(attachment.path),
              JSON.stringify(attachment),
              String(message.createdAt),
              sequence,
            );
          }
        }
        const deliveryInsert = db.prepare(`
          INSERT INTO projection_deliveries
            (delivery_id, message_id, recipient_agent_id, status, turn_id, error, created_at, delivery_json, last_event_sequence)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const delivery of value.deliveries) {
          deliveryInsert.run(
            String(delivery.id),
            String(delivery.messageId),
            String(delivery.recipientBotId),
            String(delivery.status),
            isString(delivery.turnId) ? delivery.turnId : null,
            isString(delivery.error) ? delivery.error : null,
            String(delivery.createdAt),
            JSON.stringify(delivery),
            sequence,
          );
        }
        const queueInsert = db.prepare(`
          INSERT INTO projection_queue_state
            (agent_id, paused, metadata_json, last_event_sequence) VALUES (?, ?, ?, ?)
        `);
        queueInsert.run("__mailbox__", 0, JSON.stringify({ idempotency: value.idempotency }), sequence);
        for (const botId of value.pausedBotIds) queueInsert.run(botId, 1, "{}", sequence);
        const reactionInsert = db.prepare(`
          INSERT INTO projection_reactions
            (agent_id, message_id, emoji, actor_kind, actor_bot_id, updated_at, last_event_sequence)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        for (const reaction of value.reactions) {
          reactionInsert.run(
            String(reaction.botId),
            String(reaction.messageId),
            String(reaction.emoji),
            reaction.actor.kind,
            reaction.actor.kind === "bot" ? reaction.actor.botId : "",
            String(reaction.updatedAt),
            sequence,
          );
        }
        for (const draft of value.drafts) {
          attachmentInsert.run(
            String(draft.id),
            "draft",
            String(draft.id),
            String(draft.name),
            String(draft.path),
            JSON.stringify(draft),
            String(draft.createdAt),
            sequence,
          );
        }
        for (const attachment of value.generatedAttachments) {
          attachmentInsert.run(
            String(attachment.id),
            "generated",
            String(attachment.id),
            String(attachment.name),
            String(attachment.path),
            JSON.stringify(attachment),
            new Date().toISOString(),
            sequence,
          );
        }
        const outboxInsert = db.prepare(`
          INSERT OR IGNORE INTO file_deletion_outbox
            (id, path, reason, created_at, attempts, last_error)
          VALUES (?, ?, ?, ?, 0, NULL)
        `);
        for (const path of fileDeletions) {
          outboxInsert.run(randomUUID(), path, eventType, new Date().toISOString());
        }
        return null;
      },
    );
  }

  pendingFileDeletions(): Array<{ id: string; path: string }> {
    return databaseRows(
      this.connection.prepare("SELECT id, path FROM file_deletion_outbox ORDER BY created_at").all(),
    ).map((row) => ({
      id: requiredStringColumn(row, "id"),
      path: requiredStringColumn(row, "path"),
    }));
  }

  completeFileDeletion(id: string): void {
    this.connection.prepare("DELETE FROM file_deletion_outbox WHERE id = ?").run(id);
  }

  failFileDeletion(id: string, error: string): void {
    this.connection
      .prepare(
        `UPDATE file_deletion_outbox
         SET attempts = attempts + 1, last_error = ? WHERE id = ?`,
      )
      .run(error.slice(0, 2_000), id);
  }

  readMailboxState(): unknown | null {
    const db = this.connection;
    const marker = databaseRow(
      db.prepare("SELECT metadata_json FROM projection_queue_state WHERE agent_id = '__mailbox__'").get(),
    );
    if (!marker) return null;
    const metadata = parseMailboxMetadata(requiredStringColumn(marker, "metadata_json"));
    const messages = databaseRows(
      db.prepare("SELECT message_json FROM projection_mailbox_messages ORDER BY created_at, message_id").all(),
    ).map((row) => JSON.parse(requiredStringColumn(row, "message_json")));
    const deliveries = databaseRows(
      db.prepare("SELECT delivery_json FROM projection_deliveries ORDER BY created_at, delivery_id").all(),
    ).map((row) => JSON.parse(requiredStringColumn(row, "delivery_json")));
    const drafts = databaseRows(
      db.prepare("SELECT metadata_json FROM projection_attachments WHERE owner_kind = 'draft'").all(),
    ).map((row) => JSON.parse(requiredStringColumn(row, "metadata_json")));
    const generatedAttachments = databaseRows(
      db.prepare("SELECT metadata_json FROM projection_attachments WHERE owner_kind = 'generated'").all(),
    ).map((row) => JSON.parse(requiredStringColumn(row, "metadata_json")));
    const pausedBotIds = databaseRows(
      db.prepare("SELECT agent_id FROM projection_queue_state WHERE paused = 1").all(),
    ).map((row) => requiredStringColumn(row, "agent_id"));
    const reactions = databaseRows(
      db
        .prepare("SELECT agent_id, message_id, emoji, actor_kind, actor_bot_id, updated_at FROM projection_reactions")
        .all(),
    ).map((row) => ({
      botId: requiredStringColumn(row, "agent_id"),
      messageId: requiredStringColumn(row, "message_id"),
      emoji: requiredStringColumn(row, "emoji"),
      actor:
        requiredStringColumn(row, "actor_kind") === "bot"
          ? { kind: "bot" as const, botId: requiredStringColumn(row, "actor_bot_id") }
          : { kind: "user" as const },
      updatedAt: requiredStringColumn(row, "updated_at"),
    }));
    return {
      version: 3,
      messages,
      deliveries,
      drafts,
      generatedAttachments,
      pausedBotIds,
      idempotency: metadata.idempotency ?? {},
      reactions,
    };
  }

  #ensureThreadProjection(db: DatabaseSync, agent: BotSummary, sequence: number): void {
    if (!agent.threadId) return;
    db.prepare(`
      INSERT INTO projection_threads
        (thread_id, agent_id, title, active_turn_id, created_at, updated_at, last_event_sequence)
      VALUES (?, ?, ?, NULL, ?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        agent_id = excluded.agent_id,
        title = excluded.title,
        updated_at = excluded.updated_at,
        last_event_sequence = MAX(projection_threads.last_event_sequence, excluded.last_event_sequence)
    `).run(
      agent.threadId,
      agent.id,
      agent.name,
      agent.updatedAt ?? new Date().toISOString(),
      agent.updatedAt ?? new Date().toISOString(),
      sequence,
    );
  }
}

function toProviderSession(row: SessionRow): ProviderSession {
  return {
    id: row.id,
    threadId: row.thread_id,
    provider: row.provider,
    externalSessionId: row.external_session_id,
    model: row.model,
    effort: row.effort,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resumeCursor: row.resume_cursor,
  };
}

interface ConversationPageCursor {
  version: 1;
  createdAt: string;
  ordinal: number;
  messageId: string;
}

function pageLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1) throw new Error("The conversation page limit is invalid.");
  return Math.min(value, 100);
}

function conversationRowCursor(row: DynamicRecord): ConversationPageCursor {
  return {
    version: 1,
    createdAt: requiredStringColumn(row, "created_at"),
    ordinal: requiredNumberColumn(row, "ordinal"),
    messageId: requiredStringColumn(row, "message_id"),
  };
}

function conversationMarkerSqlFilter(
  excludeRoutineEvents: boolean,
  excludeRoutineRunEvents: boolean,
  excludeHostedSiteEvents: boolean,
): string {
  return [
    excludeRoutineEvents ? `AND COALESCE(item_type, '') NOT LIKE '${ROUTINE_EVENT_ITEM_TYPE_PREFIX}%'` : "",
    excludeRoutineRunEvents ? `AND COALESCE(item_type, '') NOT LIKE '${ROUTINE_RUN_EVENT_ITEM_TYPE_PREFIX}%'` : "",
    excludeHostedSiteEvents ? `AND COALESCE(item_type, '') NOT LIKE '${HOSTED_SITE_EVENT_ITEM_TYPE_PREFIX}%'` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function encodePageCursor(cursor: ConversationPageCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeConversationCursor(value: string): ConversationPageCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      !isDynamicRecord(parsed) ||
      parsed.version !== 1 ||
      !isString(parsed.createdAt) ||
      !isNumber(parsed.ordinal) ||
      !Number.isInteger(parsed.ordinal) ||
      !isString(parsed.messageId)
    ) {
      throw new Error("invalid cursor");
    }
    return {
      version: 1,
      createdAt: parsed.createdAt,
      ordinal: parsed.ordinal,
      messageId: parsed.messageId,
    };
  } catch {
    throw new Error("The conversation page cursor is invalid.");
  }
}

function encodeSearchCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ version: 1, offset }), "utf8").toString("base64url");
}

function decodeSearchCursor(value: string): number {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      !isDynamicRecord(parsed) ||
      parsed.version !== 1 ||
      !isNumber(parsed.offset) ||
      !Number.isSafeInteger(parsed.offset) ||
      parsed.offset < 0
    ) {
      throw new Error("invalid cursor");
    }
    return parsed.offset;
  } catch {
    throw new Error("The conversation search cursor is invalid.");
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function decodeSessionRow(value: unknown): SessionRow | null {
  const row = databaseRow(value);
  if (!row) return null;
  const provider = requiredStringColumn(row, "provider");
  const state = requiredStringColumn(row, "state");
  if (!isAgentProvider(provider)) throw new Error("Invalid provider column.");
  if (state !== "active" && state !== "inactive" && state !== "failed") {
    throw new Error("Invalid provider session state column.");
  }
  return {
    id: requiredStringColumn(row, "id"),
    thread_id: requiredStringColumn(row, "thread_id"),
    provider,
    external_session_id: requiredStringColumn(row, "external_session_id"),
    model: requiredStringColumn(row, "model"),
    effort: requiredStringColumn(row, "effort"),
    state,
    created_at: requiredStringColumn(row, "created_at"),
    updated_at: requiredStringColumn(row, "updated_at"),
    resume_cursor: optionalStringColumn(row, "resume_cursor"),
  };
}

function requiredSessionRow(value: DynamicRecord): SessionRow {
  const row = decodeSessionRow(value);
  if (!row) throw new Error("Invalid provider session row.");
  return row;
}

function decodeSummaryRow(value: unknown): {
  summary_id: string;
  thread_id: string;
  through_message_id: string | null;
  summary_text: string;
  estimated_tokens: number;
  created_at: string;
} | null {
  const row = databaseRow(value);
  if (!row) return null;
  return {
    summary_id: requiredStringColumn(row, "summary_id"),
    thread_id: requiredStringColumn(row, "thread_id"),
    through_message_id: optionalStringColumn(row, "through_message_id"),
    summary_text: requiredStringColumn(row, "summary_text"),
    estimated_tokens: requiredNumberColumn(row, "estimated_tokens"),
    created_at: requiredStringColumn(row, "created_at"),
  };
}

function parseMailboxMetadata(value: string): { idempotency?: Record<string, string> } {
  const parsed = JSON.parse(value);
  if (!isDynamicRecord(parsed)) throw new Error("Invalid mailbox metadata.");
  const idempotency = parsed.idempotency;
  if (idempotency === undefined) return {};
  if (!isDynamicRecord(idempotency)) throw new Error("Invalid mailbox idempotency metadata.");
  const entries = Object.entries(idempotency);
  const values: Record<string, string> = {};
  for (const [key, entry] of entries) {
    if (!isString(entry)) throw new Error("Invalid mailbox idempotency entry.");
    values[key] = entry;
  }
  return { idempotency: values };
}

function providerSessionValue(value: DynamicRecord | null): ProviderSession | null {
  if (
    !value ||
    !isString(value.id) ||
    !isString(value.threadId) ||
    !isAgentProvider(value.provider) ||
    !isString(value.externalSessionId) ||
    !isString(value.model) ||
    !isString(value.effort) ||
    (value.state !== "active" && value.state !== "inactive" && value.state !== "failed") ||
    !isString(value.createdAt) ||
    !isString(value.updatedAt) ||
    (!isString(value.resumeCursor) && value.resumeCursor !== null)
  ) {
    return null;
  }
  return {
    id: value.id,
    threadId: value.threadId,
    provider: value.provider,
    externalSessionId: value.externalSessionId,
    model: value.model,
    effort: value.effort,
    state: value.state,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    resumeCursor: value.resumeCursor,
  };
}

function summaryValue(value: DynamicRecord | null): StoredThreadSummary | null {
  if (
    !value ||
    !isString(value.id) ||
    !isString(value.threadId) ||
    (!isString(value.throughMessageId) && value.throughMessageId !== null) ||
    !isString(value.text) ||
    !isNumber(value.estimatedTokens) ||
    !isString(value.createdAt)
  ) {
    return null;
  }
  return {
    id: value.id,
    threadId: value.threadId,
    throughMessageId: value.throughMessageId,
    text: value.text,
    estimatedTokens: value.estimatedTokens,
    createdAt: value.createdAt,
  };
}

function conversationSnapshotValue(value: DynamicRecord | null): ConversationSnapshot | null {
  if (
    !value ||
    !isString(value.botId) ||
    (!isString(value.threadId) && value.threadId !== null) ||
    (!isString(value.activeTurnId) && value.activeTurnId !== null) ||
    !isNumber(value.revision) ||
    !Array.isArray(value.messages)
  ) {
    return null;
  }
  const messages = value.messages.filter(isConversationMessage);
  if (messages.length !== value.messages.length) return null;
  return {
    botId: value.botId,
    threadId: value.threadId,
    activeTurnId: value.activeTurnId,
    revision: value.revision,
    messages,
  };
}

function conversationRecoveryState(
  db: DatabaseSync,
  threadId: string,
  activeTurnId: string | null,
): { turnProviderSessionIds: Record<string, string | null> } {
  const turnProviderSessionIds: Record<string, string | null> = {};
  for (const row of databaseRows(
    db.prepare("SELECT turn_id, provider_session_id FROM projection_turns WHERE thread_id = ?").all(threadId),
  )) {
    const turnId = requiredStringColumn(row, "turn_id");
    turnProviderSessionIds[turnId] = optionalStringColumn(row, "provider_session_id");
  }
  if (activeTurnId && !(activeTurnId in turnProviderSessionIds)) {
    const activeSession = databaseRow(
      db
        .prepare(
          `SELECT id FROM projection_provider_sessions
           WHERE thread_id = ? AND state = 'active'
           ORDER BY created_at DESC, last_event_sequence DESC LIMIT 1`,
        )
        .get(threadId),
    );
    turnProviderSessionIds[activeTurnId] = activeSession ? requiredStringColumn(activeSession, "id") : null;
  }
  return { turnProviderSessionIds };
}

function turnProviderSessionIdsValue(value: unknown): Array<[string, string | null]> {
  const recovery = objectValue(value);
  const turnProviderSessionIds = objectValue(recovery?.turnProviderSessionIds);
  if (!turnProviderSessionIds) return [];
  const result: Array<[string, string | null]> = [];
  for (const [turnId, sessionId] of Object.entries(turnProviderSessionIds)) {
    if (sessionId === null || isString(sessionId)) result.push([turnId, sessionId]);
  }
  return result;
}

function pruneConversationSnapshots(db: DatabaseSync, threadId: string, retainedSequence: number): void {
  db.prepare(
    `DELETE FROM projection_thread_activities
     WHERE thread_id = ? AND last_event_sequence IN (
       SELECT sequence FROM orchestration_events
       WHERE aggregate_type = 'thread' AND aggregate_id = ? AND sequence < ?
         AND json_type(payload_json, '$.snapshot') = 'object'
     )`,
  ).run(threadId, threadId, retainedSequence);
  db.prepare(
    `DELETE FROM orchestration_events
     WHERE aggregate_type = 'thread' AND aggregate_id = ? AND sequence < ?
       AND json_type(payload_json, '$.snapshot') = 'object'`,
  ).run(threadId, retainedSequence);
  deleteOrphanReceipts(db);
}

export function providerForStoredModel(model: BotSummary["model"]): AgentProviderId {
  return providerForLegacyModel(model);
}

export function stableThreadId(botId: string): string {
  return `openbot-thread-${botId}`;
}
