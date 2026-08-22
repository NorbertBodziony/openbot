import type { AppInfo } from "@openbot/contracts/ipc";
import { describe, expect, it, vi } from "vitest";
import { DesktopAnalytics, OPENPANEL_API_URL, type OpenPanelClient, shouldEnableDesktopAnalytics } from "./analytics";

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

  it("configures OpenPanel without a client secret or automatic tracking", () => {
    const client = fakeClient();
    const createClient = vi.fn((_options: unknown) => client);
    const analytics = new DesktopAnalytics(createClient, true);

    expect(analytics.configure(PRODUCTION_APP)).toBe(true);
    expect(createClient).toHaveBeenCalledWith({
      apiUrl: OPENPANEL_API_URL,
      clientId: expect.any(String),
      trackScreenViews: false,
      trackOutgoingLinks: false,
      trackAttributes: false,
      sessionReplay: { enabled: false },
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

  it("identifies by account ID and email and clears on logout", () => {
    const client = fakeClient();
    const analytics = new DesktopAnalytics(() => client, true);
    analytics.configure(PRODUCTION_APP);

    analytics.identify({ id: "account-1", email: "person@example.com" });
    analytics.clear();

    expect(client.identify).toHaveBeenCalledWith({ profileId: "account-1", email: "person@example.com" });
    expect(client.clear).toHaveBeenCalledOnce();
  });

  it("sends only the declared metadata for a message event", () => {
    const client = fakeClient();
    const analytics = new DesktopAnalytics(() => client, true);
    analytics.configure(PRODUCTION_APP);
    analytics.track("message_sent", {
      channel: "agent",
      attachment_count: 2,
      is_reply: true,
      delivery_count: 1,
    });

    expect(client.track).toHaveBeenCalledWith("message_sent", {
      channel: "agent",
      attachment_count: 2,
      is_reply: true,
      delivery_count: 1,
    });
  });

  it("does not let client failures escape", () => {
    const client = fakeClient();
    vi.mocked(client.track).mockImplementation(() => {
      throw new Error("offline");
    });
    const analytics = new DesktopAnalytics(() => client, true);
    analytics.configure(PRODUCTION_APP);

    expect(() => analytics.track("agent_deleted", {})).not.toThrow();
  });

  it("does not let initialization failures escape", () => {
    const analytics = new DesktopAnalytics(() => {
      throw new Error("unavailable");
    }, true);

    expect(() => analytics.configure(PRODUCTION_APP)).not.toThrow();
    expect(analytics.configure(PRODUCTION_APP)).toBe(false);
  });
});
