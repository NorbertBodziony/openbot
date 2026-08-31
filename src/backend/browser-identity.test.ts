import { describe, expect, it } from "vitest";
import { embeddedBrowserUserAgent, embeddedBrowserUserAgentForUrl } from "./browser-identity";

describe("embeddedBrowserUserAgent", () => {
  it("removes Electron while preserving the app product and Chromium version", () => {
    expect(
      embeddedBrowserUserAgent(
        "Mozilla/5.0 AppleWebKit/537.36 OpenBot/0.3.5 Chrome/152.0.7977.54 Electron/44.0.0 Safari/537.36",
      ),
    ).toBe("Mozilla/5.0 AppleWebKit/537.36 OpenBot/0.3.5 Chrome/152.0.7977.54 Safari/537.36");
  });
});

describe("embeddedBrowserUserAgentForUrl", () => {
  const userAgent = "Mozilla/5.0 AppleWebKit/537.36 OpenBot/0.3.5 Chrome/152.0.7977.54 Electron/44.0.0 Safari/537.36";

  it("uses a standard Chromium identity for X", () => {
    expect(embeddedBrowserUserAgentForUrl(userAgent, "https://x.com/i/flow/login")).toBe(
      "Mozilla/5.0 AppleWebKit/537.36 Chrome/152.0.7977.54 Safari/537.36",
    );
  });

  it("keeps the embedded app identity for other sites", () => {
    expect(embeddedBrowserUserAgentForUrl(userAgent, "https://accounts.google.com/")).toContain("OpenBot/0.3.5");
  });
});
