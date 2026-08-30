import type { AgentEvent, AgentRuntimeSnapshot, BotSummary } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { DynamicIslandCoordinator } from "./dynamic-island-coordinator";
import type { DynamicIslandPresentationInput } from "./dynamic-island-presentation";

describe("DynamicIslandCoordinator", () => {
  it("selects the highest-priority notification across hosts and reveals the next item after an action", () => {
    const coordinator = new DynamicIslandCoordinator();
    seedBots(coordinator, "local", [bot("chief", "Chief")]);
    seedBots(coordinator, "remote-a", [bot("research", "Research")]);
    seedBots(coordinator, "remote-b", [bot("sales", "Sales")]);
    coordinator.applyEvent(scoped("remote-a", prompt("research", "question-1")), "local");
    coordinator.applyEvent(scoped("remote-b", approval("sales", "approval-1")), "local");

    expect(coordinator.presentation(["local", "remote-a", "remote-b"])).toMatchObject({
      serverId: "remote-a",
      mode: "question",
      remainingCount: 1,
      item: { requestId: "question-1" },
    });

    coordinator.resolveAction({
      type: "answer-prompt",
      serverId: "remote-a",
      botId: "research",
      requestId: "question-1",
      answers: { source: ["Official data"] },
    });

    expect(coordinator.presentation(["local", "remote-a", "remote-b"])).toMatchObject({
      serverId: "remote-b",
      mode: "approval",
      item: { requestId: "approval-1" },
    });
  });

  it("keeps simultaneous requests from different bots and advances after each answer", () => {
    const coordinator = new DynamicIslandCoordinator();
    seedBots(coordinator, "local", [bot("chief", "Chief"), bot("research", "Research")]);
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

  it("removes only the matching failure after it is opened", () => {
    const coordinator = new DynamicIslandCoordinator();
    seedBots(coordinator, "local", [bot("chief", "Chief")]);
    coordinator.applyEvent(
      scoped("local", {
        type: "turn-completed",
        botId: "chief",
        threadId: "thread-chief",
        turnId: "turn-failed",
        status: "failed",
      }),
      "local",
    );

    coordinator.resolveAction({
      type: "open-failure",
      serverId: "local",
      botId: "chief",
      turnId: "another-turn",
    });
    expect(coordinator.presentation(["local"]).mode).toBe("failed");

    coordinator.resolveAction({
      type: "open-failure",
      serverId: "local",
      botId: "chief",
      turnId: "turn-failed",
    });
    expect(coordinator.presentation(["local"]).mode).toBe("idle");
  });

  it("tracks working and unread updates from an inactive host", () => {
    const coordinator = new DynamicIslandCoordinator();
    seedBots(coordinator, "remote", [bot("research", "Research")]);
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

  it("seeds an inactive host snapshot without counting historical replies as new", () => {
    const coordinator = new DynamicIslandCoordinator();
    seedBots(coordinator, "remote", [bot("research", "Research")]);
    const historical = conversation("research", 1, [
      { id: "historical", text: "Historical reply", createdAt: "2026-08-29T09:00:00.000Z" },
    ]);

    coordinator.applyEvent(scoped("remote", historical), "local");
    expect(coordinator.presentation(["remote"]).mode).toBe("idle");

    coordinator.applyEvent(
      scoped(
        "remote",
        conversation("research", 2, [
          { id: "historical", text: "Historical reply", createdAt: "2026-08-29T09:00:00.000Z" },
          { id: "new-reply", text: "Fresh reply", createdAt: "2026-08-29T10:00:00.000Z" },
        ]),
      ),
      "local",
    );
    coordinator.applyEvent(
      scoped(
        "remote",
        conversation("research", 3, [
          { id: "historical", text: "Historical reply", createdAt: "2026-08-29T09:00:00.000Z" },
          { id: "new-reply", text: "Fresh reply", createdAt: "2026-08-29T10:00:00.000Z" },
        ]),
      ),
      "local",
    );

    expect(coordinator.presentation(["remote"])).toMatchObject({
      mode: "message",
      unreadCount: 1,
      message: { messageId: "new-reply", text: "Fresh reply" },
    });
  });

  it("counts only replies after the runtime snapshot message when full history arrives", () => {
    const coordinator = new DynamicIslandCoordinator();
    const remoteBot = bot("research", "Research");
    coordinator.applyEvent(
      scoped("remote", runtimeSnapshot({ bots: [remoteBot], latestMessages: [runtimeMessage("anchor")] })),
      "local",
    );

    coordinator.applyEvent(
      scoped(
        "remote",
        conversation("research", 1, [
          { id: "historical", text: "Historical reply", createdAt: "2026-08-29T09:00:00.000Z" },
          { id: "anchor", text: "Snapshot reply", createdAt: "2026-08-29T10:00:00.000Z" },
          { id: "fresh", text: "Fresh reply", createdAt: "2026-08-29T11:00:00.000Z" },
        ]),
      ),
      "local",
    );

    expect(coordinator.presentation(["remote"])).toMatchObject({
      mode: "message",
      unreadCount: 1,
      message: { messageId: "fresh", text: "Fresh reply" },
    });
  });

  it("keeps working ahead of an unread message across hosts", () => {
    const coordinator = new DynamicIslandCoordinator();
    seedBots(coordinator, "remote-working", [bot("builder", "Builder")]);
    seedBots(coordinator, "remote-message", [bot("research", "Research")]);
    coordinator.applyEvent(
      scoped("remote-working", {
        type: "turn-started",
        botId: "builder",
        threadId: "thread-builder",
        turnId: "turn-builder",
      }),
      "local",
    );
    coordinator.applyEvent(
      scoped("remote-message", {
        type: "conversation-delta",
        botId: "research",
        threadId: "thread-research",
        turnId: "turn-research",
        messageId: "message-research",
        delta: "The source review is ready.",
        createdAt: "2026-08-29T10:00:00.000Z",
        revision: 1,
      }),
      "local",
    );
    coordinator.applyEvent(
      scoped("remote-message", {
        type: "turn-completed",
        botId: "research",
        threadId: "thread-research",
        turnId: "turn-research",
        status: "completed",
      }),
      "local",
    );

    expect(coordinator.presentation(["remote-message", "remote-working"])).toMatchObject({
      serverId: "remote-working",
      mode: "working",
    });
  });

  it("replaces the active server snapshot without deleting pending state from another host", () => {
    const coordinator = new DynamicIslandCoordinator();
    seedBots(coordinator, "remote", [bot("research", "Research")]);
    coordinator.applyEvent(scoped("remote", prompt("research", "remote-question")), "local");
    coordinator.replaceServer(emptyInput("local", [bot("chief", "Chief")]));

    expect(coordinator.presentation(["local", "remote"])).toMatchObject({
      serverId: "remote",
      mode: "question",
      item: { requestId: "remote-question" },
    });
  });

  it("counts failures hidden behind a takeover on another host", () => {
    const coordinator = new DynamicIslandCoordinator();
    seedBots(coordinator, "takeover", [bot("browser", "Browser"), bot("failed", "Failed")]);
    seedBots(coordinator, "question", [bot("research", "Research")]);
    coordinator.applyEvent(
      scoped("takeover", {
        type: "browser-takeover-requested",
        request: {
          requestId: "takeover-1",
          botId: "browser",
          threadId: "thread-browser",
          turnId: "turn-browser",
          tabId: "tab-1",
        },
      }),
      "local",
    );
    coordinator.applyEvent(
      scoped("takeover", {
        type: "turn-completed",
        botId: "failed",
        threadId: "thread-failed",
        turnId: "turn-failed",
        status: "failed",
      }),
      "local",
    );
    coordinator.applyEvent(scoped("question", prompt("research", "question-1")), "local");

    expect(coordinator.presentation(["takeover", "question"])).toMatchObject({
      mode: "question",
      remainingCount: 2,
    });
  });

  it("atomically repairs stale remote state after reconnect", () => {
    const coordinator = new DynamicIslandCoordinator();
    const remoteBot = bot("research", "Research");
    seedBots(coordinator, "remote", [remoteBot]);
    coordinator.applyEvent(scoped("remote", prompt("research", "stale-question")), "local");
    coordinator.applyEvent(
      scoped("remote", {
        type: "turn-started",
        botId: "research",
        threadId: "thread-research",
        turnId: "stale-turn",
      }),
      "local",
    );

    coordinator.applyEvent(
      scoped(
        "remote",
        runtimeSnapshot({
          bots: [remoteBot],
          activeTurns: [{ botId: "research", threadId: "thread-research", turnId: "turn-current" }],
          work: [
            {
              id: "delivery-current",
              botId: "research",
              turnId: "turn-current",
              status: "running",
              text: "Review sources",
              error: null,
            },
          ],
          latestMessages: [runtimeMessage("historical")],
        }),
      ),
      "local",
    );
    expect(coordinator.presentation(["remote"])).toMatchObject({
      mode: "working",
      working: [{ task: "Review sources" }],
    });

    coordinator.applyEvent(
      scoped("remote", runtimeSnapshot({ bots: [remoteBot], latestMessages: [runtimeMessage("missed-reply")] })),
      "local",
    );
    expect(coordinator.presentation(["remote"])).toMatchObject({
      mode: "message",
      unreadCount: 1,
      message: { messageId: "missed-reply" },
    });
  });
});

function seedBots(coordinator: DynamicIslandCoordinator, serverId: string, bots: BotSummary[]): void {
  coordinator.applyEvent(scoped(serverId, { type: "bots-changed", bots }), serverId);
}

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
      kind: "permissions",
      command: null,
      cwd: null,
      reason: "Access the project files.",
      grantRoot: "/workspace",
      permissions: { fileSystem: { read: ["/workspace"], write: ["/workspace"] }, network: false },
    },
  };
}

function conversation(
  botId: string,
  revision: number,
  messages: Array<{ id: string; text: string; createdAt: string }>,
): Extract<AgentEvent, { type: "conversation" }> {
  return {
    type: "conversation",
    snapshot: {
      botId,
      threadId: `thread-${botId}`,
      activeTurnId: null,
      revision,
      messages: messages.map((message) => ({
        ...message,
        author: "assistant",
        status: "completed",
      })),
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

function runtimeSnapshot(
  overrides: Partial<AgentRuntimeSnapshot> = {},
): Extract<AgentEvent, { type: "runtime-snapshot" }> {
  return {
    type: "runtime-snapshot",
    snapshot: {
      bots: [],
      activeTurns: [],
      work: [],
      latestMessages: [],
      pendingPrompts: [],
      pendingApprovals: [],
      pendingBrowserTakeovers: [],
      failedTurns: [],
      ...overrides,
    },
  };
}

function runtimeMessage(id: string): AgentRuntimeSnapshot["latestMessages"][number] {
  return { botId: "research", id, text: id, createdAt: "2026-08-29T10:00:00.000Z" };
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
