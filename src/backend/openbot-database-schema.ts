import type { DatabaseSync } from "node:sqlite";
import { type DynamicRecord, isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";

const SCHEMA_VERSION = 6;

const SCHEMA_SQL = `
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
  CREATE INDEX IF NOT EXISTS orchestration_events_command
    ON orchestration_events(command_id);
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
  CREATE TABLE IF NOT EXISTS projection_agent_memories (
    memory_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    text TEXT NOT NULL,
    normalized_text TEXT NOT NULL,
    origin TEXT NOT NULL CHECK(origin IN ('automatic', 'manual')),
    source_turn_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_event_sequence INTEGER NOT NULL,
    UNIQUE(agent_id, normalized_text)
  );
  CREATE INDEX IF NOT EXISTS agent_memories_agent
    ON projection_agent_memories(agent_id, updated_at DESC, memory_id);
  CREATE TABLE IF NOT EXISTS projection_agent_routines (
    routine_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    name TEXT NOT NULL,
    instruction TEXT NOT NULL,
    active INTEGER NOT NULL CHECK(active IN (0, 1)),
    timezone TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_event_sequence INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS agent_routines_agent
    ON projection_agent_routines(agent_id, updated_at DESC, routine_id);
  CREATE TABLE IF NOT EXISTS projection_routine_triggers (
    trigger_id TEXT PRIMARY KEY,
    routine_id TEXT NOT NULL REFERENCES projection_agent_routines(routine_id) ON DELETE CASCADE,
    schedule_json TEXT NOT NULL CHECK(json_valid(schedule_json)),
    next_run_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_event_sequence INTEGER NOT NULL,
    UNIQUE(routine_id)
  );
  CREATE INDEX IF NOT EXISTS routine_triggers_due
    ON projection_routine_triggers(next_run_at, routine_id);
  CREATE TABLE IF NOT EXISTS projection_routine_runs (
    run_id TEXT PRIMARY KEY,
    routine_id TEXT NOT NULL REFERENCES projection_agent_routines(routine_id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    trigger_id TEXT,
    run_kind TEXT NOT NULL CHECK(run_kind IN ('scheduled', 'manual')),
    scheduled_for TEXT NOT NULL,
    routine_name TEXT NOT NULL,
    instruction TEXT NOT NULL,
    delivery_id TEXT,
    status TEXT NOT NULL CHECK(status IN (
      'queued', 'running', 'needs-attention', 'succeeded', 'failed', 'interrupted', 'cancelled'
    )),
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_event_sequence INTEGER NOT NULL,
    UNIQUE(trigger_id, scheduled_for)
  );
  CREATE INDEX IF NOT EXISTS routine_runs_routine
    ON projection_routine_runs(routine_id, created_at DESC, run_id);
  CREATE UNIQUE INDEX IF NOT EXISTS routine_runs_delivery
    ON projection_routine_runs(delivery_id) WHERE delivery_id IS NOT NULL;
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
  CREATE INDEX IF NOT EXISTS thread_messages_page_order
    ON projection_thread_messages(thread_id, created_at, ordinal, message_id);
  CREATE TABLE IF NOT EXISTS projection_thread_reads (
    thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
    member_id TEXT NOT NULL,
    through_message_id TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(thread_id, member_id)
  );
  CREATE TABLE IF NOT EXISTS projection_thread_read_baselines (
    thread_id TEXT PRIMARY KEY REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
    through_message_id TEXT,
    initialized_at TEXT NOT NULL
  );
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
  CREATE TABLE IF NOT EXISTS projection_direct_threads (
    thread_id TEXT PRIMARY KEY,
    member_a_id TEXT NOT NULL,
    member_b_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_message_id TEXT,
    last_event_sequence INTEGER NOT NULL,
    UNIQUE(member_a_id, member_b_id)
  );
  CREATE INDEX IF NOT EXISTS direct_threads_member_a
    ON projection_direct_threads(member_a_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS direct_threads_member_b
    ON projection_direct_threads(member_b_id, updated_at DESC);
  CREATE TABLE IF NOT EXISTS projection_direct_messages (
    message_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES projection_direct_threads(thread_id) ON DELETE CASCADE,
    sender_member_id TEXT NOT NULL,
    recipient_member_id TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    message_json TEXT NOT NULL CHECK(json_valid(message_json)),
    last_event_sequence INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS direct_messages_thread
    ON projection_direct_messages(thread_id, last_event_sequence);
  CREATE TABLE IF NOT EXISTS projection_direct_reads (
    thread_id TEXT NOT NULL REFERENCES projection_direct_threads(thread_id) ON DELETE CASCADE,
    member_id TEXT NOT NULL,
    last_read_sequence INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(thread_id, member_id)
  );
  CREATE TABLE IF NOT EXISTS file_deletion_outbox (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
  );
`;

export function migrateOpenBotDatabase(db: DatabaseSync, appliedAt = new Date().toISOString()): void {
  db.exec(SCHEMA_SQL);
  const applied = db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(SCHEMA_VERSION);
  if (applied) return;
  const upgradingExistingDatabase = Boolean(db.prepare("SELECT 1 FROM schema_migrations LIMIT 1").get());

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `INSERT OR IGNORE INTO projection_thread_read_baselines (
         thread_id, through_message_id, initialized_at
       )
       SELECT thread.thread_id,
         (
           SELECT message.message_id
           FROM projection_thread_messages message
           WHERE message.thread_id = thread.thread_id
           ORDER BY message.created_at DESC, message.ordinal DESC, message.message_id DESC
           LIMIT 1
         ),
         ?
       FROM projection_threads thread`,
    ).run(appliedAt);
    db.prepare(
      `INSERT OR IGNORE INTO projection_direct_reads (
         thread_id, member_id, last_read_sequence, updated_at
       )
       SELECT thread_id, member_a_id, last_event_sequence, ?
       FROM projection_direct_threads`,
    ).run(appliedAt);
    db.prepare(
      `INSERT OR IGNORE INTO projection_direct_reads (
         thread_id, member_id, last_read_sequence, updated_at
       )
       SELECT thread_id, member_b_id, last_event_sequence, ?
       FROM projection_direct_threads`,
    ).run(appliedAt);
    compactConversationHistory(db);
    compactMailboxHistory(db);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  if (upgradingExistingDatabase) {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.exec("VACUUM");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }
  db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(SCHEMA_VERSION, appliedAt);
}

interface SnapshotEventRow {
  sequence: number;
  commandId: string;
  threadId: string;
  payload: DynamicRecord;
}

function compactConversationHistory(db: DatabaseSync): void {
  const latestByThread = new Map<string, SnapshotEventRow>();
  const events = db
    .prepare(
      `SELECT sequence, command_id, aggregate_id, payload_json
       FROM orchestration_events
       WHERE aggregate_type = 'thread'
       ORDER BY aggregate_id, sequence`,
    )
    .all();
  for (const value of events) {
    if (!isDynamicRecord(value)) continue;
    const sequence = value.sequence;
    const commandId = value.command_id;
    const threadId = value.aggregate_id;
    const payloadJson = value.payload_json;
    if (!isNumber(sequence) || !isString(commandId) || !isString(threadId) || !isString(payloadJson)) continue;
    const payload = JSON.parse(payloadJson);
    if (!isDynamicRecord(payload) || !isDynamicRecord(payload.snapshot)) continue;
    latestByThread.set(threadId, { sequence, commandId, threadId, payload });
  }

  const updateEvent = db.prepare("UPDATE orchestration_events SET payload_json = ? WHERE sequence = ?");
  const updateReceipt = db.prepare("UPDATE orchestration_command_receipts SET result_json = ? WHERE command_id = ?");
  const updateActivity = db.prepare(
    `UPDATE projection_thread_activities SET payload_json = ?
     WHERE thread_id = ? AND last_event_sequence = ?`,
  );
  const deleteActivities = db.prepare(
    `DELETE FROM projection_thread_activities
     WHERE thread_id = ? AND last_event_sequence IN (
       SELECT sequence FROM orchestration_events
       WHERE aggregate_type = 'thread' AND aggregate_id = ? AND sequence < ?
         AND json_type(payload_json, '$.snapshot') = 'object'
     )`,
  );
  const deleteEvents = db.prepare(
    `DELETE FROM orchestration_events
     WHERE aggregate_type = 'thread' AND aggregate_id = ? AND sequence < ?
       AND json_type(payload_json, '$.snapshot') = 'object'`,
  );
  for (const event of latestByThread.values()) {
    const activityDetail = event.payload.detail ?? {};
    const payload = {
      ...event.payload,
      recovery: {
        ...recordValue(event.payload.recovery),
        turnProviderSessionIds: turnProviderSessionIds(db, event.threadId),
      },
    };
    updateEvent.run(JSON.stringify(payload), event.sequence);
    updateReceipt.run(JSON.stringify({ revision: event.sequence }), event.commandId);
    updateActivity.run(JSON.stringify(activityDetail), event.threadId, event.sequence);
    deleteActivities.run(event.threadId, event.threadId, event.sequence);
    deleteEvents.run(event.threadId, event.sequence);
  }
  deleteOrphanReceipts(db);
}

function compactMailboxHistory(db: DatabaseSync): void {
  const value = db
    .prepare(
      `SELECT MAX(sequence) AS sequence FROM orchestration_events
       WHERE aggregate_type = 'mailbox' AND aggregate_id = 'mailbox'`,
    )
    .get();
  if (!isDynamicRecord(value) || !isNumber(value.sequence)) return;
  db.prepare(
    `DELETE FROM orchestration_events
     WHERE aggregate_type = 'mailbox' AND aggregate_id = 'mailbox' AND sequence < ?`,
  ).run(value.sequence);
  deleteOrphanReceipts(db);
}

function turnProviderSessionIds(db: DatabaseSync, threadId: string): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  const rows = db
    .prepare("SELECT turn_id, provider_session_id FROM projection_turns WHERE thread_id = ?")
    .all(threadId);
  for (const value of rows) {
    if (!isDynamicRecord(value) || !isString(value.turn_id)) continue;
    if (value.provider_session_id !== null && !isString(value.provider_session_id)) continue;
    result[value.turn_id] = value.provider_session_id;
  }
  return result;
}

function deleteOrphanReceipts(db: DatabaseSync): void {
  db.exec(`DELETE FROM orchestration_command_receipts
    WHERE NOT EXISTS (
      SELECT 1 FROM orchestration_events
      WHERE orchestration_events.command_id = orchestration_command_receipts.command_id
    )`);
}

function recordValue(value: unknown): DynamicRecord {
  return isDynamicRecord(value) ? value : {};
}
