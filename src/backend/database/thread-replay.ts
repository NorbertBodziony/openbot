import { randomUUID } from "node:crypto";
import type { ConversationMessage, ConversationSnapshot } from "@openbot/contracts/ipc";
import { isAgentProvider, isConversationMessage } from "@openbot/contracts/ipc";
import { type DynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import type { ConversationQueries } from "./conversation-queries";
import type { DatabaseCore } from "./database-core";
import { databaseRows, decodeThreadAgentRow, objectValue, requiredEventRow } from "./database-rows";
import type { ProviderSession } from "./provider-sessions";
import type { StoredThreadSummary } from "./thread-summaries";

export interface ThreadReplayOptions {
  core: DatabaseCore;
  conversations: ConversationQueries;
}

/**
 * Rebuilds a thread's projections by replaying its orchestration events from the start.
 *
 * Owns the recovery path taken when a projection is missing or stale: messages, turns, provider
 * session links, summaries and attachment projections are all reconstructed from the event log,
 * then read back through the conversation queries. This is the one place that opens an
 * unconditional transaction of its own, because the replay must be all-or-nothing and the
 * dispatches nested inside it must join it rather than commit piecemeal. The class never imports
 * the facade.
 */
export class ThreadReplay {
  readonly #core: DatabaseCore;
  readonly #conversations: ConversationQueries;

  constructor(options: ThreadReplayOptions) {
    this.#core = options.core;
    this.#conversations = options.conversations;
  }

  rebuildThreadProjection(threadId: string): ConversationSnapshot {
    const db = this.#core.connection;
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
      // SQLite auto-rolls back on some failures (a full disk, a statement-level abort). An
      // unguarded ROLLBACK then throws "cannot rollback - no transaction is active" and replaces
      // the original error, so the user is told about the rollback instead of the full disk.
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
    return this.#conversations.readConversation(thread.agent_id, threadId);
  }
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
  // Snapshots written before the bot-to-agent rename spell the id `botId`, and a database restored from
  // the user's own file copy still carries them however far the migrations have run. Rejecting one here
  // makes `rebuildThreadProjection` throw and the conversation unrecoverable, so both spellings are read.
  const agentId = value?.agentId ?? value?.botId;
  if (
    !value ||
    !isString(agentId) ||
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
    agentId,
    threadId: value.threadId,
    activeTurnId: value.activeTurnId,
    revision: value.revision,
    messages,
  };
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
