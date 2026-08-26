// @vitest-environment node

import type { BotSummary } from "@openbot/contracts/ipc";
import { describe, expect, it, vi } from "vitest";
import { HostAnalytics, type HostOpenPanelClient, sanitizeHostEvent } from "./analytics";

const BOT: BotSummary = {
  id: "chief",
  provider: "codex",
  name: "Chief",
  title: "Chief of staff",
  description: "",
  notifications: true,
  model: "gpt-5.6-luna",
  reasoningEffort: "medium",
  avatarSeed: "chief",
  avatarHue: null,
  avatarUrl: null,
  threadId: "thread-chief",
  workspacePath: "/private/workspace",
  preview: "private preview",
  updatedAt: null,
};

function fakeClient(): HostOpenPanelClient {
  return {
    setGlobalProperties: vi.fn(),
    track: vi.fn(),
    identify: vi.fn(),
    clear: vi.fn(),
  };
}

describe("host analytics", () => {
  it("emits one owner-scoped lifecycle pair without local identifiers", () => {
    const client = fakeClient();
    const analytics = new HostAnalytics(
      {
        enabled: true,
        appVersion: "1.2.3",
        platform: "darwin",
        resolveOwner: () => ({ id: "owner-account", email: "owner@example.com" }),
        resolveBot: (botId) => (botId === BOT.id ? BOT : null),
      },
      () => client,
    );

    analytics.handleAgentEvent({
      type: "turn-started",
      botId: BOT.id,
      threadId: BOT.threadId ?? "",
      turnId: "turn-private",
      origin: "user",
    });
    analytics.handleAgentEvent({
      type: "turn-completed",
      botId: BOT.id,
      threadId: BOT.threadId ?? "",
      turnId: "turn-private",
      origin: "user",
      status: "completed",
    });

    expect(client.identify).toHaveBeenCalledOnce();
    expect(client.track).toHaveBeenCalledTimes(2);
    expect(client.track).toHaveBeenNthCalledWith(1, "system_turn_started", {
      provider: "codex",
      model: "gpt-5.6-luna",
      reasoning_effort: "medium",
      origin: "user",
      profileId: "owner-account",
    });
    expect(client.track).toHaveBeenNthCalledWith(
      2,
      "system_turn_completed",
      expect.objectContaining({
        provider: "codex",
        model: "gpt-5.6-luna",
        reasoning_effort: "medium",
        origin: "user",
        status: "completed",
        duration_ms: expect.any(Number),
        profileId: "owner-account",
      }),
    );
    expect(JSON.stringify(vi.mocked(client.track).mock.calls)).not.toContain("turn-private");
    expect(JSON.stringify(vi.mocked(client.track).mock.calls)).not.toContain("thread-chief");
  });

  it("buffers lifecycle until the owner is known and preserves its timestamp", () => {
    const client = fakeClient();
    let owner: { id: string; email: string } | null = null;
    const analytics = new HostAnalytics(
      {
        enabled: true,
        appVersion: "1.2.3",
        platform: "darwin",
        resolveOwner: () => owner,
        resolveBot: () => BOT,
      },
      () => client,
    );
    analytics.handleAgentEvent({
      type: "turn-started",
      botId: BOT.id,
      threadId: BOT.threadId ?? "",
      turnId: "turn-1",
      origin: "routine",
    });
    expect(client.track).not.toHaveBeenCalled();

    owner = { id: "owner-account", email: "owner@example.com" };
    analytics.flushPending();

    expect(client.track).toHaveBeenCalledWith(
      "system_turn_started",
      expect.objectContaining({
        origin: "routine",
        profileId: "owner-account",
        __timestamp: expect.any(String),
      }),
    );
  });

  it("drops unsafe runtime fields", () => {
    expect(
      sanitizeHostEvent("system_operation_failed", {
        ...Object.assign({ area: "agent", failure_code: "interrupt_failed" }, { raw_error: "secret", botId: "chief" }),
      }),
    ).toEqual({ area: "agent", failure_code: "interrupt_failed" });
  });
});
