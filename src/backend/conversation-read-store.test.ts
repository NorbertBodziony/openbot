// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ConversationSnapshot } from "@openbot/contracts/ipc";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationReadStore } from "./conversation-read-store";
import { OpenBotDatabase } from "./openbot-database";
import { migrateOpenBotDatabase } from "./openbot-database-schema";
import { directThreadId, TeamChatStore } from "./team-chat-store";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ConversationReadStore", () => {
  it("keeps durable monotonic read boundaries per team member", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-conversation-read-"));
    roots.push(root);
    const database = new OpenBotDatabase(root);
    await database.initialize();
    database.connection
      .prepare(
        `INSERT INTO projection_threads (
          thread_id, agent_id, title, active_turn_id, created_at, updated_at, last_event_sequence
        ) VALUES (?, ?, ?, NULL, ?, ?, ?)`,
      )
      .run("thread-chief", "chief", "Chief", "2026-08-19T09:00:00.000Z", "2026-08-19T09:00:00.000Z", 1);
    const reads = new ConversationReadStore(database);
    const first = snapshot([message("message-1", "assistant")]);

    expect(reads.readState("member-a", first)).toEqual({
      unreadCount: 1,
      firstUnreadMessageId: "message-1",
      throughMessageId: null,
    });
    reads.markRead("member-a", first, "message-1");

    const second = snapshot([
      ...first.messages,
      message("commentary-2", "assistant", "commentary"),
      message("attachment-2", "assistant", "agent_attachment"),
      message("message-2", "assistant"),
    ]);
    expect(reads.readState("member-a", second)).toMatchObject({
      unreadCount: 1,
      firstUnreadMessageId: "message-2",
    });
    expect(reads.readState("member-b", second).unreadCount).toBe(2);
    reads.markRead("member-a", second, "message-2");
    reads.adoptMemberState("member-a", "member-owner");
    expect(reads.readState("member-owner", second).throughMessageId).toBe("message-2");

    const third = snapshot([...second.messages, message("message-3", "assistant")]);
    reads.markRead("member-a", third, "message-1");
    expect(reads.readState("member-a", third)).toMatchObject({
      unreadCount: 1,
      firstUnreadMessageId: "message-3",
      throughMessageId: "message-2",
    });
    expect(reads.readState("member-b", third).unreadCount).toBe(3);
    database.close();

    const restoredDatabase = new OpenBotDatabase(root);
    await restoredDatabase.initialize();
    const restored = new ConversationReadStore(restoredDatabase);
    expect(restored.readState("member-a", third).throughMessageId).toBe("message-2");
    restoredDatabase.close();
  });

  it("rebases a filtered marker cursor to the preceding supported message", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-conversation-read-filter-"));
    roots.push(root);
    const database = new OpenBotDatabase(root);
    await database.initialize();
    database.connection
      .prepare(
        `INSERT INTO projection_threads (
          thread_id, agent_id, title, active_turn_id, created_at, updated_at, last_event_sequence
        ) VALUES (?, ?, ?, NULL, ?, ?, ?)`,
      )
      .run("thread-chief", "chief", "Chief", "2026-08-19T09:00:00.000Z", "2026-08-19T09:00:00.000Z", 1);
    const visible = message("message-1", "assistant");
    const marker: ConversationSnapshot["messages"][number] = {
      id: "hosted-site-marker",
      author: "system",
      source: "system",
      text: "{}",
      createdAt: "2026-08-19T09:02:00.000Z",
      status: "completed",
      itemType: "hosted-site-event:publish:running:operation-1",
    };
    const insert = database.connection.prepare(
      `INSERT INTO projection_thread_messages (
        thread_id, message_id, turn_id, author, status, item_type, created_at,
        ordinal, message_json, last_event_sequence
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
    );
    [visible, marker].forEach((entry, ordinal) => {
      insert.run(
        "thread-chief",
        entry.id,
        entry.author,
        entry.status,
        entry.itemType ?? null,
        entry.createdAt,
        ordinal,
        JSON.stringify(entry),
        ordinal + 1,
      );
    });
    const reads = new ConversationReadStore(database);
    reads.markRead("member-a", snapshot([visible, marker]), marker.id);

    expect(
      reads.markRead("member-a", snapshot([visible, marker]), visible.id, {
        excludeHostedSiteEvents: true,
      }),
    ).toMatchObject({ unreadCount: 0, throughMessageId: visible.id });
    expect(
      reads.readStateForThread("member-a", "thread-chief", {
        excludeHostedSiteEvents: true,
      }),
    ).toMatchObject({ unreadCount: 0, throughMessageId: visible.id });
    database.close();
  });

  it("baselines agent history that existed before the read-state migration", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-conversation-read-migration-"));
    roots.push(root);
    const legacy = legacyDatabase(join(root, "openbot.db"));
    legacy
      .prepare(
        `INSERT INTO projection_threads (
          thread_id, agent_id, title, active_turn_id, created_at, updated_at, last_event_sequence
        ) VALUES (?, ?, ?, NULL, ?, ?, ?)`,
      )
      .run("thread-chief", "chief", "Chief", "2026-08-19T09:00:00.000Z", "2026-08-19T09:00:00.000Z", 1);
    legacy
      .prepare(
        `INSERT INTO projection_thread_messages (
          thread_id, message_id, turn_id, author, status, item_type, created_at,
          ordinal, message_json, last_event_sequence
        ) VALUES (?, ?, NULL, ?, 'completed', NULL, ?, 0, ?, 1)`,
      )
      .run(
        "thread-chief",
        "legacy-answer",
        "assistant",
        "2026-08-19T09:00:00.000Z",
        JSON.stringify(message("legacy-answer", "assistant")),
      );
    const directId = directThreadId("member-a", "member-b");
    const legacyDirectMessage = {
      id: "legacy-direct",
      threadId: directId,
      senderMemberId: "member-a",
      recipientMemberId: "member-b",
      text: "Legacy direct message",
      createdAt: "2026-08-19T09:00:00.000Z",
      sequence: 1,
    };
    legacy
      .prepare(
        `INSERT INTO projection_direct_threads (
          thread_id, member_a_id, member_b_id, created_at, updated_at,
          last_message_id, last_event_sequence
        ) VALUES (?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(
        directId,
        "member-a",
        "member-b",
        legacyDirectMessage.createdAt,
        legacyDirectMessage.createdAt,
        legacyDirectMessage.id,
      );
    legacy
      .prepare(
        `INSERT INTO projection_direct_messages (
          message_id, thread_id, sender_member_id, recipient_member_id, text,
          created_at, message_json, last_event_sequence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(
        legacyDirectMessage.id,
        directId,
        legacyDirectMessage.senderMemberId,
        legacyDirectMessage.recipientMemberId,
        legacyDirectMessage.text,
        legacyDirectMessage.createdAt,
        JSON.stringify(legacyDirectMessage),
      );
    migrateOpenBotDatabase(legacy, {
      appliedAt: "2026-08-19T10:00:00.000Z",
    });
    legacy.close();

    const database = new OpenBotDatabase(root);
    await database.initialize();
    const reads = new ConversationReadStore(database);
    const legacySnapshot = snapshot([message("legacy-answer", "assistant")]);
    expect(reads.readState("member-new", legacySnapshot)).toEqual({
      unreadCount: 0,
      firstUnreadMessageId: null,
      throughMessageId: "legacy-answer",
    });
    expect(
      reads.readState("member-new", {
        ...legacySnapshot,
        messages: [...legacySnapshot.messages, message("new-answer", "assistant")],
      }),
    ).toMatchObject({ unreadCount: 1, firstUnreadMessageId: "new-answer" });

    const direct = new TeamChatStore(database);
    expect(direct.readConversation("member-b", "member-a").readState).toEqual({
      unreadCount: 0,
      firstUnreadMessageId: null,
      throughSequence: 1,
    });
    direct.sendMessage({
      clientMessageId: "new-direct",
      senderMemberId: "member-a",
      recipientMemberId: "member-b",
      text: "New direct message",
      createdAt: "2026-08-19T11:00:00.000Z",
    });
    expect(direct.readConversation("member-b", "member-a").readState).toMatchObject({
      unreadCount: 1,
      firstUnreadMessageId: "new-direct",
    });
    database.close();
  });
});

function legacyDatabase(path: string): DatabaseSync {
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations(version, applied_at) VALUES (2, '2026-08-18T00:00:00.000Z');
    CREATE TABLE projection_threads (
      thread_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      title TEXT NOT NULL,
      active_turn_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_event_sequence INTEGER NOT NULL
    );
    CREATE TABLE projection_thread_messages (
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
    CREATE TABLE projection_direct_threads (
      thread_id TEXT PRIMARY KEY,
      member_a_id TEXT NOT NULL,
      member_b_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_message_id TEXT,
      last_event_sequence INTEGER NOT NULL,
      UNIQUE(member_a_id, member_b_id)
    );
    CREATE TABLE projection_direct_messages (
      message_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES projection_direct_threads(thread_id) ON DELETE CASCADE,
      sender_member_id TEXT NOT NULL,
      recipient_member_id TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      message_json TEXT NOT NULL CHECK(json_valid(message_json)),
      last_event_sequence INTEGER NOT NULL
    );
    CREATE TABLE projection_direct_reads (
      thread_id TEXT NOT NULL REFERENCES projection_direct_threads(thread_id) ON DELETE CASCADE,
      member_id TEXT NOT NULL,
      last_read_sequence INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(thread_id, member_id)
    );
  `);
  return database;
}

function snapshot(messages: ConversationSnapshot["messages"]): ConversationSnapshot {
  return {
    botId: "chief",
    threadId: "thread-chief",
    activeTurnId: null,
    revision: messages.length,
    messages,
  };
}

function message(
  id: string,
  author: "assistant" | "user",
  itemType?: string,
): ConversationSnapshot["messages"][number] {
  return {
    id,
    author,
    text: id,
    createdAt: `2026-08-19T09:0${id.at(-1) ?? "0"}:00.000Z`,
    status: "completed",
    itemType,
  };
}
