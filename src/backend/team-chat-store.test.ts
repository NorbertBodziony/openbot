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

    chat.markRead("member-bob", "member-alice");
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
});
