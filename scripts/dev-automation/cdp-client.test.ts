// Guardrails that keep automation on the intended dev instance: the wrong
// port must fail before any click or keystroke can reach another app.
import { describe, expect, it } from "vitest";
import { assertMutationAllowed, findRendererPages, isOpenBotBrowser, resolveAutomationPort } from "./cdp-client";
import { describeTarget, findMainPages, isMainAppUrl } from "./page-url";
import { resolveScreenshotPath } from "./tools";

describe("isOpenBotBrowser", () => {
  it("accepts the Electron user agent", () => {
    expect(isOpenBotBrowser("Mozilla/5.0 OpenBot/44.0.0 Chrome/152 Electron/44.0.0")).toBe(true);
  });

  it("rejects foreign Chromium instances sharing the machine", () => {
    expect(isOpenBotBrowser("Mozilla/5.0 Chrome/152 Safari/537.36")).toBe(false);
    expect(isOpenBotBrowser("")).toBe(false);
  });
});

describe("findMainPages", () => {
  const island = { url: () => "http://localhost:5173/?surface=dynamic-island" };
  const main = { url: () => "http://localhost:5173/" };
  const embedded = { url: () => "https://accounts.google.com/o/oauth2/auth?code=abcdefghij" };

  it("keeps the bare app route regardless of target order", () => {
    expect(findMainPages([island, main])).toEqual([main]);
    expect(findMainPages([main, island])).toEqual([main]);
  });

  it("never offers a helper surface or an embedded site as the app", () => {
    expect(findMainPages([island, embedded])).toEqual([]);
    expect(findMainPages([])).toEqual([]);
  });

  it("rejects the app route of another worktree's instance", () => {
    const sibling = { url: () => "http://localhost:5174/" };
    expect(findMainPages([sibling, main], 5_173)).toEqual([main]);
    expect(findMainPages([sibling], 5_173)).toEqual([]);
  });

  it("rejects an external page served from the app route", () => {
    expect(isMainAppUrl("https://example.com/")).toBe(false);
    expect(isMainAppUrl("http://127.0.0.1:5173/index.html")).toBe(true);
    expect(isMainAppUrl("devtools://devtools/bundled/inspector.html")).toBe(false);
    expect(isMainAppUrl("not a url")).toBe(false);
  });
});

describe("findRendererPages", () => {
  // `BrowserHost.open` accepts any http(s) address, so a visited local
  // development server can wear the app's origin and path. Only the preload
  // bridge separates them.
  const app = { url: () => "http://localhost:5173/", evaluate: async () => "object" };
  const visitedLocalSite = { url: () => "http://localhost:5173/", evaluate: async () => "undefined" };

  it("drives only a page that carries the OpenBot preload bridge", async () => {
    await expect(findRendererPages([visitedLocalSite, app])).resolves.toEqual([app]);
    await expect(findRendererPages([visitedLocalSite])).resolves.toEqual([]);
  });

  it("skips a page that closes or navigates while it is probed", async () => {
    const closing = {
      url: () => "http://localhost:5173/",
      evaluate: async () => {
        throw new Error("Target page, context or browser has been closed");
      },
    };
    await expect(findRendererPages([closing, app])).resolves.toEqual([app]);
  });
});

describe("describeTarget", () => {
  it("keeps a visited page's path and query out of the diagnostics", () => {
    const described = describeTarget("https://accounts.google.com/o/oauth2/auth?code=abcdefghij&state=xyz");
    expect(described).toBe("https://accounts.google.com (external)");
  });

  it("keeps the local route recognizable without its query", () => {
    expect(describeTarget("http://localhost:5173/?token=abcdefghij")).toBe("http://localhost:5173/");
    expect(describeTarget("http://localhost:5173/?surface=dynamic-island")).toBe("http://localhost:5173/ [surface]");
  });
});

describe("resolveScreenshotPath", () => {
  const root = "/tmp/openbot/.openbot-build/dev-automation";

  it("names a timestamped file inside the build directory by default", () => {
    expect(resolveScreenshotPath(root, null, 1_700_000_000_000)).toBe(`${root}/screenshot-1700000000000.png`);
  });

  it("refuses a destination outside the build directory", () => {
    expect(() => resolveScreenshotPath(root, "src/main/index.ts", 1)).toThrow(/must stay inside|\.png/u);
    expect(() => resolveScreenshotPath(root, "../../../src/main/index.ts", 1)).toThrow(/must stay inside/u);
    expect(() => resolveScreenshotPath(root, "/etc/hosts", 1)).toThrow(/must stay inside/u);
    expect(() => resolveScreenshotPath(root, "", 1)).toThrow(/cannot be empty/u);
  });

  it("accepts a relative .png name under the build directory", () => {
    expect(resolveScreenshotPath(root, "run-1/after.png", 1)).toBe(`${root}/run-1/after.png`);
  });
});

describe("resolveAutomationPort", () => {
  it("rejects values outside the dev port range", () => {
    expect(() => resolveAutomationPort("80", undefined)).toThrow();
  });

  it("marks defaulted ports as non-explicit so mutations refuse them", () => {
    expect(resolveAutomationPort(undefined, undefined)).toEqual({ port: 9_333, explicit: false });
    expect(resolveAutomationPort("", "  ")).toEqual({ port: 9_333, explicit: false });
  });

  it("marks flag and environment ports as explicit", () => {
    expect(resolveAutomationPort("9334", undefined)).toEqual({ port: 9334, explicit: true });
    expect(resolveAutomationPort(undefined, "9335")).toEqual({ port: 9335, explicit: true });
  });
});

describe("assertMutationAllowed", () => {
  it("refuses a mutation without the opt-in flag", () => {
    expect(() => assertMutationAllowed({ command: "click", allowMutations: false, instanceNamed: true })).toThrow(
      /--allow-mutations/u,
    );
  });

  it("refuses a mutation on an instance that was inferred rather than named", () => {
    expect(() =>
      assertMutationAllowed({ command: "type", allowMutations: true, instanceNamed: false, target: ":9333" }),
    ).toThrow(/--instance=/u);
  });

  it("allows a mutation that opts in and names its instance", () => {
    expect(() => assertMutationAllowed({ command: "click", allowMutations: true, instanceNamed: true })).not.toThrow();
  });
});
