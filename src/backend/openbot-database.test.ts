// @vitest-environment node

import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BotSummary, ConversationSnapshot } from "@openbot/contracts/ipc";
import { isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import { afterEach, describe, expect, it } from "vitest";
import { OpenBotDatabase } from "./openbot-database";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("OpenBotDatabase", () => {
  it("configures a private WAL database with every required projection", async () => {
    const database = await createDatabase();
    const tables = database.connection
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => {
        if (!isDynamicRecord(row) || !isString(row.name)) throw new Error("Invalid table row.");
        return row.name;
      });

    expect(tables).toEqual(
      expect.arrayContaining([
        "schema_migrations",
        "orchestration_events",
        "orchestration_command_receipts",
        "projection_agents",
        "projection_threads",
        "projection_provider_sessions",
        "projection_turns",
        "projection_thread_messages",
        "projection_thread_activities",
        "projection_mailbox_messages",
        "projection_deliveries",
        "projection_queue_state",
        "projection_reactions",
        "projection_attachments",
        "projection_thread_summaries",
        "projection_direct_threads",
        "projection_direct_messages",
        "projection_direct_reads",
        "file_deletion_outbox",
      ]),
    );
    expect(database.connection.prepare("PRAGMA journal_mode").get()).toMatchObject({
      journal_mode: "wal",
    });
    expect((await stat(database.path)).mode & 0o777).toBe(0o600);
    database.close();
  });

  it("rolls back events, projections, and receipts as one transaction", async () => {
    const database = await createDatabase();
    expect(() =>
      database.dispatch(
        "broken-command",
        [
          {
            aggregateType: "test",
            aggregateId: "one",
            eventType: "test.started",
            payload: {},
          },
        ],
        () => {
          throw new Error("projection failed");
        },
      ),
    ).toThrow("projection failed");

    expect(eventCount(database)).toBe(0);
    expect(
      database.connection
        .prepare("SELECT COUNT(*) AS count FROM orchestration_command_receipts WHERE command_id = ?")
        .get("broken-command"),
    ).toMatchObject({ count: 0 });
    database.close();
  });

  it("returns the durable command receipt without running a command twice", async () => {
    const database = await createDatabase();
    let projections = 0;
    const run = () =>
      database.dispatch(
        "stable-command",
        [
          {
            aggregateType: "test",
            aggregateId: "one",
            eventType: "test.completed",
            payload: { value: 42 },
          },
        ],
        () => ({ projections: ++projections }),
      );

    expect(run()).toEqual({ projections: 1 });
    expect(run()).toEqual({ projections: 1 });
    expect(projections).toBe(1);
    expect(eventCount(database)).toBe(1);
    database.close();
  });

  it("reads a completed conversation after a database restart without a provider", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-db-restart-"));
    roots.push(root);
    const database = new OpenBotDatabase(root);
    await database.initialize();
    const bot = testBot();
    database.replaceAgents("agents-import", [bot], "agents.imported");
    const snapshot: ConversationSnapshot = {
      botId: bot.id,
      threadId: bot.threadId,
      activeTurnId: null,
      revision: 0,
      messages: [
        {
          id: "user-1",
          author: "user",
          text: "Return 42",
          createdAt: "2026-08-18T10:00:00.000Z",
          status: "completed",
        },
        {
          id: "assistant-1",
          turnId: "turn-1",
          author: "assistant",
          text: "42",
          createdAt: "2026-08-18T10:00:01.000Z",
          status: "completed",
        },
      ],
    };
    const saved = database.persistConversation(snapshot, "turn.completed", {
      turnId: "turn-1",
      status: "completed",
    });
    database.connection.prepare("DELETE FROM projection_thread_messages WHERE thread_id = ?").run(bot.threadId);
    expect(database.readConversation(bot.id, bot.threadId).messages).toEqual([]);
    if (!bot.threadId) throw new Error("The test bot has no thread.");
    expect(database.rebuildThreadProjection(bot.threadId).messages).toMatchObject([
      { text: "Return 42", status: "completed" },
      { text: "42", status: "completed" },
    ]);
    database.close();

    const restored = new OpenBotDatabase(root);
    await restored.initialize();
    expect(restored.readConversation(bot.id, bot.threadId)).toMatchObject({
      revision: saved.revision,
      messages: [
        { text: "Return 42", status: "completed" },
        { text: "42", status: "completed" },
      ],
    });
    restored.close();
  });

  it("pages and searches a 10,000-message conversation without gaps", async () => {
    const database = await createDatabase();
    const bot = testBot();
    database.replaceAgents("agents-large-history", [bot], "agents.imported");
    const messages = Array.from({ length: 10_000 }, (_, index) => ({
      id: `message-${index.toString().padStart(5, "0")}`,
      author: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: index === 1234 ? "A unique pagination needle" : `Message ${index}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, index)).toISOString(),
      status: "completed" as const,
    }));
    database.persistConversation(
      { botId: bot.id, threadId: bot.threadId, activeTurnId: null, revision: 0, messages },
      "conversation.large-history",
    );

    const latest = database.readConversationPage(bot.id, bot.threadId, { type: "latest" }, 50);
    expect(latest.messages).toHaveLength(50);
    expect(latest.messages[0]?.id).toBe("message-09950");
    expect(latest.messages.at(-1)?.id).toBe("message-09999");
    expect(latest.pageInfo.hasOlder).toBe(true);

    const seen = new Set(latest.messages.map((message) => message.id));
    let page = latest;
    while (page.pageInfo.olderCursor) {
      page = database.readConversationPage(
        bot.id,
        bot.threadId,
        { type: "before", cursor: page.pageInfo.olderCursor },
        50,
      );
      for (const message of page.messages) expect(seen.has(message.id)).toBe(false);
      page.messages.forEach((message) => {
        seen.add(message.id);
      });
    }
    expect(seen.size).toBe(10_000);

    const around = database.readConversationPage(
      bot.id,
      bot.threadId,
      { type: "around", messageId: "message-05000" },
      50,
    );
    expect(around.messages).toHaveLength(50);
    expect(around.messages.some((message) => message.id === "message-05000")).toBe(true);
    expect(database.readConversationPage(bot.id, bot.threadId, { type: "latest" }, 1_000).messages).toHaveLength(100);

    const search = database.searchConversationMessages("pagination needle", bot.id, undefined, 100);
    expect(search.total).toBe(1);
    expect(search.results[0]?.message.id).toBe("message-01234");
    database.close();
  });

  it("keeps one full conversation snapshot and a small idempotency receipt", async () => {
    const database = await createDatabase();
    const bot = testBot();
    database.replaceAgents("agents-import", [bot], "agents.imported");
    const snapshot = conversationSnapshot(bot, "x".repeat(40_000));

    const first = database.persistConversation(snapshot, "response.delta-flushed", {}, "stable-conversation");
    expect(database.persistConversation(snapshot, "response.delta-flushed", {}, "stable-conversation")).toEqual(first);
    for (let index = 0; index < 100; index += 1) {
      database.persistConversation(snapshot, "response.delta-flushed");
    }

    expect(snapshotEventCount(database, bot.threadId)).toBe(1);
    expect(
      database.connection
        .prepare(
          `SELECT COUNT(*) AS count, SUM(LENGTH(result_json)) AS bytes
           FROM orchestration_command_receipts WHERE command_id LIKE 'conversation:%'`,
        )
        .get(),
    ).toMatchObject({ count: 1, bytes: expect.any(Number) });
    const receipt = database.connection
      .prepare(
        `SELECT result_json FROM orchestration_command_receipts
         WHERE command_id LIKE 'conversation:%' LIMIT 1`,
      )
      .get();
    expect(receipt).toMatchObject({ result_json: expect.stringMatching(/^\{"revision":\d+\}$/) });
    database.close();
  });

  it("rebuilds provider turn links, summaries, and attachment projections from compact history", async () => {
    const database = await createDatabase();
    const bot = testBot();
    database.replaceAgents("agents-import", [bot], "agents.imported");
    if (!bot.threadId) throw new Error("The test bot has no thread.");
    const session = database.bindProviderSession({
      threadId: bot.threadId,
      provider: "codex",
      externalSessionId: "provider-thread-1",
      model: bot.model,
      effort: bot.reasoningEffort,
    });
    const running = conversationSnapshot(bot, "Working");
    running.activeTurnId = "turn-1";
    running.messages[0] = {
      ...running.messages[0],
      turnId: "turn-1",
      status: "streaming",
      attachments: [
        {
          id: "attachment-1",
          name: "report.csv",
          size: 12,
          kind: "file",
          mimeType: "text/csv",
          previewKind: "text",
          previewUrl: null,
        },
      ],
    };
    database.persistConversation(running, "response.delta-flushed");
    const completed = structuredClone(running);
    completed.activeTurnId = null;
    completed.messages[0].status = "completed";
    database.persistConversation(completed, "turn.completed", { turnId: "turn-1", status: "completed" });
    database.saveThreadSummary(bot.threadId, completed.messages[0].id, "Saved context", 3);

    expect(snapshotEventCount(database, bot.threadId)).toBe(1);
    database.rebuildThreadProjection(bot.threadId);

    expect(
      database.connection.prepare("SELECT provider_session_id FROM projection_turns WHERE turn_id = 'turn-1'").get(),
    ).toMatchObject({ provider_session_id: session.id });
    expect(
      database.connection
        .prepare("SELECT name FROM projection_attachments WHERE attachment_id = ?")
        .get(`${bot.threadId}:assistant-1:attachment-1`),
    ).toMatchObject({ name: "report.csv" });
    expect(
      database.connection
        .prepare("SELECT payload_json FROM projection_thread_activities WHERE activity_type = 'turn.completed'")
        .get(),
    ).toEqual({ payload_json: '{"turnId":"turn-1","status":"completed"}' });
    expect(database.latestThreadSummary(bot.threadId)).toMatchObject({ text: "Saved context" });
    database.close();
  });

  it("keeps only the latest full mailbox state", async () => {
    const database = await createDatabase();
    const state = {
      messages: [],
      deliveries: [],
      drafts: [],
      generatedAttachments: [],
      pausedBotIds: [],
      idempotency: {},
      reactions: [],
    };
    database.replaceMailboxState("mailbox:first", state, "mailbox.updated");
    database.replaceMailboxState(
      "mailbox:second",
      { ...state, idempotency: { request: "message-1" } },
      "mailbox.updated",
    );

    expect(
      database.connection
        .prepare(
          `SELECT COUNT(*) AS count FROM orchestration_events
           WHERE aggregate_type = 'mailbox' AND aggregate_id = 'mailbox'`,
        )
        .get(),
    ).toMatchObject({ count: 1 });
    expect(
      database.connection
        .prepare("SELECT command_id FROM orchestration_command_receipts WHERE command_id LIKE 'mailbox:%'")
        .all(),
    ).toEqual([{ command_id: "mailbox:second" }]);
    database.close();
  });

  it("migrates version 3 history, preserves the current chat, and reclaims disk space", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-db-v3-"));
    roots.push(root);
    const database = new OpenBotDatabase(root);
    await database.initialize();
    const bot = testBot();
    database.replaceAgents("agents-import", [bot], "agents.imported");
    const snapshot = conversationSnapshot(bot, "x".repeat(40_000));
    database.persistConversation(snapshot, "conversation.snapshot-updated");
    database.close();

    const legacy = new DatabaseSync(database.path);
    legacy.exec("PRAGMA journal_mode = WAL");
    legacy.prepare("DELETE FROM schema_migrations WHERE version = 4").run();
    legacy
      .prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (3, ?)")
      .run("2026-08-20T10:00:00.000Z");
    const insertEvent = legacy.prepare(`
      INSERT INTO orchestration_events (
        event_id, command_id, aggregate_type, aggregate_id, event_type, occurred_at, payload_json
      ) VALUES (?, ?, 'thread', ?, 'provider-history.backfilled', ?, ?)
    `);
    const insertReceipt = legacy.prepare(`
      INSERT INTO orchestration_command_receipts (
        command_id, accepted_at, first_sequence, last_sequence, result_json
      ) VALUES (?, ?, ?, ?, ?)
    `);
    for (let index = 0; index < 100; index += 1) {
      const commandId = `legacy-conversation-${index}`;
      const result = insertEvent.run(
        randomUUID(),
        commandId,
        bot.threadId,
        "2026-08-20T10:00:00.000Z",
        JSON.stringify({ detail: {}, snapshot }),
      );
      const sequence = Number(result.lastInsertRowid);
      insertReceipt.run(
        commandId,
        "2026-08-20T10:00:00.000Z",
        sequence,
        sequence,
        JSON.stringify({ ...snapshot, revision: sequence }),
      );
    }
    legacy.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    legacy.close();
    const sizeBefore = (await stat(database.path)).size;

    const migrated = new OpenBotDatabase(root);
    await migrated.initialize();
    const sizeAfter = (await stat(database.path)).size;
    expect(sizeAfter).toBeLessThan(sizeBefore / 2);
    expect(snapshotEventCount(migrated, bot.threadId)).toBe(1);
    expect(migrated.readConversation(bot.id, bot.threadId).messages[0]?.text).toHaveLength(40_000);
    expect(migrated.connection.prepare("PRAGMA integrity_check").get()).toMatchObject({ integrity_check: "ok" });
    expect(migrated.connection.prepare("SELECT 1 AS applied FROM schema_migrations WHERE version = 4").get()).toEqual({
      applied: 1,
    });
    migrated.close();

    const reopened = new OpenBotDatabase(root);
    await reopened.initialize();
    expect(snapshotEventCount(reopened, bot.threadId)).toBe(1);
    reopened.close();
  });
});

async function createDatabase(): Promise<OpenBotDatabase> {
  const root = await mkdtemp(join(tmpdir(), "openbot-db-"));
  roots.push(root);
  const database = new OpenBotDatabase(root);
  await database.initialize();
  return database;
}

function testBot(): BotSummary {
  return {
    id: "chief",
    name: "Chief",
    title: "Coordinator",
    description: "",
    notifications: true,
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
    threadId: "openbot-thread-chief",
    workspacePath: "/tmp/openbot-chief",
    preview: "42",
    updatedAt: "2026-08-18T10:00:01.000Z",
    avatarSeed: "chief",
    avatarHue: null,
    avatarUrl: null,
  };
}

function eventCount(database: OpenBotDatabase): number {
  const row = database.connection.prepare("SELECT COUNT(*) AS count FROM orchestration_events").get();
  if (!isDynamicRecord(row) || !isNumber(row.count)) throw new Error("Invalid event count row.");
  return row.count;
}

function snapshotEventCount(database: OpenBotDatabase, threadId: string | null): number {
  if (!threadId) throw new Error("The test bot has no thread.");
  const row = database.connection
    .prepare(
      `SELECT COUNT(*) AS count FROM orchestration_events
       WHERE aggregate_type = 'thread' AND aggregate_id = ?
         AND json_type(payload_json, '$.snapshot') = 'object'`,
    )
    .get(threadId);
  if (!isDynamicRecord(row) || !isNumber(row.count)) throw new Error("Invalid snapshot count row.");
  return row.count;
}

function conversationSnapshot(bot: BotSummary, text: string): ConversationSnapshot {
  return {
    botId: bot.id,
    threadId: bot.threadId,
    activeTurnId: null,
    revision: 0,
    messages: [
      {
        id: "assistant-1",
        turnId: "turn-1",
        author: "assistant",
        text,
        createdAt: "2026-08-20T10:00:00.000Z",
        status: "completed",
      },
    ],
  };
}
