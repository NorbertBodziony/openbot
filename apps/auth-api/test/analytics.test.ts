import { describe, expect, it, vi } from "vitest";
import { LandingAnalytics, OPENPANEL_API_URL, shouldEnableLandingAnalytics } from "../src/lib/analytics";

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
    });
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
