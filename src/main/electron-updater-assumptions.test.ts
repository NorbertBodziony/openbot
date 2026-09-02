// @vitest-environment node

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The macOS update flow in update-service.ts is built on specific behaviour inside electron-updater,
 * none of which is part of its public API. Issue #152 happened because the updater waited for a
 * native staging event that electron-updater only triggers under a condition we had turned off, and a
 * hand-written fake in the unit tests happily emitted that event anyway — so the suite passed while
 * the product hung forever.
 *
 * These assertions read the installed package instead of a fake, so a version bump that changes any
 * of these behaviours fails here. If that happens, re-verify the whole download and install flow
 * against the new version before raising the pinned version below; do not just update the string.
 */
const VERIFIED_VERSION = "6.8.9";

const require_ = createRequire(import.meta.url);
const packageRoot = dirname(require_.resolve("electron-updater/package.json"));

async function readOut(file: string): Promise<string> {
  return readFile(join(packageRoot, "out", file), "utf8");
}

describe("electron-updater assumptions", () => {
  it("pins the version these assumptions were verified against", async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    expect(manifest.version).toBe(VERIFIED_VERSION);
  });

  it("only asks Squirrel to stage the update when autoInstallOnAppQuit is on", async () => {
    const source = await readOut("MacUpdater.js");
    // We keep autoInstallOnAppQuit off so nothing installs without shutdown preparation, which means
    // this branch never runs and the native update-downloaded event never fires. Waiting on that
    // event is what left macOS stuck on "Preparing update...".
    expect(source).toMatch(/if\s*\(this\.autoInstallOnAppQuit\)\s*\{[\s\S]{0,200}?nativeUpdater\.checkForUpdates\(\)/u);
  });

  it("dispatches update-downloaded before any Squirrel staging", async () => {
    const source = await readOut("MacUpdater.js");
    const dispatched = source.indexOf("this.dispatchUpdateDownloaded(event)");
    const staged = source.indexOf("if (this.autoInstallOnAppQuit)");
    expect(dispatched).toBeGreaterThan(-1);
    expect(staged).toBeGreaterThan(dispatched);
  });

  it("stages the update on demand from quitAndInstall", async () => {
    const source = await readOut("MacUpdater.js");
    // This is why "ready" is a valid state straight after the download: the restart action stages the
    // ZIP itself when Squirrel has not already done so.
    const quitAndInstall = source.slice(source.indexOf("quitAndInstall() {"));
    expect(quitAndInstall).toMatch(/if\s*\(this\.squirrelDownloadedUpdate\)/u);
    expect(quitAndInstall).toMatch(/nativeUpdater\.on\("update-downloaded"/u);
    expect(quitAndInstall).toMatch(/nativeUpdater\.checkForUpdates\(\)/u);
  });

  it("returns a cancellation token from every check that finds an update", async () => {
    const source = await readOut("AppUpdater.js");
    // The service reuses this token for both the automatic and the manual download, which is what
    // lets a download be cancelled without depending on builder-util-runtime directly.
    const outcome = source.slice(source.indexOf("this.updateInfoAndProvider = result;"));
    expect(outcome).toMatch(/const cancellationToken = new builder_util_runtime_1\.CancellationToken\(\)/u);
    expect(outcome).toMatch(/isUpdateAvailable: true,[\s\S]{0,200}?cancellationToken,/u);
  });

  it("keeps a manual download cancellable and deduplicated", async () => {
    const source = await readOut("AppUpdater.js");
    expect(source).toMatch(/downloadUpdate\(cancellationToken = new builder_util_runtime_1\.CancellationToken\(\)\)/u);
    expect(source).toMatch(/if\s*\(this\.downloadPromise != null\)/u);
  });

  it("can hand control back from quitAndInstall without quitting", async () => {
    const source = await readOut("BaseUpdater.js");
    // install() returns false on a missing installer or a thrown installer, and quitAndInstall then
    // returns normally. The service has to release its install latch on the error event, or the
    // restart action would never come back.
    const quitAndInstall = source.slice(
      source.indexOf("quitAndInstall(isSilent = false, isForceRunAfter = false) {"),
      source.indexOf("executeDownload(taskOptions) {"),
    );
    expect(quitAndInstall).toMatch(/const isInstalled = this\.install\(/u);
    expect(quitAndInstall).toMatch(/else\s*\{[\s\S]{0,120}?this\.quitAndInstallCalled = false;/u);
  });

  it("does not install on quit while autoInstallOnAppQuit is off", async () => {
    const source = await readOut("BaseUpdater.js");
    // This is the guarantee that keeps prepareForUpdateInstall on the only install path.
    expect(source).toMatch(/addQuitHandler\(\)\s*\{[\s\S]{0,200}?!this\.autoInstallOnAppQuit/u);
  });
});
