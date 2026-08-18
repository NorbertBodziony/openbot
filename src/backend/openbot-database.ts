import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AgentProviderId,
  BotSummary,
  ConversationMessage,
  ConversationSnapshot,
} from "../shared/ipc";
import { isClaudeModel } from "../shared/ipc";

export interface OrchestrationEventInput {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: unknown;
  occurredAt?: string;
}

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

interface ReceiptRow {
  last_sequence: number;
  result_json: string;
}

interface MessageRow {
  message_json: string;
}

interface AgentRow {
  agent_json: string;
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

const SCHEMA_VERSION = 1;

/**
 * The local OpenBot event log and its read projections.
 *
 * A command appends events, changes projections, and stores its receipt in one
 * SQLite transaction. Providers never receive direct access to this database.
 */
export class OpenBotDatabase {
  readonly path: string;
  readonly #legacyBackupRoot: string;
  #db: DatabaseSync | null = null;

  constructor(readonly userDataPath: string) {
    this.path = join(userDataPath, "openbot.db");
    this.#legacyBackupRoot = join(userDataPath, "legacy-backup-v1");
  }

  async initialize(): Promise<void> {
    if (this.#db) return;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(this.path);
    try {
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA foreign_keys = ON");
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("PRAGMA synchronous = NORMAL");
      this.#db = db;
      this.#migrate();
      await chmod(this.path, 0o600);
    } catch (error) {
      db.close();
      this.#db = null;
      throw error;
    }
  }

  close(): void {
    this.#db?.close();
    this.#db = null;
  }

  get connection(): DatabaseSync {
    if (!this.#db) throw new Error("OpenBot database is not initialized.");
    return this.#db;
  }

  dispatch<T>(
    commandId: string,
    events: OrchestrationEventInput[],
    project: (db: DatabaseSync, sequences: number[]) => T,
  ): T {
    const db = this.connection;
    const receipt = db
      .prepare(
        "SELECT last_sequence, result_json FROM orchestration_command_receipts WHERE command_id = ?",
      )
      .get(commandId) as ReceiptRow | undefined;
    if (receipt) return JSON.parse(receipt.result_json) as T;

    db.exec("BEGIN IMMEDIATE");
    try {
      const sequences: number[] = [];
      const append = db.prepare(`
        INSERT INTO orchestration_events (
          event_id, command_id, aggregate_type, aggregate_id, event_type, occurred_at, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const event of events) {
        const result = append.run(
          randomUUID(),
          commandId,
          event.aggregateType,
          event.aggregateId,
          event.eventType,
          event.occurredAt ?? new Date().toISOString(),
          JSON.stringify(event.payload),
        );
        sequences.push(Number(result.lastInsertRowid));
      }
      const result = project(db, sequences);
      db.prepare(
        `INSERT INTO orchestration_command_receipts
          (command_id, accepted_at, first_sequence, last_sequence, result_json)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        commandId,
        new Date().toISOString(),
        sequences[0] ?? 0,
        sequences.at(-1) ?? 0,
        JSON.stringify(result ?? null),
      );
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  listAgents(): BotSummary[] {
    return (
      this.connection
        .prepare("SELECT agent_json FROM projection_agents ORDER BY sort_order, agent_id")
        .all() as unknown as AgentRow[]
    ).map((row) => JSON.parse(row.agent_json) as BotSummary);
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

  hardDeleteAgent(
    commandId: string,
    botId: string,
    threadId: string | null,
    remainingAgents: BotSummary[],
  ): void {
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
        const sensitiveFilter = threadId
          ? `(aggregate_id = ? OR aggregate_id = ? OR
              (aggregate_type = 'agents' AND aggregate_id = 'agents' AND sequence < ?))`
          : `(aggregate_id = ? OR
              (aggregate_type = 'agents' AND aggregate_id = 'agents' AND sequence < ?))`;
        const sensitiveParameters = threadId
          ? ([botId, threadId, sequence] as const)
          : ([botId, sequence] as const);
        db.prepare(
          `DELETE FROM orchestration_command_receipts WHERE command_id IN (
             SELECT DISTINCT command_id FROM orchestration_events WHERE ${sensitiveFilter}
           )`,
        ).run(...sensitiveParameters);
        db.prepare(`DELETE FROM orchestration_events WHERE ${sensitiveFilter}`).run(
          ...sensitiveParameters,
        );
        db.prepare("DELETE FROM projection_agents WHERE agent_id = ?").run(botId);
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
    const thread = this.connection
      .prepare(
        `SELECT active_turn_id, last_event_sequence
         FROM projection_threads WHERE thread_id = ? AND agent_id = ?`,
      )
      .get(threadId, botId) as
      | { active_turn_id: string | null; last_event_sequence: number }
      | undefined;
    const rows = this.connection
      .prepare(
        `SELECT message_json FROM projection_thread_messages
         WHERE thread_id = ? ORDER BY created_at, ordinal, message_id`,
      )
      .all(threadId) as unknown as MessageRow[];
    return {
      botId,
      threadId,
      activeTurnId: thread?.active_turn_id ?? null,
      revision: thread?.last_event_sequence ?? 0,
      messages: rows.map((row) => JSON.parse(row.message_json) as ConversationMessage),
    };
  }

  persistConversation(
    snapshot: ConversationSnapshot,
    eventType: string,
    payload: unknown = {},
    commandId = `conversation:${eventType}:${randomUUID()}`,
  ): ConversationSnapshot {
    if (!snapshot.threadId) return structuredClone(snapshot);
    return this.dispatch(
      commandId,
      [
        {
          aggregateType: "thread",
          aggregateId: snapshot.threadId,
          eventType,
          payload: { detail: payload, snapshot },
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
          `).run(
            snapshot.activeTurnId,
            snapshot.threadId,
            snapshot.threadId,
            new Date().toISOString(),
            sequence,
          );
        }
        if (
          [
            "turn.completed",
            "turn.reconciled-after-restart",
            "turn.interrupted-by-restart",
          ].includes(eventType) &&
          typeof payload === "object" &&
          payload !== null &&
          "turnId" in payload &&
          typeof payload.turnId === "string"
        ) {
          const status =
            "status" in payload && typeof payload.status === "string"
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
        return { ...snapshot, revision: sequence };
      },
    );
  }

  activeProviderSession(threadId: string, provider: AgentProviderId): ProviderSession | null {
    const row = this.connection
      .prepare(
        `SELECT id, thread_id, provider, external_session_id, model, effort, state,
                created_at, updated_at, resume_cursor
         FROM projection_provider_sessions
         WHERE thread_id = ? AND provider = ? AND state = 'active'
         ORDER BY created_at DESC, last_event_sequence DESC LIMIT 1`,
      )
      .get(threadId, provider) as SessionRow | undefined;
    return row ? toProviderSession(row) : null;
  }

  listProviderSessions(threadId: string): ProviderSession[] {
    return (
      this.connection
        .prepare(
          `SELECT id, thread_id, provider, external_session_id, model, effort, state,
                  created_at, updated_at, resume_cursor
           FROM projection_provider_sessions
           WHERE thread_id = ?
           ORDER BY created_at, last_event_sequence`,
        )
        .all(threadId) as unknown as SessionRow[]
    ).map(toProviderSession);
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
    const active = this.listProviderSessions(threadId).filter(
      (session) => session.state === "active",
    );
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

  updateProviderSessionConfig(
    sessionId: string,
    threadId: string,
    model: string,
    effort: string,
  ): void {
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
        `).run(
          summary.id,
          threadId,
          throughMessageId,
          text,
          estimatedTokens,
          summary.createdAt,
          sequences[0],
        );
        return summary;
      },
    );
  }

  latestThreadSummary(threadId: string): StoredThreadSummary | null {
    const row = this.connection
      .prepare(
        `SELECT summary_id, thread_id, through_message_id, summary_text, estimated_tokens, created_at
         FROM projection_thread_summaries WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(threadId) as
      | {
          summary_id: string;
          thread_id: string;
          through_message_id: string | null;
          summary_text: string;
          estimated_tokens: number;
          created_at: string;
        }
      | undefined;
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
    const events = db
      .prepare(
        `SELECT sequence, event_type, occurred_at, payload_json
         FROM orchestration_events
         WHERE aggregate_type = 'thread' AND aggregate_id = ? ORDER BY sequence`,
      )
      .all(threadId) as Array<{
      sequence: number;
      event_type: string;
      occurred_at: string;
      payload_json: string;
    }>;
    const thread = db
      .prepare("SELECT agent_id FROM projection_threads WHERE thread_id = ?")
      .get(threadId) as { agent_id: string } | undefined;
    if (!thread) throw new Error(`Unknown OpenBot thread: ${threadId}`);

    let latest: ConversationSnapshot | null = null;
    let latestSequence = 0;
    const sessions = new Map<string, ProviderSession & { sequence: number }>();
    const summaries: Array<StoredThreadSummary & { sequence: number }> = [];
    const turnSessions = new Map<string, string | null>();
    for (const event of events) {
      const payload = JSON.parse(event.payload_json) as unknown;
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
          if (typeof id === "string") {
            const session = sessions.get(id);
            if (session) session.state = "inactive";
          }
        }
      } else if (event.event_type === "provider-session.config-updated") {
        const session =
          typeof record?.sessionId === "string" ? sessions.get(record.sessionId) : null;
        if (session) {
          if (typeof record?.model === "string") session.model = record.model;
          if (typeof record?.effort === "string") session.effort = record.effort;
          session.sequence = event.sequence;
        }
      } else if (event.event_type === "thread.summary-created") {
        const summary = summaryValue(record);
        if (summary) summaries.push({ ...summary, sequence: event.sequence });
      }
      const snapshot = conversationSnapshotValue(objectValue(record?.snapshot));
      if (snapshot) {
        latest = snapshot;
        latestSequence = event.sequence;
        if (snapshot.activeTurnId && !turnSessions.has(snapshot.activeTurnId)) {
          const activeSession = [...sessions.values()].find(
            (session) => session.state === "active",
          );
          turnSessions.set(snapshot.activeTurnId, activeSession?.id ?? null);
        }
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
      db.prepare(
        "DELETE FROM projection_attachments WHERE owner_kind = 'thread-message' AND owner_id LIKE ?",
      ).run(`${threadId}:%`);
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
        activityInsert.run(
          randomUUID(),
          threadId,
          event.event_type,
          event.payload_json,
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
    state: unknown,
    eventType: string,
    fileDeletions: string[] = [],
    rebaseHistory = false,
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
        if (rebaseHistory) {
          db.prepare(
            `DELETE FROM orchestration_command_receipts WHERE command_id IN (
               SELECT DISTINCT command_id FROM orchestration_events
               WHERE aggregate_type = 'mailbox' AND aggregate_id = 'mailbox' AND sequence < ?
             )`,
          ).run(sequence);
          db.prepare(
            `DELETE FROM orchestration_events
             WHERE aggregate_type = 'mailbox' AND aggregate_id = 'mailbox' AND sequence < ?`,
          ).run(sequence);
        }
        const value = state as {
          messages: Array<Record<string, unknown>>;
          deliveries: Array<Record<string, unknown>>;
          drafts: Array<Record<string, unknown>>;
          pausedBotIds: string[];
          idempotency: Record<string, string>;
          reactions: Array<Record<string, unknown>>;
        };
        db.exec("DELETE FROM projection_deliveries");
        db.exec("DELETE FROM projection_mailbox_messages");
        db.exec("DELETE FROM projection_queue_state");
        db.exec("DELETE FROM projection_reactions");
        db.exec(
          "DELETE FROM projection_attachments WHERE owner_kind IN ('mailbox-message', 'draft')",
        );
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
          const sender = message.sender as { kind: string; botId?: string };
          messageInsert.run(
            String(message.id),
            sender.kind,
            sender.botId ?? null,
            String(message.text),
            typeof message.replyToMessageId === "string" ? message.replyToMessageId : null,
            String(message.createdAt),
            JSON.stringify(message),
            sequence,
          );
          for (const attachment of (message.attachments ?? []) as Array<Record<string, unknown>>) {
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
            typeof delivery.turnId === "string" ? delivery.turnId : null,
            typeof delivery.error === "string" ? delivery.error : null,
            String(delivery.createdAt),
            JSON.stringify(delivery),
            sequence,
          );
        }
        const queueInsert = db.prepare(`
          INSERT INTO projection_queue_state
            (agent_id, paused, metadata_json, last_event_sequence) VALUES (?, ?, ?, ?)
        `);
        queueInsert.run(
          "__mailbox__",
          0,
          JSON.stringify({ idempotency: value.idempotency }),
          sequence,
        );
        for (const botId of value.pausedBotIds) queueInsert.run(botId, 1, "{}", sequence);
        const reactionInsert = db.prepare(`
          INSERT INTO projection_reactions
            (agent_id, message_id, emoji, updated_at, last_event_sequence) VALUES (?, ?, ?, ?, ?)
        `);
        for (const reaction of value.reactions) {
          reactionInsert.run(
            String(reaction.botId),
            String(reaction.messageId),
            String(reaction.emoji),
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
    return this.connection
      .prepare("SELECT id, path FROM file_deletion_outbox ORDER BY created_at")
      .all() as Array<{ id: string; path: string }>;
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
    const marker = db
      .prepare("SELECT metadata_json FROM projection_queue_state WHERE agent_id = '__mailbox__'")
      .get() as { metadata_json: string } | undefined;
    if (!marker) return null;
    const metadata = JSON.parse(marker.metadata_json) as { idempotency?: Record<string, string> };
    const messages = (
      db
        .prepare(
          "SELECT message_json FROM projection_mailbox_messages ORDER BY created_at, message_id",
        )
        .all() as Array<{ message_json: string }>
    ).map((row) => JSON.parse(row.message_json));
    const deliveries = (
      db
        .prepare("SELECT delivery_json FROM projection_deliveries ORDER BY created_at, delivery_id")
        .all() as Array<{ delivery_json: string }>
    ).map((row) => JSON.parse(row.delivery_json));
    const drafts = (
      db
        .prepare("SELECT metadata_json FROM projection_attachments WHERE owner_kind = 'draft'")
        .all() as Array<{ metadata_json: string }>
    ).map((row) => JSON.parse(row.metadata_json));
    const pausedBotIds = (
      db.prepare("SELECT agent_id FROM projection_queue_state WHERE paused = 1").all() as Array<{
        agent_id: string;
      }>
    ).map((row) => row.agent_id);
    const reactions = (
      db
        .prepare("SELECT agent_id, message_id, emoji, updated_at FROM projection_reactions")
        .all() as Array<{
        agent_id: string;
        message_id: string;
        emoji: string;
        updated_at: string;
      }>
    ).map((row) => ({
      botId: row.agent_id,
      messageId: row.message_id,
      emoji: row.emoji,
      updatedAt: row.updated_at,
    }));
    return {
      version: 1,
      messages,
      deliveries,
      drafts,
      pausedBotIds,
      idempotency: metadata.idempotency ?? {},
      reactions,
    };
  }

  async backupLegacyFile(path: string): Promise<void> {
    try {
      await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await mkdir(this.#legacyBackupRoot, { recursive: true, mode: 0o700 });
    const target = join(this.#legacyBackupRoot, basename(path));
    try {
      await copyFile(path, target, 1);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await chmod(target, 0o600);
  }

  hasAggregateEvents(aggregateType: string, aggregateId: string): boolean {
    return Boolean(
      this.connection
        .prepare(
          "SELECT 1 FROM orchestration_events WHERE aggregate_type = ? AND aggregate_id = ? LIMIT 1",
        )
        .get(aggregateType, aggregateId),
    );
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

  #migrate(): void {
    const db = this.connection;
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS orchestration_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        command_id TEXT NOT NULL,
        aggregate_type TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK(json_valid(payload_json))
      );
      CREATE INDEX IF NOT EXISTS orchestration_events_aggregate
        ON orchestration_events(aggregate_type, aggregate_id, sequence);
      CREATE TABLE IF NOT EXISTS orchestration_command_receipts (
        command_id TEXT PRIMARY KEY,
        accepted_at TEXT NOT NULL,
        first_sequence INTEGER NOT NULL,
        last_sequence INTEGER NOT NULL,
        result_json TEXT NOT NULL CHECK(json_valid(result_json))
      );
      CREATE TABLE IF NOT EXISTS projection_threads (
        thread_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        title TEXT NOT NULL,
        active_turn_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_event_sequence INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS projection_agents (
        agent_id TEXT PRIMARY KEY,
        thread_id TEXT,
        model TEXT NOT NULL,
        updated_at TEXT,
        sort_order INTEGER NOT NULL,
        agent_json TEXT NOT NULL CHECK(json_valid(agent_json)),
        last_event_sequence INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS projection_provider_sessions (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
        provider TEXT NOT NULL CHECK(provider IN ('codex', 'claude')),
        external_session_id TEXT NOT NULL,
        model TEXT NOT NULL,
        effort TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('active', 'inactive', 'failed')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resume_cursor TEXT,
        last_event_sequence INTEGER NOT NULL,
        UNIQUE(provider, external_session_id)
      );
      CREATE INDEX IF NOT EXISTS provider_sessions_thread
        ON projection_provider_sessions(thread_id, provider, state);
      CREATE TABLE IF NOT EXISTS projection_turns (
        turn_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
        provider_session_id TEXT REFERENCES projection_provider_sessions(id) ON DELETE SET NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        last_event_sequence INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS projection_thread_messages (
        thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
        message_id TEXT NOT NULL,
        turn_id TEXT,
        author TEXT NOT NULL,
        status TEXT NOT NULL,
        item_type TEXT,
        created_at TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        message_json TEXT NOT NULL CHECK(json_valid(message_json)),
        last_event_sequence INTEGER NOT NULL,
        PRIMARY KEY(thread_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS thread_messages_order
        ON projection_thread_messages(thread_id, created_at, ordinal);
      CREATE TABLE IF NOT EXISTS projection_thread_activities (
        activity_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
        turn_id TEXT,
        activity_type TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
        created_at TEXT NOT NULL,
        last_event_sequence INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS projection_mailbox_messages (
        message_id TEXT PRIMARY KEY,
        sender_kind TEXT NOT NULL,
        sender_agent_id TEXT,
        text TEXT NOT NULL,
        reply_to_message_id TEXT,
        created_at TEXT NOT NULL,
        message_json TEXT NOT NULL CHECK(json_valid(message_json)),
        last_event_sequence INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS projection_deliveries (
        delivery_id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL REFERENCES projection_mailbox_messages(message_id) ON DELETE CASCADE,
        recipient_agent_id TEXT NOT NULL,
        status TEXT NOT NULL,
        turn_id TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        delivery_json TEXT NOT NULL CHECK(json_valid(delivery_json)),
        last_event_sequence INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS projection_queue_state (
        agent_id TEXT PRIMARY KEY,
        paused INTEGER NOT NULL CHECK(paused IN (0, 1)),
        metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
        last_event_sequence INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS projection_reactions (
        agent_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        emoji TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_event_sequence INTEGER NOT NULL,
        PRIMARY KEY(agent_id, message_id)
      );
      CREATE TABLE IF NOT EXISTS projection_attachments (
        attachment_id TEXT PRIMARY KEY,
        owner_kind TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
        created_at TEXT NOT NULL,
        last_event_sequence INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS projection_thread_summaries (
        summary_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
        through_message_id TEXT,
        summary_text TEXT NOT NULL,
        estimated_tokens INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        last_event_sequence INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS file_deletion_outbox (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      );
    `);
    const applied = db
      .prepare("SELECT version FROM schema_migrations WHERE version = ?")
      .get(SCHEMA_VERSION);
    if (!applied) {
      db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(
        SCHEMA_VERSION,
        new Date().toISOString(),
      );
    }
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

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function providerSessionValue(value: Record<string, unknown> | null): ProviderSession | null {
  if (
    !value ||
    typeof value.id !== "string" ||
    typeof value.threadId !== "string" ||
    (value.provider !== "codex" && value.provider !== "claude") ||
    typeof value.externalSessionId !== "string" ||
    typeof value.model !== "string" ||
    typeof value.effort !== "string" ||
    (value.state !== "active" && value.state !== "inactive" && value.state !== "failed") ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    (typeof value.resumeCursor !== "string" && value.resumeCursor !== null)
  ) {
    return null;
  }
  return value as unknown as ProviderSession;
}

function summaryValue(value: Record<string, unknown> | null): StoredThreadSummary | null {
  if (
    !value ||
    typeof value.id !== "string" ||
    typeof value.threadId !== "string" ||
    (typeof value.throughMessageId !== "string" && value.throughMessageId !== null) ||
    typeof value.text !== "string" ||
    typeof value.estimatedTokens !== "number" ||
    typeof value.createdAt !== "string"
  ) {
    return null;
  }
  return value as unknown as StoredThreadSummary;
}

function conversationSnapshotValue(
  value: Record<string, unknown> | null,
): ConversationSnapshot | null {
  if (
    !value ||
    typeof value.botId !== "string" ||
    (typeof value.threadId !== "string" && value.threadId !== null) ||
    (typeof value.activeTurnId !== "string" && value.activeTurnId !== null) ||
    typeof value.revision !== "number" ||
    !Array.isArray(value.messages)
  ) {
    return null;
  }
  return value as unknown as ConversationSnapshot;
}

export function providerForStoredModel(model: BotSummary["model"]): AgentProviderId {
  return isClaudeModel(model) ? "claude" : "codex";
}

export function stableThreadId(botId: string): string {
  return `openbot-thread-${botId}`;
}
