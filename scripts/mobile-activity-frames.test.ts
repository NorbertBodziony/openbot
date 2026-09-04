import { describe, expect, it } from "vitest";
import { bloubActivityFrames, bloubActivityGeometry } from "../apps/mobile/src/features/bots/model/bloub-activity";

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
