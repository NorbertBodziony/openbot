import { type AgentApproval, isDynamicIslandPresentation } from "@openbot/contracts/ipc";
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
  it("uses the bot preview when an unread conversation is not loaded", () => {
    const input = state();
    input.bots = [{ ...research, preview: "The source review is ready." }];
    input.unreadReplies.research = 3;
    input.unreadMessageIds = { research: "reply-research" };

    expect(createDynamicIslandPresentation(input)).toMatchObject({
      mode: "message",
      unreadCount: 3,
      message: {
        bot: { id: "research" },
        messageId: "reply-research",
        text: "The source review is ready.",
      },
    });
  });

  it("keeps long live data inside the validated overlay contract", () => {
    const input = state();
    input.unreadReplies.chief = 1;
    input.liveMessages.chief = [{ id: "long-message", author: "bot", body: "m".repeat(2_000), time: "" }];

    const message = createDynamicIslandPresentation(input);
    expect(isDynamicIslandPresentation(message)).toBe(true);

    input.unreadReplies = {};
    input.liveMessages = {};
    input.pendingApprovals.chief = {
      requestId: "long-approval",
      botId: "chief",
      threadId: "thread-1",
      turnId: "turn-1",
      kind: "command",
      command: "c".repeat(2_000),
      cwd: null,
      reason: "r".repeat(2_000),
      grantRoot: null,
      permissions: null,
    };

    expect(isDynamicIslandPresentation(createDynamicIslandPresentation(input))).toBe(true);

    input.pendingApprovals = {};
    input.pendingPrompts.chief = {
      type: "prompt",
      requestId: "long-question",
      botId: "chief",
      threadId: "thread-1",
      turnId: "turn-1",
      questions: [
        { id: "question", header: "h".repeat(120), question: "q".repeat(2_000), isSecret: false, options: null },
      ],
    };

    expect(isDynamicIslandPresentation(createDynamicIslandPresentation(input))).toBe(true);
  });

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
    if (presentation.mode !== "question") throw new Error("Expected a question presentation.");
    expect(presentation.item).toMatchObject({
      requestId: "prompt-1",
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
    });
  });

  it("maps approvals to the approval presentation", () => {
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
    expect(presentation.mode).toBe("approval");
    if (presentation.mode !== "approval") throw new Error("Expected an approval presentation.");
    expect(presentation.remainingCount).toBe(0);
    expect(presentation.item).toMatchObject({
      requestId: "approval-1",
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
    if (presentation.mode !== "approval") throw new Error("Expected an approval presentation.");
    expect(presentation.item.requestId).toBe("approval-1");
    expect(presentation.remainingCount).toBe(1);
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
    if (presentation.mode !== "takeover") throw new Error("Expected a takeover presentation.");
    expect(presentation.item).toMatchObject({
      requestId: "takeover-1",
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
    if (presentation.mode !== "failed") throw new Error("Expected a failure presentation.");
    expect(presentation.item).toMatchObject({
      turnId: "turn-failed",
      detail: "The browser tab closed unexpectedly.",
    });
  });

  it("aggregates unread replies across working bots", () => {
    const input = state();
    input.bots = [bot, research];
    input.activeTurns = { chief: "turn-1", research: "turn-2" };
    input.unreadReplies = { chief: 2, research: 3 };
    input.liveMessages = {
      chief: [{ id: "m1", author: "bot", body: "Launch plan ready", time: "now" }],
      research: [{ id: "m2", author: "bot", body: "Sources ready", time: "now" }],
    };
    const presentation = createDynamicIslandPresentation(input);
    expect(presentation.mode).toBe("message");
    if (presentation.mode !== "message") throw new Error("Expected a message presentation.");
    expect(presentation.unreadCount).toBe(5);
  });
});
