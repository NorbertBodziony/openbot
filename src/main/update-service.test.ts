// @vitest-environment node

import { EventEmitter } from "node:events";
import type { AppUpdater } from "electron-updater";
import { describe, expect, it, vi } from "vitest";
import { supportsInstalledUpdates, UpdateService } from "./update-service";

class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = false;
  allowPrerelease = true;
  checkForUpdates = vi.fn(async () => null);
  downloadUpdate = vi.fn(async () => [] as string[]);
  quitAndInstall = vi.fn();
}

function createService(updater: FakeUpdater, beforeInstall = vi.fn(async () => undefined)) {
  return new UpdateService(updater as unknown as AppUpdater, {
    currentVersion: "0.1.0",
    enabled: true,
    beforeInstall,
  });
}

describe("UpdateService", () => {
  it("checks, downloads, and installs an available update", async () => {
    const updater = new FakeUpdater();
    const beforeInstall = vi.fn(async () => undefined);
    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit("checking-for-update");
      updater.emit("update-available", { version: "0.1.1" });
      return null;
    });
    updater.downloadUpdate.mockImplementation(async () => {
      updater.emit("download-progress", { percent: 42.4 });
      updater.emit("update-downloaded", { version: "0.1.1" });
      return [];
    });
    const service = createService(updater, beforeInstall);
    service.start(false);

    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(updater.allowPrerelease).toBe(false);

    await service.checkForUpdates();
    expect(service.getStatus()).toMatchObject({
      phase: "available",
      currentVersion: "0.1.0",
      availableVersion: "0.1.1",
    });

    await service.downloadUpdate();
    expect(service.getStatus()).toMatchObject({
      phase: "ready",
      availableVersion: "0.1.1",
      progress: 100,
    });

    await service.installUpdate();
    expect(beforeInstall).toHaveBeenCalledOnce();
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it("surfaces up-to-date and recoverable error states", async () => {
    const updater = new FakeUpdater();
    updater.checkForUpdates
      .mockImplementationOnce(async () => {
        updater.emit("update-not-available", { version: "0.1.0" });
        return null;
      })
      .mockRejectedValueOnce(new Error("network details that should not reach the renderer"));
    const service = createService(updater);
    service.start(false);

    await service.checkForUpdates();
    expect(service.getStatus()).toMatchObject({ phase: "up-to-date", availableVersion: null });

    await service.checkForUpdates();
    expect(service.getStatus()).toMatchObject({
      phase: "error",
      message: "Could not check for updates. Try again.",
    });
  });

  it("does not contact the update provider from an unsupported build", async () => {
    const updater = new FakeUpdater();
    const service = new UpdateService(updater as unknown as AppUpdater, {
      currentVersion: "0.1.0",
      enabled: false,
      beforeInstall: vi.fn(async () => undefined),
    });
    service.start(false);

    expect((await service.checkForUpdates()).phase).toBe("unsupported");
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
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
