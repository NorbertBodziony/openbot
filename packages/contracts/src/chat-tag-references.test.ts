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

  it("round-trips names and ids containing marker delimiters", () => {
    const name = " C] Guide\n~advanced ";
    const id = " skill)id\r\n~v2 ";
    const marker = serializeChatTagReference("skill", name, id);

    expect(marker).toContain("skill+uri:");
    expect(marker).not.toContain(name);
    expect(chatTagReferences(marker)).toEqual([{ kind: "skill", id, name, start: 0, end: marker.length }]);
    expect(expandChatTagReferences(marker)).toBe(`${name} (skill)`);
  });

  it("does not decode legacy marker text that resembles URI encoding", () => {
    expect(chatTagReferences("@[~C%5D Guide](skill:~guide%29advanced)")).toEqual([
      {
        kind: "skill",
        id: "~guide%29advanced",
        name: "~C%5D Guide",
        start: 0,
        end: 39,
      },
    ]);
  });
});
