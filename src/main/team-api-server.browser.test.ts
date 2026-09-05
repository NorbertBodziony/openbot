// @vitest-environment node

// The embedded browser over the wire: `src/main/team-api/route-browser.ts`.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowser, createTeamApiFixture, jsonRequest, stopTeamApiFixtures } from "./team-api-server-test-harness";

afterEach(stopTeamApiFixtures);

describe("TeamApiServer browser", () => {
  it("returns a bounded browser preview to an authenticated client", async () => {
    const { start, signIn } = await createTeamApiFixture("browser-preview", { configure: true });
    const capturePreview = vi.fn(async () => ({
      dataUrl: "data:image/jpeg;base64,YWJj",
      width: 960,
      height: 600,
    }));
    const { base } = await start({
      browser: createBrowser({ capturePreview }),
    });

    const token = await signIn();
    const preview = await jsonRequest<{ dataUrl: string; width: number; height: number }>(base, "/v1/browser/preview", {
      token: token,
      body: { tabId: "tab-login" },
    });

    expect(capturePreview).toHaveBeenCalledWith("tab-login");
    expect(preview).toEqual({ dataUrl: "data:image/jpeg;base64,YWJj", width: 960, height: 600 });
  });
});
