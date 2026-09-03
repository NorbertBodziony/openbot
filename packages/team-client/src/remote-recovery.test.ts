import type { ConversationSnapshot } from "@openbot/contracts/ipc";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRemoteConnectionRecovery, remoteRecoveryMessage, resyncRemoteConversations } from "./remote-recovery";

afterEach(() => vi.useRealTimers());

describe("remote connection recovery", () => {
  it("shows five attempts ten seconds apart, then a two-minute cooldown before restarting at one", async () => {
    vi.useFakeTimers();
    let desktopOnline = false;
    let connected = false;
    let attempts = 0;
    const errors: unknown[] = [];
    const messages: Array<string | null> = [];
    const connecting: string[] = [];
    const recovery = createRemoteConnectionRecovery(
      async () => {
        attempts += 1;
        if (!desktopOnline) throw new Error("Desktop offline");
        connected = true;
      },
      (error) => errors.push(error),
      (status) => {
        const message = remoteRecoveryMessage(status);
        messages.push(message);
        if (status.phase === "connecting" && message) connecting.push(message);
      },
    );
    recovery.setActive(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(1);
    expect(messages.at(-1)).toBe("Reconnecting 1/5 · Next attempt in 10s");
    await vi.advanceTimersByTimeAsync(9_999);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(attempts).toBe(5);
    expect(connecting).toEqual([
      "Reconnecting 1/5",
      "Reconnecting 2/5",
      "Reconnecting 3/5",
      "Reconnecting 4/5",
      "Reconnecting 5/5",
    ]);
    expect(messages.at(-1)).toBe("Connection failed after 5 attempts. Retrying in 2:00.");
    recovery.setActive(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempts).toBe(5);
    desktopOnline = true;
    recovery.setActive(true);
    recovery.refresh();
    recovery.offline();
    expect(messages.at(-1)).toBe("Connection failed after 5 attempts. Retrying in 1:00.");
    await vi.advanceTimersByTimeAsync(59_999);
    expect(attempts).toBe(5);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(connected).toBe(true);
    expect(attempts).toBe(6);
    expect(connecting.at(-1)).toBe("Reconnecting 1/5");
    expect(messages.at(-1)).toBeNull();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(attempts).toBe(6);
    connected = false;
    recovery.offline();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(connected).toBe(true);
    expect(connecting.at(-1)).toBe("Reconnecting 1/5");
    expect(errors).toHaveLength(5);
    recovery.dispose();
  });

  it("does not overlap connection attempts and ignores a disposed server", async () => {
    vi.useFakeTimers();
    let resolve = () => {};
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    let attempts = 0;
    const recovery = createRemoteConnectionRecovery(
      async () => {
        attempts += 1;
        await promise;
      },
      () => {},
    );
    recovery.setActive(true);
    recovery.offline();
    recovery.offline();
    recovery.refresh();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(attempts).toBe(1);
    resolve();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(2);
    recovery.offline();
    recovery.dispose();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(attempts).toBe(2);
  });

  it("does no work in the background and starts only one attempt after an expired cooldown", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    let updates = 0;
    const recovery = createRemoteConnectionRecovery(
      async () => {
        attempts += 1;
        throw new Error("Offline");
      },
      () => {},
      () => {
        updates += 1;
      },
    );
    recovery.setActive(true);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(attempts).toBe(5);
    recovery.setActive(false);
    const beforeBackground = updates;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(attempts).toBe(5);
    expect(updates).toBe(beforeBackground);
    recovery.setActive(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(6);
    recovery.dispose();
    const beforeDispose = updates;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(attempts).toBe(6);
    expect(updates).toBe(beforeDispose);
  });
});

describe("conversation recovery after an event reset", () => {
  it("replaces stale cached conversations only for agents in the recovered server", async () => {
    const snapshot = (botId: string, text: string, revision: number): ConversationSnapshot => ({
      botId,
      threadId: null,
      activeTurnId: null,
      revision,
      messages: [{ id: "message", author: "assistant", text, status: "completed", createdAt: "2026-09-03T00:00:00Z" }],
    });
    const cached: Record<string, ConversationSnapshot> = {
      local: snapshot("local", "old", 1),
      other: snapshot("other", "untouched", 1),
    };
    const loaded: string[] = [];
    await resyncRemoteConversations({
      botIds: ["local", "unopened"],
      cached,
      load: async (id) => {
        loaded.push(id);
        return snapshot(id, "missed response", 2);
      },
      apply: (value) => {
        cached[value.botId] = value;
      },
      isCurrent: () => true,
    });
    expect(cached.local?.messages[0]?.text).toBe("missed response");
    expect(cached.other?.messages[0]?.text).toBe("untouched");
    expect(loaded).toEqual(["local"]);
  });
  it("does not apply a recovery snapshot after switching servers", async () => {
    let current = true;
    const old: ConversationSnapshot = { botId: "bot", threadId: null, activeTurnId: null, revision: 1, messages: [] };
    let displayed = old;
    await resyncRemoteConversations({
      botIds: ["bot"],
      cached: { bot: old },
      load: async () => {
        current = false;
        return { ...old, revision: 2 };
      },
      apply: (value) => {
        displayed = value;
      },
      isCurrent: () => current,
    });
    expect(displayed.revision).toBe(1);
  });
});
