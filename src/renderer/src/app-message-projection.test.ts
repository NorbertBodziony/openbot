import type { BotSummary } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { toBotProfile } from "./app-message-projection";

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
});
