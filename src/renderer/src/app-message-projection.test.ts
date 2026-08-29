import type { BotSummary } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { botProfilesEqual, toBotProfile } from "./app-message-projection";

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
