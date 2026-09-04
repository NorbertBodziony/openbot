import type {
  ConversationMessage,
  ConversationPage,
  ConversationPageAnchor,
  ConversationSearchPage,
  ConversationSnapshot,
} from "@openbot/contracts/ipc";
import {
  HOSTED_SITE_EVENT_ITEM_TYPE_PREFIX,
  ROUTINE_EVENT_ITEM_TYPE_PREFIX,
  ROUTINE_RUN_EVENT_ITEM_TYPE_PREFIX,
} from "@openbot/contracts/ipc";
import { type DynamicRecord, isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import type { DatabaseCore } from "./database-core";
import {
  databaseRow,
  databaseRows,
  decodeConversationMessageJson,
  decodeConversationThreadRow,
  optionalStringColumn,
  requiredNumberColumn,
  requiredStringColumn,
} from "./database-rows";

export interface ConversationQueriesOptions {
  core: DatabaseCore;
}

/**
 * Every read of a thread's messages: the whole snapshot, one anchored page, a page's supported
 * cursor, and a text search across the thread.
 *
 * Owns the read side of `projection_thread_messages` and the opaque base64url cursors that page it,
 * including the marker filters that hide routine and hosted-site events from a page whose caller
 * did not ask for them. Reads only — nothing here dispatches an event or opens a transaction. The
 * class never imports the facade.
 */
export class ConversationQueries {
  readonly #core: DatabaseCore;

  constructor(options: ConversationQueriesOptions) {
    this.#core = options.core;
  }

  readConversation(botId: string, threadId: string | null): ConversationSnapshot {
    if (!threadId) return { botId, threadId: null, activeTurnId: null, revision: 0, messages: [] };
    const thread = decodeConversationThreadRow(
      this.#core.connection
        .prepare(
          `SELECT active_turn_id, last_event_sequence
           FROM projection_threads WHERE thread_id = ? AND agent_id = ?`,
        )
        .get(threadId, botId),
    );
    const rows = databaseRows(
      this.#core.connection
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
      this.#core.connection
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
      this.#core.connection
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
        this.#core.connection
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
      this.#core.connection
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
      this.#core.connection
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
      this.#core.connection
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
      this.#core.connection
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
        this.#core.connection
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
        this.#core.connection
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
      this.#core.connection
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
      this.#core.connection
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
      this.#core.connection
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
      this.#core.connection
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
