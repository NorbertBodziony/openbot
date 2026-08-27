// @vitest-environment node

import { EventEmitter } from "node:events";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { pruneShipItLogs, supportsInstalledUpdates, UpdateService } from "./update-service";

class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = false;
  allowPrerelease = true;
  checkForUpdates = vi.fn(async () => null);
  downloadUpdate = vi.fn(async (): Promise<string[]> => []);
  quitAndInstall = vi.fn();
}

function createService(
  updater: FakeUpdater,
  options: { platform?: NodeJS.Platform; nativeUpdater?: EventEmitter; beforeInstall?: () => Promise<void> } = {},
) {
  return new UpdateService(updater, {
    currentVersion: "0.1.0",
    enabled: true,
    beforeInstall: options.beforeInstall ?? vi.fn(async () => undefined),
    platform: options.platform ?? "darwin",
    nativeUpdater: options.nativeUpdater,
  });
}

function makeUpdateAvailable(updater: FakeUpdater): void {
  updater.checkForUpdates.mockImplementation(async () => {
    updater.emit("checking-for-update");
    updater.emit("update-available", { version: "0.1.1" });
    return null;
  });
}

describe("UpdateService", () => {
  it("waits for native macOS staging before it exposes restart", async () => {
    const updater = new FakeUpdater();
    const nativeUpdater = new EventEmitter();
    makeUpdateAvailable(updater);
    updater.downloadUpdate.mockImplementation(async () => {
      updater.emit("download-progress", { percent: 42.4 });
      updater.emit("update-downloaded", { version: "0.1.1" });
      return [];
    });
    const service = createService(updater, { platform: "darwin", nativeUpdater });
    service.start(false);

    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.allowPrerelease).toBe(false);
    await service.checkForUpdates();
    await service.downloadUpdate();
    expect(service.getStatus()).toMatchObject({ phase: "preparing", progress: 100 });

    nativeUpdater.emit("update-downloaded");
    expect(service.getStatus()).toMatchObject({ phase: "ready", availableVersion: "0.1.1" });
  });

  it("installs a Windows update only after the explicit install action", async () => {
    const updater = new FakeUpdater();
    const beforeInstall = vi.fn(async () => undefined);
    makeUpdateAvailable(updater);
    updater.downloadUpdate.mockImplementation(async () => {
      updater.emit("update-downloaded", { version: "0.1.1" });
      return [];
    });
    const service = createService(updater, { platform: "win32", beforeInstall });
    service.start(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);

    await service.checkForUpdates();
    await service.downloadUpdate();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    await service.installUpdate();
    expect(beforeInstall).toHaveBeenCalledOnce();
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
    await expect(service.installUpdate()).rejects.toThrow("not ready");
  });

  it("reports errors for the active update stage without raw provider details", async () => {
    const updater = new FakeUpdater();
    const nativeUpdater = new EventEmitter();
    makeUpdateAvailable(updater);
    updater.downloadUpdate.mockImplementation(async () => {
      updater.emit("update-downloaded", { version: "0.1.1" });
      updater.emit("error", new Error("secret provider URL"));
      return [];
    });
    const service = createService(updater, { nativeUpdater });
    service.start(false);
    await service.checkForUpdates();
    await service.downloadUpdate();

    expect(service.getStatus()).toMatchObject({
      phase: "error",
      errorCode: "prepare_failed",
      message: "Could not prepare the update. Restart OpenBot and try again.",
    });
    expect(JSON.stringify(service.getDiagnostics())).not.toContain("secret provider URL");
  });

  it("does not run the installer if shutdown preparation fails", async () => {
    const updater = new FakeUpdater();
    updater.downloadUpdate.mockImplementation(async () => {
      updater.emit("update-downloaded", { version: "0.1.1" });
      return [];
    });
    makeUpdateAvailable(updater);
    const service = createService(updater, {
      platform: "win32",
      beforeInstall: vi.fn(async () => {
        throw new Error("shutdown failed");
      }),
    });
    service.start(false);
    await service.checkForUpdates();
    await service.downloadUpdate();
    await expect(service.installUpdate()).rejects.toThrow(/could not restart/iu);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(service.getStatus().errorCode).toBe("install_failed");
  });

  it("does not contact the update provider from an unsupported build", async () => {
    const updater = new FakeUpdater();
    const service = new UpdateService(updater, {
      currentVersion: "0.1.0",
      enabled: false,
      beforeInstall: vi.fn(async () => undefined),
    });
    service.start(false);

    expect((await service.checkForUpdates()).phase).toBe("unsupported");
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });
});

describe("pruneShipItLogs", () => {
  it("keeps state files and the ten newest rotated logs", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-shipit-"));
    await Promise.all([
      writeFile(join(root, "ShipItState.plist"), "state"),
      ...Array.from({ length: 12 }, (_, index) => writeFile(join(root, `ShipIt_stdout.log.${index + 1}`), "log")),
    ]);
    await pruneShipItLogs(root);
    const entries = await readdir(root);
    expect(entries).toContain("ShipItState.plist");
    expect(entries.filter((entry) => entry.startsWith("ShipIt_stdout.log.")).sort()).toHaveLength(10);
    expect(entries).not.toContain("ShipIt_stdout.log.1");
    expect(entries).not.toContain("ShipIt_stdout.log.2");
  });
});

describe("supportsInstalledUpdates", () => {
  it.each([
    ["darwin", true],
    ["win32", true],
    ["linux", false],
  ] as const)("returns %s support as %s", (platform, expected) => {
    expect(supportsInstalledUpdates(platform)).toBe(expected);
  });
});
