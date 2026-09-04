// @vitest-environment node

// What a remote client reads back from one agent service: the agent list, the conversation and
// its capability-filtered shape. `src/main/team-api/route-agent-conversation.ts`.

import type { AccountUsage, BotSummary, ConversationWithReadState, CreateBotInput } from "@openbot/contracts/ipc";
import {
  hostedSiteConversationEventItemType,
  hostedSiteConversationEventText,
  routineConversationEventItemType,
  routineRunConversationEventItemType,
} from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { TEAM_CURRENT_CAPABILITIES } from "@openbot/contracts/team-protocol/current";
import {
  TEAM_CAPABILITIES_HEADER,
  TEAM_PROTOCOL_V1_CAPABILITIES,
  TEAM_PROTOCOL_VERSION_HEADER,
} from "@openbot/contracts/team-protocol/v1";
import { TEAM_PROTOCOL_V3 } from "@openbot/contracts/team-protocol/v3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAgents,
  createTeamApiFixture,
  jsonRequest,
  stopTeamApiFixtures,
  type TeamApiAgents,
} from "./team-api-server-test-harness";

afterEach(stopTeamApiFixtures);

describe("TeamApiServer conversations", () => {
  it("publishes agents and conversations from the same local agent service", async () => {
    const { root, store, start, signIn } = await createTeamApiFixture("local-instance", { configure: true });
    const localBots: BotSummary[] = [
      {
        id: "chief",
        provider: "codex",
        name: "Chief",
        title: "Lead",
        description: "",
        notifications: true,
        model: "gpt-5.6-luna",
        reasoningEffort: "medium",
        threadId: "thread-chief",
        workspacePath: root,
        preview: "",
        updatedAt: null,
        avatarSeed: "chief",
        avatarHue: null,
        avatarUrl: null,
      },
    ];
    const localConversation: ConversationWithReadState = {
      botId: "chief",
      threadId: "thread-chief",
      activeTurnId: null,
      revision: 1,
      messages: [
        {
          id: "message-1",
          author: "assistant",
          text: "Ask @[Research](agent:research) to use @[Sources](skill:sources).",
          createdAt: "2026-08-19T10:00:00.000Z",
          status: "completed",
        },
        {
          id: "routine-event-1",
          author: "system",
          source: "system",
          text: "Morning brief",
          createdAt: "2026-08-19T10:01:00.000Z",
          status: "completed",
          itemType: routineConversationEventItemType("created", "routine-1"),
        },
        {
          id: "routine-run-event-1",
          author: "system",
          source: "system",
          text: "Morning brief",
          createdAt: "2026-08-19T10:02:00.000Z",
          status: "completed",
          itemType: routineRunConversationEventItemType("running", "routine-1", "run-1"),
        },
        {
          id: "hosted-site-event-1",
          author: "system",
          source: "system",
          text: hostedSiteConversationEventText({
            siteId: null,
            title: "Launch page",
            hostname: null,
            url: null,
          }),
          createdAt: "2026-08-19T10:03:00.000Z",
          status: "completed",
          itemType: hostedSiteConversationEventItemType("publish", "running", "operation-1"),
        },
      ],
    };
    const createBot = vi.fn(
      async (input: CreateBotInput): Promise<BotSummary> => ({
        ...localBots[0],
        id: "trip-planner",
        name: input.name,
        title: "",
        description: input.description,
        avatarSeed: input.avatarSeed,
        avatarHue: input.avatarHue,
      }),
    );
    const legacyConversation = {
      ...localConversation,
      messages: [
        { ...localConversation.messages[0], text: "Ask @Research to use Sources (skill)." },
        ...localConversation.messages.slice(1),
      ],
    };
    const sendMessage = vi.fn<TeamApiAgents["sendMessage"]>(async () => ({
      messageId: "message-tagged",
      deliveries: [],
    }));
    const usage: AccountUsage = {
      limits: [
        {
          id: "codex",
          primary: null,
          secondary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: 1_788_825_600 },
        },
      ],
    };
    const getUsage = vi.fn(async () => usage);
    const readConversationPageFor = vi.fn(async (...args: unknown[]) => {
      const options = isDynamicRecord(args[4]) ? args[4] : {};
      const messages = localConversation.messages.filter((message) => {
        if (options.excludeRoutineEvents && message.itemType?.startsWith("routine-event:")) return false;
        if (options.excludeRoutineRunEvents && message.itemType?.startsWith("routine-run-event:")) return false;
        if (options.excludeHostedSiteEvents && message.itemType?.startsWith("hosted-site-event:")) return false;
        return true;
      });
      return {
        ...localConversation,
        messages,
        references: {},
        pageInfo: { hasOlder: false, olderCursor: null },
        readState: {
          unreadCount: 0,
          firstUnreadMessageId: null,
          throughMessageId: options.excludeHostedSiteEvents ? "message-1" : "hosted-site-event-1",
        },
      };
    });
    const listConversationReads = vi.fn((_memberId: string, options: { excludeHostedSiteEvents?: boolean } = {}) => ({
      chief: {
        unreadCount: 0,
        firstUnreadMessageId: null,
        throughMessageId: options.excludeHostedSiteEvents ? "message-1" : "hosted-site-event-1",
      },
    }));
    const markConversationUnread = vi.fn(async (_botId: string, _memberId: string) => ({
      unreadCount: 1,
      firstUnreadMessageId: "message-1",
      throughMessageId: null,
    }));
    const agents = createAgents({
      listBots: () => localBots,
      getUsage,
      createBot,
      listConversationReads,
      markConversationUnread,
      readConversationFor: async (botId: string, _memberId: string) => ({
        ...localConversation,
        botId,
        readState: { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: "hosted-site-event-1" },
      }),
      readConversationPageFor,
      markConversationRead: async (
        _botId: string,
        _memberId: string,
        throughMessageId: string | null,
        options: { excludeHostedSiteEvents?: boolean } = {},
      ) => ({
        unreadCount: 0,
        firstUnreadMessageId: null,
        throughMessageId: options.excludeHostedSiteEvents ? throughMessageId : "hosted-site-event-1",
      }),
      sendMessage,
    });
    const { base } = await start({ agents });

    const token = await signIn();
    const createInput: CreateBotInput = {
      name: "Trip Planner",
      description: "Builds practical itineraries.",
      avatarSeed: "setup:trip",
      avatarHue: 215,
      initialMessage: "Help me plan a trip.",
    };
    await expect(jsonRequest(base, "/v1/agents", { token: token, body: createInput })).resolves.toMatchObject({
      id: "trip-planner",
      name: "Trip Planner",
      description: "Builds practical itineraries.",
      title: "",
    });
    expect(createBot).toHaveBeenCalledWith(createInput);
    await expect(jsonRequest(base, "/v1/agents", { token: token })).resolves.toEqual(localBots);
    await expect(
      jsonRequest(base, "/v1/agents/chief/usage", {
        token: token,
        capabilities: [...TEAM_CURRENT_CAPABILITIES],
        protocol: TEAM_PROTOCOL_V3,
      }),
    ).resolves.toEqual(usage);
    expect(getUsage).toHaveBeenCalledWith("chief");
    await expect(jsonRequest(base, "/v1/agents/chief/conversation", { token: token })).resolves.toEqual({
      ...legacyConversation,
      messages: [legacyConversation.messages[0]],
      readState: { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: "message-1" },
    });
    await expect(
      jsonRequest(base, "/v1/agents/chief/conversation", {
        token: token,
        capabilities: [...TEAM_PROTOCOL_V1_CAPABILITIES],
      }),
    ).resolves.toEqual({
      ...legacyConversation,
      readState: { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: "hosted-site-event-1" },
    });
    await expect(
      jsonRequest(base, "/v1/agents/chief/conversation", {
        token: token,
        capabilities: [...TEAM_CURRENT_CAPABILITIES],
      }),
    ).resolves.toEqual({
      ...localConversation,
      readState: { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: "hosted-site-event-1" },
    });
    await expect(
      jsonRequest(base, "/v1/agents/chief/conversation-page?limit=10", { token: token }),
    ).resolves.toMatchObject({
      messages: [{ id: "message-1" }],
      readState: { throughMessageId: "message-1" },
    });
    expect(readConversationPageFor.mock.calls.at(-1)?.[4]).toEqual({
      excludeRoutineEvents: true,
      excludeRoutineRunEvents: true,
      excludeHostedSiteEvents: true,
    });
    await expect(
      jsonRequest(base, "/v1/agents/chief/conversation-page?limit=10", {
        token: token,
        capabilities: [...TEAM_PROTOCOL_V1_CAPABILITIES],
      }),
    ).resolves.toMatchObject({ messages: legacyConversation.messages });
    expect(readConversationPageFor.mock.calls.at(-1)?.[4]).toEqual({
      excludeRoutineEvents: false,
      excludeRoutineRunEvents: false,
      excludeHostedSiteEvents: false,
    });
    await expect(jsonRequest(base, "/v1/agents/conversation-reads", { token: token })).resolves.toEqual({
      chief: { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: "message-1" },
    });
    expect(listConversationReads.mock.calls.at(-1)?.[1]).toEqual({
      excludeRoutineEvents: true,
      excludeRoutineRunEvents: true,
      excludeHostedSiteEvents: true,
    });
    await expect(
      jsonRequest(base, "/v1/agents/conversation-reads", {
        token: token,
        capabilities: [...TEAM_PROTOCOL_V1_CAPABILITIES],
      }),
    ).resolves.toEqual({
      chief: { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: "hosted-site-event-1" },
    });
    expect(listConversationReads.mock.calls.at(-1)?.[1]).toEqual({
      excludeRoutineEvents: false,
      excludeRoutineRunEvents: false,
      excludeHostedSiteEvents: false,
    });
    await expect(
      jsonRequest(base, "/v1/agents/chief/conversation/read", {
        token: token,
        body: { throughMessageId: "message-1" },
      }),
    ).resolves.toEqual({
      unreadCount: 0,
      firstUnreadMessageId: null,
      throughMessageId: "message-1",
    });
    const taggedMessage = "Ask @[Research](agent:research) to use @[Sources](skill:sources).";
    await jsonRequest(base, "/v1/agents/chief/messages", {
      token: token,
      protocol: TEAM_PROTOCOL_V3,
      capabilities: [...TEAM_CURRENT_CAPABILITIES],
      body: {
        text: taggedMessage,
        attachmentDraftIds: [],
        replyToMessageId: null,
      },
    });
    expect(sendMessage).toHaveBeenCalledWith({
      botId: "chief",
      text: taggedMessage,
      attachmentDraftIds: [],
      replyToMessageId: null,
    });
    await expect(
      jsonRequest(base, "/v1/agents/chief/conversation/read", {
        token: token,
        capabilities: [...TEAM_PROTOCOL_V1_CAPABILITIES],
        body: { throughMessageId: "message-1" },
      }),
    ).resolves.toEqual({
      unreadCount: 0,
      firstUnreadMessageId: null,
      throughMessageId: "hosted-site-event-1",
    });
    await expect(
      jsonRequest(base, "/v1/agents/chief/conversation/unread", {
        token: token,
        protocol: TEAM_PROTOCOL_V3,
        capabilities: [...TEAM_CURRENT_CAPABILITIES],
        body: {},
      }),
    ).resolves.toEqual({ unreadCount: 1, firstUnreadMessageId: "message-1", throughMessageId: null });
    expect(markConversationUnread).toHaveBeenCalledWith("chief", store.authenticate(token)?.id);
    const unsupported = await fetch(`${base}/v1/agents/chief/conversation/unread`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        [TEAM_PROTOCOL_VERSION_HEADER]: "3",
      },
      body: "{}",
    });
    expect(unsupported.status).toBe(400);
    const forgedReader = await fetch(`${base}/v1/agents/chief/conversation/unread`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        [TEAM_PROTOCOL_VERSION_HEADER]: "3",
        [TEAM_CAPABILITIES_HEADER]: TEAM_CURRENT_CAPABILITIES.join(","),
      },
      body: JSON.stringify({ memberId: "other-reader" }),
    });
    expect(forgedReader.status).toBe(400);
    expect(markConversationUnread).toHaveBeenCalledTimes(1);
  });
});
