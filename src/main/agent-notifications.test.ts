// @vitest-environment node

import type { AgentEvent, BotSummary } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { notificationForAgentEvent } from "./agent-notifications";

const bot = {
  id: "chief",
  name: "Chief",
  notifications: true,
  role: "Lead",
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
} satisfies BotSummary;

describe("notificationForAgentEvent", () => {
  it("surfaces completed work and prompts for enabled agents", () => {
    expect(notificationForAgentEvent(completed("completed"), [bot])).toEqual({
      title: "Chief",
      body: "Finished working.",
    });
    expect(
      notificationForAgentEvent(
        {
          type: "prompt",
          botId: "chief",
          threadId: "thread-chief",
          turnId: "turn-1",
          requestId: 1,
          questions: [],
        },
        [bot],
      ),
    ).toEqual({ title: "Chief", body: "Needs your input." });
  });

  it("ignores disabled agents, non-successful turns, and unrelated events", () => {
    expect(notificationForAgentEvent(completed("failed"), [bot])).toBeNull();
    expect(notificationForAgentEvent(completed("completed"), [{ ...bot, notifications: false }])).toBeNull();
    expect(notificationForAgentEvent({ type: "bots-changed", bots: [] }, [bot])).toBeNull();
  });
});

function completed(status: string): AgentEvent {
  return {
    type: "turn-completed",
    botId: "chief",
    threadId: "thread-chief",
    turnId: "turn-1",
    status,
  };
}
