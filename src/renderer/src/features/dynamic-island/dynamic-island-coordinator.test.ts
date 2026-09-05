import type { AgentEvent, AgentRuntimeSnapshot, AgentSummary } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { DynamicIslandCoordinator } from "./dynamic-island-coordinator";
import type { DynamicIslandPresentationInput } from "./dynamic-island-presentation";

describe("DynamicIslandCoordinator", () => {
  it("retains progress for the active turn and clears it when the turn completes", () => {
    const coordinator = new DynamicIslandCoordinator();
    seedAgents(coordinator, "remote", [agent("research", "Research")]);
    coordinator.applyEvent(
      scoped("remote", { type: "turn-started", agentId: "research", threadId: "thread-1", turnId: "turn-1" }),
      "local",
    );
    coordinator.applyEvent(
      scoped("remote", {
        type: "turn-progress",
        agentId: "research",
        threadId: "thread-1",
        turnId: "turn-1",
        detail: "Checking the release…",
      }),
      "local",
    );

    expect(coordinator.serverState("remote")?.turnProgress).toEqual({
      research: { turnId: "turn-1", detail: "Checking the release…" },
    });

    coordinator.applyEvent(
      scoped("remote", {
        type: "turn-completed",
        agentId: "research",
        threadId: "thread-1",
        turnId: "turn-1",
        status: "completed",
      }),
      "local",
    );
    expect(coordinator.serverState("remote")?.turnProgress).toEqual({});
  });

  it("selects the highest-priority notification across hosts and applies remote resolutions", () => {
    const coordinator = new DynamicIslandCoordinator();
    seedAgents(coordinator, "local", [agent("chief", "Chief")]);
    seedAgents(coordinator, "remote-a", [agent("research", "Research")]);
    seedAgents(coordinator, "remote-b", [agent("sales", "Sales")]);
    coordinator.applyEvent(scoped("remote-a", prompt("research", "question-1")), "local");
    coordinator.applyEvent(scoped("remote-b", approval("sales", "approval-1")), "local");

    expect(coordinator.presentation(["local", "remote-a", "remote-b"])).toMatchObject({
      serverId: "remote-a",
      mode: "question",
      remainingCount: 1,
      item: { requestId: "question-1" },
    });

    coordinator.applyEvent(
      scoped("remote-a", {
        type: "agent-input-resolved",
        kind: "prompt",
        requestId: "question-1",
        agentId: "research",
      }),
      "local",
    );

    expect(coordinator.presentation(["local", "remote-a", "remote-b"])).toMatchObject({
      serverId: "remote-b",
      mode: "approval",
      item: { requestId: "approval-1" },
    });

    coordinator.applyEvent(
      scoped("remote-b", {
        type: "agent-input-resolved",
        kind: "approval",
        requestId: "approval-1",
        agentId: "sales",
      }),
      "local",
    );
    expect(coordinator.presentation(["local", "remote-a", "remote-b"]).mode).toBe("idle");
  });

  it("keeps simultaneous requests from different agents and advances after each answer", () => {
    const coordinator = new DynamicIslandCoordinator();
    seedAgents(coordinator, "local", [agent("chief", "Chief"), agent("research", "Research")]);
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
      agentId: "chief",
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
    seedAgents(coordinator, "local", [agent("chief", "Chief")]);
    coordinator.applyEvent(
      scoped("local", {
        type: "turn-completed",
        agentId: "chief",
        threadId: "thread-chief",
        turnId: "turn-failed",
        status: "failed",
      }),
      "local",
    );

    coordinator.resolveAction({
      type: "open-failure",
      serverId: "local",
      agentId: "chief",
      turnId: "another-turn",
    });
    expect(coordinator.presentation(["local"]).mode).toBe("failed");

    coordinator.resolveAction({
      type: "open-failure",
      serverId: "local",
      agentId: "chief",
      turnId: "turn-failed",
    });
    expect(coordinator.presentation(["local"]).mode).toBe("idle");
  });

  it("tracks working and unread updates from an inactive host", () => {
    const coordinator = new DynamicIslandCoordinator();
    seedAgents(coordinator, "remote", [agent("research", "Research")]);
    coordinator.applyEvent(scoped("remote", conversation("research", 0, [])), "local");
    coordinator.applyEvent(
      scoped("remote", { type: "turn-started", agentId: "research", threadId: "thread-1", turnId: "turn-1" }),
      "local",
    );
    expect(coordinator.presentation(["remote"]).mode).toBe("working");

    coordinator.applyEvent(
      scoped(
        "remote",
        conversation("research", 1, [{ id: "message-1", text: "The result", createdAt: "2026-08-29T10:00:00.000Z" }]),
      ),
      "local",
    );
    coordinator.applyEvent(
      scoped("remote", {
        type: "conversation-delta",
        agentId: "research",
        threadId: "thread-1",
        turnId: "turn-1",
        messageId: "message-1",
        delta: " is ready.",
        createdAt: "2026-08-29T10:00:00.000Z",
        revision: 2,
      }),
      "local",
    );
    coordinator.applyEvent(
      scoped("remote", {
        type: "turn-completed",
        agentId: "research",
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

  it("removes a citation marker split across Dynamic Island deltas", () => {
    const coordinator = new DynamicIslandCoordinator();
    seedAgents(coordinator, "remote", [agent("research", "Research")]);
    coordinator.applyEvent(scoped("remote", conversation("research", 0, [])), "local");
    coordinator.applyEvent(
      scoped(
        "remote",
        conversation("research", 1, [
          { id: "message-1", text: "Storms are likely.", createdAt: "2026-08-29T10:00:00.000Z" },
        ]),
      ),
      "local",
    );
    coordinator.applyEvent(
      scoped("remote", {
        type: "conversation-delta",
        agentId: "research",
        threadId: "thread-1",
        turnId: "turn-1",
        messageId: "message-1",
        delta: "\u{e200}cite\u{e202}turn0fore",
        createdAt: "2026-08-29T10:00:00.000Z",
        revision: 2,
      }),
      "local",
    );
    expect(coordinator.presentation(["remote"])).toMatchObject({
      mode: "message",
      message: { text: "Storms are likely." },
    });

    coordinator.applyEvent(
      scoped("remote", {
        type: "conversation-delta",
        agentId: "research",
        threadId: "thread-1",
        turnId: "turn-1",
        messageId: "message-1",
        delta: "cast0\u{e201} Take care.",
        createdAt: "2026-08-29T10:00:00.000Z",
        revision: 3,
      }),
      "local",
    );
    expect(coordinator.presentation(["remote"])).toMatchObject({
      mode: "message",
      message: { text: "Storms are likely. Take care." },
    });
  });

  it("does not count or display non-reply items from a full conversation", () => {
    const coordinator = new DynamicIslandCoordinator();
    seedAgents(coordinator, "remote", [agent("research", "Research")]);
    coordinator.applyEvent(scoped("remote", conversation("research", 0, [])), "local");
    coordinator.applyEvent(
      scoped(
        "remote",
        conversation("research", 1, [
          {
            id: "commentary",
            text: "Checking the sources",
            createdAt: "2026-08-29T10:00:00.000Z",
            itemType: "commentary",
          },
          {
            id: "question",
            text: "Which source should I use?",
            createdAt: "2026-08-29T10:01:00.000Z",
            itemType: "question_prompt",
          },
          {
            id: "attachment",
            text: "",
            createdAt: "2026-08-29T10:02:00.000Z",
            itemType: "agent_attachment",
          },
        ]),
      ),
      "local",
    );

    expect(coordinator.presentation(["remote"]).mode).toBe("idle");
  });

  it("waits for a full conversation before classifying a new delta message", () => {
    const coordinator = new DynamicIslandCoordinator();
    seedAgents(coordinator, "remote", [agent("research", "Research")]);
    coordinator.applyEvent(scoped("remote", conversation("research", 0, [])), "local");
    coordinator.applyEvent(
      scoped("remote", {
        type: "conversation-delta",
        agentId: "research",
        threadId: "thread-research",
        turnId: "turn-research",
        messageId: "commentary",
        delta: "Checking the sources",
        createdAt: "2026-08-29T10:00:00.000Z",
        revision: 1,
      }),
      "local",
    );
    expect(coordinator.presentation(["remote"]).mode).toBe("idle");

    coordinator.applyEvent(
      scoped(
        "remote",
        conversation("research", 2, [
          {
            id: "commentary",
            text: "Checking the sources",
            createdAt: "2026-08-29T10:00:00.000Z",
            itemType: "commentary",
          },
        ]),
      ),
      "local",
    );
    expect(coordinator.presentation(["remote"]).mode).toBe("idle");
  });

  it("seeds an inactive host snapshot without counting historical replies as new", () => {
    const coordinator = new DynamicIslandCoordinator();
    seedAgents(coordinator, "remote", [agent("research", "Research")]);
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

  it("counts a buffered live legacy snapshot after the same baseline", () => {
    const coordinator = new DynamicIslandCoordinator();
    seedAgents(coordinator, "remote", [agent("research", "Research")]);
    const reply = conversation("research", 1, [
      { id: "live-reply", text: "Fresh reply", createdAt: "2026-08-29T10:00:00.000Z" },
    ]);
    coordinator.applyEvent(scoped("remote", reply), "local");
    coordinator.applyEvent({ ...scoped("remote", reply), bufferedLive: true }, "local");
    coordinator.applyEvent({ ...scoped("remote", reply), bufferedLive: true }, "local");

    expect(coordinator.presentation(["remote"])).toMatchObject({
      mode: "message",
      unreadCount: 1,
      message: { messageId: "live-reply" },
    });
  });

  it("counts a buffered live legacy reply when its baseline could not be loaded", () => {
    const coordinator = new DynamicIslandCoordinator();
    seedAgents(coordinator, "remote", [agent("research", "Research")]);
    const reply = conversation("research", 1, [
      { id: "live-reply", text: "Fresh reply", createdAt: "2026-08-29T10:00:00.000Z" },
    ]);

    coordinator.applyEvent({ ...scoped("remote", reply), bufferedLive: true }, "local");

    expect(coordinator.presentation(["remote"])).toMatchObject({
      mode: "message",
      unreadCount: 1,
      message: { messageId: "live-reply" },
    });
  });

  it("counts only replies after the runtime snapshot message when full history arrives", () => {
    const coordinator = new DynamicIslandCoordinator();
    const remoteAgent = agent("research", "Research");
    coordinator.applyEvent(
      scoped("remote", runtimeSnapshot({ agents: [remoteAgent], latestMessages: [runtimeMessage("anchor")] })),
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
    seedAgents(coordinator, "remote-working", [agent("builder", "Builder")]);
    seedAgents(coordinator, "remote-message", [agent("research", "Research")]);
    coordinator.applyEvent(
      scoped("remote-working", {
        type: "turn-started",
        agentId: "builder",
        threadId: "thread-builder",
        turnId: "turn-builder",
      }),
      "local",
    );
    coordinator.applyEvent(
      scoped("remote-message", {
        type: "conversation-delta",
        agentId: "research",
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
        agentId: "research",
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
    seedAgents(coordinator, "remote", [agent("research", "Research")]);
    coordinator.applyEvent(scoped("remote", prompt("research", "remote-question")), "local");
    coordinator.replaceServer(emptyInput("local", [agent("chief", "Chief")]));

    expect(coordinator.presentation(["local", "remote"])).toMatchObject({
      serverId: "remote",
      mode: "question",
      item: { requestId: "remote-question" },
    });
  });

  it("counts failures hidden behind a takeover on another host", () => {
    const coordinator = new DynamicIslandCoordinator();
    seedAgents(coordinator, "takeover", [agent("browser", "Browser"), agent("failed", "Failed")]);
    seedAgents(coordinator, "question", [agent("research", "Research")]);
    coordinator.applyEvent(
      scoped("takeover", {
        type: "browser-takeover-requested",
        request: {
          requestId: "takeover-1",
          agentId: "browser",
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
        agentId: "failed",
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
    const remoteAgent = agent("research", "Research");
    seedAgents(coordinator, "remote", [remoteAgent]);
    coordinator.applyEvent(scoped("remote", prompt("research", "stale-question")), "local");
    coordinator.applyEvent(
      scoped("remote", {
        type: "turn-started",
        agentId: "research",
        threadId: "thread-research",
        turnId: "stale-turn",
      }),
      "local",
    );

    coordinator.applyEvent(
      scoped(
        "remote",
        runtimeSnapshot({
          agents: [remoteAgent],
          latestMessages: [runtimeMessage("historical")],
          attentionComplete: false,
        }),
      ),
      "local",
    );
    expect(coordinator.presentation(["remote"])).toMatchObject({
      mode: "question",
      item: { requestId: "stale-question" },
    });

    coordinator.applyEvent(
      scoped(
        "remote",
        runtimeSnapshot({
          agents: [remoteAgent],
          activeTurns: [{ agentId: "research", threadId: "thread-research", turnId: "turn-current" }],
          work: [
            {
              id: "delivery-current",
              agentId: "research",
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
      scoped("remote", runtimeSnapshot({ agents: [remoteAgent], latestMessages: [runtimeMessage("missed-reply")] })),
      "local",
    );
    expect(coordinator.presentation(["remote"])).toMatchObject({
      mode: "message",
      unreadCount: 1,
      message: { messageId: "missed-reply" },
    });
  });

  it("shows a completed reply after reconnecting during its turn", () => {
    const coordinator = new DynamicIslandCoordinator();
    const remoteAgent = agent("research", "Research");
    coordinator.applyEvent(
      scoped(
        "remote",
        runtimeSnapshot({
          agents: [remoteAgent],
          activeTurns: [{ agentId: "research", threadId: "thread-research", turnId: "turn-current" }],
          latestMessages: [runtimeMessage("reply-previous")],
        }),
      ),
      "local",
    );
    coordinator.applyEvent(
      scoped("remote", {
        type: "conversation-delta",
        agentId: "research",
        threadId: "thread-research",
        turnId: "turn-current",
        messageId: "reply-current",
        delta: "Fresh reply",
        createdAt: "2026-08-29T10:00:00.000Z",
        revision: 2,
      }),
      "local",
    );
    coordinator.applyEvent(
      scoped("remote", {
        type: "turn-completed",
        agentId: "research",
        threadId: "thread-research",
        turnId: "turn-current",
        status: "completed",
      }),
      "local",
    );
    coordinator.applyEvent(
      scoped("remote", runtimeSnapshot({ agents: [remoteAgent], latestMessages: [runtimeMessage("reply-current")] })),
      "local",
    );

    expect(coordinator.presentation(["remote"])).toMatchObject({
      mode: "message",
      unreadCount: 1,
      message: { messageId: "reply-current" },
    });
  });
});

function seedAgents(coordinator: DynamicIslandCoordinator, serverId: string, agents: AgentSummary[]): void {
  coordinator.applyEvent(scoped(serverId, { type: "agents-changed", agents }), serverId);
}

function scoped(serverId: string, event: AgentEvent) {
  return { serverId, event };
}

function prompt(agentId: string, requestId: string): Extract<AgentEvent, { type: "prompt" }> {
  return {
    type: "prompt",
    requestId,
    agentId,
    threadId: `thread-${agentId}`,
    turnId: `turn-${agentId}`,
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

function approval(agentId: string, requestId: string): Extract<AgentEvent, { type: "approval" }> {
  return {
    type: "approval",
    approval: {
      requestId,
      agentId,
      threadId: `thread-${agentId}`,
      turnId: `turn-${agentId}`,
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
  agentId: string,
  revision: number,
  messages: Array<{ id: string; text: string; createdAt: string; itemType?: string }>,
): Extract<AgentEvent, { type: "conversation" }> {
  return {
    type: "conversation",
    snapshot: {
      agentId,
      threadId: `thread-${agentId}`,
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

function emptyInput(serverId: string, agents: AgentSummary[]): DynamicIslandPresentationInput {
  return {
    serverId,
    agents,
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
      agents: [],
      activeTurns: [],
      work: [],
      latestMessages: [],
      attentionComplete: true,
      pendingPrompts: [],
      pendingApprovals: [],
      pendingBrowserTakeovers: [],
      failedTurns: [],
      ...overrides,
    },
  };
}

function runtimeMessage(id: string): AgentRuntimeSnapshot["latestMessages"][number] {
  return { agentId: "research", id, text: id, createdAt: "2026-08-29T10:00:00.000Z" };
}

function agent(id: string, name: string): AgentSummary {
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
