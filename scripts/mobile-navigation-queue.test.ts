import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import type * as RoutingQueueModule from "../apps/mobile/node_modules/expo-router/build/global-state/routingQueue";
import { createChatNavigationGate } from "../apps/mobile/src/features/bots/model/chat-navigation-gate";

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

describe("chat navigation during native zoom return", () => {
  it("opens from an already focused nested screen without waiting for an initial focus event", () => {
    const gate = createChatNavigationGate();
    const opened: string[] = [];
    gate.request(
      () => opened.push("chat"),
      () => true,
    );
    expect(opened).toEqual(["chat"]);
  });

  it.each(["focus-first", "transition-first"] as const)(
    "opens the requested chat exactly once after focus and transition completion (%s)",
    (order) => {
      const gate = createChatNavigationGate();
      const opened: string[] = [];
      let focused = false;
      const focus = () => {
        focused = true;
        gate.focus();
      };
      gate.start();
      gate.request(
        () => opened.push("chat"),
        () => focused,
      );
      if (order === "focus-first") focus();
      else gate.finish();
      expect(opened).toEqual([]);
      if (order === "focus-first") gate.finish();
      else focus();
      expect(opened).toEqual(["chat"]);
      gate.finish();
      gate.focus();
      expect(opened).toEqual(["chat"]);
    },
  );

  it("keeps only the latest requested chat while the list is returning", () => {
    const gate = createChatNavigationGate();
    const opened: string[] = [];
    gate.focus();
    gate.start();
    gate.request(
      () => opened.push("first"),
      () => true,
    );
    gate.request(
      () => opened.push("second"),
      () => true,
    );
    gate.finish();
    expect(opened).toEqual(["second"]);
    gate.request(
      () => opened.push("ready"),
      () => true,
    );
    expect(opened).toEqual(["second", "ready"]);
  });

  it("discards a queued tap if the back gesture is cancelled or the source loses focus", () => {
    const gate = createChatNavigationGate();
    const opened: string[] = [];
    gate.start();
    gate.request(
      () => opened.push("cancelled"),
      () => true,
    );
    gate.cancel();
    gate.finish();
    gate.focus();
    gate.start();
    gate.request(
      () => opened.push("left"),
      () => true,
    );
    gate.blur();
    gate.finish();
    gate.focus();
    expect(opened).toEqual([]);
    gate.request(
      () => opened.push("next"),
      () => true,
    );
    expect(opened).toEqual(["next"]);
  });
});
