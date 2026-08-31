import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { describe, expect, it, vi } from "vitest";
import {
  isLikelyAutomation,
  LandingAnalytics,
  landingAcquisitionSource,
  OPENPANEL_API_URL,
  shouldEnableLandingAnalytics,
} from "../src/lib/analytics";

describe("landing analytics", () => {
  it("enables only the production landing hostname", () => {
    expect(shouldEnableLandingAnalytics("openbot.run", true)).toBe(true);
    expect(shouldEnableLandingAnalytics("localhost", true)).toBe(false);
    expect(shouldEnableLandingAnalytics("openbot.run", false)).toBe(false);
  });

  it("tracks only allowlisted links and download metadata", () => {
    document.body.innerHTML = `
      <header class="landing-header"><a id="contact" href="https://x.com/norbertbodziony">Contact</a></header>
      <section class="landing-download"><a id="mac" href="/download/macos">Download</a></section>
      <a id="private" href="https://private.example/secret">Private</a>
    `;
    const client = {
      screenView: vi.fn(),
      setGlobalProperties: vi.fn(),
      track: vi.fn(),
    };
    const createClient = vi.fn((_options: unknown) => client);
    const analytics = new LandingAnalytics(createClient, true);
    const cleanup = analytics.start(document, "openbot.run");

    clickWithoutNavigation("#contact");
    clickWithoutNavigation("#mac");
    clickWithoutNavigation("#private");
    cleanup();

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
      surface: "landing",
      environment: "production",
      event_schema_version: 3,
    });
    expect(client.screenView).toHaveBeenCalledOnce();
    expect(client.screenView).toHaveBeenCalledWith("/");
    expect(client.track).toHaveBeenNthCalledWith(1, "landing_viewed", {});
    expect(client.track).toHaveBeenNthCalledWith(2, "landing_link_clicked", {
      destination: "contact",
      placement: "header",
    });
    expect(client.track).toHaveBeenNthCalledWith(3, "landing_download_clicked", {
      platform: "macos",
      placement: "download_section",
    });
    expect(client.track).toHaveBeenCalledTimes(3);
  });

  it("does not create a client outside production", () => {
    const createClient = vi.fn();
    const analytics = new LandingAnalytics(createClient, false);
    analytics.start(document, "openbot.run");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("tracks the invitation page anonymously and removes its click listener", () => {
    document.body.innerHTML = `
      <a id="open" href="openbot://join?invite=private">Open app</a>
      <a id="download" href="/download/macos">Download</a>
    `;
    const client = { screenView: vi.fn(), setGlobalProperties: vi.fn(), track: vi.fn() };
    const analytics = new LandingAnalytics(() => client, true);
    const cleanup = analytics.startJoin(document, "openbot.run", { validInvite: true, platform: "macos" });

    document.querySelector<HTMLElement>("#open")?.click();
    document.querySelector<HTMLElement>("#download")?.click();
    cleanup();
    document.querySelector<HTMLElement>("#open")?.click();

    expect(client.track).toHaveBeenNthCalledWith(1, "join_page_action", { action: "view", valid_invite: true });
    expect(client.track).toHaveBeenNthCalledWith(2, "join_page_action", { action: "open_app" });
    expect(client.track).toHaveBeenNthCalledWith(3, "join_page_action", {
      action: "download",
      platform: "macos",
    });
    expect(client.track).toHaveBeenCalledTimes(3);
    expect(client.screenView).toHaveBeenCalledOnce();
    expect(client.screenView).toHaveBeenCalledWith("/join");
    expect(JSON.stringify(client.track.mock.calls)).not.toContain("profileId");
    expect(JSON.stringify(client.track.mock.calls)).not.toContain("private");
  });

  it("replaces an existing document listener instead of double tracking clicks", () => {
    document.body.innerHTML = '<a id="open" href="openbot://join">Open app</a>';
    const client = { screenView: vi.fn(), setGlobalProperties: vi.fn(), track: vi.fn() };
    const analytics = new LandingAnalytics(() => client, true);
    analytics.startJoin(document, "openbot.run", { validInvite: false, platform: "windows" });
    const cleanup = analytics.startJoin(document, "openbot.run", { validInvite: true, platform: "windows" });

    document.querySelector<HTMLElement>("#open")?.click();
    cleanup();

    expect(client.track.mock.calls.filter(([name]) => name === "join_page_action")).toEqual([
      ["join_page_action", { action: "view", valid_invite: false }],
      ["join_page_action", { action: "view", valid_invite: true }],
      ["join_page_action", { action: "open_app" }],
    ]);
    expect(client.screenView).toHaveBeenCalledOnce();
  });

  it("sends one anonymous screen view with a safe invitation path through the real SDK", async () => {
    window.history.replaceState({}, "", "/join?invite=private-token#secret");
    const requests: unknown[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const analytics = new LandingAnalytics(undefined, true);
      analytics.startJoin(document, "openbot.run", { validInvite: true, platform: "macos" });

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      const screenViewRequest = requests.find(
        (candidate) =>
          isDynamicRecord(candidate) && isDynamicRecord(candidate.payload) && candidate.payload.name === "screen_view",
      );
      const payload =
        isDynamicRecord(screenViewRequest) && isDynamicRecord(screenViewRequest.payload)
          ? screenViewRequest.payload
          : null;
      expect(payload).toMatchObject({ properties: expect.objectContaining({ __path: "/join" }) });
      expect(payload).not.toHaveProperty("profileId");
      expect(JSON.stringify(requests)).not.toContain("private-token");
      expect(JSON.stringify(requests)).not.toContain("#secret");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("derives only coarse acquisition sources and ignores automation", () => {
    window.history.replaceState({}, "", "/?utm_source=github-campaign");
    expect(landingAcquisitionSource(document)).toBe("github");
    expect(isLikelyAutomation({ userAgent: "HeadlessChrome", webdriver: false })).toBe(true);
    expect(isLikelyAutomation({ userAgent: "Mozilla/5.0", webdriver: false })).toBe(false);
  });

  it("does not let initialization failures escape", () => {
    const analytics = new LandingAnalytics(() => {
      throw new Error("unavailable");
    }, true);

    expect(() => analytics.start(document, "openbot.run")).not.toThrow();
  });
});

function clickWithoutNavigation(selector: string): void {
  const link = document.querySelector<HTMLAnchorElement>(selector);
  if (!link) throw new Error(`Missing test link: ${selector}`);
  link.addEventListener("click", (event) => event.preventDefault(), { once: true });
  link.click();
}
