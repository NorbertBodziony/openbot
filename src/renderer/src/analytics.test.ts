import type { AppInfo } from "@openbot/contracts/ipc";
import { describe, expect, it, vi } from "vitest";
import {
  DesktopAnalytics,
  OPENPANEL_API_URL,
  type OpenPanelClient,
  sanitizeDesktopAnalyticsEvent,
  shouldEnableDesktopAnalytics,
} from "./analytics";

const PRODUCTION_APP: AppInfo = {
  name: "OpenBot",
  version: "1.2.3",
  platform: "darwin",
  variant: "production",
};

function fakeClient(): OpenPanelClient {
  return {
    setGlobalProperties: vi.fn(),
    track: vi.fn(),
    identify: vi.fn(),
    clear: vi.fn(),
  };
}

describe("desktop analytics", () => {
  it("enables only a production build of the production variant", () => {
    expect(shouldEnableDesktopAnalytics(PRODUCTION_APP, true)).toBe(true);
    expect(shouldEnableDesktopAnalytics({ ...PRODUCTION_APP, variant: "dev" }, true)).toBe(false);
    expect(shouldEnableDesktopAnalytics(PRODUCTION_APP, false)).toBe(false);
  });

  it("configures the base OpenPanel SDK without browser auto-tracking", () => {
    const client = fakeClient();
    const createClient = vi.fn((_options: unknown) => client);
    const analytics = new DesktopAnalytics(createClient, true);

    expect(analytics.configure(PRODUCTION_APP)).toBe(true);
    expect(createClient).toHaveBeenCalledWith({
      apiUrl: OPENPANEL_API_URL,
      clientId: expect.any(String),
    });
    expect(createClient.mock.calls[0]?.[0]).not.toHaveProperty("clientSecret");
    expect(client.setGlobalProperties).toHaveBeenCalledWith({
      __referrer: "",
      surface: "desktop",
      environment: "production",
      app_version: "1.2.3",
      platform: "darwin",
    });
  });

  it("retains identity before configuration and applies it to buffered events", () => {
    const client = fakeClient();
    const analytics = new DesktopAnalytics(() => client, true);
    analytics.setUser({ id: "account-1", email: "person@example.com" });
    analytics.track("agent_action", { action: "delete", result: "succeeded" });

    analytics.configure(PRODUCTION_APP);

    expect(client.identify).toHaveBeenCalledWith({ profileId: "account-1", email: "person@example.com" });
    expect(client.track).toHaveBeenCalledWith("agent_action", {
      action: "delete",
      result: "succeeded",
      profileId: "account-1",
      __timestamp: expect.any(String),
    });
  });

  it("clears before identifying a different account", () => {
    const client = fakeClient();
    const order: string[] = [];
    vi.mocked(client.clear).mockImplementation(async () => {
      order.push("clear");
    });
    vi.mocked(client.identify).mockImplementation(async () => {
      order.push("identify");
    });
    const analytics = new DesktopAnalytics(() => client, true);
    analytics.configure(PRODUCTION_APP);
    analytics.setUser({ id: "account-1", email: "one@example.com" });
    order.length = 0;

    analytics.setUser({ id: "account-2", email: "two@example.com" });

    expect(order).toEqual(["clear", "identify"]);
    expect(client.identify).toHaveBeenLastCalledWith({ profileId: "account-2", email: "two@example.com" });
  });

  it("keeps the captured profile through a logout race", () => {
    const client = fakeClient();
    const analytics = new DesktopAnalytics(() => client, true);
    analytics.configure(PRODUCTION_APP);
    analytics.setUser({ id: "account-1", email: "person@example.com" });
    const scope = analytics.scope();

    analytics.clear();
    scope.track("account_sign_out", { result: "succeeded" });

    expect(client.track).toHaveBeenCalledWith("account_sign_out", {
      result: "succeeded",
      profileId: "account-1",
    });
  });

  it("keeps pre-authentication events anonymous even when another identity exists", () => {
    const client = fakeClient();
    const analytics = new DesktopAnalytics(() => client, true);
    analytics.configure(PRODUCTION_APP);
    analytics.setUser({ id: "account-1", email: "person@example.com" });

    analytics.anonymousScope().track("account_sign_in_started", { result: "code_sent" });

    expect(client.track).toHaveBeenCalledWith("account_sign_in_started", { result: "code_sent" });
  });

  it("sanitizes runtime payloads independently of TypeScript types", () => {
    expect(
      sanitizeDesktopAnalyticsEvent("message_send", {
        ...Object.assign(
          { channel: "agent" as const, attachment_count: 2, is_reply: true, result: "succeeded" as const },
          { text: "private message", url: "https://private.example" },
        ),
      }),
    ).toEqual({ channel: "agent", attachment_count: 2, is_reply: true, result: "succeeded" });
    expect(
      sanitizeDesktopAnalyticsEvent("agent_action", {
        action: "delete",
        result: "failed",
        failure_code: "raw exception text",
      }),
    ).toEqual({ action: "delete", result: "failed", failure_code: "unknown" });
  });

  it("keeps only the newest 100 events buffered before configuration", () => {
    const client = fakeClient();
    const analytics = new DesktopAnalytics(() => client, true);
    for (let index = 0; index < 101; index += 1) {
      analytics.track("search_action", { scope: "global", result: "succeeded", result_count: index });
    }

    analytics.configure(PRODUCTION_APP);

    expect(client.track).toHaveBeenCalledTimes(100);
    expect(client.track).not.toHaveBeenCalledWith("search_action", expect.objectContaining({ result_count: 0 }));
    expect(client.track).toHaveBeenCalledWith(
      "search_action",
      expect.objectContaining({ result_count: 100, __timestamp: expect.any(String) }),
    );
  });

  it("does not let SDK failures escape", () => {
    const client = fakeClient();
    vi.mocked(client.track).mockImplementation(() => {
      throw new Error("offline");
    });
    const analytics = new DesktopAnalytics(() => client, true);
    analytics.configure(PRODUCTION_APP);

    expect(() => analytics.track("agent_action", { action: "delete", result: "succeeded" })).not.toThrow();
    const unavailable = new DesktopAnalytics(() => {
      throw new Error("unavailable");
    }, true);
    expect(() => unavailable.configure(PRODUCTION_APP)).not.toThrow();
    expect(unavailable.configure(PRODUCTION_APP)).toBe(false);
  });
});
