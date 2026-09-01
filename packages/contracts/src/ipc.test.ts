import { describe, expect, it } from "vitest";
import {
  AGENT_RUNTIME_ATTENTION_LIMIT,
  AGENT_RUNTIME_TEXT_LIMIT,
  AGENT_RUNTIME_WORKING_ITEMS_LIMIT,
  isAgentEvent,
  isAvatarHue,
  isAvatarSeed,
  isBotMemory,
  isConversationMessage,
  isDynamicIslandAction,
  isMessageReaction,
  parseRoutineConversationEventItemType,
  parseRoutineRunConversationEventItemType,
  routineConversationEvent,
  routineConversationEventItemType,
  routineRunConversationEvent,
  routineRunConversationEventItemType,
} from "./ipc";

describe("Dynamic Island action validation", () => {
  it("accepts approval decisions and rejects unknown decisions", () => {
    const action = {
      type: "respond-approval",
      serverId: "local",
      botId: "chief",
      requestId: "approval-1",
      decision: "accept",
    };
    expect(isDynamicIslandAction(action)).toBe(true);
    expect(isDynamicIslandAction({ ...action, decision: "always" })).toBe(false);
  });
});

describe("question prompt message validation", () => {
  const message = {
    id: "question-prompt:turn-1:request-1",
    turnId: "turn-1",
    author: "assistant",
    source: "assistant",
    text: "",
    createdAt: "2026-08-28T12:00:00.000Z",
    status: "completed",
    itemType: "question_prompt",
    questionPrompt: {
      requestId: "request-1",
      questions: [
        {
          id: "scope",
          header: "Scope",
          question: "How broad should the change be?",
          isSecret: false,
          options: [{ label: "Small", description: "One focused change." }],
        },
      ],
      resolution: null,
    },
  };

  it("accepts pending, answered, cancelled, and expired prompt records", () => {
    expect(isConversationMessage(message)).toBe(true);
    expect(
      isConversationMessage({
        ...message,
        questionPrompt: {
          ...message.questionPrompt,
          resolution: { status: "answered", responses: { scope: { status: "answered", answers: ["Small"] } } },
        },
      }),
    ).toBe(true);
    expect(
      isConversationMessage({
        ...message,
        questionPrompt: { ...message.questionPrompt, resolution: { status: "cancelled" } },
      }),
    ).toBe(true);
    expect(
      isConversationMessage({
        ...message,
        questionPrompt: { ...message.questionPrompt, resolution: { status: "expired" } },
      }),
    ).toBe(true);
  });

  it("rejects malformed question and resolution data", () => {
    expect(
      isConversationMessage({
        ...message,
        questionPrompt: { ...message.questionPrompt, questions: [{ id: "scope" }] },
      }),
    ).toBe(false);
    expect(
      isConversationMessage({
        ...message,
        questionPrompt: { ...message.questionPrompt, resolution: { status: "answered", responses: [] } },
      }),
    ).toBe(false);
  });
});

describe("message reaction validation", () => {
  it("accepts one complete Unicode emoji sequence", () => {
    expect(isMessageReaction("😀")).toBe(true);
    expect(isMessageReaction("👋🏽")).toBe(true);
    expect(isMessageReaction("👨‍👩‍👧‍👦")).toBe(true);
    expect(isMessageReaction("🇵🇱")).toBe(true);
    expect(isMessageReaction("1️⃣")).toBe(true);
  });

  it("rejects text, whitespace, and multiple emoji", () => {
    expect(isMessageReaction("hello")).toBe(false);
    expect(isMessageReaction(" 😀 ")).toBe(false);
    expect(isMessageReaction("😀😀")).toBe(false);
    expect(isMessageReaction("")).toBe(false);
  });
});

describe("avatar IPC validation", () => {
  it("accepts generated avatar seeds and rejects unsafe or oversized values", () => {
    expect(isAvatarSeed("chief:avatar:12:4")).toBe(true);
    expect(isAvatarSeed("Chief avatar")).toBe(false);
    expect(isAvatarSeed("../chief")).toBe(false);
    expect(isAvatarSeed("a".repeat(129))).toBe(false);
  });

  it("accepts only the supported hue presets", () => {
    expect(isAvatarHue(215)).toBe(true);
    expect(isAvatarHue(214)).toBe(false);
    expect(isAvatarHue(null)).toBe(false);
  });
});

describe("sidebar layout event validation", () => {
  it("accepts a canonical sidebar layout event", () => {
    expect(
      isAgentEvent({
        type: "sidebar-layout-changed",
        layout: {
          revision: 3,
          sections: [{ id: "11111111-1111-4111-8111-111111111111", name: "Demo" }],
          order: ["people", "11111111-1111-4111-8111-111111111111", "unassigned"],
          agentAssignments: { chief: "11111111-1111-4111-8111-111111111111" },
          agentOrder: ["chief"],
        },
      }),
    ).toBe(true);
  });

  it("rejects malformed sidebar layout events", () => {
    expect(
      isAgentEvent({
        type: "sidebar-layout-changed",
        layout: {
          revision: -1,
          sections: [],
          order: ["people", "people", "unassigned"],
          agentAssignments: {},
          agentOrder: [],
        },
      }),
    ).toBe(false);
  });
});

describe("runtime snapshot event validation", () => {
  it("accepts a complete snapshot and rejects malformed collections", () => {
    const snapshot = {
      bots: [],
      activeTurns: [],
      work: [],
      latestMessages: [],
      attentionComplete: true,
      pendingPrompts: [],
      pendingApprovals: [],
      pendingBrowserTakeovers: [],
      failedTurns: [],
    };
    expect(isAgentEvent({ type: "runtime-snapshot", snapshot })).toBe(true);
    expect(isAgentEvent({ type: "runtime-snapshot", snapshot: { ...snapshot, attentionComplete: null } })).toBe(false);
    expect(isAgentEvent({ type: "runtime-snapshot", snapshot: { ...snapshot, failedTurns: null } })).toBe(false);
    expect(isAgentEvent({ type: "runtime-snapshot", snapshot: { ...snapshot, bots: [{}] } })).toBe(false);
    expect(isAgentEvent({ type: "runtime-snapshot", snapshot: { ...snapshot, work: [{}] } })).toBe(false);
    expect(
      isAgentEvent({
        type: "runtime-snapshot",
        snapshot: {
          ...snapshot,
          bots: [
            {
              id: "chief",
              name: "Chief",
              notifications: true,
              preview: "x".repeat(AGENT_RUNTIME_TEXT_LIMIT + 1),
              updatedAt: null,
              avatarSeed: "chief",
              avatarHue: null,
              avatarUrl: null,
            },
          ],
        },
      }),
    ).toBe(false);
    expect(
      isAgentEvent({
        type: "runtime-snapshot",
        snapshot: {
          ...snapshot,
          work: Array.from(
            { length: AGENT_RUNTIME_WORKING_ITEMS_LIMIT + AGENT_RUNTIME_ATTENTION_LIMIT + 1 },
            (_, index) => ({
              id: `delivery-${index}`,
              botId: `bot-${index}`,
              text: "Work",
              status: "running",
              turnId: `turn-${index}`,
              error: null,
            }),
          ),
        },
      }),
    ).toBe(false);
    expect(
      isAgentEvent({
        type: "runtime-snapshot",
        snapshot: {
          ...snapshot,
          pendingPrompts: [
            {
              requestId: "prompt-1",
              botId: "chief",
              threadId: "thread-1",
              turnId: "turn-1",
              questions: [null],
            },
          ],
        },
      }),
    ).toBe(false);
    expect(isAgentEvent({ type: "runtime-snapshot", snapshot: { ...snapshot, pendingApprovals: [{}] } })).toBe(false);
    expect(isAgentEvent({ type: "runtime-snapshot", snapshot: { ...snapshot, pendingBrowserTakeovers: [{}] } })).toBe(
      false,
    );
    expect(
      isAgentEvent({
        type: "runtime-snapshot",
        snapshot: {
          ...snapshot,
          pendingBrowserTakeovers: Array.from({ length: AGENT_RUNTIME_ATTENTION_LIMIT + 1 }, (_, index) => ({
            requestId: `takeover-${index}`,
            botId: `bot-${index}`,
            threadId: `thread-${index}`,
            turnId: `turn-${index}`,
            tabId: `tab-${index}`,
          })),
        },
      }),
    ).toBe(false);
  });
});

describe("agent input resolution event validation", () => {
  it("accepts bounded prompt and approval resolutions", () => {
    expect(isAgentEvent({ type: "agent-input-resolved", kind: "prompt", requestId: "prompt-1", botId: "chief" })).toBe(
      true,
    );
    expect(isAgentEvent({ type: "agent-input-resolved", kind: "approval", requestId: 1, botId: "chief" })).toBe(true);
    expect(isAgentEvent({ type: "agent-input-resolved", kind: "other", requestId: 1, botId: "chief" })).toBe(false);
  });
});

describe("conversation event validation", () => {
  it("accepts complete snapshots and rejects malformed messages", () => {
    const snapshot = {
      botId: "chief",
      threadId: "thread-1",
      activeTurnId: null,
      revision: 1,
      messages: [
        {
          id: "message-1",
          author: "assistant",
          text: "Done",
          createdAt: "2026-08-29T10:00:00.000Z",
          status: "completed",
        },
      ],
    };

    expect(isAgentEvent({ type: "conversation", snapshot })).toBe(true);
    expect(
      isAgentEvent({
        type: "conversation",
        snapshot: {
          ...snapshot,
          messages: [
            { ...snapshot.messages[0], text: "x".repeat(100_001) },
            ...Array.from({ length: 10_000 }, () => snapshot.messages[0]),
          ],
        },
      }),
    ).toBe(true);
    expect(isAgentEvent({ type: "conversation", snapshot: {} })).toBe(false);
    expect(isAgentEvent({ type: "conversation", snapshot: { ...snapshot, messages: [null] } })).toBe(false);
    expect(isAgentEvent({ type: "conversation-invalidated", botId: "chief", revision: 2 })).toBe(true);
    expect(isAgentEvent({ type: "queue-invalidated", botId: "chief" })).toBe(true);
    expect(
      isAgentEvent({
        type: "conversation-page",
        page: {
          ...snapshot,
          references: {},
          pageInfo: { hasOlder: true, olderCursor: "older" },
        },
      }),
    ).toBe(true);
  });
});

describe("routine conversation events", () => {
  it("encodes and decodes a valid routine marker", () => {
    const itemType = routineConversationEventItemType("updated", "routine-1");
    const message = {
      id: "event-1",
      author: "system",
      source: "system",
      text: "Morning brief",
      createdAt: "2026-08-31T12:00:00.000Z",
      status: "completed",
      itemType,
    } as const;

    expect(itemType).toBe("routine-event:updated:routine-1");
    expect(parseRoutineConversationEventItemType(itemType)).toEqual({ action: "updated", routineId: "routine-1" });
    expect(routineConversationEvent(message)).toEqual({
      action: "updated",
      routineId: "routine-1",
      routineName: "Morning brief",
    });
    expect(isConversationMessage(message)).toBe(true);
  });

  it("rejects malformed routine marker metadata", () => {
    expect(parseRoutineConversationEventItemType("routine-event:renamed:routine-1")).toBeNull();
    expect(parseRoutineConversationEventItemType("routine-event:created:")).toBeNull();
    expect(() => routineConversationEventItemType("created", "x".repeat(128))).toThrow(
      "The routine event item type is too long.",
    );
  });
});

describe("routine run conversation events", () => {
  it.each(["running", "needs-attention", "succeeded", "failed", "interrupted", "cancelled"] as const)(
    "encodes and decodes the %s state",
    (status) => {
      const itemType = routineRunConversationEventItemType(status, "routine-1", "run-1");
      const message = {
        id: `event-${status}`,
        author: "system",
        source: "system",
        text: "Morning brief",
        createdAt: "2026-09-01T12:00:00.000Z",
        status: "completed",
        itemType,
      } as const;

      expect(parseRoutineRunConversationEventItemType(itemType)).toEqual({
        status,
        routineId: "routine-1",
        runId: "run-1",
      });
      expect(routineRunConversationEvent(message)).toEqual({
        status,
        routineId: "routine-1",
        runId: "run-1",
        routineName: "Morning brief",
      });
      expect(isConversationMessage(message)).toBe(true);
    },
  );

  it("rejects unknown, malformed, and oversized metadata", () => {
    expect(parseRoutineRunConversationEventItemType("routine-run-event:queued:routine-1:run-1")).toBeNull();
    expect(parseRoutineRunConversationEventItemType("routine-run-event:running:routine-1")).toBeNull();
    expect(parseRoutineRunConversationEventItemType("routine-run-event:running::run-1")).toBeNull();
    expect(parseRoutineRunConversationEventItemType("routine-run-event:running:routine-1:run-1:extra")).toBeNull();
    expect(() => routineRunConversationEventItemType("running", "r".repeat(80), "x".repeat(80))).toThrow(
      "The routine run event item type is too long.",
    );
  });
});

describe("memory event validation", () => {
  it("accepts only a memory event with a bot id", () => {
    expect(isAgentEvent({ type: "memories-changed", botId: "chief" })).toBe(true);
    expect(isAgentEvent({ type: "memories-changed", botId: "" })).toBe(false);
    expect(isAgentEvent({ type: "memories-changed" })).toBe(false);
  });

  it("validates memory identifiers, text, and origin", () => {
    const memory = {
      id: "memory-1",
      botId: "chief",
      text: "Uses metric units.",
      origin: "manual",
      sourceTurnId: null,
      createdAt: "2026-08-25T12:00:00.000Z",
      updatedAt: "2026-08-25T12:00:00.000Z",
    };
    expect(isBotMemory(memory)).toBe(true);
    expect(isBotMemory({ ...memory, text: "" })).toBe(false);
    expect(isBotMemory({ ...memory, origin: "imported" })).toBe(false);
  });
});
