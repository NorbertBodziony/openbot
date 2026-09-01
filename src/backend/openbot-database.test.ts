// @vitest-environment node

import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BotSummary, ConversationMessage, ConversationSnapshot } from "@openbot/contracts/ipc";
import {
  hostedSiteConversationEventItemType,
  hostedSiteConversationEventText,
  routineConversationEventItemType,
  routineRunConversationEventItemType,
} from "@openbot/contracts/ipc";
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
        "projection_agent_memories",
        "projection_agent_routines",
        "projection_routine_triggers",
        "projection_routine_runs",
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
    expect(database.connection.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([
      { version: 8 },
      { version: 9 },
      { version: 10 },
      { version: 11 },
    ]);
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

  it("keeps a terminal hosted-site outcome pending until its marker command is durable", async () => {
    const database = await createDatabase();
    const pending = {
      botId: "chief",
      threadId: "thread-chief",
      turnId: "turn-1",
      operationId: "operation-1",
      action: "publish" as const,
      status: "succeeded" as const,
      details: {
        siteId: "site-1",
        title: "Launch page",
        hostname: "launch-page-23456789ab.openbot.site",
        url: "https://launch-page-23456789ab.openbot.site",
      },
      markerCommandId: "hosted-site-event:chief:operation-1:succeeded",
      createdAt: "2026-09-01T12:00:00.000Z",
    };

    database.recordPendingHostedSiteTerminalEvent(pending);
    database.recordPendingHostedSiteTerminalEvent(pending);
    expect(database.pendingHostedSiteTerminalEvents()).toEqual([pending]);
    expect(
      database.connection
        .prepare(
          "SELECT aggregate_type, aggregate_id FROM orchestration_events WHERE event_type = 'hosted-site.terminal-pending'",
        )
        .get(),
    ).toEqual({ aggregate_type: "hosted-site-terminal", aggregate_id: pending.botId });

    database.dispatch(pending.markerCommandId, [], () => ({ recorded: true }));
    expect(database.pendingHostedSiteTerminalEvents()).toEqual([]);
    database.deletePendingHostedSiteTerminalEvent(pending.botId, pending.operationId, pending.status);
    expect(
      database.connection
        .prepare("SELECT COUNT(*) AS count FROM orchestration_events WHERE event_type = 'hosted-site.terminal-pending'")
        .get(),
    ).toMatchObject({ count: 0 });
    expect(
      database.connection
        .prepare(
          "SELECT COUNT(*) AS count FROM orchestration_command_receipts WHERE command_id LIKE 'hosted-site-terminal-pending:%'",
        )
        .get(),
    ).toMatchObject({ count: 0 });
    database.close();
  });

  it("stores only active hosted-site operations for restart reconciliation", async () => {
    const database = await createDatabase();
    const bot = testBot();
    database.replaceAgents("agents-running-sites", [bot], "agents.imported");
    if (!bot.threadId) throw new Error("The test bot needs a thread.");
    const threadId = bot.threadId;
    const details = {
      siteId: "site-1",
      title: "Launch page",
      hostname: "launch-page-23456789ab.openbot.site",
      url: "https://launch-page-23456789ab.openbot.site",
    };
    const recordActive = (operationId: string, createdAt: string) => {
      database.recordActiveHostedSiteConversationEvent({
        botId: bot.id,
        threadId,
        turnId: `turn-${operationId}`,
        createdAt,
        event: { action: "replace", status: "running", operationId, ...details },
      });
    };

    recordActive("operation-complete", "2026-09-01T12:00:00.000Z");
    database.deleteActiveHostedSiteConversationEvent(bot.id, "operation-complete");
    recordActive("operation-running", "2026-09-01T12:00:02.000Z");

    expect(database.activeHostedSiteConversationEvents()).toEqual([
      expect.objectContaining({
        botId: bot.id,
        threadId: bot.threadId,
        turnId: "turn-operation-running",
        event: expect.objectContaining({ operationId: "operation-running", status: "running" }),
      }),
    ]);
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
    if (!bot.threadId) throw new Error("The test bot has no thread.");
    const threadId = bot.threadId;
    database.replaceAgents("agents-import", [bot], "agents.imported");
    const snapshot: ConversationSnapshot = {
      botId: bot.id,
      threadId,
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

  it("appends one conversation marker and replays it without another full snapshot", async () => {
    const database = await createDatabase();
    const bot = testBot();
    database.replaceAgents("agents-append-marker", [bot], "agents.imported");
    if (!bot.threadId) throw new Error("The test bot has no thread.");
    const saved = database.persistConversation(
      {
        botId: bot.id,
        threadId: bot.threadId,
        activeTurnId: "turn-1",
        revision: 0,
        messages: [
          {
            id: "user-before-marker",
            author: "user",
            text: "Run the routine",
            createdAt: "2026-08-18T10:00:00.000Z",
            status: "completed",
          },
        ],
      },
      "turn.started",
    );
    const marker: ConversationMessage = {
      id: "routine-marker",
      author: "system",
      source: "system",
      text: "Morning brief",
      createdAt: "2026-08-18T10:00:01.000Z",
      status: "completed",
      itemType: "routine-run-event:running:routine-1:run-1",
    };

    const revision = database.appendConversationMessage({
      botId: bot.id,
      threadId: bot.threadId,
      activeTurnId: "turn-1",
      message: marker,
      eventType: "routine.run-running",
      detail: { routineId: "routine-1", runId: "run-1", status: "running" },
    });

    expect(revision).toBeGreaterThan(saved.revision);
    expect(database.readConversation(bot.id, bot.threadId)).toMatchObject({
      revision,
      messages: [{ id: "user-before-marker" }, { id: marker.id, itemType: marker.itemType }],
    });
    const event = database.connection
      .prepare("SELECT payload_json FROM orchestration_events WHERE event_type = 'routine.run-running'")
      .get();
    if (!isDynamicRecord(event) || !isString(event.payload_json)) throw new Error("The marker event is invalid.");
    const eventPayload = JSON.parse(event.payload_json);
    expect(eventPayload).toMatchObject({ appendedMessage: { id: marker.id } });
    expect(eventPayload).not.toHaveProperty("snapshot");

    database.connection.prepare("DELETE FROM projection_thread_messages WHERE thread_id = ?").run(bot.threadId);
    expect(database.rebuildThreadProjection(bot.threadId)).toMatchObject({
      revision,
      messages: [{ id: "user-before-marker" }, { id: marker.id, itemType: marker.itemType }],
    });
    database.close();
  });

  it("reads bounded runtime metadata without loading a full conversation", async () => {
    const database = await createDatabase();
    const bot = testBot();
    database.replaceAgents("agents-runtime", [bot], "agents.imported");
    database.persistConversation(
      {
        botId: bot.id,
        threadId: bot.threadId,
        activeTurnId: "turn-active",
        revision: 0,
        messages: [
          {
            id: "assistant-latest",
            author: "assistant",
            text: "Latest answer",
            createdAt: "2026-08-29T10:00:00.000Z",
            status: "completed",
          },
          {
            id: "user-after",
            author: "user",
            text: "Follow-up",
            createdAt: "2026-08-29T10:01:00.000Z",
            status: "completed",
          },
          {
            id: "commentary-after",
            author: "assistant",
            text: "Checking the sources",
            createdAt: "2026-08-29T10:02:00.000Z",
            status: "completed",
            itemType: "commentary",
          },
          {
            id: "question-after",
            author: "assistant",
            text: "Which source should I use?",
            createdAt: "2026-08-29T10:03:00.000Z",
            status: "completed",
            itemType: "question_prompt",
          },
          {
            id: "attachment-after",
            author: "assistant",
            text: "",
            createdAt: "2026-08-29T10:04:00.000Z",
            status: "completed",
            itemType: "agent_attachment",
          },
        ],
      },
      "turn.started",
      { turnId: "turn-active" },
    );

    expect(database.readConversationRuntime(bot.id, bot.threadId)).toEqual({
      activeTurnId: "turn-active",
      latestMessage: expect.objectContaining({ id: "assistant-latest", text: "Latest answer" }),
    });
    database.close();
  });

  it("pages and searches a 1,000-message conversation without gaps", async () => {
    const database = await createDatabase();
    const bot = testBot();
    database.replaceAgents("agents-large-history", [bot], "agents.imported");
    const messages = Array.from({ length: 1_000 }, (_, index) => ({
      id: `message-${index.toString().padStart(5, "0")}`,
      author: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: index === 234 ? "A unique pagination needle" : `Message ${index}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, index)).toISOString(),
      status: "completed" as const,
    }));
    database.persistConversation(
      { botId: bot.id, threadId: bot.threadId, activeTurnId: null, revision: 0, messages },
      "conversation.large-history",
    );

    const latest = database.readConversationPage(bot.id, bot.threadId, { type: "latest" }, 50);
    expect(latest.messages).toHaveLength(50);
    expect(latest.messages[0]?.id).toBe("message-00950");
    expect(latest.messages.at(-1)?.id).toBe("message-00999");
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
    expect(seen.size).toBe(1_000);

    const around = database.readConversationPage(
      bot.id,
      bot.threadId,
      { type: "around", messageId: "message-00500" },
      50,
    );
    expect(around.messages).toHaveLength(50);
    expect(around.messages.some((message) => message.id === "message-00500")).toBe(true);
    expect(database.readConversationPage(bot.id, bot.threadId, { type: "latest" }, 1_000).messages).toHaveLength(100);

    const search = database.searchConversationMessages("pagination needle", bot.id, undefined, 100);
    expect(search.total).toBe(1);
    expect(search.results[0]?.message.id).toBe("message-00234");
    database.close();
  });

  it("fills legacy pages after excluding action markers", async () => {
    const database = await createDatabase();
    const bot = testBot();
    database.replaceAgents("agents-routine-history", [bot], "agents.imported");
    const routineEvent = (id: string, createdAt: string) => ({
      id,
      author: "system" as const,
      source: "system" as const,
      text: "Morning brief",
      createdAt,
      status: "completed" as const,
      itemType: routineConversationEventItemType("updated", "routine-1"),
    });
    const routineRunEvent = (id: string, createdAt: string) => ({
      id,
      author: "system" as const,
      source: "system" as const,
      text: "Morning brief",
      createdAt,
      status: "completed" as const,
      itemType: routineRunConversationEventItemType("running", "routine-1", "run-1"),
    });
    const hostedSiteEvent = (id: string, createdAt: string) => ({
      id,
      author: "system" as const,
      source: "system" as const,
      text: hostedSiteConversationEventText({
        siteId: null,
        title: "Launch page",
        hostname: null,
        url: null,
      }),
      createdAt,
      status: "completed" as const,
      itemType: hostedSiteConversationEventItemType("publish", "running", "operation-1"),
    });
    database.persistConversation(
      {
        botId: bot.id,
        threadId: bot.threadId,
        activeTurnId: null,
        revision: 0,
        messages: [
          {
            id: "reply-old",
            author: "assistant",
            text: "Older reply",
            createdAt: "2026-08-29T10:00:00.000Z",
            status: "completed",
          },
          routineEvent("routine-event-1", "2026-08-29T10:01:00.000Z"),
          {
            id: "reply-new",
            author: "assistant",
            text: "Newer reply",
            createdAt: "2026-08-29T10:02:00.000Z",
            status: "completed",
          },
          routineEvent("routine-event-2", "2026-08-29T10:03:00.000Z"),
          routineRunEvent("routine-run-event-1", "2026-08-29T10:04:00.000Z"),
          routineEvent("routine-event-3", "2026-08-29T10:05:00.000Z"),
          hostedSiteEvent("hosted-site-event-1", "2026-08-29T10:06:00.000Z"),
        ],
      },
      "conversation.routine-history",
    );

    const latest = database.readConversationPage(bot.id, bot.threadId, { type: "latest" }, 1, {
      excludeRoutineEvents: true,
      excludeRoutineRunEvents: true,
      excludeHostedSiteEvents: true,
    });
    expect(latest.messages.map((message) => message.id)).toEqual(["reply-new"]);
    expect(latest.pageInfo.hasOlder).toBe(true);
    if (!latest.pageInfo.olderCursor) throw new Error("The older page cursor is missing.");

    const older = database.readConversationPage(
      bot.id,
      bot.threadId,
      { type: "before", cursor: latest.pageInfo.olderCursor },
      1,
      { excludeRoutineEvents: true, excludeRoutineRunEvents: true, excludeHostedSiteEvents: true },
    );
    expect(older.messages.map((message) => message.id)).toEqual(["reply-old"]);
    expect(older.pageInfo.hasOlder).toBe(false);
    expect(database.searchConversationMessages("Morning brief", bot.id).total).toBe(0);
    expect(database.searchConversationMessages("Launch page", bot.id).total).toBe(0);
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

  it("rolls back mailbox attachments when the matching conversation projection fails", async () => {
    const database = await createDatabase();
    const mailboxState = {
      messages: [],
      deliveries: [],
      drafts: [],
      generatedAttachments: [],
      pausedBotIds: [],
      idempotency: {},
      reactions: [],
    };
    database.replaceMailboxState("mailbox-baseline", mailboxState, "mailbox.baseline");
    const snapshot: ConversationSnapshot = {
      botId: "missing-agent",
      threadId: "missing-thread",
      activeTurnId: null,
      revision: 0,
      messages: [],
    };

    expect(() =>
      database.persistConversationAndMailbox(
        snapshot,
        "response.attachments-added",
        {},
        {
          ...mailboxState,
          generatedAttachments: [
            {
              id: "generated-1",
              name: "screenshot.png",
              size: 12,
              kind: "image",
              mimeType: "image/png",
              previewKind: "image",
              previewUrl: "openbot-attachment://file/generated-1",
              path: "/tmp/screenshot.png",
              sha256: "hash",
            },
          ],
        },
        "attachment.generated-batch",
      ),
    ).toThrow("Unknown agent for conversation");
    expect(database.readMailboxState()).toMatchObject({ generatedAttachments: [] });
    expect(database.connection.isTransaction).toBe(false);
    database.close();
  });

  it("removes messages omitted from the latest full conversation snapshot", async () => {
    const database = await createDatabase();
    const bot = testBot();
    database.replaceAgents("agents-import", [bot], "agents.imported");
    const snapshot = conversationSnapshot(bot, "Canonical reply");
    snapshot.messages.push({
      ...snapshot.messages[0],
      id: "provisional-reply",
    });
    database.persistConversation(snapshot, "conversation.snapshot-updated");

    snapshot.messages = snapshot.messages.filter((message) => message.id !== "provisional-reply");
    database.persistConversation(snapshot, "provider-history.backfilled");

    expect(database.readConversation(bot.id, bot.threadId).messages.map((message) => message.id)).toEqual([
      "assistant-1",
    ]);
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
    legacy.prepare("DELETE FROM schema_migrations WHERE version IN (8, 9, 10, 11)").run();
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
    expect(migrated.connection.prepare("SELECT 1 AS applied FROM schema_migrations WHERE version = 8").get()).toEqual({
      applied: 1,
    });
    expect(migrated.connection.prepare("SELECT 1 AS applied FROM schema_migrations WHERE version = 9").get()).toEqual({
      applied: 1,
    });
    expect(migrated.connection.prepare("SELECT 1 AS applied FROM schema_migrations WHERE version = 10").get()).toEqual({
      applied: 1,
    });
    expect(migrated.connection.prepare("SELECT 1 AS applied FROM schema_migrations WHERE version = 11").get()).toEqual({
      applied: 1,
    });
    migrated.close();

    const reopened = new OpenBotDatabase(root);
    await reopened.initialize();
    expect(snapshotEventCount(reopened, bot.threadId)).toBe(1);
    reopened.close();
  }, 20_000);

  it("adds post-v4 agent memory and routine projections", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-db-v4-"));
    roots.push(root);
    const database = new OpenBotDatabase(root);
    await database.initialize();
    database.close();

    const legacy = new DatabaseSync(database.path);
    legacy.exec(`
      DROP TABLE projection_routine_runs;
      DROP TABLE projection_routine_triggers;
      DROP TABLE projection_agent_routines;
      DROP TABLE projection_agent_memories;
      DELETE FROM schema_migrations WHERE version IN (8, 9, 10, 11);
      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
        VALUES (4, '2026-08-20T10:00:00.000Z');
    `);
    legacy.close();

    const migrated = new OpenBotDatabase(root);
    await migrated.initialize();
    const tables = migrated.connection
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN (
           'projection_agent_memories', 'projection_agent_routines',
           'projection_routine_triggers', 'projection_routine_runs'
         ) ORDER BY name`,
      )
      .all();
    expect(tables).toEqual([
      { name: "projection_agent_memories" },
      { name: "projection_agent_routines" },
      { name: "projection_routine_runs" },
      { name: "projection_routine_triggers" },
    ]);
    expect(migrated.connection.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([
      { version: 4 },
      { version: 8 },
      { version: 9 },
      { version: 10 },
      { version: 11 },
    ]);
    migrated.close();
  });

  it("migrates legacy reactions to user-owned rows and permits another actor", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-db-reactions-v7-"));
    roots.push(root);
    const database = new OpenBotDatabase(root);
    await database.initialize();
    database.close();

    const legacy = new DatabaseSync(database.path);
    downgradeReactionsToV7(legacy);
    legacy.close();

    const migrated = new OpenBotDatabase(root);
    await migrated.initialize();
    expect(
      migrated.connection
        .prepare(
          "SELECT actor_kind, actor_bot_id FROM projection_reactions WHERE agent_id = 'chief' AND message_id = 'message-1'",
        )
        .get(),
    ).toEqual({ actor_kind: "user", actor_bot_id: "" });
    expect(() =>
      migrated.connection
        .prepare(
          `INSERT INTO projection_reactions (
             agent_id, message_id, emoji, actor_kind, actor_bot_id, updated_at, last_event_sequence
           ) VALUES ('chief', 'message-1', '🎉', 'bot', 'chief', '2026-08-20T10:01:00.000Z', 2)`,
        )
        .run(),
    ).not.toThrow();
    migrated.close();
  });

  it("rolls back a failed baseline migration and succeeds on retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-db-rollback-"));
    roots.push(root);
    const database = new OpenBotDatabase(root);
    await database.initialize();
    database.close();

    const legacy = new DatabaseSync(database.path);
    downgradeReactionsToV7(legacy);
    legacy.exec("CREATE TABLE projection_reactions_v8 (blocker TEXT)");
    legacy.close();

    const failed = new OpenBotDatabase(root);
    await expect(failed.initialize()).rejects.toThrow("migration to version 8 failed");

    const rolledBack = new DatabaseSync(database.path);
    expect(rolledBack.prepare("SELECT 1 FROM schema_migrations WHERE version = 8").get()).toBeUndefined();
    expect(rolledBack.prepare("PRAGMA table_info(projection_reactions)").all()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "actor_kind" })]),
    );
    rolledBack.exec("DROP TABLE projection_reactions_v8");
    rolledBack.close();

    const retried = new OpenBotDatabase(root);
    await retried.initialize();
    expect(retried.connection.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([
      { version: 7 },
      { version: 8 },
      { version: 9 },
      { version: 10 },
      { version: 11 },
    ]);
    retried.close();
  });

  it("deactivates existing provider sessions when reaction guidance changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-db-runtime-v9-"));
    roots.push(root);
    const database = new OpenBotDatabase(root);
    await database.initialize();
    const bot = testBot();
    if (!bot.threadId) throw new Error("The test bot has no thread.");
    database.replaceAgents("agents-import", [bot], "agents.imported");
    database.bindProviderSession({
      threadId: bot.threadId,
      provider: "codex",
      externalSessionId: "legacy-tool-session",
      model: "gpt-5.6-luna",
      effort: "medium",
    });
    database.close();

    const legacy = new DatabaseSync(database.path);
    legacy.prepare("DELETE FROM schema_migrations WHERE version IN (10, 11)").run();
    legacy.close();

    const migrated = new OpenBotDatabase(root);
    await migrated.initialize();
    expect(migrated.activeProviderSession(bot.threadId, "codex")).toBeNull();
    expect(migrated.listProviderSessions(bot.threadId)).toEqual([
      expect.objectContaining({ externalSessionId: "legacy-tool-session", state: "inactive" }),
    ]);
    migrated.close();
  });

  it("deactivates existing provider sessions when response attachment tools are added", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-db-runtime-v11-"));
    roots.push(root);
    const database = new OpenBotDatabase(root);
    await database.initialize();
    const bot = testBot();
    if (!bot.threadId) throw new Error("The test bot has no thread.");
    database.replaceAgents("agents-import", [bot], "agents.imported");
    database.bindProviderSession({
      threadId: bot.threadId,
      provider: "codex",
      externalSessionId: "session-without-response-attachments",
      model: "gpt-5.6-luna",
      effort: "medium",
    });
    database.close();

    const legacy = new DatabaseSync(database.path);
    legacy.prepare("DELETE FROM schema_migrations WHERE version = 11").run();
    legacy.close();

    const migrated = new OpenBotDatabase(root);
    await migrated.initialize();
    expect(migrated.activeProviderSession(bot.threadId, "codex")).toBeNull();
    expect(migrated.listProviderSessions(bot.threadId)).toEqual([
      expect.objectContaining({
        externalSessionId: "session-without-response-attachments",
        state: "inactive",
      }),
    ]);
    migrated.close();
  });

  it("rolls back a failed response attachment session refresh and succeeds on retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-db-runtime-v11-rollback-"));
    roots.push(root);
    const database = new OpenBotDatabase(root);
    await database.initialize();
    const bot = testBot();
    if (!bot.threadId) throw new Error("The test bot has no thread.");
    database.replaceAgents("agents-import", [bot], "agents.imported");
    database.bindProviderSession({
      threadId: bot.threadId,
      provider: "codex",
      externalSessionId: "session-before-failed-refresh",
      model: "gpt-5.6-luna",
      effort: "medium",
    });
    database.close();

    const legacy = new DatabaseSync(database.path);
    legacy.exec(`
      DELETE FROM schema_migrations WHERE version = 11;
      CREATE TRIGGER reject_session_refresh
      BEFORE UPDATE OF state ON projection_provider_sessions
      BEGIN
        SELECT RAISE(ABORT, 'blocked session refresh');
      END;
    `);
    legacy.close();

    const failed = new OpenBotDatabase(root);
    await expect(failed.initialize()).rejects.toThrow("migration to version 11 failed");
    const rolledBack = new DatabaseSync(database.path);
    expect(rolledBack.prepare("SELECT 1 FROM schema_migrations WHERE version = 11").get()).toBeUndefined();
    expect(
      rolledBack
        .prepare("SELECT external_session_id, state FROM projection_provider_sessions WHERE thread_id = ?")
        .get(bot.threadId),
    ).toEqual({ external_session_id: "session-before-failed-refresh", state: "active" });
    rolledBack.exec("DROP TRIGGER reject_session_refresh");
    rolledBack.close();

    const retried = new OpenBotDatabase(root);
    await retried.initialize();
    expect(retried.activeProviderSession(bot.threadId, "codex")).toBeNull();
    expect(retried.connection.prepare("SELECT 1 AS applied FROM schema_migrations WHERE version = 11").get()).toEqual({
      applied: 1,
    });
    retried.close();
  });

  it("rejects a database created by a newer application", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-db-newer-"));
    roots.push(root);
    const database = new OpenBotDatabase(root);
    await database.initialize();
    database.close();

    const newer = new DatabaseSync(database.path);
    newer.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (12, ?)").run("2026-08-20T10:00:00.000Z");
    newer.close();

    const downgradedApp = new OpenBotDatabase(root);
    await expect(downgradedApp.initialize()).rejects.toThrow("newer than this application supports");
  });

  it("rejects modern migration history with a missing baseline", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-db-gap-"));
    roots.push(root);
    const database = new OpenBotDatabase(root);
    await database.initialize();
    database.close();

    const incomplete = new DatabaseSync(database.path);
    incomplete.prepare("DELETE FROM schema_migrations WHERE version = 8").run();
    incomplete.close();

    const reopened = new OpenBotDatabase(root);
    await expect(reopened.initialize()).rejects.toThrow("migration history is missing version 8");
  });

  it("widens the provider-session constraint for Grok without losing Codex or Claude sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-db-provider-v6-"));
    roots.push(root);
    const database = new OpenBotDatabase(root);
    await database.initialize();
    const bot = testBot();
    if (!bot.threadId) throw new Error("The test bot has no thread.");
    const threadId = bot.threadId;
    database.replaceAgents("agents-import", [bot], "agents.imported");
    database.bindProviderSession({
      threadId,
      provider: "codex",
      externalSessionId: "codex-session",
      model: "gpt-5.4",
      effort: "medium",
    });
    database.bindProviderSession({
      threadId,
      provider: "claude",
      externalSessionId: "claude-session",
      model: "claude-opus-5",
      effort: "high",
    });
    database.close();

    const legacy = new DatabaseSync(database.path);
    legacy.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE projection_provider_sessions_v6 (
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
      INSERT INTO projection_provider_sessions_v6 SELECT * FROM projection_provider_sessions;
      DROP TABLE projection_provider_sessions;
      ALTER TABLE projection_provider_sessions_v6 RENAME TO projection_provider_sessions;
      CREATE INDEX provider_sessions_thread
        ON projection_provider_sessions(thread_id, provider, state);
      DELETE FROM schema_migrations WHERE version IN (8, 9, 10, 11);
      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
        VALUES (6, '2026-08-20T10:00:00.000Z');
      PRAGMA foreign_keys = ON;
    `);
    legacy.close();

    const migrated = new OpenBotDatabase(root);
    await migrated.initialize();
    expect(migrated.listProviderSessions(threadId).map((session) => session.provider)).toEqual(["codex", "claude"]);
    const table = migrated.connection
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'projection_provider_sessions'")
      .get();
    expect(table).toMatchObject({ sql: expect.stringContaining("'grok'") });
    expect(() =>
      migrated.bindProviderSession({
        threadId,
        provider: "grok",
        externalSessionId: "grok-session",
        model: "grok-4.5",
        effort: "xhigh",
      }),
    ).not.toThrow();
    migrated.close();
  });
});

function downgradeReactionsToV7(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE projection_reactions_v7 (
      agent_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      emoji TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_event_sequence INTEGER NOT NULL,
      PRIMARY KEY(agent_id, message_id)
    );
    INSERT INTO projection_reactions_v7 VALUES (
      'chief', 'message-1', '❤️', '2026-08-20T10:00:00.000Z', 1
    );
    DROP TABLE projection_reactions;
    ALTER TABLE projection_reactions_v7 RENAME TO projection_reactions;
    DELETE FROM schema_migrations WHERE version IN (8, 9, 10, 11);
    INSERT OR IGNORE INTO schema_migrations(version, applied_at)
      VALUES (7, '2026-08-20T10:00:00.000Z');
  `);
}

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
    provider: "codex",
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
