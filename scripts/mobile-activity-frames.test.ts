import { BotEngine } from "@norbert_bodziony/bloub";
import { describe, expect, it, vi } from "vitest";
import { bloubActivityFrames, bloubActivityGeometry } from "../apps/mobile/src/features/bots/model/bloub-activity";
import {
  type LoaderFrame,
  prepareLoaderFrames,
  prepareReturnToIdleFrames,
} from "../apps/mobile/src/shared/lib/bloub-loader-frames";

function idleQueue() {
  const callbacks = new Set<() => void>();
  return {
    schedule(callback: () => void) {
      callbacks.add(callback);
      return () => {
        callbacks.delete(callback);
      };
    },
    next() {
      const callback = callbacks.values().next().value;
      if (!callback) return false;
      callbacks.delete(callback);
      callback();
      return true;
    },
  };
}

describe("loader frame preparation", () => {
  it("leaves the first commit free of animation sampling and yields between bounded batches", () => {
    const idle = idleQueue();
    const sample = vi.spyOn(BotEngine.prototype, "sample");
    let ready: LoaderFrame[] | undefined;
    try {
      prepareLoaderFrames((frames) => {
        ready = frames;
      }, idle.schedule);
      expect(sample).not.toHaveBeenCalled();
      expect(ready).toBeUndefined();
      while (idle.next()) {
        expect(sample.mock.calls.length).toBeLessThanOrEqual(4);
        sample.mockClear();
      }
      expect(ready?.length).toBeGreaterThan(0);
      expect(ready?.length).toBeLessThanOrEqual(120);
    } finally {
      sample.mockRestore();
    }
  });

  it("stops preparing a loader that disappears before its sequence is ready", () => {
    const idle = idleQueue();
    const sample = vi.spyOn(BotEngine.prototype, "sample");
    const ready = vi.fn();
    try {
      const cancel = prepareLoaderFrames(ready, idle.schedule);
      idle.next();
      sample.mockClear();
      cancel();
      while (idle.next()) {
        /* Drain any erroneously retained work. */
      }
      expect(sample).not.toHaveBeenCalled();
      expect(ready).not.toHaveBeenCalled();
    } finally {
      sample.mockRestore();
    }
  });

  it("prepares an exit asynchronously from the displayed pose and can cancel a stale exit", () => {
    const idle = idleQueue();
    let cycle: LoaderFrame[] = [];
    prepareLoaderFrames((frames) => {
      cycle = frames;
    }, idle.schedule);
    while (idle.next()) {
      /* Finish the cycle before requesting an exit. */
    }
    const sample = vi.spyOn(BotEngine.prototype, "sample");
    const ready = vi.fn();
    try {
      prepareReturnToIdleFrames(60, ready, idle.schedule);
      expect(sample).not.toHaveBeenCalled();
      while (idle.next()) {
        /* Finish the idle morph. */
      }
      expect(ready).toHaveBeenCalledOnce();
      expect(ready.mock.calls[0][0][0]).toEqual(cycle[60]);
      ready.mockClear();
      const cancel = prepareReturnToIdleFrames(90, ready, idle.schedule);
      idle.next();
      cancel();
      sample.mockClear();
      while (idle.next()) {
        /* A cancelled exit must not resume later. */
      }
      expect(sample).not.toHaveBeenCalled();
      expect(ready).not.toHaveBeenCalled();
    } finally {
      sample.mockRestore();
    }
  });
});

it("reuses sampled SVG data for separate presentations with the same avatar geometry", () => {
  const header = bloubActivityFrames(bloubActivityGeometry("bot-test"));
  const activity = bloubActivityFrames(bloubActivityGeometry("bot-test"));
  expect(activity).toBe(header);
});

describe("activity sequence eviction", () => {
  it("keeps an existing player's frames valid when unused cached geometry is evicted", () => {
    const geometry = bloubActivityGeometry("eviction-test");
    const mounted = bloubActivityFrames(geometry);
    const firstPath = mounted[0].body.d;
    const geometries = new Map([[geometry.key, geometry]]);
    for (let index = 0; geometries.size < 10; index += 1) {
      const next = bloubActivityGeometry(`geometry-${index}`);
      if (geometries.has(next.key)) continue;
      geometries.set(next.key, next);
      bloubActivityFrames(next);
    }
    const remounted = bloubActivityFrames(geometry);
    expect(remounted).not.toBe(mounted);
    expect(mounted[0].body.d).toBe(firstPath);
    expect(remounted).toEqual(mounted);
  });
});
