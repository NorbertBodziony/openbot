import { describe, expect, it, vi } from "vitest";
import {
  MAX_SIDEBAR_PINNED_ITEMS,
  normalizeSidebarPinnedItems,
  readSidebarPins,
  SIDEBAR_PINS_STORAGE_KEY,
  writeSidebarPins,
} from "./sidebar-pins";

describe("sidebar pins", () => {
  it("removes duplicate supported items", () => {
    expect(
      normalizeSidebarPinnedItems([
        { kind: "agent", id: "chief" },
        { kind: "person", id: "member-alice" },
        { kind: "agent", id: "chief" },
      ]),
    ).toEqual([
      { kind: "agent", id: "chief" },
      { kind: "person", id: "member-alice" },
    ]);
  });

  it("keeps at most six items", () => {
    const items = Array.from({ length: MAX_SIDEBAR_PINNED_ITEMS + 2 }, (_, index) => ({
      kind: "agent" as const,
      id: `agent-${index}`,
    }));

    expect(normalizeSidebarPinnedItems(items)).toEqual(items.slice(0, MAX_SIDEBAR_PINNED_ITEMS));
  });

  it("reads separate server lists and ignores invalid entries", () => {
    const storage = {
      getItem: vi.fn(() =>
        JSON.stringify({
          local: [
            { kind: "agent", id: "chief" },
            { kind: "channel", id: "general" },
          ],
          team: [{ kind: "person", id: "member-alice" }],
          empty: [{ kind: "person", id: "" }],
        }),
      ),
      setItem: vi.fn(),
    };

    expect(readSidebarPins(storage)).toEqual({
      local: [{ kind: "agent", id: "chief" }],
      team: [{ kind: "person", id: "member-alice" }],
    });
  });

  it("returns an empty map for damaged storage", () => {
    expect(readSidebarPins({ getItem: () => "not-json", setItem: vi.fn() })).toEqual({});
  });

  it("writes the versioned preference without throwing on storage errors", () => {
    const storage = { getItem: vi.fn(), setItem: vi.fn() };
    const pins = { local: [{ kind: "agent" as const, id: "chief" }] };
    writeSidebarPins(pins, storage);
    expect(storage.setItem).toHaveBeenCalledWith(SIDEBAR_PINS_STORAGE_KEY, JSON.stringify(pins));

    expect(() =>
      writeSidebarPins(pins, {
        getItem: vi.fn(),
        setItem: () => {
          throw new Error("full");
        },
      }),
    ).not.toThrow();
  });
});
