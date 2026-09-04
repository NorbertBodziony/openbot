import type { ConversationSnapshot } from "@openbot/contracts/ipc";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRemoteConnectionRecovery,
  mergeRemoteUnreadIds,
  remoteConnectionFailure,
  remoteRecoveryMessage,
  resyncRemoteConversations,
} from "./remote-recovery";

afterEach(() => vi.useRealTimers());

describe("remote connection recovery", () => {
  it("keeps a safe failure reason visible through retries and clears it when connected", async () => {
    vi.useFakeTimers();
    let failure: string | null = null;
    let message: string | null = null;
    const recovery = createRemoteConnectionRecovery(
      async () => {},
      (error) => {
        failure = remoteConnectionFailure("connection", error);
      },
      (status) => {
        message = remoteRecoveryMessage(status, failure);
      },
    );
    recovery.setActive(true);
    await vi.advanceTimersByTimeAsync(0);
    recovery.offline(new Error("The host already has an active remote session."));
    expect(message).toContain("Connecting to the desktop: The host already has an active remote session.");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(message).toContain("Connecting to the desktop: The host already has an active remote session.");
    await vi.advanceTimersByTimeAsync(9_000);
    expect(message).toBeNull();
    recovery.dispose();
  });

  it("does not expose credentials or response contents in connection diagnostics", () => {
    const sensitive = "Bearer test-private-token; secret=private-value; conversation=private-message";
    expect(remoteConnectionFailure("compatibility", new Error(sensitive))).toBe(
      "Checking desktop compatibility: Unexpected error.",
    );
    expect(remoteConnectionFailure("preferences", new TypeError(sensitive))).toBe(
      "Loading local chat preferences: TypeError.",
    );
    expect(remoteConnectionFailure("agents", new SyntaxError(sensitive))).toBe("Loading agents: SyntaxError.");
    expect(remoteConnectionFailure("reads", sensitive)).toBe("Loading read status: Unexpected error.");
    expect(
      remoteRecoveryMessage(
        { phase: "cooldown", attempt: 5, remainingSeconds: 120 },
        remoteConnectionFailure("connection", new Error("The desktop did not connect.")),
      ),
    ).toContain("Connecting to the desktop: The desktop did not connect.");
  });

  it("applies live unread changes without erasing another server's unread agents", () => {
    expect(
      mergeRemoteUnreadIds(["other-server", "read-now"], {
        "read-now": { unreadCount: 0 },
        "new-reply": { unreadCount: 1 },
      }),
    ).toEqual(["other-server", "new-reply"]);
  });
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
    expect(messages.at(-1)).toBe("Connection attempt failed. Retrying in 10s.");
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
    expect(messages.at(-1)).toBe("Connection lost. Retrying in 10s.");
    const attemptsBeforeRetry = connecting.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(connected).toBe(true);
    expect(connecting.slice(attemptsBeforeRetry)).toEqual(["Reconnecting 1/5"]);
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
    // The retry deadline already elapsed, but no new work starts until the old work settles.
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(2);
    recovery.offline();
    recovery.dispose();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(attempts).toBe(2);
  });

  it("shows cooldown as soon as the fifth attempt reports offline, without waiting for command cleanup", async () => {
    vi.useFakeTimers();
    let rejectFifth = (_error: Error) => {};
    let attempts = 0;
    let message: string | null = null;
    const recovery = createRemoteConnectionRecovery(
      async () => {
        attempts += 1;
        if (attempts < 5) throw new Error("Offline");
        if (attempts === 5) {
          await new Promise<void>((_resolve, reject) => {
            rejectFifth = reject;
          });
        }
      },
      () => {},
      (status) => {
        message = remoteRecoveryMessage(status);
      },
    );
    recovery.setActive(true);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(attempts).toBe(5);
    expect(message).toBe("Reconnecting 5/5");
    recovery.offline();
    expect(message).toBe("Connection failed after 5 attempts. Retrying in 2:00.");
    recovery.offline();
    recovery.refresh();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(message).toBe("Connection failed after 5 attempts. Retrying in 1:59.");
    rejectFifth(new Error("Connection command finished cleaning up"));
    await vi.advanceTimersByTimeAsync(0);
    expect(message).toBe("Connection failed after 5 attempts. Retrying in 1:59.");
    await vi.advanceTimersByTimeAsync(118_999);
    expect(attempts).toBe(5);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(6);
    expect(message).toBeNull();
    recovery.dispose();
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
