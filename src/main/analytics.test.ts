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

    expect(client.setGlobalProperties).toHaveBeenCalledWith(
      expect.objectContaining({ event_schema_version: 2, surface: "desktop_host" }),
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
    expect(client.identify).toHaveBeenCalledWith({ profileId: "owner-account" });
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
    expect(
      sanitizeHostEvent("system_turn_completed", {
        provider: "private-provider",
        model: "../../private",
        origin: "private",
        status: "private",
        duration_ms: Number.NaN,
      }),
    ).toEqual({ status: "other" });
  });

  it("deduplicates starts and keeps a known stored origin on completion", () => {
    const client = fakeClient();
    const analytics = new HostAnalytics(
      {
        enabled: true,
        appVersion: "1.2.3",
        platform: "darwin",
        resolveOwner: () => ({ id: "owner-account" }),
        resolveBot: () => BOT,
      },
      () => client,
    );
    const started = {
      type: "turn-started" as const,
      botId: BOT.id,
      threadId: BOT.threadId ?? "",
      turnId: "turn-1",
      origin: "routine" as const,
    };
    analytics.handleAgentEvent(started);
    analytics.handleAgentEvent(started);
    analytics.handleAgentEvent({
      type: "turn-completed",
      botId: BOT.id,
      threadId: BOT.threadId ?? "",
      turnId: "turn-1",
      origin: "unknown",
      status: "completed",
    });

    expect(client.track).toHaveBeenCalledTimes(2);
    expect(client.track).toHaveBeenLastCalledWith(
      "system_turn_completed",
      expect.objectContaining({ origin: "routine" }),
    );
  });

  it("adds safe bot context to host failures", () => {
    const client = fakeClient();
    const analytics = new HostAnalytics(
      {
        enabled: true,
        appVersion: "1.2.3",
        platform: "darwin",
        resolveOwner: () => ({ id: "owner-account" }),
        resolveBot: () => BOT,
      },
      () => client,
    );
    analytics.handleAgentEvent({ type: "error", botId: BOT.id, code: "interrupt_failed", message: "private" });

    expect(client.track).toHaveBeenCalledWith("system_operation_failed", {
      provider: "codex",
      model: "gpt-5.6-luna",
      reasoning_effort: "medium",
      area: "agent",
      failure_code: "interrupt_failed",
      profileId: "owner-account",
    });
  });

  it("does not identify or emit lifecycle while tracking is disabled", () => {
    const client = fakeClient();
    const analytics = new HostAnalytics(
      {
        enabled: true,
        trackingEnabled: false,
        appVersion: "1.2.3",
        platform: "darwin",
        resolveOwner: () => ({ id: "owner-account" }),
        resolveBot: () => BOT,
      },
      () => client,
    );
    analytics.handleAgentEvent({
      type: "turn-started",
      botId: BOT.id,
      threadId: BOT.threadId ?? "",
      turnId: "turn-1",
      origin: "user",
    });
    expect(client.identify).not.toHaveBeenCalled();
    expect(client.track).not.toHaveBeenCalled();

    analytics.setTrackingEnabled(true);
    analytics.handleAgentEvent({
      type: "turn-started",
      botId: BOT.id,
      threadId: BOT.threadId ?? "",
      turnId: "turn-2",
      origin: "user",
    });
    expect(client.track).toHaveBeenCalledOnce();
  });
});
