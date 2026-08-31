import { describe, expect, it } from "vitest";
import { chatTagReferences, expandChatTagReferences, serializeChatTagReference } from "./chat-tag-references";

describe("chat tag references", () => {
  it("serializes, locates, and expands agent and skill references", () => {
    const agent = serializeChatTagReference("agent", "Research", "agent-1");
    const skill = serializeChatTagReference("skill", "Release Notes", "skill-1");
    const value = `Ask ${agent} to use ${skill}.`;

    expect(chatTagReferences(value)).toEqual([
      { kind: "agent", id: "agent-1", name: "Research", start: 4, end: 30 },
      { kind: "skill", id: "skill-1", name: "Release Notes", start: 38, end: 69 },
    ]);
    expect(expandChatTagReferences(value)).toBe("Ask @Research to use Release Notes (skill).");
  });

  it("uses current names when available and leaves malformed markers untouched", () => {
    expect(
      expandChatTagReferences("@[Old name](agent:agent-1) @[broken](other:id)", (reference) =>
        reference.id === "agent-1" ? "New name" : undefined,
      ),
    ).toBe("@New name @[broken](other:id)");
  });
});
