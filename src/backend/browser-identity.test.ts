import { describe, expect, it } from "vitest";
import { embeddedBrowserUserAgent } from "./browser-identity";

describe("embeddedBrowserUserAgent", () => {
  it("removes Electron while preserving the OpenBot product and Chromium version", () => {
    expect(
      embeddedBrowserUserAgent(
        "Mozilla/5.0 AppleWebKit/537.36 OpenBot/0.3.5 Chrome/152.0.7977.54 Electron/44.0.0 Safari/537.36",
      ),
    ).toBe("Mozilla/5.0 AppleWebKit/537.36 OpenBot/0.3.5 Chrome/152.0.7977.54 Safari/537.36");
  });
});
