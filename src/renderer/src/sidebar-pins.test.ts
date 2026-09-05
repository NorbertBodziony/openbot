import { describe, expect, it, vi } from "vitest";
import {
  MAX_SIDEBAR_PINNED_ITEMS,
  normalizeSidebarPinnedItems,
  readSidebarPins,
  reownSidebarPinnedItems,
  SIDEBAR_PINS_STORAGE_KEY,
  writeSidebarPins,
} from "./sidebar-pins";

describe("sidebar pins", () => {
  it("keeps unique agents and removes legacy person pins", () => {
    expect(
      normalizeSidebarPinnedItems([
        { kind: "agent", id: "chief" },
        { kind: "person", id: "member-alice" },
        { kind: "agent", id: "chief" },
      ]),
    ).toEqual([{ kind: "agent", id: "chief" }]);
  });

  it("repins an agent migration v13 renamed instead of stranding it", () => {
    const uuid = "6d3e8b17-9c04-4f21-8a55-1b2c3d4e5f60";
    const items = [
      { kind: "agent" as const, id: `bot-${uuid}` },
      { kind: "agent" as const, id: "chief" },
    ];

    // These pins live in browser storage, which the id migration never touched, so a pinned agent looks
    // deleted after the upgrade: it disappears from the pinned group while still holding one of six slots.
    expect(reownSidebarPinnedItems(items, new Set([`agent-${uuid}`, "chief"]))).toEqual([
      { kind: "agent", id: `agent-${uuid}` },
      { kind: "agent", id: "chief" },
    ]);

    // v13 declines to rename onto an id that is taken, so the agent that literally holds the old spelling
    // keeps this pin; and a pin matching nobody is left alone, because an agent can be absent for reasons
    // that have nothing to do with the rename.
    expect(reownSidebarPinnedItems(items, new Set([`agent-${uuid}`, `bot-${uuid}`]))).toEqual(items);
    expect(reownSidebarPinnedItems(items, new Set(["chief"]))).toEqual(items);
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
