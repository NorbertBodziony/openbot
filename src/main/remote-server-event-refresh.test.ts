// @vitest-environment node
import type { AgentEvent } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import type { RemoteRequestFn } from "./remote-server-client";
import { RemoteEventRefresh } from "./remote-server-event-refresh";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
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

/**
 * Every request is left hanging until the test answers it, so the test decides the interleaving.
 * `nextRequest` and `nextEmit` are the two observable things this class does; waiting on either is
 * how these tests avoid waiting on a clock.
 */
function harness() {
  const paths: string[] = [];
  const replies: { resolve: (value: unknown) => void }[] = [];
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
  it("answers a burst of invalidations for one agent with a single refetch", async () => {
    const { refresh, paths, replies, emitted, nextEmit } = harness();

    refresh.forward("server", invalidated("research", 7));
    refresh.forward("server", invalidated("research", 7));
    refresh.forward("server", invalidated("research", 7));
    expect(paths).toHaveLength(1);

    const shown = nextEmit();
    replies[0]?.resolve(conversationPage(7));
    await shown;

    expect(paths).toHaveLength(1);
    expect(emitted.map((entry) => entry.event.type)).toEqual(["conversation-page"]);
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
