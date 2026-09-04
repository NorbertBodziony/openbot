// Guardrails that keep automation on the intended dev instance: the wrong
// port must fail before any click or keystroke can reach another app.

import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertMutationAllowed,
  describeDevPages,
  findRendererPages,
  isOpenBotBrowser,
  matchPages,
  resolveAutomationPort,
} from "./cdp-client";
import { describeTarget, findMainPages, isMainAppUrl } from "./page-url";
import { parseWaitTarget, reportableScreenshotPath, resolveScreenshotPath } from "./tools";

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

describe("matchPages", () => {
  // The point of --page= is that dev has nothing off limits: an embedded
  // browser view or a helper surface is a legitimate target when it is aimed
  // at by hand.
  const app = { url: () => "http://localhost:5173/" };
  const island = { url: () => "http://localhost:5173/?surface=dynamic-island" };
  const embedded = { url: () => "https://accounts.google.com/o/oauth2/auth" };
  const pages = [app, island, embedded];
  const ids = new Map([
    [app, "AAAA1111"],
    [island, "BBBB2222"],
    [embedded, "CCCC3333"],
  ]);
  const readId = async (page: (typeof pages)[number]): Promise<string> => ids.get(page) ?? "";

  it("aims at the target id the pages command printed, whatever the order is now", async () => {
    // The id has to survive another window closing between two commands,
    // which is exactly what an array position does not.
    await expect(matchPages(pages, "cccc3333", readId)).resolves.toEqual([embedded]);
    await expect(matchPages([embedded, app], "CCCC3333", readId)).resolves.toEqual([embedded]);
    await expect(matchPages(pages, "DDDD4444", readId)).resolves.toEqual([]);
  });

  it("aims at a target by a case-insensitive url fragment", async () => {
    await expect(matchPages(pages, "ACCOUNTS.GOOGLE", readId)).resolves.toEqual([embedded]);
    await expect(matchPages(pages, "dynamic-island", readId)).resolves.toEqual([island]);
  });

  it("reports every match so an ambiguous aim can be refused", async () => {
    await expect(matchPages(pages, "localhost:5173", readId)).resolves.toEqual([app, island]);
  });

  it("keeps matching by url when a page cannot report its id", async () => {
    const closing = async (): Promise<string> => {
      throw new Error("Target closed");
    };
    await expect(matchPages(pages, "dynamic-island", closing)).resolves.toEqual([island]);
  });
});

describe("describeDevPages", () => {
  it("names the targets it prints by id and keeps their queries out", async () => {
    const page = { url: () => "https://example.com/pay?token=abcdefghij" };
    await expect(describeDevPages([page], async () => "AAAA1111")).resolves.toEqual([
      { targetId: "AAAA1111", target: "https://example.com (external)" },
    ]);
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

  it("hides the path of a loopback page that is not an app route", () => {
    // An embedded view can serve a callback on 127.0.0.1, and such a path
    // carries its code as a plain segment where no redaction rule sees it.
    expect(describeTarget("http://127.0.0.1:8976/callback/abcdefghij")).toBe("http://127.0.0.1:8976/… (path hidden)");
    expect(describeTarget("http://localhost:5173/index.html")).toBe("http://localhost:5173/index.html");
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

describe("parseWaitTarget", () => {
  it("splits on the first comma so a name may contain one", () => {
    expect(parseWaitTarget("button,Send to Alice, Bob")).toEqual({ role: "button", name: "Send to Alice, Bob" });
  });

  it("rejects a target without a name or with an unknown role", () => {
    expect(() => parseWaitTarget("button")).toThrow("<role>,<name>");
    expect(() => parseWaitTarget("button,   ")).toThrow("accessible name");
    expect(() => parseWaitTarget("buton,Send")).toThrow('Unknown role "buton"');
  });
});

describe("resolveScreenshotPath containment", () => {
  it("refuses a destination reached through a symbolic link", () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-shot-root-"));
    const outside = mkdtempSync(join(tmpdir(), "openbot-shot-outside-"));
    // Lexically inside the build directory, but the write would land in
    // `outside` - which is how a read-only command could overwrite tracked
    // code without --allow-mutations.
    symlinkSync(outside, join(root, "escape"));
    expect(() => resolveScreenshotPath(root, "escape/shot.png", 0)).toThrow("symbolic link");
    symlinkSync(join(outside, "target.png"), join(root, "direct.png"));
    expect(() => resolveScreenshotPath(root, "direct.png", 0)).toThrow("symbolic link");
    expect(resolveScreenshotPath(root, "real/shot.png", 0)).toBe(join(root, "real", "shot.png"));
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
});

describe("reportableScreenshotPath", () => {
  it("drops the absolute prefix the developer's home directory carries", () => {
    expect(
      reportableScreenshotPath(
        "/Users/jan@example.com/work/tree/.openbot-build/shot.png",
        "/Users/jan@example.com/work/tree",
      ),
    ).toBe(".openbot-build/shot.png");
  });

  it("refuses a name it would have to redact, instead of returning one that cannot be reopened", () => {
    expect(() => reportableScreenshotPath("/tree/.openbot-build/token=abcdef123456.png", "/tree")).toThrow(
      "would be redacted",
    );
  });
});
