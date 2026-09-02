// @vitest-environment node

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The macOS update flow depends on electron-updater behaviour that is not part of its public API,
 * documented on `UpdateAdapter` in update-service.ts. Issue #152 happened because the updater waited
 * for a native staging event that electron-updater only triggers under a condition we keep switched
 * off - and the unit tests passed throughout, because their fake emitted that event anyway. A fake
 * cannot notice when the real library stops behaving the way it was written against, so this asserts
 * the resolved version instead: a bump has to be accompanied by re-reading those assumptions.
 */
const VERIFIED_VERSION = "6.8.9";

describe("electron-updater assumptions", () => {
  it("still resolves to the version the macOS update flow was verified against", async () => {
    const require_ = createRequire(import.meta.url);
    const manifestPath = join(dirname(require_.resolve("electron-updater/package.json")), "package.json");
    const { version } = JSON.parse(await readFile(manifestPath, "utf8"));

    expect(
      version,
      "electron-updater changed version. Re-verify the four behaviours documented on UpdateAdapter in " +
        "update-service.ts against the new release before updating VERIFIED_VERSION: MacUpdater only " +
        "asks Squirrel to stage while autoInstallOnAppQuit is on, quitAndInstall stages on demand, " +
        "every successful check returns a cancellation token, and BaseUpdater.quitAndInstall can " +
        "return without quitting.",
    ).toBe(VERIFIED_VERSION);
  });
});
