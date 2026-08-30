import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import {
  type AgentApproval,
  type DynamicIslandPresentation,
  isDynamicIslandPresentation,
} from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import type { BotProfile } from "./data";
import {
  createDynamicIslandPresentation,
  type DynamicIslandPresentationInput,
  selectDynamicIslandPresentation,
} from "./dynamic-island-presentation";

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
  it("selects the complete production priority order", () => {
    const identity = {
      id: bot.id,
      name: bot.name,
      avatarSeed: bot.avatarSeed,
      avatarHue: bot.avatarHue,
      avatarUrl: bot.avatarUrl,
    };
    const candidates: DynamicIslandPresentation[] = [
      { serverId: "idle", mode: "idle" },
      {
        serverId: "message",
        mode: "message",
        unreadCount: 1,
        message: { bot: identity, messageId: "message-1", text: "Ready", createdAt: "now" },
      },
      { serverId: "working", mode: "working", working: [{ bot: identity, task: "Running checks" }] },
      {
        serverId: "failed",
        mode: "failed",
        item: { turnId: "turn-failed", bot: identity, title: "Failed", detail: "The task failed." },
      },
      {
        serverId: "takeover",
        mode: "takeover",
        item: { requestId: "takeover-1", bot: identity, title: "Take over", detail: "Complete the step." },
      },
      {
        serverId: "approval",
        mode: "approval",
        remainingCount: 0,
        item: {
          requestId: "approval-1",
          bot: identity,
          title: "Approve access",
          detail: "Review access.",
          approval: {
            kind: "permissions",
            command: null,
            cwd: null,
            reason: "Review access.",
            grantRoot: null,
            permissions: { fileSystem: { read: ["/workspace"], write: [] }, network: false },
          },
        },
      },
      {
        serverId: "question",
        mode: "question",
        remainingCount: 0,
        item: {
          requestId: "question-1",
          bot: identity,
          title: "Choose",
          detail: "Which option?",
          questions: [{ id: "choice", header: "Choose", question: "Which option?", isSecret: false, options: null }],
        },
      },
    ];
    const selectedModes: DynamicIslandPresentation["mode"][] = [];

    while (candidates.length > 0) {
      const selected = selectDynamicIslandPresentation(candidates);
      selectedModes.push(selected.mode);
      candidates.splice(
        candidates.findIndex((candidate) => candidate.mode === selected.mode),
        1,
      );
    }

    expect(selectedModes).toEqual(["question", "approval", "takeover", "failed", "working", "message", "idle"]);
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

  it("normalizes malformed and oversized prompt display fields before publication", () => {
    const input = state();
    input.pendingPrompts.chief = {
      type: "prompt",
      requestId: "normalized-question",
      botId: "chief",
      threadId: "thread-1",
      turnId: "turn-1",
      questions: Array.from({ length: INPUT_LIMITS.promptQuestions + 4 }, (_, index) => ({
        id: index === 0 ? "" : `question-${index}`.repeat(20),
        header: index === 0 ? "" : "h".repeat(INPUT_LIMITS.promptHeader + 20),
        question: index === 0 ? "" : "q".repeat(INPUT_LIMITS.promptQuestion + 20),
        isSecret: false,
        options: Array.from({ length: INPUT_LIMITS.promptOptions + 2 }, (_, optionIndex) => ({
          label: optionIndex === 0 ? "" : "l".repeat(INPUT_LIMITS.promptOptionLabel + 20),
          description: optionIndex === 0 ? "" : "d".repeat(INPUT_LIMITS.promptOptionDescription + 20),
        })),
      })),
    };

    const presentation = createDynamicIslandPresentation(input);

    expect(isDynamicIslandPresentation(presentation)).toBe(true);
    expect(presentation.mode).toBe("question");
    if (presentation.mode !== "question") throw new Error("Expected a question presentation.");
    expect(presentation.item.questions).toHaveLength(INPUT_LIMITS.promptQuestions);
    const firstQuestion = presentation.item.questions[0];
    expect(firstQuestion).toMatchObject({
      id: "question-1",
      header: "Question from your bot",
      question: "Open OpenBot to answer this question.",
    });
    expect(firstQuestion?.options).toHaveLength(INPUT_LIMITS.promptOptions);
    expect(firstQuestion?.options?.[0]).toEqual({ label: "Option 1", description: "Option 1" });
  });

  it("excludes bots with notifications disabled from presentations and aggregate counts", () => {
    const input = state();
    input.bots = [{ ...bot, notifications: false }, research];
    input.pendingPrompts.chief = {
      type: "prompt",
      requestId: "hidden-question",
      botId: "chief",
      threadId: "thread-1",
      turnId: "turn-1",
      questions: [{ id: "hidden", header: "Hidden", question: "Hidden?", isSecret: false, options: null }],
    };
    input.pendingPrompts.research = {
      type: "prompt",
      requestId: "visible-question",
      botId: "research",
      threadId: "thread-2",
      turnId: "turn-2",
      questions: [{ id: "visible", header: "Visible", question: "Visible?", isSecret: false, options: null }],
    };

    const question = createDynamicIslandPresentation(input);
    expect(question).toMatchObject({ mode: "question", remainingCount: 0, item: { requestId: "visible-question" } });

    input.pendingPrompts = {};
    input.activeTurns.chief = "hidden-turn";
    input.unreadReplies = { chief: 5, research: 1 };
    input.liveMessages = {
      chief: [{ id: "hidden-message", author: "bot", body: "Hidden", time: "2026-08-29T10:00:00Z" }],
      research: [{ id: "visible-message", author: "bot", body: "Visible", time: "2026-08-29T09:00:00Z" }],
    };

    expect(createDynamicIslandPresentation(input)).toMatchObject({
      mode: "message",
      unreadCount: 1,
      message: { messageId: "visible-message", bot: { id: "research" } },
    });
  });

  it("selects the newest unread reply across bots", () => {
    const input = state();
    input.bots = [bot, research];
    input.unreadReplies = { chief: 1, research: 1 };
    input.liveMessages = {
      chief: [
        {
          id: "older",
          author: "bot",
          body: "Older",
          time: "10:00 AM",
          createdAt: "2026-08-29T10:00:00Z",
        },
      ],
      research: [
        {
          id: "newer",
          author: "bot",
          body: "Newer",
          time: "11:00 AM",
          createdAt: "2026-08-29T11:00:00Z",
        },
      ],
    };

    expect(createDynamicIslandPresentation(input)).toMatchObject({
      mode: "message",
      message: { messageId: "newer", bot: { id: "research" } },
    });
  });

  it("selects the newest unread preview before conversations are loaded", () => {
    const input = state();
    input.bots = [
      { ...bot, preview: "Older preview", updatedAt: "2026-08-29T10:00:00Z" },
      { ...research, preview: "Newer preview", updatedAt: "2026-08-29T11:00:00Z" },
    ];
    input.unreadReplies = { chief: 1, research: 1 };
    input.unreadMessageIds = { chief: "older-preview", research: "newer-preview" };

    expect(createDynamicIslandPresentation(input)).toMatchObject({
      mode: "message",
      message: { messageId: "newer-preview", bot: { id: "research" } },
    });
  });

  it("maps a question and returns to idle", () => {
    const input = state();
    expect(createDynamicIslandPresentation(input).mode).toBe("idle");
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

  it("preserves technical question ids and option labels exactly", () => {
    const input = state();
    input.pendingPrompts.chief = {
      type: "prompt",
      requestId: "prompt-technical-values",
      botId: "chief",
      threadId: "thread-1",
      turnId: "turn-1",
      questions: [
        {
          id: " choice ",
          header: "Choose",
          question: "Which option?",
          isSecret: false,
          options: [{ label: " Option ", description: "" }],
        },
      ],
    };

    const presentation = createDynamicIslandPresentation(input);

    expect(presentation).toMatchObject({
      mode: "question",
      item: {
        questions: [
          {
            id: " choice ",
            options: [{ label: " Option ", description: "Option" }],
          },
        ],
      },
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

  it("maps a browser takeover presentation", () => {
    const input = state();
    input.bots = [research];
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

    const takeover = createDynamicIslandPresentation(input);
    expect(takeover.mode).toBe("takeover");
    if (takeover.mode !== "takeover") throw new Error("Expected a takeover presentation.");
    expect(takeover.item).toMatchObject({
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

  it("keeps working ahead of unread replies and preserves their aggregate", () => {
    const input = state();
    input.bots = [bot, research];
    input.activeTurns = { chief: "turn-1", research: "turn-2" };
    input.unreadReplies = { chief: 2, research: 3 };
    input.liveMessages = {
      chief: [{ id: "m1", author: "bot", body: "Launch plan ready", time: "now" }],
      research: [{ id: "m2", author: "bot", body: "Sources ready", time: "now" }],
    };
    expect(createDynamicIslandPresentation(input).mode).toBe("working");

    input.activeTurns = {};
    const presentation = createDynamicIslandPresentation(input);
    expect(presentation.mode).toBe("message");
    if (presentation.mode !== "message") throw new Error("Expected a message presentation.");
    expect(presentation.unreadCount).toBe(5);
  });
});
