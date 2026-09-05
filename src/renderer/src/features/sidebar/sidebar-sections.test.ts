import { describe, expect, it, vi } from "vitest";
import { readSidebarCollapsed, SIDEBAR_COLLAPSED_STORAGE_KEY, writeSidebarCollapsed } from "./sidebar-sections";

describe("sidebar collapsed sections", () => {
  it("reads separate server lists and removes duplicates and invalid values", () => {
    const storage = {
      getItem: vi.fn(() =>
        JSON.stringify({
          local: ["people", "demo", "demo", null, ""],
          team: ["unassigned"],
          empty: [null],
        }),
      ),
      setItem: vi.fn(),
    };

    expect(readSidebarCollapsed(storage)).toEqual({
      local: ["people", "demo"],
      team: ["unassigned"],
    });
  });

  it("returns an empty map for damaged storage", () => {
    expect(readSidebarCollapsed({ getItem: () => "not-json", setItem: vi.fn() })).toEqual({});
  });

  it("writes the versioned preference without blocking on storage errors", () => {
    const storage = { getItem: vi.fn(), setItem: vi.fn() };
    const collapsed = { local: ["people"], team: ["demo"] };
    writeSidebarCollapsed(collapsed, storage);
    expect(storage.setItem).toHaveBeenCalledWith(SIDEBAR_COLLAPSED_STORAGE_KEY, JSON.stringify(collapsed));

    expect(() =>
      writeSidebarCollapsed(collapsed, {
        getItem: vi.fn(),
        setItem: () => {
          throw new Error("full");
        },
      }),
    ).not.toThrow();
  });
});
