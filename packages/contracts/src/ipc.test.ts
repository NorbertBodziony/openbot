import { describe, expect, it } from "vitest";
import { isAgentEvent, isAvatarHue, isAvatarSeed, isBotMemory } from "./ipc";

describe("avatar IPC validation", () => {
  it("accepts generated avatar seeds and rejects unsafe or oversized values", () => {
    expect(isAvatarSeed("chief:avatar:12:4")).toBe(true);
    expect(isAvatarSeed("Chief avatar")).toBe(false);
    expect(isAvatarSeed("../chief")).toBe(false);
    expect(isAvatarSeed("a".repeat(129))).toBe(false);
  });

  it("accepts only the supported hue presets", () => {
    expect(isAvatarHue(215)).toBe(true);
    expect(isAvatarHue(214)).toBe(false);
    expect(isAvatarHue(null)).toBe(false);
  });
});

describe("sidebar layout event validation", () => {
  it("accepts a canonical sidebar layout event", () => {
    expect(
      isAgentEvent({
        type: "sidebar-layout-changed",
        layout: {
          revision: 3,
          sections: [{ id: "11111111-1111-4111-8111-111111111111", name: "Demo" }],
          order: ["people", "11111111-1111-4111-8111-111111111111", "unassigned"],
          agentAssignments: { chief: "11111111-1111-4111-8111-111111111111" },
          agentOrder: ["chief"],
        },
      }),
    ).toBe(true);
  });

  it("rejects malformed sidebar layout events", () => {
    expect(
      isAgentEvent({
        type: "sidebar-layout-changed",
        layout: {
          revision: -1,
          sections: [],
          order: ["people", "people", "unassigned"],
          agentAssignments: {},
          agentOrder: [],
        },
      }),
    ).toBe(false);
  });
});

describe("memory event validation", () => {
  it("accepts only a memory event with a bot id", () => {
    expect(isAgentEvent({ type: "memories-changed", botId: "chief" })).toBe(true);
    expect(isAgentEvent({ type: "memories-changed", botId: "" })).toBe(false);
    expect(isAgentEvent({ type: "memories-changed" })).toBe(false);
  });

  it("validates memory identifiers, text, and origin", () => {
    const memory = {
      id: "memory-1",
      botId: "chief",
      text: "Uses metric units.",
      origin: "manual",
      sourceTurnId: null,
      createdAt: "2026-08-25T12:00:00.000Z",
      updatedAt: "2026-08-25T12:00:00.000Z",
    };
    expect(isBotMemory(memory)).toBe(true);
    expect(isBotMemory({ ...memory, text: "" })).toBe(false);
    expect(isBotMemory({ ...memory, origin: "imported" })).toBe(false);
  });
});
