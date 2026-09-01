import type { AppInfo } from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { OpenPanelBase } from "@openpanel/web";
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
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(createClient).toHaveBeenCalledWith({
      apiUrl: OPENPANEL_API_URL,
      clientId: expect.any(String),
    });
    expect(createClient.mock.calls[0]?.[0]).not.toHaveProperty("clientSecret");
    expect(client.setGlobalProperties).toHaveBeenCalledWith({
      __referrer: "",
      surface: "desktop",
      environment: "production",
      event_schema_version: 3,
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

  it("updates the email for the same account without clearing its session", () => {
    const client = fakeClient();
    const analytics = new DesktopAnalytics(() => client, true);
    analytics.configure(PRODUCTION_APP);
    analytics.setUser({ id: "account-1", email: "old@example.com" });
    vi.mocked(client.clear).mockClear();
    vi.mocked(client.identify).mockClear();

    analytics.setUser({ id: "account-1", email: "new@example.com" });

    expect(client.clear).not.toHaveBeenCalled();
    expect(client.identify).toHaveBeenCalledWith({ profileId: "account-1", email: "new@example.com" });
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
    const identifiedClient = fakeClient();
    const anonymousClient = fakeClient();
    const createClient = vi.fn().mockReturnValueOnce(identifiedClient).mockReturnValueOnce(anonymousClient);
    const analytics = new DesktopAnalytics(createClient, true);
    analytics.configure(PRODUCTION_APP);
    analytics.setUser({ id: "account-1", email: "person@example.com" });

    analytics.anonymousScope().track("account_sign_in_started", { result: "code_sent" });

    expect(identifiedClient.track).not.toHaveBeenCalled();
    expect(anonymousClient.track).toHaveBeenCalledWith("account_sign_in_started", { result: "code_sent" });
  });

  it("keeps anonymous events unassigned in the real SDK transport", async () => {
    const requests: unknown[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const analytics = new DesktopAnalytics((options) => new OpenPanelBase(options), true);
      analytics.configure(PRODUCTION_APP);
      analytics.setUser({ id: "account-1", email: "person@example.com" });
      analytics.anonymousScope().track("account_sign_in_started", { result: "code_sent" });

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
      const request = requests.find(
        (candidate) =>
          isDynamicRecord(candidate) &&
          isDynamicRecord(candidate.payload) &&
          candidate.payload.name === "account_sign_in_started",
      );
      expect(isDynamicRecord(request) && isDynamicRecord(request.payload) ? request.payload.profileId : undefined).toBe(
        undefined,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("sends the account email through the real SDK transport", async () => {
    const requests: unknown[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const analytics = new DesktopAnalytics((options) => new OpenPanelBase(options), true);
      analytics.configure(PRODUCTION_APP);
      analytics.setUser({ id: "account-1", email: "person@example.com" });
      analytics.track("agent_action", { action: "delete", result: "succeeded" });

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      const identifyRequest = requests.find((candidate) => isDynamicRecord(candidate) && candidate.type === "identify");
      const trackRequest = requests.find(
        (candidate) =>
          isDynamicRecord(candidate) && isDynamicRecord(candidate.payload) && candidate.payload.name === "agent_action",
      );
      expect(
        isDynamicRecord(identifyRequest) && isDynamicRecord(identifyRequest.payload) ? identifyRequest.payload : null,
      ).toMatchObject({ profileId: "account-1", email: "person@example.com" });
      expect(
        isDynamicRecord(trackRequest) && isDynamicRecord(trackRequest.payload)
          ? trackRequest.payload.profileId
          : undefined,
      ).toBe("account-1");
      expect(JSON.stringify(trackRequest)).not.toContain("person@example.com");
    } finally {
      vi.unstubAllGlobals();
    }
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
    expect(
      sanitizeDesktopAnalyticsEvent(
        "routine_action",
        Object.assign(
          { action: "test" as const, trigger_type: "hourly", duration_ms: Number.NaN, result: "failed" as const },
          { failure_code: "test_failed", provider: "private-provider", changed_fields: ["name", "private"] },
        ),
      ),
    ).toEqual({ action: "test", trigger_type: "hourly", result: "failed", failure_code: "test_failed" });
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

  it("disables both identified and anonymous tracking until re-enabled", () => {
    const identifiedClient = fakeClient();
    const anonymousClient = fakeClient();
    const createClient = vi.fn().mockReturnValueOnce(identifiedClient).mockReturnValueOnce(anonymousClient);
    const analytics = new DesktopAnalytics(createClient, true);
    analytics.setTrackingEnabled(false);
    analytics.setUser({ id: "account-1", email: "person@example.com" });
    analytics.configure(PRODUCTION_APP);
    analytics.track("agent_action", { action: "delete", result: "succeeded" });
    analytics.anonymousScope().track("account_sign_in_started", { result: "code_sent" });

    expect(identifiedClient.identify).not.toHaveBeenCalled();
    expect(identifiedClient.track).not.toHaveBeenCalled();
    expect(anonymousClient.track).not.toHaveBeenCalled();

    analytics.setTrackingEnabled(true);
    analytics.track("agent_action", { action: "delete", result: "succeeded" });
    expect(identifiedClient.identify).toHaveBeenCalledWith({
      profileId: "account-1",
      email: "person@example.com",
    });
    expect(identifiedClient.track).toHaveBeenCalledOnce();
  });
});
