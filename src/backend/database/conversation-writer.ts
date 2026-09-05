import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ConversationMessage, ConversationSnapshot } from "@openbot/contracts/ipc";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import type { AgentRoster } from "./agent-roster";
import { type DatabaseCore, deleteOrphanReceipts } from "./database-core";
import {
  databaseRow,
  databaseRows,
  optionalStringColumn,
  requiredNumberColumn,
  requiredStringColumn,
} from "./database-rows";

export interface ConversationWriterOptions {
  core: DatabaseCore;
  roster: AgentRoster;
}

/**
 * The write side of a thread's conversation: a whole snapshot, or one appended message.
 *
 * Owns `projection_thread_messages` and `projection_thread_activities`, and compacts the thread
 * aggregate so the log keeps only the newest full snapshot. Both entry points run inside a single
 * dispatch, so a caller already in a transaction has these writes pulled into it, and neither opens
 * a transaction of its own. The agent lookup and the thread projection row come from the roster.
 * The class never imports the facade.
 */
export class ConversationWriter {
  readonly #core: DatabaseCore;
  readonly #roster: AgentRoster;

  constructor(options: ConversationWriterOptions) {
    this.#core = options.core;
    this.#roster = options.roster;
  }

  persistConversation(
    snapshot: ConversationSnapshot,
    eventType: string,
    payload: unknown = {},
    commandId = `conversation:${eventType}:${randomUUID()}`,
  ): ConversationSnapshot {
    if (!snapshot.threadId) return structuredClone(snapshot);
    const threadId = snapshot.threadId;
    const recovery = conversationRecoveryState(this.#core.connection, threadId, snapshot.activeTurnId);
    const result = this.#core.dispatch(
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
        const agent = this.#roster.listAgents().find((candidate) => candidate.id === snapshot.agentId);
        if (!agent) throw new Error(`Unknown agent for conversation: ${snapshot.agentId}`);
        this.#roster.ensureThreadProjection(db, agent, sequence);
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
    agentId: string;
    threadId: string;
    activeTurnId: string | null;
    message: ConversationMessage;
    eventType: string;
    detail?: unknown;
    commandId?: string;
  }): number {
    const result = this.#core.dispatch(
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
        const agent = this.#roster.listAgents().find((candidate) => candidate.id === input.agentId);
        if (!agent || agent.threadId !== input.threadId) {
          throw new Error(`Unknown agent thread for conversation append: ${input.agentId}`);
        }
        this.#roster.ensureThreadProjection(db, agent, sequence);
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
