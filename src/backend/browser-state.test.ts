import { describe, expect, it } from "vitest";
import { persistentBrowserUrl, storedBrowserTab, X_LANDING_URL } from "./browser-state";

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

describe("storedBrowserTab", () => {
  it("reopens a tab a pre-rename release owned, under the agent id that release's agent now has", () => {
    // The file on disk is whatever the last build wrote, and a released one spelled the owner key
    // `ownerBotId` and the id value `bot-<uuid>`. Rejecting either loses every tab the user had open.
    expect(
      storedBrowserTab({
        id: "tab-1",
        url: "https://example.com/app",
        ownerThreadId: "openbot-thread-agent-6d3e8b17-9c04-4f21-8a55-1b2c3d4e5f60",
        ownerBotId: "bot-6d3e8b17-9c04-4f21-8a55-1b2c3d4e5f60",
      }),
    ).toEqual({
      id: "tab-1",
      url: "https://example.com/app",
      ownerThreadId: "openbot-thread-agent-6d3e8b17-9c04-4f21-8a55-1b2c3d4e5f60",
      ownerAgentId: "agent-6d3e8b17-9c04-4f21-8a55-1b2c3d4e5f60",
    });
    // An owner the application did not mint is a name migration v13 leaves alone, so the tab keeps it.
    expect(
      storedBrowserTab({ id: "tab-2", url: "https://example.com/", ownerThreadId: null, ownerBotId: "chief" }),
    ).toMatchObject({ ownerAgentId: "chief" });
    expect(
      storedBrowserTab({ id: "tab-3", url: "https://example.com/", ownerThreadId: null, ownerAgentId: null }),
    ).toMatchObject({ ownerAgentId: null });
    expect(
      storedBrowserTab({ id: "tab-4", url: "file:///etc/passwd", ownerThreadId: null, ownerAgentId: null }),
    ).toBeNull();
  });
});
