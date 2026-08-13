import { describe, expect, it } from "vitest";
import { persistentBrowserUrl } from "./browser-state";

describe("persistentBrowserUrl", () => {
  it("restarts volatile X onboarding routes from the stable login entry", () => {
    expect(persistentBrowserUrl("https://x.com/i/jf/onboarding/web#/s/signup_phone/r-z4wf9")).toBe(
      "https://x.com/i/jf/onboarding/web?mode=login",
    );
    expect(
      persistentBrowserUrl(
        "https://x.com/i/jf/onboarding/web?flow=expired#/s/knowledge_check/r-old",
      ),
    ).toBe("https://x.com/i/jf/onboarding/web?mode=login");
  });

  it("keeps ordinary browser URLs and hashes", () => {
    expect(persistentBrowserUrl("https://x.com/home")).toBe("https://x.com/home");
    expect(persistentBrowserUrl("https://example.com/app#/saved-view")).toBe(
      "https://example.com/app#/saved-view",
    );
  });
});
