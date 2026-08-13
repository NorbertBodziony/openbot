// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { AgentEvent, BotSummary } from "../shared/ipc";
import { notificationForAgentEvent } from "./agent-notifications";

const bot = {
  id: "chief",
  name: "Chief",
  notifications: true,
} as BotSummary;

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
    expect(
      notificationForAgentEvent(completed("completed"), [{ ...bot, notifications: false }]),
    ).toBeNull();
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
