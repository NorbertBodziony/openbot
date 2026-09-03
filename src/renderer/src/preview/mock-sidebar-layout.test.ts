import type { SidebarLayoutSnapshot } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { applySidebarLayoutAction } from "./mock-sidebar-layout";

const layout: SidebarLayoutSnapshot = {
  revision: 3,
  sections: [
    { id: "s1", name: "First" },
    { id: "s2", name: "Second" },
  ],
  order: ["s1", "s2"],
  agentAssignments: { "bot-1": "s1" },
  agentOrder: ["bot-1"],
};

describe("mock sidebar layout", () => {
  it("bumps the revision on every action without mutating the input", () => {
    const next = applySidebarLayoutAction(layout, { type: "rename", sectionId: "s1", name: "Renamed" });
    expect(next.revision).toBe(4);
    expect(next.sections[0]?.name).toBe("Renamed");
    expect(layout.revision).toBe(3);
    expect(layout.sections[0]?.name).toBe("First");
  });

  it("creates sections and optionally assigns the new agent", () => {
    const next = applySidebarLayoutAction(layout, { type: "create", name: "  Third  ", agentId: "bot-2" });
    expect(next.sections).toHaveLength(3);
    const created = next.sections[2];
    expect(created?.name).toBe("Third");
    expect(next.order).toEqual(["s1", "s2", created?.id]);
    expect(next.agentAssignments["bot-2"]).toBe(created?.id);
  });

  it("deletes sections and drops their assignments", () => {
    const next = applySidebarLayoutAction(layout, { type: "delete", sectionId: "s1" });
    expect(next.sections.map((section) => section.id)).toEqual(["s2"]);
    expect(next.order).toEqual(["s2"]);
    expect(next.agentAssignments).toEqual({});
  });

  it("moves sections within bounds and ignores out-of-range moves", () => {
    const moved = applySidebarLayoutAction(layout, { type: "move", sectionId: "s1", direction: "down" });
    expect(moved.order).toEqual(["s2", "s1"]);
    const stayed = applySidebarLayoutAction(layout, { type: "move", sectionId: "s1", direction: "up" });
    expect(stayed.order).toEqual(["s1", "s2"]);
  });

  it("orders agents and assigns or unassigns sections", () => {
    const ordered = applySidebarLayoutAction(layout, {
      type: "move-agent",
      agentId: "bot-2",
      sectionId: "s2",
      beforeAgentId: "bot-1",
    });
    expect(ordered.agentOrder).toEqual(["bot-2", "bot-1"]);
    expect(ordered.agentAssignments["bot-2"]).toBe("s2");
    const unassigned = applySidebarLayoutAction(ordered, {
      type: "assign",
      agentId: "bot-1",
      sectionId: null,
    });
    expect(unassigned.agentAssignments["bot-1"]).toBeUndefined();
    expect(unassigned.agentOrder).toContain("bot-1");
  });
});
