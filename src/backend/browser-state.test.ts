import { describe, expect, it } from "vitest";
import { persistentBrowserUrl, X_LOGIN_URL, xLoginUrlForLanding } from "./browser-state";

describe("xLoginUrlForLanding", () => {
  it("moves the logged-out X landing form to the stable login route", () => {
    expect(xLoginUrlForLanding("https://x.com/")).toBe(X_LOGIN_URL);
    expect(xLoginUrlForLanding("https://www.x.com/")).toBe(X_LOGIN_URL);
  });

  it("does not redirect signed-in or non-X pages", () => {
    expect(xLoginUrlForLanding("https://x.com/home")).toBeNull();
    expect(xLoginUrlForLanding("https://example.com/")).toBeNull();
  });
});

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
