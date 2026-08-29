import type { AgentEvent, BotSummary } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { DynamicIslandCoordinator } from "./dynamic-island-coordinator";
import type { DynamicIslandPresentationInput } from "./dynamic-island-presentation";

describe("DynamicIslandCoordinator", () => {
  it("selects the highest-priority notification across hosts and reveals the next item after an action", () => {
    const coordinator = new DynamicIslandCoordinator();
    coordinator.setBots("local", [bot("chief", "Chief")]);
    coordinator.setBots("remote-a", [bot("research", "Research")]);
    coordinator.setBots("remote-b", [bot("sales", "Sales")]);
    coordinator.applyEvent(scoped("remote-a", prompt("research", "question-1")), "local");
    coordinator.applyEvent(scoped("remote-b", approval("sales", "approval-1")), "local");

    expect(coordinator.presentation(["local", "remote-a", "remote-b"])).toMatchObject({
      serverId: "remote-b",
      mode: "approval",
      remainingCount: 1,
      item: { requestId: "approval-1" },
    });

    coordinator.resolveAction({
      type: "approve-attention",
      serverId: "remote-b",
      botId: "sales",
      requestId: "approval-1",
    });

    expect(coordinator.presentation(["local", "remote-a", "remote-b"])).toMatchObject({
      serverId: "remote-a",
      mode: "question",
      item: { requestId: "question-1" },
    });
  });

  it("keeps simultaneous requests from different bots and advances after each answer", () => {
    const coordinator = new DynamicIslandCoordinator();
    coordinator.setBots("local", [bot("chief", "Chief"), bot("research", "Research")]);
    coordinator.applyEvent(scoped("local", prompt("chief", "question-chief")), "local");
    coordinator.applyEvent(scoped("local", prompt("research", "question-research")), "local");

    expect(coordinator.presentation(["local"])).toMatchObject({
      mode: "question",
      remainingCount: 1,
      item: { requestId: "question-chief" },
    });

    coordinator.resolveAction({
      type: "answer-prompt",
      serverId: "local",
      botId: "chief",
      requestId: "question-chief",
      answers: { source: ["Official data"] },
    });

    expect(coordinator.presentation(["local"])).toMatchObject({
      mode: "question",
      remainingCount: 0,
      item: { requestId: "question-research" },
    });
  });

  it("tracks working and unread updates from an inactive host", () => {
    const coordinator = new DynamicIslandCoordinator();
    coordinator.setBots("remote", [bot("research", "Research")]);
    coordinator.applyEvent(
      scoped("remote", { type: "turn-started", botId: "research", threadId: "thread-1", turnId: "turn-1" }),
      "local",
    );
    expect(coordinator.presentation(["remote"]).mode).toBe("working");

    coordinator.applyEvent(
      scoped("remote", {
        type: "conversation-delta",
        botId: "research",
        threadId: "thread-1",
        turnId: "turn-1",
        messageId: "message-1",
        delta: "The result is ready.",
        createdAt: "2026-08-29T10:00:00.000Z",
        revision: 1,
      }),
      "local",
    );
    coordinator.applyEvent(
      scoped("remote", {
        type: "turn-completed",
        botId: "research",
        threadId: "thread-1",
        turnId: "turn-1",
        status: "completed",
      }),
      "local",
    );

    expect(coordinator.presentation(["remote"])).toMatchObject({
      serverId: "remote",
      mode: "message",
      unreadCount: 1,
      message: { messageId: "message-1", text: "The result is ready." },
    });
  });

  it("replaces the active server snapshot without deleting pending state from another host", () => {
    const coordinator = new DynamicIslandCoordinator();
    coordinator.setBots("remote", [bot("research", "Research")]);
    coordinator.applyEvent(scoped("remote", prompt("research", "remote-question")), "local");
    coordinator.replaceServer(emptyInput("local", [bot("chief", "Chief")]));

    expect(coordinator.presentation(["local", "remote"])).toMatchObject({
      serverId: "remote",
      mode: "question",
      item: { requestId: "remote-question" },
    });
  });
});

function scoped(serverId: string, event: AgentEvent) {
  return { serverId, event };
}

function prompt(botId: string, requestId: string): Extract<AgentEvent, { type: "prompt" }> {
  return {
    type: "prompt",
    requestId,
    botId,
    threadId: `thread-${botId}`,
    turnId: `turn-${botId}`,
    questions: [
      {
        id: "source",
        header: "Choose a source",
        question: "Which source should I use?",
        isSecret: false,
        options: [{ label: "Official data", description: "Use the public dataset" }],
      },
    ],
  };
}

function approval(botId: string, requestId: string): Extract<AgentEvent, { type: "approval" }> {
  return {
    type: "approval",
    approval: {
      requestId,
      botId,
      threadId: `thread-${botId}`,
      turnId: `turn-${botId}`,
      kind: "command",
      command: "bun test",
      cwd: "/workspace",
      reason: "Run the test suite.",
      grantRoot: null,
      permissions: null,
    },
  };
}

function emptyInput(serverId: string, bots: BotSummary[]): DynamicIslandPresentationInput {
  return {
    serverId,
    bots,
    activeTurns: {},
    queues: {},
    unreadReplies: {},
    liveMessages: {},
    pendingPrompts: {},
    pendingApprovals: {},
    failedTurns: {},
  };
}

function bot(id: string, name: string): BotSummary {
  return {
    id,
    name,
    title: "Agent",
    description: "Agent",
    notifications: true,
    provider: "codex",
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
    threadId: `thread-${id}`,
    workspacePath: `/workspace/${id}`,
    preview: "",
    updatedAt: null,
    avatarSeed: id,
    avatarHue: null,
    avatarUrl: null,
  };
}
