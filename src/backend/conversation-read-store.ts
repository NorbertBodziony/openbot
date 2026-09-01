import type { BotSummary, ConversationReadState, ConversationSnapshot } from "@openbot/contracts/ipc";
import {
  HOSTED_SITE_EVENT_ITEM_TYPE_PREFIX,
  ROUTINE_EVENT_ITEM_TYPE_PREFIX,
  ROUTINE_RUN_EVENT_ITEM_TYPE_PREFIX,
} from "@openbot/contracts/ipc";
import { isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import type { OpenBotDatabase } from "./openbot-database";

export interface ConversationMarkerExclusions {
  excludeRoutineEvents?: boolean;
  excludeRoutineRunEvents?: boolean;
  excludeHostedSiteEvents?: boolean;
}

export class ConversationReadStore {
  constructor(readonly database: OpenBotDatabase) {}

  listStates(
    memberId: string,
    bots: BotSummary[],
    options: ConversationMarkerExclusions = {},
  ): Record<string, ConversationReadState> {
    return Object.fromEntries(bots.map((bot) => [bot.id, this.readStateForThread(memberId, bot.threadId, options)]));
  }

  readStateForThread(
    memberId: string,
    threadId: string | null,
    options: ConversationMarkerExclusions = {},
  ): ConversationReadState {
    if (!threadId) return emptyReadState();
    const stored = this.#storedCursor(threadId, memberId);
    let state: ConversationReadState;
    if (stored === undefined) {
      const baseline = this.#migrationCursor(threadId);
      const initialCursor =
        baseline && !this.#messageExists(threadId, baseline) ? this.#latestMessageId(threadId) : baseline;
      this.#saveCursor(threadId, memberId, initialCursor, "initialized");
      state = this.#stateFromDatabase(threadId, initialCursor);
    } else if (stored !== null && !this.#messageExists(threadId, stored)) {
      const latestMessageId = this.#latestMessageId(threadId);
      this.#saveCursor(threadId, memberId, latestMessageId, "initialized");
      state = this.#stateFromDatabase(threadId, latestMessageId);
    } else {
      state = this.#stateFromDatabase(threadId, stored);
    }
    return this.#withSupportedCursor(threadId, state, options);
  }

  adoptMemberState(sourceMemberId: string, targetMemberId: string): void {
    if (sourceMemberId === targetMemberId) return;
    const rows = this.database.connection
      .prepare(
        `SELECT thread_id, through_message_id FROM projection_thread_reads
         WHERE member_id = ?`,
      )
      .all(sourceMemberId);
    if (!Array.isArray(rows)) throw new Error("The conversation read states are malformed.");
    for (const value of rows) {
      if (!isDynamicRecord(value) || !isString(value.thread_id)) {
        throw new Error("The conversation read state is malformed.");
      }
      const cursor = value.through_message_id;
      if (cursor !== null && !isString(cursor)) {
        throw new Error("The conversation read cursor is malformed.");
      }
      if (this.#storedCursor(value.thread_id, targetMemberId) === undefined) {
        this.#saveCursor(value.thread_id, targetMemberId, cursor, "initialized");
      }
    }
  }

  readState(memberId: string, snapshot: ConversationSnapshot): ConversationReadState {
    if (!snapshot.threadId) return emptyReadState();
    const stored = this.#storedCursor(snapshot.threadId, memberId);
    if (stored === undefined) {
      const baseline = this.#migrationCursor(snapshot.threadId);
      const initialCursor =
        baseline && !snapshot.messages.some((message) => message.id === baseline)
          ? (snapshot.messages.at(-1)?.id ?? null)
          : baseline;
      return this.#initialize(memberId, snapshot, initialCursor);
    }
    if (stored !== null && !snapshot.messages.some((message) => message.id === stored)) {
      return this.#initialize(memberId, snapshot, snapshot.messages.at(-1)?.id ?? null);
    }
    return stateFromSnapshot(snapshot, stored);
  }

  markRead(
    memberId: string,
    snapshot: ConversationSnapshot,
    throughMessageId: string | null,
    options: ConversationMarkerExclusions = {},
  ): ConversationReadState {
    if (!snapshot.threadId) return emptyReadState();
    const requestedIndex = throughMessageId
      ? snapshot.messages.findIndex((message) => message.id === throughMessageId)
      : -1;
    if (throughMessageId && requestedIndex < 0) {
      throw new Error("The read boundary is no longer available.");
    }
    const stored = this.#storedCursor(snapshot.threadId, memberId);
    const storedIndex = stored ? snapshot.messages.findIndex((message) => message.id === stored) : -1;
    const nextThroughMessageId = storedIndex > requestedIndex ? (stored ?? null) : (throughMessageId ?? null);
    this.#saveCursor(snapshot.threadId, memberId, nextThroughMessageId, "marked");
    return this.#withSupportedCursor(snapshot.threadId, stateFromSnapshot(snapshot, nextThroughMessageId), options);
  }

  #withSupportedCursor(
    threadId: string,
    state: ConversationReadState,
    options: ConversationMarkerExclusions,
  ): ConversationReadState {
    return {
      ...state,
      throughMessageId: this.database.supportedConversationCursor(threadId, state.throughMessageId, options),
    };
  }

  #storedCursor(threadId: string, memberId: string): string | null | undefined {
    const row = this.database.connection
      .prepare(
        `SELECT through_message_id FROM projection_thread_reads
         WHERE thread_id = ? AND member_id = ?`,
      )
      .get(threadId, memberId);
    if (row === undefined) return undefined;
    if (!isDynamicRecord(row)) {
      throw new Error("The stored conversation read state is malformed.");
    }
    const value = row.through_message_id;
    if (value === null || isString(value)) return value;
    throw new Error("The stored conversation read cursor is malformed.");
  }

  #messageExists(threadId: string, messageId: string): boolean {
    return Boolean(
      this.database.connection
        .prepare(
          `SELECT 1 FROM projection_thread_messages
           WHERE thread_id = ? AND message_id = ? LIMIT 1`,
        )
        .get(threadId, messageId),
    );
  }

  #latestMessageId(threadId: string): string | null {
    const row = this.database.connection
      .prepare(
        `SELECT message_id FROM projection_thread_messages
         WHERE thread_id = ?
         ORDER BY created_at DESC, ordinal DESC, message_id DESC
         LIMIT 1`,
      )
      .get(threadId);
    if (row === undefined) return null;
    if (!isDynamicRecord(row) || !isString(row.message_id)) {
      throw new Error("The latest conversation message is malformed.");
    }
    return row.message_id;
  }

  #stateFromDatabase(threadId: string, throughMessageId: string | null): ConversationReadState {
    const boundary = throughMessageId
      ? this.database.connection
          .prepare(
            `SELECT created_at, ordinal, message_id FROM projection_thread_messages
             WHERE thread_id = ? AND message_id = ?`,
          )
          .get(threadId, throughMessageId)
      : undefined;
    if (
      boundary !== undefined &&
      (!isDynamicRecord(boundary) || !isString(boundary.created_at) || !isNumber(boundary.ordinal))
    ) {
      throw new Error("The conversation read boundary is malformed.");
    }
    const afterBoundary = boundary ? `AND (created_at, ordinal, message_id) > (?, ?, ?)` : "";
    const parameters = boundary ? [threadId, boundary.created_at, boundary.ordinal, throughMessageId] : [threadId];
    const unreadFilter = `author != 'user'
      AND COALESCE(item_type, '') != 'commentary'
      AND COALESCE(item_type, '') != 'agent_attachment'
      AND COALESCE(item_type, '') NOT LIKE '${ROUTINE_EVENT_ITEM_TYPE_PREFIX}%'
      AND COALESCE(item_type, '') NOT LIKE '${ROUTINE_RUN_EVENT_ITEM_TYPE_PREFIX}%'
      AND COALESCE(item_type, '') NOT LIKE '${HOSTED_SITE_EVENT_ITEM_TYPE_PREFIX}%'`;
    const countRow = this.database.connection
      .prepare(
        `SELECT COUNT(*) AS unread_count FROM projection_thread_messages
         WHERE thread_id = ? ${afterBoundary} AND ${unreadFilter}`,
      )
      .get(...parameters);
    const firstRow = this.database.connection
      .prepare(
        `SELECT message_id FROM projection_thread_messages
         WHERE thread_id = ? ${afterBoundary} AND ${unreadFilter}
         ORDER BY created_at, ordinal, message_id LIMIT 1`,
      )
      .get(...parameters);
    if (!isDynamicRecord(countRow) || !isNumber(countRow.unread_count)) {
      throw new Error("The conversation unread count is malformed.");
    }
    if (firstRow !== undefined && (!isDynamicRecord(firstRow) || !isString(firstRow.message_id))) {
      throw new Error("The first unread conversation message is malformed.");
    }
    const firstUnreadMessageId =
      firstRow !== undefined && isDynamicRecord(firstRow) && isString(firstRow.message_id) ? firstRow.message_id : null;
    return {
      unreadCount: countRow.unread_count,
      firstUnreadMessageId,
      throughMessageId,
    };
  }

  #migrationCursor(threadId: string): string | null {
    const row = this.database.connection
      .prepare(
        `SELECT through_message_id FROM projection_thread_read_baselines
         WHERE thread_id = ?`,
      )
      .get(threadId);
    if (row === undefined) return null;
    if (!isDynamicRecord(row)) {
      throw new Error("The conversation read baseline is malformed.");
    }
    const value = row.through_message_id;
    if (value === null || isString(value)) return value;
    throw new Error("The conversation read baseline cursor is malformed.");
  }

  #initialize(
    memberId: string,
    snapshot: ConversationSnapshot,
    throughMessageId: string | null,
  ): ConversationReadState {
    if (!snapshot.threadId) return emptyReadState();
    this.#saveCursor(snapshot.threadId, memberId, throughMessageId, "initialized");
    return stateFromSnapshot(snapshot, throughMessageId);
  }

  #saveCursor(
    threadId: string,
    memberId: string,
    throughMessageId: string | null,
    event: "initialized" | "marked",
  ): void {
    const updatedAt = new Date().toISOString();
    this.database.dispatch(
      `thread-read:${event}:${threadId}:${memberId}:${throughMessageId ?? "empty"}`,
      [
        {
          aggregateType: "thread-read",
          aggregateId: `${threadId}:${memberId}`,
          eventType: `thread-read.${event}`,
          payload: { threadId, memberId, throughMessageId },
          occurredAt: updatedAt,
        },
      ],
      (db) => {
        db.prepare(
          `INSERT INTO projection_thread_reads (
             thread_id, member_id, through_message_id, updated_at
           ) VALUES (?, ?, ?, ?)
           ON CONFLICT(thread_id, member_id) DO UPDATE SET
             through_message_id = excluded.through_message_id,
             updated_at = excluded.updated_at`,
        ).run(threadId, memberId, throughMessageId, updatedAt);
        return null;
      },
    );
  }
}

function stateFromSnapshot(snapshot: ConversationSnapshot, throughMessageId: string | null): ConversationReadState {
  const throughIndex = throughMessageId
    ? snapshot.messages.findIndex((message) => message.id === throughMessageId)
    : -1;
  const unread = snapshot.messages
    .slice(throughIndex + 1)
    .filter(
      (message) =>
        message.author !== "user" &&
        message.itemType !== "commentary" &&
        message.itemType !== "agent_attachment" &&
        !message.itemType?.startsWith(ROUTINE_EVENT_ITEM_TYPE_PREFIX) &&
        !message.itemType?.startsWith(ROUTINE_RUN_EVENT_ITEM_TYPE_PREFIX) &&
        !message.itemType?.startsWith(HOSTED_SITE_EVENT_ITEM_TYPE_PREFIX),
    );
  return {
    unreadCount: unread.length,
    firstUnreadMessageId: unread[0]?.id ?? null,
    throughMessageId,
  };
}

function emptyReadState(): ConversationReadState {
  return { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: null };
}
