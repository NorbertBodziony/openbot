// @vitest-environment node

import {
  type BotSummary,
  type ConversationMessage,
  hostedSiteConversationEventItemType,
  hostedSiteConversationEventText,
} from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { OpenPanelBase } from "@openpanel/web";
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

function hostedSiteMessage(
  id: string,
  action: "publish" | "replace" | "delete",
  status: "running" | "succeeded" | "failed" | "interrupted" | "cancelled",
  operationId: string,
): ConversationMessage {
  const terminalSite = {
    siteId: "site-1",
    title: "Hosted site",
    hostname: "hosted-site-23456789ab.openbot.site",
    url: "https://hosted-site-23456789ab.openbot.site",
  };
  const details =
    action === "publish" && status !== "succeeded"
      ? { siteId: null, title: "Hosted site", hostname: null, url: null }
      : terminalSite;
  return {
    id,
    turnId: "turn-hosted-site",
    author: "system",
    source: "system",
    text: hostedSiteConversationEventText(details),
    createdAt: "2026-08-31T10:00:00.000Z",
    status: "completed",
    itemType: hostedSiteConversationEventItemType(action, status, operationId),
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
      expect.objectContaining({ event_schema_version: 4, surface: "desktop_host" }),
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
    expect(client.identify).toHaveBeenCalledWith({ profileId: "owner-account", email: "owner@example.com" });
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

  it("clears pending host events and the identified session on logout", () => {
    const client = fakeClient();
    let owner: { id: string; email: string } | null = { id: "owner-account", email: "owner@example.com" };
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

    analytics.handleAgentEvent({ type: "error", code: "provider_error", message: "private" });
    owner = null;
    analytics.handleAgentEvent({ type: "error", code: "provider_error", message: "pending-after-logout" });
    analytics.clear();
    analytics.flushPending();

    expect(client.track).toHaveBeenCalledOnce();
    expect(client.clear).toHaveBeenCalledOnce();
  });

  it("updates the email for the same owner without clearing its session", () => {
    const client = fakeClient();
    let owner = { id: "owner-account", email: "old@example.com" };
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
    analytics.handleAgentEvent({ type: "error", code: "first_error", message: "private" });
    vi.mocked(client.clear).mockClear();
    vi.mocked(client.identify).mockClear();

    owner = { id: "owner-account", email: "new@example.com" };
    analytics.handleAgentEvent({ type: "error", code: "second_error", message: "private" });

    expect(client.clear).not.toHaveBeenCalled();
    expect(client.identify).toHaveBeenCalledWith({ profileId: "owner-account", email: "new@example.com" });
  });

  it("sends the owner email through the real SDK transport", async () => {
    const requests: unknown[] = [];
    let releaseIdentify!: () => void;
    const identifyReady = new Promise<void>((resolve) => {
      releaseIdentify = resolve;
    });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      requests.push(request);
      if (isDynamicRecord(request) && request.type === "identify") await identifyReady;
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const analytics = new HostAnalytics(
        {
          enabled: true,
          appVersion: "1.2.3",
          platform: "darwin",
          resolveOwner: () => ({ id: "owner-account", email: "owner@example.com" }),
          resolveBot: () => BOT,
        },
        (options) => new OpenPanelBase(options),
      );
      analytics.handleAgentEvent({ type: "error", code: "provider_error", message: "private" });

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(isDynamicRecord(requests[0]) ? requests[0].type : undefined).toBe("identify");
      releaseIdentify();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      const identifyRequest = requests.find((candidate) => isDynamicRecord(candidate) && candidate.type === "identify");
      const trackRequest = requests.find(
        (candidate) =>
          isDynamicRecord(candidate) &&
          isDynamicRecord(candidate.payload) &&
          candidate.payload.name === "system_operation_failed",
      );
      expect(
        isDynamicRecord(identifyRequest) && isDynamicRecord(identifyRequest.payload) ? identifyRequest.payload : null,
      ).toMatchObject({ profileId: "owner-account", email: "owner@example.com" });
      expect(
        isDynamicRecord(trackRequest) && isDynamicRecord(trackRequest.payload)
          ? trackRequest.payload.profileId
          : undefined,
      ).toBe("owner-account");
      expect(JSON.stringify(trackRequest)).not.toContain("owner@example.com");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("tracks terminal hosted-site markers once for the operation owner", () => {
    const client = fakeClient();
    let owner = { id: "owner-1", email: "one@example.com" };
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
    const running = hostedSiteMessage("hosted-running", "publish", "running", "operation-success");
    const runningFailed = hostedSiteMessage("hosted-running-failed", "replace", "running", "operation-failed");
    const runningCancelled = hostedSiteMessage("hosted-running-cancelled", "delete", "running", "operation-cancelled");
    const runningInterrupted = hostedSiteMessage(
      "hosted-running-interrupted",
      "replace",
      "running",
      "operation-interrupted",
    );
    analytics.handleAgentEvent({
      type: "conversation",
      snapshot: {
        botId: BOT.id,
        threadId: BOT.threadId,
        activeTurnId: null,
        revision: 1,
        messages: [running, runningFailed, runningCancelled, runningInterrupted],
      },
    });

    owner = { id: "owner-2", email: "two@example.com" };
    const succeeded = hostedSiteMessage("hosted-succeeded", "publish", "succeeded", "operation-success");
    const failed = hostedSiteMessage("hosted-failed", "replace", "failed", "operation-failed");
    const cancelled = hostedSiteMessage("hosted-cancelled", "delete", "cancelled", "operation-cancelled");
    const interrupted = hostedSiteMessage("hosted-interrupted", "replace", "interrupted", "operation-interrupted");
    const messages = [
      running,
      runningFailed,
      runningCancelled,
      runningInterrupted,
      succeeded,
      failed,
      cancelled,
      interrupted,
    ];
    analytics.handleAgentEvent({
      type: "conversation",
      snapshot: { botId: BOT.id, threadId: BOT.threadId, activeTurnId: null, revision: 2, messages },
    });
    analytics.handleAgentEvent({
      type: "conversation",
      snapshot: { botId: BOT.id, threadId: BOT.threadId, activeTurnId: null, revision: 3, messages },
    });

    expect(client.track).toHaveBeenCalledTimes(4);
    expect(client.track).toHaveBeenNthCalledWith(1, "hosted_site_action", {
      action: "publish",
      entry_point: "agent",
      result: "succeeded",
      profileId: "owner-1",
    });
    expect(client.track).toHaveBeenNthCalledWith(2, "hosted_site_action", {
      action: "replace",
      entry_point: "agent",
      result: "failed",
      failure_code: "hosted_site_failed",
      profileId: "owner-1",
    });
    expect(client.track).toHaveBeenNthCalledWith(3, "hosted_site_action", {
      action: "delete",
      entry_point: "agent",
      result: "failed",
      failure_code: "cancelled",
      profileId: "owner-1",
    });
    expect(client.track).toHaveBeenNthCalledWith(4, "hosted_site_action", {
      action: "replace",
      entry_point: "agent",
      result: "failed",
      failure_code: "interrupted",
      profileId: "owner-1",
    });
    expect(JSON.stringify(vi.mocked(client.track).mock.calls)).not.toContain("hosted-site-23456789ab.openbot.site");
  });

  it("ignores hosted-site history even when it contains running and terminal markers", () => {
    const client = fakeClient();
    const analytics = new HostAnalytics(
      {
        enabled: true,
        appVersion: "1.2.3",
        platform: "darwin",
        resolveOwner: () => ({ id: "owner-account", email: "owner@example.com" }),
        resolveBot: () => BOT,
      },
      () => client,
    );

    const messages = [
      hostedSiteMessage("hosted-history-running", "publish", "running", "operation-history"),
      hostedSiteMessage("hosted-history-terminal", "publish", "succeeded", "operation-history"),
    ];
    analytics.handleAgentEvent({
      type: "conversation",
      snapshot: {
        botId: BOT.id,
        threadId: BOT.threadId,
        activeTurnId: null,
        revision: 1,
        messages,
      },
    });
    analytics.handleAgentEvent({
      type: "conversation",
      snapshot: { botId: BOT.id, threadId: BOT.threadId, activeTurnId: null, revision: 2, messages },
    });

    expect(client.track).not.toHaveBeenCalled();
  });

  it("keeps a hosted-site operation owner across account clearing", () => {
    const client = fakeClient();
    let owner: { id: string; email: string } | null = { id: "owner-1", email: "one@example.com" };
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
    const running = hostedSiteMessage("hosted-running", "publish", "running", "operation-owner");
    analytics.handleAgentEvent({
      type: "conversation",
      snapshot: { botId: BOT.id, threadId: BOT.threadId, activeTurnId: null, revision: 1, messages: [running] },
    });

    analytics.clear();
    owner = null;
    analytics.handleAgentEvent({
      type: "conversation",
      snapshot: {
        botId: BOT.id,
        threadId: BOT.threadId,
        activeTurnId: null,
        revision: 2,
        messages: [running, hostedSiteMessage("hosted-succeeded", "publish", "succeeded", "operation-owner")],
      },
    });

    expect(client.track).toHaveBeenCalledWith("hosted_site_action", expect.objectContaining({ profileId: "owner-1" }));
    expect(client.clear).toHaveBeenCalledTimes(2);
  });

  it("does not flush ownerless events with a captured hosted-site owner", () => {
    const client = fakeClient();
    let owner: { id: string; email: string } | null = { id: "owner-1", email: "one@example.com" };
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
    const running = hostedSiteMessage("hosted-running", "publish", "running", "operation-pending");
    analytics.handleAgentEvent({
      type: "conversation",
      snapshot: { botId: BOT.id, threadId: BOT.threadId, activeTurnId: null, revision: 1, messages: [running] },
    });

    owner = null;
    analytics.handleAgentEvent({ type: "error", code: "provider_error", message: "private" });
    analytics.handleAgentEvent({
      type: "conversation",
      snapshot: {
        botId: BOT.id,
        threadId: BOT.threadId,
        activeTurnId: null,
        revision: 2,
        messages: [running, hostedSiteMessage("hosted-succeeded", "publish", "succeeded", "operation-pending")],
      },
    });

    expect(client.track).toHaveBeenCalledOnce();
    expect(client.track).toHaveBeenCalledWith("hosted_site_action", expect.objectContaining({ profileId: "owner-1" }));

    owner = { id: "owner-2", email: "two@example.com" };
    analytics.flushPending();

    expect(client.track).toHaveBeenCalledTimes(2);
    expect(client.track).toHaveBeenLastCalledWith(
      "system_operation_failed",
      expect.objectContaining({ profileId: "owner-2" }),
    );
  });

  it("preserves identity transitions when the queue overflows", async () => {
    const client = fakeClient();
    let releaseIdentify!: () => void;
    const identifyReady = new Promise<void>((resolve) => {
      releaseIdentify = resolve;
    });
    vi.mocked(client.identify).mockImplementation(async () => identifyReady);
    let owner = { id: "owner-1", email: "one@example.com" };
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

    analytics.handleAgentEvent({ type: "error", code: "agent_initial", message: "private" });
    owner = { id: "owner-2", email: "two@example.com" };
    for (let index = 0; index < 150; index += 1) {
      analytics.handleAgentEvent({ type: "error", code: `agent_${index}`, message: "private" });
    }
    releaseIdentify();

    await vi.waitFor(() => expect(client.track).toHaveBeenCalledTimes(100));
    expect(client.identify).toHaveBeenCalledWith({ profileId: "owner-2", email: "two@example.com" });
    expect(client.clear).toHaveBeenCalled();
  });

  it("normalizes the owner email before identifying", () => {
    const client = fakeClient();
    const analytics = new HostAnalytics(
      {
        enabled: true,
        appVersion: "1.2.3",
        platform: "darwin",
        resolveOwner: () => ({ id: "owner-account", email: " Owner@EXAMPLE.COM " }),
        resolveBot: () => BOT,
      },
      () => client,
    );

    analytics.handleAgentEvent({ type: "error", code: "provider_error", message: "private" });

    expect(client.identify).toHaveBeenCalledWith({ profileId: "owner-account", email: "owner@example.com" });
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
        resolveOwner: () => ({ id: "owner-account", email: "owner@example.com" }),
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
        resolveOwner: () => ({ id: "owner-account", email: "owner@example.com" }),
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
        resolveOwner: () => ({ id: "owner-account", email: "owner@example.com" }),
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

  it("clears the host OpenPanel client when tracking is disabled", () => {
    const client = fakeClient();
    const analytics = new HostAnalytics(
      {
        enabled: true,
        appVersion: "1.2.3",
        platform: "darwin",
        resolveOwner: () => ({ id: "owner-account", email: "owner@example.com" }),
        resolveBot: () => BOT,
      },
      () => client,
    );
    analytics.handleAgentEvent({ type: "error", code: "provider_error", message: "private" });
    vi.mocked(client.clear).mockClear();

    analytics.setTrackingEnabled(false);

    expect(client.clear).toHaveBeenCalledOnce();
  });
});
