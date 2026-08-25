import { describe, expect, it, vi } from "vitest";
import {
  normalizeSidebarPeopleOrder,
  readSidebarPeopleOrder,
  SIDEBAR_PEOPLE_ORDER_STORAGE_KEY,
  writeSidebarPeopleOrder,
} from "./sidebar-people-order";

describe("sidebar people order", () => {
  it("normalizes duplicate and empty member IDs", () => {
    expect(normalizeSidebarPeopleOrder([" alice ", "", "bob", "alice"])).toEqual(["alice", "bob"]);
  });

  it("reads separate server orders and ignores damaged storage", () => {
    const storage = {
      getItem: vi.fn(() => JSON.stringify({ local: ["alice", "alice", null], team: ["bob"] })),
      setItem: vi.fn(),
    };
    expect(readSidebarPeopleOrder(storage)).toEqual({ local: ["alice"], team: ["bob"] });
    expect(readSidebarPeopleOrder({ getItem: () => "not-json", setItem: vi.fn() })).toEqual({});
  });

  it("writes without blocking when storage is unavailable", () => {
    const order = { local: ["alice", "bob"] };
    const storage = { getItem: vi.fn(), setItem: vi.fn() };
    writeSidebarPeopleOrder(order, storage);
    expect(storage.setItem).toHaveBeenCalledWith(SIDEBAR_PEOPLE_ORDER_STORAGE_KEY, JSON.stringify(order));
    expect(() =>
      writeSidebarPeopleOrder(order, {
        getItem: vi.fn(),
        setItem: () => {
          throw new Error("full");
        },
      }),
    ).not.toThrow();
  });
});
