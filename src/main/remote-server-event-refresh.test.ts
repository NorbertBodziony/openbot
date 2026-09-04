// @vitest-environment node
import type { AgentEvent } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import type { RemoteRequestFn } from "./remote-server-client";
import { RemoteEventRefresh } from "./remote-server-event-refresh";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function conversationPage(revision: number) {
  return {
    botId: "research",
    threadId: null,
    activeTurnId: null,
    revision,
    messages: [],
    references: {},
    pageInfo: { hasOlder: false, olderCursor: null },
  };
}

function invalidated(botId: string, revision: number): AgentEvent {
  return { type: "conversation-invalidated", botId, revision };
}

function queueInvalidated(botId: string): AgentEvent {
  return { type: "queue-invalidated", botId };
}

/**
 * Every request is left hanging until the test answers it, so the test decides the interleaving.
 * `nextRequest` and `nextEmit` are the two observable things this class does; waiting on either is
 * how these tests avoid waiting on a clock.
 */
function harness() {
  const paths: string[] = [];
  const replies: { resolve: (value: unknown) => void; reject: (error: Error) => void }[] = [];
  const emitted: { serverId: string; event: AgentEvent; bufferedLive?: boolean }[] = [];
  const requestWaiters: (() => void)[] = [];
  const emitWaiters: (() => void)[] = [];
  const wake = (waiters: (() => void)[]) => {
    for (const waiter of waiters.splice(0)) waiter();
  };
  // The real decoder runs, so a reply that is not a shape the host could send fails here rather
  // than sailing through to an assertion about coordination.
  const request: RemoteRequestFn = (_serverId, path, decoder) => {
    paths.push(path);
    const pending = deferred<unknown>();
    replies.push(pending);
    wake(requestWaiters);
    return pending.promise.then(decoder);
  };
  const refresh = new RemoteEventRefresh({
    request,
    hasServer: () => true,
    emit: (serverId, event, bufferedLive) => {
      emitted.push({ serverId, event, bufferedLive });
      wake(emitWaiters);
    },
  });
  return {
    refresh,
    paths,
    replies,
    emitted,
    nextRequest: () => new Promise<void>((resolve) => requestWaiters.push(resolve)),
    nextEmit: () => new Promise<void>((resolve) => emitWaiters.push(resolve)),
  };
}

describe("RemoteEventRefresh", () => {
  it("holds a burst to one fetch in flight, then refetches once for what arrived during it", async () => {
    const { refresh, paths, replies, emitted, nextRequest, nextEmit } = harness();

    refresh.forward("server", invalidated("research", 7));
    refresh.forward("server", invalidated("research", 7));
    refresh.forward("server", invalidated("research", 7));
    expect(paths).toHaveLength(1);

    // Repeating a revision is not repeating an announcement. A read on another device moves the
    // page's unread counts without moving its content revision, so the answer to the first fetch is
    // already stale -- and comparing revisions alone cannot tell that from nothing having happened.
    const refetched = nextRequest();
    replies[0]?.resolve(conversationPage(7));
    await refetched;

    expect(emitted).toEqual([]);
    expect(paths).toHaveLength(2);

    const shown = nextEmit();
    replies[1]?.resolve(conversationPage(7));
    await shown;

    expect(paths).toHaveLength(2);
    expect(emitted.map((entry) => entry.event)).toEqual([{ type: "conversation-page", page: conversationPage(7) }]);
  });

  it("fetches again when a newer revision is announced while the first fetch is in flight", async () => {
    const { refresh, paths, replies, emitted, nextRequest, nextEmit } = harness();

    refresh.forward("server", invalidated("research", 7));
    refresh.forward("server", invalidated("research", 9));
    const refetched = nextRequest();
    replies[0]?.resolve(conversationPage(7));
    await refetched;

    // The answer describes revision 7, which is older than what the host has since announced, so it
    // is never shown to the user.
    expect(emitted).toEqual([]);
    expect(paths).toHaveLength(2);

    const shown = nextEmit();
    replies[1]?.resolve(conversationPage(9));
    await shown;

    expect(emitted.map((entry) => entry.event)).toEqual([{ type: "conversation-page", page: conversationPage(9) }]);
  });

  it("retries a failed refetch for the revision announced while it was away", async () => {
    const { refresh, paths, replies, emitted, nextRequest, nextEmit } = harness();

    refresh.forward("server", invalidated("research", 7));
    refresh.forward("server", invalidated("research", 9));
    const retried = nextRequest();
    replies[0]?.reject(new Error("Refresh failed"));
    await retried;

    // The retry is for revision 9, not the 7 that failed. A refetch that fails with nothing newer
    // announced stops instead, which is why the retry has to be tied to the revision and not to the
    // failure.
    expect(paths).toHaveLength(2);

    const shown = nextEmit();
    replies[1]?.resolve(conversationPage(9));
    await shown;

    expect(emitted.map((entry) => entry.event)).toEqual([{ type: "conversation-page", page: conversationPage(9) }]);
  });

  it("answers a burst of queue invalidations with one fetch and retries when one is waiting", async () => {
    const { refresh, paths, replies, emitted, nextRequest, nextEmit } = harness();
    const snapshot = { botId: "research", deliveries: [] };

    // The queue carries no revision, so "changed again" is the only thing a second event can say --
    // which makes coalescing and retrying the same question here, unlike a conversation page.
    refresh.forward("server", queueInvalidated("research"));
    refresh.forward("server", queueInvalidated("research"));
    expect(paths).toHaveLength(1);

    const retried = nextRequest();
    replies[0]?.reject(new Error("Refresh failed"));
    await retried;
    expect(paths).toEqual(["/v1/agents/research/queue", "/v1/agents/research/queue"]);

    const shown = nextEmit();
    replies[1]?.resolve(snapshot);
    await shown;

    expect(emitted.map((entry) => entry.event)).toEqual([{ type: "queue-changed", snapshot }]);
  });

  it("drops a fallback load that a later one has already replaced", async () => {
    const { refresh, replies, emitted, nextEmit } = harness();

    void refresh.refreshAgentState("server");
    void refresh.refreshAgentState("server");
    const shown = nextEmit();
    replies[0]?.resolve([]);
    replies[1]?.resolve([]);
    await shown;

    expect(emitted.map((entry) => entry.event)).toEqual([{ type: "bots-changed", bots: [] }]);
  });
});
