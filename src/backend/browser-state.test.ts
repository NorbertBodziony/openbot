import { describe, expect, it } from "vitest";
import { persistentBrowserUrl, X_LANDING_URL } from "./browser-state";

describe("persistentBrowserUrl", () => {
  it("restarts volatile X onboarding routes from the stable login entry", () => {
    expect(persistentBrowserUrl("https://x.com/i/jf/onboarding/web#/s/signup_phone/r-z4wf9")).toBe(X_LANDING_URL);
    expect(persistentBrowserUrl("https://x.com/i/jf/onboarding/web?flow=expired#/s/knowledge_check/r-old")).toBe(
      X_LANDING_URL,
    );
  });

  it("keeps ordinary browser URLs and hashes", () => {
    expect(persistentBrowserUrl("https://x.com/home")).toBe("https://x.com/home");
    expect(persistentBrowserUrl("https://example.com/app#/saved-view")).toBe("https://example.com/app#/saved-view");
  });
});
