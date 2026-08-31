import type { BotSummary, ConversationMessage } from "@openbot/contracts/ipc";
import { routineConversationEventItemType } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { botProfilesEqual, readStateForMessages, toBotMessage, toBotProfile } from "./app-message-projection";

describe("toBotProfile", () => {
  it("preserves marketplace installation metadata for the renderer", () => {
    const bot = {
      id: "release-coordinator",
      name: "Release Coordinator",
      title: "Launch partner",
      description: "Keeps launches clear.",
      notifications: true,
      provider: "codex",
      model: "gpt-5.6-luna",
      reasoningEffort: "medium",
      threadId: null,
      workspacePath: "/tmp/release-coordinator",
      preview: "No messages yet",
      updatedAt: null,
      avatarSeed: "release-coordinator",
      avatarHue: null,
      avatarUrl: null,
      marketplaceSource: {
        agentId: "market-release-coordinator",
        versionId: "market-release-coordinator-v2",
        version: 2,
        skillIds: ["release-notes"],
        routineIds: ["release-check-in"],
      },
    } satisfies BotSummary;

    expect(toBotProfile(bot).marketplaceSource).toEqual(bot.marketplaceSource);
  });

  it("detects metadata changes hidden by the formatted preview time", () => {
    const first = toBotProfile(botSummary("2026-08-29T10:00:01.000Z"));
    const second = toBotProfile(botSummary("2026-08-29T10:00:40.000Z"));

    expect(first.time).toBe(second.time);
    expect(first.preview).toBe(second.preview);
    expect(botProfilesEqual(first, second)).toBe(false);
  });
});

describe("readStateForMessages", () => {
  it("does not count response attachments as unread replies", () => {
    const messages: ConversationMessage[] = [
      {
        id: "attachment",
        author: "assistant",
        text: "",
        createdAt: "2026-08-30T11:00:00.000Z",
        status: "completed",
        itemType: "agent_attachment",
      },
      {
        id: "answer",
        author: "assistant",
        text: "Here is the screenshot.",
        createdAt: "2026-08-30T11:01:00.000Z",
        status: "completed",
      },
    ];

    expect(
      readStateForMessages({ unreadCount: 0, firstUnreadMessageId: null, throughMessageId: null }, messages),
    ).toMatchObject({ unreadCount: 1, firstUnreadMessageId: "answer" });
  });

  it("does not count routine event markers as unread replies", () => {
    const messages: ConversationMessage[] = [
      {
        id: "routine-event",
        author: "system",
        source: "system",
        text: "Morning brief",
        createdAt: "2026-08-30T11:00:00.000Z",
        status: "completed",
        itemType: routineConversationEventItemType("created", "routine-1"),
      },
    ];

    expect(
      readStateForMessages({ unreadCount: 0, firstUnreadMessageId: null, throughMessageId: null }, messages),
    ).toMatchObject({ unreadCount: 0, firstUnreadMessageId: null });
  });
});

describe("toBotMessage", () => {
  it("removes internal citation markers from completed and streaming agent text", () => {
    const message = {
      id: "forecast",
      author: "assistant",
      text: "Storms are likely. \u{e200}cite\u{e202}turn0forecast0\u{e201}",
      createdAt: "2026-08-31T10:00:00.000Z",
      status: "completed",
    } satisfies ConversationMessage;

    expect(toBotMessage(message).body).toBe("Storms are likely. ");
    expect(
      toBotMessage({ ...message, text: "Storms are likely. \u{e200}cite\u{e202}turn0fore", status: "streaming" }).body,
    ).toBe("Storms are likely. ");
  });

  it("projects routine event metadata for the conversation timeline", () => {
    const message = {
      id: "routine-event",
      author: "system",
      source: "system",
      text: "Morning brief",
      createdAt: "2026-08-31T10:00:00.000Z",
      status: "completed",
      itemType: routineConversationEventItemType("created", "routine-1"),
    } satisfies ConversationMessage;

    expect(toBotMessage(message)).toMatchObject({
      kind: "routine-event",
      routineEvent: { action: "created", routineId: "routine-1", routineName: "Morning brief" },
    });
  });
});

function botSummary(updatedAt: string): BotSummary {
  return {
    id: "chief",
    name: "Chief",
    title: "Coordinator",
    description: "Coordinates work.",
    notifications: true,
    provider: "codex",
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
    threadId: "thread-chief",
    workspacePath: "/tmp/chief",
    preview: "Repeated result",
    updatedAt,
    avatarSeed: "chief",
    avatarHue: null,
    avatarUrl: null,
  };
}
