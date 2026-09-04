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
  it("lets an outer rollback discard a nested call's rows and its in-memory state together", () => {
    const message = systemMessage("nested");
    const published: string[] = [];
    runtime = new ConversationRuntime(
      store,
      (event) => {
        if (event.type === "conversation") published.push(event.snapshot.botId);
      },
      () => store.list(),
    );
    const threadRowsBefore = threadRowCount();

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

    // The rows are gone, so nothing may still claim them: not the thread the nested call created,
    // not the projection the renderer reads, and not a conversation event already on the wire.
    expect(threadRowCount()).toBe(threadRowsBefore);
    expect(store.list().find((candidate) => candidate.id === BOT_ID)?.threadId).toBeNull();
    expect(runtime.ensureSnapshot(BOT_ID, null).messages).toEqual([]);
    expect(published).toEqual([]);
  });

  it("keeps memory agreeing with SQLite when publishing throws after the commit", () => {
    const message = systemMessage("committed");
    const threadRowsBefore = threadRowCount();
    runtime = new ConversationRuntime(
      store,
      (event) => {
        if (event.type === "conversation") throw new Error("a conversation listener failed");
      },
      () => store.list(),
    );

    expect(() =>
      runtime.withConversationTransaction(BOT_ID, ({ threadId, snapshot }) => {
        snapshot.messages.push(message);
        snapshot.revision = store.database.appendConversationMessage({
          botId: BOT_ID,
          threadId,
          activeTurnId: snapshot.activeTurnId,
          message,
          eventType: "test.committed-append",
        });
        return { result: undefined, snapshot };
      }),
    ).toThrow("a conversation listener failed");

    // COMMIT already ran, so these rows are durable and nothing in memory may claim otherwise: a
    // restored snapshot or a cleared thread id would leave the renderer reading a conversation
    // SQLite no longer agrees with, and the caller retrying a mutation that already applied.
    expect(threadRowCount()).toBe(threadRowsBefore + 1);
    expect(store.list().find((candidate) => candidate.id === BOT_ID)?.threadId).toBeTruthy();
    expect(runtime.snapshot(BOT_ID)?.messages).toEqual([message]);
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
