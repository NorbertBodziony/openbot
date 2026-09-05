// @vitest-environment node

import type { AgentEvent, AgentSummary } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { notificationForAgentEvent } from "./agent-notifications";

const agent = {
  id: "chief",
  provider: "codex",
  name: "Chief",
  notifications: true,
  title: "Lead",
  description: "",
  model: "gpt-5.6-luna",
  reasoningEffort: "medium",
  threadId: "thread-chief",
  workspacePath: "/tmp/chief",
  preview: "",
  updatedAt: null,
  avatarSeed: "chief",
  avatarHue: null,
  avatarUrl: null,
} satisfies AgentSummary;

describe("notificationForAgentEvent", () => {
  it("surfaces completed work and prompts for enabled agents", () => {
    expect(notificationForAgentEvent(completed("completed"), [agent])).toEqual({
      title: "Chief",
      body: "Finished working.",
      silent: true,
    });
    expect(
      notificationForAgentEvent(
        {
          type: "prompt",
          agentId: "chief",
          threadId: "thread-chief",
          turnId: "turn-1",
          requestId: 1,
          questions: [],
        },
        [agent],
      ),
    ).toEqual({ title: "Chief", body: "Needs your input." });
  });

  it("ignores disabled agents, non-successful turns, and unrelated events", () => {
    expect(notificationForAgentEvent(completed("failed"), [agent])).toBeNull();
    expect(notificationForAgentEvent(completed("completed"), [{ ...agent, notifications: false }])).toBeNull();
    expect(notificationForAgentEvent({ type: "agents-changed", agents: [] }, [agent])).toBeNull();
  });
});

function completed(status: string): AgentEvent {
  return {
    type: "turn-completed",
    agentId: "chief",
    threadId: "thread-chief",
    turnId: "turn-1",
    status,
  };
}
