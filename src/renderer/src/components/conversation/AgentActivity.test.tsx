import { describe, expect, it } from "vitest";
import { type AgentActivityPresentation, nextAgentActivityPresentation } from "./AgentActivity";

describe("AgentActivityIndicator", () => {
  it("does not repeat the previous animation or label", () => {
    const previous: AgentActivityPresentation = { animation: "thinking", label: "Working on it…" };
    const next = nextAgentActivityPresentation(previous, () => 0);

    expect(next.animation).not.toBe(previous.animation);
    expect(next.label).not.toBe(previous.label);
  });
});
