import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import type * as RoutingQueueModule from "../apps/mobile/node_modules/expo-router/build/global-state/routingQueue";

function loadRoutingQueue() {
  const exports: Partial<typeof RoutingQueueModule> = {};
  // Exercise the installed patch without loading native route resolution in Node.
  runInNewContext(
    readFileSync(
      new URL("../apps/mobile/node_modules/expo-router/build/global-state/routingQueue.js", import.meta.url),
      "utf8",
    ),
    {
      exports,
      require: (name: string) => {
        if (name === "./getNavigationAction") return {};
        throw new Error(`Unexpected routing queue dependency: ${name}`);
      },
    },
  );
  if (!exports.routingQueue) throw new Error("Expo Router did not export its routing queue");
  return exports.routingQueue;
}

describe("mobile navigation queue", () => {
  it("notifies a snapshot-identity observer on the first navigation after going back", () => {
    const queue = loadRoutingQueue();
    let observed = queue.snapshot();
    const notifications: string[][] = [];
    const unsubscribe = queue.subscribe(() => {
      const next = queue.snapshot();
      // useSyncExternalStore, used by Expo Router, compares snapshots with Object.is.
      if (Object.is(observed, next)) return;
      observed = next;
      notifications.push(next.map((action) => action.type));
    });
    queue.add({ type: "GO_BACK" });
    queue.run({ current: null });
    observed = queue.snapshot();
    queue.add({ type: "NAVIGATE", payload: { name: "chat/[botId]", params: { botId: "bot-test" } } });
    unsubscribe();
    expect(notifications).toEqual([["GO_BACK"], ["NAVIGATE"]]);
  });

  it("keeps the snapshot already read by React unchanged when another navigation is queued", () => {
    const queue = loadRoutingQueue();
    queue.add({ type: "GO_BACK" });
    const previous = queue.snapshot();
    queue.add({ type: "NAVIGATE" });
    expect(previous.map((action) => action.type)).toEqual(["GO_BACK"]);
    const pending = queue.snapshot();
    queue.run({ current: null });
    expect(pending.map((action) => action.type)).toEqual(["GO_BACK", "NAVIGATE"]);
    expect(queue.snapshot()).toEqual([]);
  });
});
