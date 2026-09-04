// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationMessage } from "@openbot/contracts/ipc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BotStore } from "../bot-store";
import { ConversationRuntime, withDatabaseTransaction } from "./conversation-runtime";

let root: string;
let store: BotStore;
let runtime: ConversationRuntime;

const BOT_ID = "design";

function systemMessage(text: string): ConversationMessage {
  return {
    id: `message-${text}`,
    author: "system",
    source: "system",
    text,
    createdAt: new Date().toISOString(),
    status: "completed",
  };
}

function threadRowCount(): number {
  return store.database.connection.prepare("SELECT thread_id FROM projection_threads").all().length;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openbot-conversation-transaction-"));
  store = new BotStore(join(root, "user-data"), join(root, "home"));
  await store.initialize();
  await store.getOrCreate(BOT_ID, "Design Studio", "Product design");
  runtime = new ConversationRuntime(
    store,
    () => undefined,
    () => store.list(),
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("conversation transactions", () => {
  it("joins an open transaction instead of committing inside it", () => {
    const message = systemMessage("nested");
    expect(() =>
      withDatabaseTransaction(store.database, () => {
        runtime.withConversationTransaction(BOT_ID, ({ threadId, snapshot }) => {
          snapshot.messages.push(message);
          snapshot.revision = store.database.appendConversationMessage({
            botId: BOT_ID,
            threadId,
            activeTurnId: snapshot.activeTurnId,
            message,
            eventType: "test.nested-append",
          });
          return { result: undefined, snapshot };
        });
        // The inner call must not have committed: the outer rollback below has to reach its rows.
        throw new Error("the outer transaction failed");
      }),
    ).toThrow("the outer transaction failed");

    const bot = store.list().find((candidate) => candidate.id === BOT_ID);
    expect(bot?.threadId).toBeTruthy();
    const persisted = store.database.readConversation(BOT_ID, bot?.threadId ?? null);
    expect(persisted.messages).toEqual([]);
  });

  it("restores the snapshot and the thread identity when the body throws", () => {
    const before = structuredClone(runtime.ensureSnapshot(BOT_ID, null));
    expect(before.threadId).toBeNull();
    const threadRowsBefore = threadRowCount();

    expect(() =>
      runtime.withConversationTransaction(BOT_ID, ({ threadId, snapshot }) => {
        const message = systemMessage("discarded");
        snapshot.messages.push(message);
        snapshot.revision = store.database.appendConversationMessage({
          botId: BOT_ID,
          threadId,
          activeTurnId: snapshot.activeTurnId,
          message,
          eventType: "test.discarded-append",
        });
        throw new Error("the conversation work failed");
      }),
    ).toThrow("the conversation work failed");

    expect(runtime.snapshot(BOT_ID)).toEqual(before);
    expect(store.list().find((candidate) => candidate.id === BOT_ID)?.threadId).toBeNull();
    expect(threadRowCount()).toBe(threadRowsBefore);
  });
});
