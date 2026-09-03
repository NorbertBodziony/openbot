import { describe, expect, it } from "vitest";
import {
  AGENT_RUNTIME_ATTENTION_LIMIT,
  AGENT_RUNTIME_TEXT_LIMIT,
  AGENT_RUNTIME_WORKING_ITEMS_LIMIT,
  hostedSiteConversationEvent,
  hostedSiteConversationEventItemType,
  hostedSiteConversationEventText,
  isAccountUsage,
  isAgentEvent,
  isAgentModelOption,
  isAgentStatus,
  isAttachmentSummary,
  isAvatarHue,
  isAvatarSeed,
  isBotMemory,
  isBotSummary,
  isConversationMessage,
  isConversationWithReadState,
  isDynamicIslandAction,
  isHostedSiteConversationEventUrl,
  isMessageReaction,
  isQueuedMessageReceipt,
  isQueueSnapshot,
  parseHostedSiteConversationEventItemType,
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

describe("hosted site conversation events", () => {
  const publishedSite = {
    siteId: "site-1",
    title: "Launch page",
    hostname: "launch-page-23456789ab.openbot.site",
    url: "https://launch-page-23456789ab.openbot.site",
  } as const;

  it.each(["running", "succeeded", "failed", "interrupted", "cancelled"] as const)(
    "encodes and decodes the publish %s state",
    (status) => {
      const details =
        status === "succeeded"
          ? publishedSite
          : { siteId: null, title: publishedSite.title, hostname: null, url: null };
      const itemType = hostedSiteConversationEventItemType("publish", status, "operation-1");
      const message = {
        id: `site-event-${status}`,
        author: "system",
        source: "system",
        text: hostedSiteConversationEventText(details),
        createdAt: "2026-09-01T12:00:00.000Z",
        status: "completed",
        itemType,
      } as const;

      expect(parseHostedSiteConversationEventItemType(itemType)).toEqual({
        action: "publish",
        status,
        operationId: "operation-1",
      });
      expect(hostedSiteConversationEvent(message)).toEqual({
        action: "publish",
        status,
        operationId: "operation-1",
        ...details,
      });
      expect(isConversationMessage(message)).toBe(true);
    },
  );

  it.each(["replace", "delete"] as const)("encodes every %s state with stored site data", (action) => {
    for (const status of ["running", "succeeded", "failed", "interrupted", "cancelled"] as const) {
      const itemType = hostedSiteConversationEventItemType(action, status, `operation-${status}`);
      const message = {
        id: `${action}-${status}`,
        author: "system",
        source: "system",
        text: hostedSiteConversationEventText(publishedSite),
        createdAt: "2026-09-01T12:00:00.000Z",
        status: "completed",
        itemType,
      } as const;
      expect(hostedSiteConversationEvent(message)).toMatchObject({ action, status, ...publishedSite });
    }
  });

  it("accepts a matching local development URL for a canonical hosted-site hostname", () => {
    const localUrl = "http://launch-page-23456789ab.openbot.localhost:3100/";
    const details = { ...publishedSite, url: localUrl };
    const message = {
      id: "local-site-publish",
      author: "system",
      source: "system",
      text: hostedSiteConversationEventText(details),
      createdAt: "2026-09-01T12:00:00.000Z",
      status: "completed",
      itemType: hostedSiteConversationEventItemType("publish", "succeeded", "operation-local"),
    } as const;

    expect(hostedSiteConversationEvent(message)).toMatchObject({ ...details, status: "succeeded" });
    expect(isHostedSiteConversationEventUrl(localUrl, publishedSite.hostname)).toBe(true);
    expect(
      isHostedSiteConversationEventUrl(
        "http://different-page-23456789ab.openbot.localhost:3100/",
        publishedSite.hostname,
      ),
    ).toBe(false);
    expect(
      isHostedSiteConversationEventUrl("http://launch-page-23456789ab.openbot.localhost/", publishedSite.hostname),
    ).toBe(false);
  });

  it("keeps a terminal marker structured when legacy display metadata is unavailable", () => {
    const details = { siteId: "site-1", title: "Hosted site", hostname: null, url: null };
    const message = {
      id: "legacy-delete",
      author: "system",
      source: "system",
      text: hostedSiteConversationEventText(details),
      createdAt: "2026-09-01T12:00:00.000Z",
      status: "completed",
      itemType: hostedSiteConversationEventItemType("delete", "succeeded", "operation-legacy"),
    } as const;

    expect(hostedSiteConversationEvent(message)).toMatchObject({
      action: "delete",
      status: "succeeded",
      ...details,
    });
  });

  it("rejects malformed metadata, invalid details, and unsafe links", () => {
    expect(parseHostedSiteConversationEventItemType("hosted-site-event:deploy:running:operation-1")).toBeNull();
    expect(parseHostedSiteConversationEventItemType("hosted-site-event:publish:queued:operation-1")).toBeNull();
    expect(parseHostedSiteConversationEventItemType("hosted-site-event:publish:running:")).toBeNull();
    expect(() => hostedSiteConversationEventItemType("publish", "running", "x".repeat(128))).toThrow(
      "The hosted site event item type is too long.",
    );
    expect(() => hostedSiteConversationEventText({ ...publishedSite, title: "x".repeat(121) })).toThrow(
      "Valid hosted site event details are required.",
    );
    expect(() => hostedSiteConversationEventText({ ...publishedSite, url: "https://example.com" })).toThrow(
      "Valid hosted site event details are required.",
    );
    expect(
      hostedSiteConversationEvent({
        id: "bad-json",
        author: "system",
        source: "system",
        text: "{",
        createdAt: "2026-09-01T12:00:00.000Z",
        status: "completed",
        itemType: "hosted-site-event:publish:succeeded:operation-1",
      }),
    ).toBeNull();
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

describe("renderer-to-main boundary guards", () => {
  const status = {
    phase: "ready",
    cliVersion: "1.4.0",
    auth: { kind: "chatgpt", email: "pilot@example.com" },
    capabilities: { chat: "ready", browser: "setup-required", computerUse: "unavailable" },
    message: null,
    fullAccess: true,
  };

  const bot = {
    id: "bot-1",
    name: "Chief",
    title: "Lead engineer",
    description: "Runs the shop.",
    notifications: true,
    provider: "codex",
    model: "gpt-5-codex",
    reasoningEffort: "high",
    threadId: null,
    workspacePath: "/Users/pilot/OpenBot/Bots/bot-1",
    preview: "Done",
    updatedAt: "2026-08-29T10:00:00.000Z",
    avatarSeed: "chief-1",
    avatarHue: 215,
    avatarUrl: null,
  };

  const attachment = {
    id: "attachment-1",
    name: "notes.pdf",
    size: 2048,
    kind: "file",
    mimeType: "application/pdf",
    previewKind: "pdf",
    previewUrl: null,
  };

  const snapshot = {
    botId: "bot-1",
    threadId: "thread-1",
    activeTurnId: null,
    revision: 3,
    messages: [
      {
        id: "message-1",
        author: "assistant",
        text: "Done",
        createdAt: "2026-08-29T10:00:00.000Z",
        status: "completed",
      },
    ],
    readState: { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: "message-1" },
  };

  it("narrows the agent phase and capability states to their unions", () => {
    expect(isAgentStatus(status)).toBe(true);
    expect(isAgentStatus({ ...status, phase: "sleeping" })).toBe(false);
    expect(isAgentStatus({ ...status, capabilities: { ...status.capabilities, chat: "yes" } })).toBe(false);
  });

  it("keeps the agent auth kind open so a newer remote server still reports status", () => {
    expect(isAgentStatus({ ...status, auth: { kind: "passkey" } })).toBe(true);
    expect(isAgentStatus({ ...status, auth: "chatgpt" })).toBe(false);
  });

  it("keeps provider entries open so one unknown provider field does not reject the whole status", () => {
    const providers = [
      { id: "codex", state: "available", version: "1.0.0", message: null },
      { id: "gemini", state: "rate-limited", version: null, message: null, connectionState: "reconnecting" },
    ];
    expect(isAgentStatus({ ...status, providers })).toBe(true);
    expect(isAgentStatus({ ...status, providers: "codex" })).toBe(false);
  });

  it("requires an agent provider and a well-formed avatar on every agent summary", () => {
    expect(isBotSummary(bot)).toBe(true);
    const { provider, ...withoutProvider } = bot;
    expect(isBotSummary(withoutProvider)).toBe(false);
    expect(isBotSummary({ ...bot, provider: "gemini" })).toBe(false);
    expect(isBotSummary({ ...bot, avatarSeed: "Not A Seed!" })).toBe(false);
    expect(isBotSummary({ ...bot, avatarHue: 7 })).toBe(false);
  });

  it("validates every message inside a conversation, not just the array", () => {
    expect(isConversationWithReadState(snapshot)).toBe(true);
    expect(isConversationWithReadState({ ...snapshot, messages: [{ id: "message-1" }] })).toBe(false);
    expect(isConversationWithReadState({ ...snapshot, readState: { unreadCount: -1 } })).toBe(false);
    const { readState, ...withoutReadState } = snapshot;
    expect(isConversationWithReadState(withoutReadState)).toBe(true);
  });

  it("narrows attachment kind and preview kind", () => {
    expect(isAttachmentSummary(attachment)).toBe(true);
    expect(isAttachmentSummary({ ...attachment, kind: "video" })).toBe(false);
    expect(isAttachmentSummary({ ...attachment, previewKind: "html" })).toBe(false);
  });

  it("validates the usage windows inside an account usage limit", () => {
    const usage = {
      limits: [
        {
          id: "codex",
          primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: null },
          secondary: null,
        },
      ],
    };
    expect(isAccountUsage(usage)).toBe(true);
    expect(isAccountUsage({ limits: [{ ...usage.limits[0], primary: { usedPercent: "25" } }] })).toBe(false);
  });

  it("validates every delivery inside a queue snapshot and a queued message receipt", () => {
    const delivery = {
      id: "delivery-1",
      messageId: "message-1",
      recipientBotId: "bot-1",
      sender: { kind: "user" },
      text: "Ship it",
      attachments: [attachment],
      replyToMessageId: null,
      status: "queued",
      position: 1,
      turnId: null,
      error: null,
      createdAt: "2026-08-29T10:00:00.000Z",
    };
    expect(isQueueSnapshot({ botId: "bot-1", deliveries: [delivery] })).toBe(true);
    expect(isQueueSnapshot({ botId: "bot-1", deliveries: [{ ...delivery, status: "pending" }] })).toBe(false);

    const receipt = {
      messageId: "message-1",
      deliveries: [{ id: "delivery-1", recipientBotId: "bot-1", status: "queued", position: 1 }],
    };
    expect(isQueuedMessageReceipt(receipt)).toBe(true);
    expect(isQueuedMessageReceipt({ ...receipt, deliveries: [{ id: "delivery-1" }] })).toBe(false);
  });

  it("requires the provider on every agent model option", () => {
    const model = {
      provider: "claude",
      id: "claude-sonnet-5",
      name: "Sonnet 5",
      description: "Balanced reasoning.",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: ["low", "medium", "high"],
    };
    expect(isAgentModelOption(model)).toBe(true);
    const { provider, ...withoutProvider } = model;
    expect(isAgentModelOption(withoutProvider)).toBe(false);
    expect(isAgentModelOption({ ...model, supportedReasoningEfforts: ["low", "extreme"] })).toBe(false);
  });
});
