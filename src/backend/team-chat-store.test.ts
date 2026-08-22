// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OpenBotDatabase } from "./openbot-database";
import { directThreadId, TeamChatStore } from "./team-chat-store";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("TeamChatStore", () => {
  it("stores one durable and idempotent direct thread per member pair", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-direct-chat-"));
    roots.push(root);
    const database = new OpenBotDatabase(root);
    await database.initialize();
    const chat = new TeamChatStore(database);

    const sent = chat.sendMessage({
      clientMessageId: "message-alice-1",
      senderMemberId: "member-alice",
      recipientMemberId: "member-bob",
      text: "Can you review the launch note?",
      createdAt: "2026-08-19T09:00:00.000Z",
    });
    const repeated = chat.sendMessage({
      clientMessageId: "message-alice-1",
      senderMemberId: "member-alice",
      recipientMemberId: "member-bob",
      text: "Can you review the launch note?",
      createdAt: "2026-08-19T09:00:00.000Z",
    });

    expect(repeated).toEqual(sent);
    expect(sent.threadId).toBe(directThreadId("member-bob", "member-alice"));
    expect(chat.listThreads("member-bob")).toMatchObject([
      { otherMemberId: "member-alice", unreadCount: 1, lastMessage: sent },
    ]);
    expect(chat.readConversation("member-bob", "member-alice").messages).toEqual([sent]);
    expect(chat.readConversation("member-bob", "member-alice").readState).toMatchObject({
      unreadCount: 1,
      firstUnreadMessageId: sent.id,
      throughSequence: 0,
    });

    chat.markRead("member-bob", "member-alice", sent.sequence);
    expect(chat.listThreads("member-bob")[0]?.unreadCount).toBe(0);
    chat.sendMessage({
      clientMessageId: "message-bob-1",
      senderMemberId: "member-bob",
      recipientMemberId: "member-alice",
      text: "Yes. I will review it now.",
      createdAt: "2026-08-19T09:01:00.000Z",
    });
    database.close();

    const restoredDatabase = new OpenBotDatabase(root);
    await restoredDatabase.initialize();
    const restored = new TeamChatStore(restoredDatabase);
    expect(restored.readConversation("member-alice", "member-bob").messages).toHaveLength(2);
    expect(restored.listThreads("member-alice")[0]).toMatchObject({
      otherMemberId: "member-bob",
      unreadCount: 1,
      lastMessage: { text: "Yes. I will review it now." },
    });
    restoredDatabase.close();
  });

  it("pages a 10,000-message direct conversation without gaps or duplicates", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-direct-chat-large-"));
    roots.push(root);
    const database = new OpenBotDatabase(root);
    await database.initialize();
    const chat = new TeamChatStore(database);
    const first = chat.sendMessage({
      clientMessageId: "message-00000",
      senderMemberId: "member-alice",
      recipientMemberId: "member-bob",
      text: "Message 0",
      createdAt: "2026-08-19T09:00:00.000Z",
    });
    const insert = database.connection.prepare(
      `INSERT INTO projection_direct_messages (
         message_id, thread_id, sender_member_id, recipient_member_id, text,
         created_at, message_json, last_event_sequence
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    database.connection.exec("BEGIN");
    try {
      for (let index = 1; index < 10_000; index += 1) {
        const id = `message-${index.toString().padStart(5, "0")}`;
        const senderMemberId = index % 2 === 0 ? "member-alice" : "member-bob";
        const recipientMemberId = senderMemberId === "member-alice" ? "member-bob" : "member-alice";
        const createdAt = new Date(Date.UTC(2026, 7, 19, 9, 0, 0, index)).toISOString();
        const sequence = first.sequence + index;
        const message = {
          id,
          threadId: first.threadId,
          senderMemberId,
          recipientMemberId,
          text: `Message ${index}`,
          createdAt,
          sequence,
        };
        insert.run(
          id,
          first.threadId,
          senderMemberId,
          recipientMemberId,
          message.text,
          createdAt,
          JSON.stringify(message),
          sequence,
        );
      }
      database.connection
        .prepare(
          `UPDATE projection_direct_threads
           SET updated_at = ?, last_message_id = ?, last_event_sequence = ?
           WHERE thread_id = ?`,
        )
        .run(
          new Date(Date.UTC(2026, 7, 19, 9, 0, 0, 9_999)).toISOString(),
          "message-09999",
          first.sequence + 9_999,
          first.threadId,
        );
      database.connection.exec("COMMIT");
    } catch (error) {
      database.connection.exec("ROLLBACK");
      throw error;
    }

    const latest = chat.readConversationPage("member-bob", "member-alice", { type: "latest" }, 50);
    expect(latest.messages).toHaveLength(50);
    expect(latest.messages[0]?.id).toBe("message-09950");
    expect(latest.messages.at(-1)?.id).toBe("message-09999");
    expect(latest.pageInfo.hasOlder).toBe(true);
    expect(latest.readState?.unreadCount).toBe(5_000);

    const seen = new Set(latest.messages.map((message) => message.id));
    let page = latest;
    while (page.pageInfo.olderCursor) {
      page = chat.readConversationPage(
        "member-bob",
        "member-alice",
        { type: "before", cursor: page.pageInfo.olderCursor },
        50,
      );
      for (const message of page.messages) expect(seen.has(message.id)).toBe(false);
      page.messages.forEach((message) => {
        seen.add(message.id);
      });
    }
    expect(seen.size).toBe(10_000);

    const around = chat.readConversationPage(
      "member-bob",
      "member-alice",
      { type: "around", messageId: "message-05000" },
      50,
    );
    expect(around.messages).toHaveLength(50);
    expect(around.messages.some((message) => message.id === "message-05000")).toBe(true);
    expect(chat.readConversationPage("member-bob", "member-alice", { type: "latest" }, 1_000).messages).toHaveLength(
      100,
    );
    expect(() => chat.readConversationPage("member-bob", "member-alice", { type: "latest" }, 0)).toThrow(
      "limit is invalid",
    );
    database.close();
  });
});
