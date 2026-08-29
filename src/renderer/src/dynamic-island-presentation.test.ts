import type { AgentApproval } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import type { BotProfile } from "./data";
import { createDynamicIslandPresentation, type DynamicIslandPresentationInput } from "./dynamic-island-presentation";

const bot: BotProfile = {
  id: "chief",
  name: "Chief",
  title: "Coordinator",
  description: "Coordinates work",
  notifications: true,
  provider: "codex",
  model: "gpt-5",
  reasoningEffort: "medium",
  threadId: "thread-1",
  avatarSeed: "chief",
  avatarHue: 215,
  avatarUrl: null,
  time: "now",
  preview: "Ready",
};

const research: BotProfile = {
  ...bot,
  id: "research",
  name: "Research",
  threadId: "thread-2",
  avatarSeed: "research",
  avatarHue: 150,
};

function state(): DynamicIslandPresentationInput {
  return {
    serverId: "local",
    bots: [bot],
    activeTurns: {},
    queues: {},
    unreadReplies: {},
    liveMessages: {},
    pendingPrompts: {},
    pendingApprovals: {},
    failedTurns: {},
  };
}

describe("createDynamicIslandPresentation", () => {
  it("uses the required priority and returns to idle", () => {
    const input = state();
    expect(createDynamicIslandPresentation(input).mode).toBe("idle");
    input.activeTurns.chief = "turn-1";
    expect(createDynamicIslandPresentation(input).mode).toBe("working");
    input.unreadReplies.chief = 2;
    input.liveMessages.chief = [{ id: "m1", author: "bot", body: "Done", time: "now" }];
    expect(createDynamicIslandPresentation(input).mode).toBe("message");
    input.pendingPrompts.chief = {
      type: "prompt",
      requestId: "prompt-1",
      botId: "chief",
      threadId: "thread-1",
      turnId: "turn-1",
      questions: [{ id: "q1", header: "Choose a source", question: "Which source?", isSecret: false, options: null }],
    };
    const presentation = createDynamicIslandPresentation(input);
    expect(presentation.mode).toBe("question");
    expect(presentation.attention[0]).toMatchObject({
      requestId: "prompt-1",
      kind: "prompt",
      detail: "Which source?",
      questions: [
        {
          id: "q1",
          header: "Choose a source",
          question: "Which source?",
          isSecret: false,
          options: null,
        },
      ],
      approval: null,
    });
  });

  it("counts approvals and limits visible items", () => {
    const input = state();
    const approval: AgentApproval = {
      requestId: "approval-1",
      botId: "chief",
      threadId: "thread-1",
      turnId: "turn-1",
      kind: "command",
      command: "bun test",
      cwd: null,
      reason: null,
      grantRoot: null,
      permissions: null,
    };
    input.pendingApprovals.chief = approval;
    const presentation = createDynamicIslandPresentation(input);
    expect(presentation.attentionCount).toBe(1);
    expect(presentation.attention).toHaveLength(1);
    expect(presentation.mode).toBe("approval");
    expect(presentation.attention[0]).toMatchObject({
      requestId: "approval-1",
      kind: "approval",
      approval: { kind: "command", command: "bun test" },
    });
  });

  it("shows an approval before a question", () => {
    const input = state();
    input.pendingPrompts.chief = {
      type: "prompt",
      requestId: "prompt-1",
      botId: "chief",
      threadId: "thread-1",
      turnId: "turn-1",
      questions: [{ id: "q1", header: "Choose", question: "Which option?", isSecret: false, options: null }],
    };
    input.pendingApprovals.chief = {
      requestId: "approval-1",
      botId: "chief",
      threadId: "thread-1",
      turnId: "turn-1",
      kind: "file-change",
      command: null,
      cwd: null,
      reason: "Update the generated files.",
      grantRoot: "/workspace",
      permissions: null,
    };

    const presentation = createDynamicIslandPresentation(input);

    expect(presentation.mode).toBe("approval");
    expect(presentation.attention.map((item) => item.kind)).toEqual(["approval", "prompt"]);
  });

  it("surfaces a browser takeover before a question", () => {
    const input = state();
    input.bots = [bot, research];
    input.pendingPrompts.chief = {
      type: "prompt",
      requestId: "prompt-1",
      botId: "chief",
      threadId: "thread-1",
      turnId: "turn-1",
      questions: [{ id: "q1", header: "Choose", question: "Which option?", isSecret: false, options: null }],
    };
    input.pendingPrompts.research = {
      type: "browser-takeover-requested",
      request: {
        requestId: "takeover-1",
        botId: "research",
        threadId: "thread-2",
        turnId: "turn-2",
        tabId: "tab-login",
      },
    };

    const presentation = createDynamicIslandPresentation(input);

    expect(presentation.mode).toBe("takeover");
    expect(presentation.attention[0]).toMatchObject({
      requestId: "takeover-1",
      kind: "takeover",
      bot: { id: "research" },
      title: "Browser step needs you",
      detail: "Complete the sign-in, verification, or consent in the browser.",
    });
  });

  it("shows a fresh task failure with the delivery error", () => {
    const input = state();
    input.failedTurns.chief = "turn-failed";
    input.queues.chief = {
      botId: "chief",
      deliveries: [
        {
          id: "delivery-failed",
          messageId: "message-failed",
          recipientBotId: "chief",
          sender: { kind: "user" },
          text: "Collect the sources",
          attachments: [],
          replyToMessageId: null,
          status: "failed",
          position: null,
          turnId: "turn-failed",
          error: "The browser tab closed unexpectedly.",
          createdAt: "2026-08-29T10:42:00.000Z",
        },
      ],
    };

    const presentation = createDynamicIslandPresentation(input);

    expect(presentation.mode).toBe("failed");
    expect(presentation.attentionCount).toBe(1);
    expect(presentation.attention[0]).toMatchObject({
      kind: "failure",
      requestId: "turn-failed",
      detail: "The browser tab closed unexpectedly.",
    });
  });

  it("counts multiple working bots and unread replies", () => {
    const input = state();
    input.bots = [bot, research];
    input.activeTurns = { chief: "turn-1", research: "turn-2" };
    input.unreadReplies = { chief: 2, research: 3 };
    input.liveMessages = {
      chief: [{ id: "m1", author: "bot", body: "Launch plan ready", time: "now" }],
      research: [{ id: "m2", author: "bot", body: "Sources ready", time: "now" }],
    };
    const presentation = createDynamicIslandPresentation(input);
    expect(presentation.activeCount).toBe(2);
    expect(presentation.unreadCount).toBe(5);
    expect(presentation.mode).toBe("message");
  });
});
