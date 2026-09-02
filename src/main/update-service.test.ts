// @vitest-environment node

import { EventEmitter } from "node:events";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UpdateBusyPhase } from "@openbot/contracts/ipc";
import { isUpdateBusyPhase, UPDATE_BUSY_PHASES } from "@openbot/contracts/ipc";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdateCancellationToken, UpdateCheckOutcome } from "./update-service";
import { pruneShipItLogs, supportsInstalledUpdates, UpdateService } from "./update-service";

const CHECK_TIMEOUT = 1_000;
const DOWNLOAD_STALL_TIMEOUT = 2_000;
const INSTALL_TIMEOUT = 3_000;

class FakeCancellationToken {
  cancelled = false;
  cancel = vi.fn(() => {
    this.cancelled = true;
  });
}

class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowPrerelease = true;
  tokens: FakeCancellationToken[] = [];
  downloadTokens: (UpdateCancellationToken | undefined)[] = [];
  checkForUpdates = vi.fn(
    async (): Promise<UpdateCheckOutcome> => ({ isUpdateAvailable: false, updateInfo: { version: "0.1.0" } }),
  );
  downloadUpdate = vi.fn(async (token?: UpdateCancellationToken): Promise<string[]> => {
    this.downloadTokens.push(token);
    return [];
  });
  quitAndInstall = vi.fn();

  /** Mirrors electron-updater: a fresh cancellation token accompanies every available update. */
  mintToken(): FakeCancellationToken {
    const token = new FakeCancellationToken();
    this.tokens.push(token);
    return token;
  }
}

function createService(
  updater: FakeUpdater,
  options: {
    platform?: NodeJS.Platform;
    beforeInstall?: () => Promise<void>;
    autoDownload?: boolean;
  } = {},
) {
  return new UpdateService(updater, {
    currentVersion: "0.1.0",
    enabled: true,
    autoDownload: options.autoDownload ?? false,
    beforeInstall: options.beforeInstall ?? vi.fn(async () => undefined),
    platform: options.platform ?? "darwin",
    checkTimeoutMs: CHECK_TIMEOUT,
    downloadStallTimeoutMs: DOWNLOAD_STALL_TIMEOUT,
    installTimeoutMs: INSTALL_TIMEOUT,
  });
}

function makeUpdateAvailable(updater: FakeUpdater): void {
  updater.checkForUpdates.mockImplementation(async () => {
    updater.emit("checking-for-update");
    updater.emit("update-available", { version: "0.1.1" });
    return {
      isUpdateAvailable: true,
      versionInfo: { version: "0.1.1" },
      updateInfo: { version: "0.1.1" },
      cancellationToken: updater.mintToken(),
    };
  });
}

function completeDownload(updater: FakeUpdater): void {
  updater.downloadUpdate.mockImplementation(async (token?: UpdateCancellationToken) => {
    updater.downloadTokens.push(token);
    updater.emit("download-progress", { percent: 42.4 });
    updater.emit("update-downloaded", { version: "0.1.1" });
    return [];
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("UpdateService", () => {
  it("exposes restart as soon as the macOS download finishes", async () => {
    const updater = new FakeUpdater();
    makeUpdateAvailable(updater);
    completeDownload(updater);
    const service = createService(updater, { platform: "darwin" });
    service.start(false);

    // The service owns the download, and nothing may install without the explicit restart action.
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.allowPrerelease).toBe(false);

    await service.checkForUpdates();
    await service.downloadUpdate();

    // No native staging event is emitted: waiting for one is what used to hang macOS forever.
    expect(service.getStatus()).toMatchObject({ phase: "ready", progress: 100, availableVersion: "0.1.1" });
  });

  it("downloads automatically when the preference is enabled", async () => {
    const updater = new FakeUpdater();
    makeUpdateAvailable(updater);
    completeDownload(updater);
    const service = createService(updater, { autoDownload: true });
    service.start(false);

    await service.checkForUpdates();
    await vi.waitFor(() => expect(service.getStatus().phase).toBe("ready"));
    expect(updater.downloadUpdate).toHaveBeenCalledOnce();
    expect(updater.downloadTokens.at(0)).toBe(updater.tokens.at(0));
  });

  it("waits for the download action when the preference is disabled", async () => {
    const updater = new FakeUpdater();
    makeUpdateAvailable(updater);
    completeDownload(updater);
    const service = createService(updater, { autoDownload: false });
    service.start(false);

    await service.checkForUpdates();
    expect(service.getStatus().phase).toBe("available");
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
  });

  it("starts the pending download when the preference is switched on", async () => {
    const updater = new FakeUpdater();
    makeUpdateAvailable(updater);
    completeDownload(updater);
    const service = createService(updater, { autoDownload: false });
    service.start(false);
    await service.checkForUpdates();

    service.setAutoDownload(true);

    expect(service.getAutoDownload()).toBe(true);
    await vi.waitFor(() => expect(service.getStatus().phase).toBe("ready"));
  });

  it("does not start a download when the preference is switched off", async () => {
    const updater = new FakeUpdater();
    makeUpdateAvailable(updater);
    const service = createService(updater, { autoDownload: false });
    service.start(false);
    await service.checkForUpdates();

    service.setAutoDownload(false);

    expect(service.getStatus().phase).toBe("available");
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
  });

  it("installs a Windows update only after the explicit install action", async () => {
    const updater = new FakeUpdater();
    const beforeInstall = vi.fn(async () => undefined);
    makeUpdateAvailable(updater);
    completeDownload(updater);
    const service = createService(updater, { platform: "win32", beforeInstall });
    service.start(false);

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
    makeUpdateAvailable(updater);
    updater.downloadUpdate.mockImplementation(async () => {
      updater.emit("error", new Error("secret provider URL"));
      return [];
    });
    const service = createService(updater);
    service.start(false);
    await service.checkForUpdates();
    await service.downloadUpdate();

    expect(service.getStatus()).toMatchObject({
      phase: "error",
      errorCode: "download_failed",
      message: "Could not download the update. Try again.",
    });
    expect(JSON.stringify(service.getDiagnostics())).not.toContain("secret provider URL");
  });

  it("retries a failed download without another explicit check", async () => {
    const updater = new FakeUpdater();
    makeUpdateAvailable(updater);
    updater.downloadUpdate.mockImplementationOnce(async () => {
      updater.emit("error", new Error("network reset"));
      return [];
    });
    const service = createService(updater);
    service.start(false);
    await service.checkForUpdates();
    await service.downloadUpdate();
    expect(service.getStatus().errorCode).toBe("download_failed");

    completeDownload(updater);
    await service.downloadUpdate();

    expect(service.getStatus()).toMatchObject({ phase: "ready", availableVersion: "0.1.1" });
  });

  it("does not report a superseded download attempt after the stall watchdog gave up", async () => {
    vi.useFakeTimers();
    const updater = new FakeUpdater();
    makeUpdateAvailable(updater);
    let rejectDownload: ((error: Error) => void) | undefined;
    updater.downloadUpdate.mockImplementation(
      () =>
        new Promise<string[]>((_resolve, reject) => {
          rejectDownload = reject;
        }),
    );
    const service = createService(updater);
    service.start(false);
    await service.checkForUpdates();
    const download = service.downloadUpdate();
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(DOWNLOAD_STALL_TIMEOUT);
    const reported = service.getStatus();
    // The abandoned transfer rejects later; it must not overwrite the message the user is reading.
    rejectDownload?.(new Error("aborted"));
    await download;

    expect(updater.tokens.at(0)?.cancel).toHaveBeenCalledOnce();
    expect(service.getStatus()).toEqual(reported);
    expect(service.getStatus().message).toBe("The update download stopped responding. Try again.");
  });

  it("re-checks for a fresh cancellation token when retrying a cancelled attempt", async () => {
    vi.useFakeTimers();
    const updater = new FakeUpdater();
    makeUpdateAvailable(updater);
    updater.downloadUpdate.mockImplementationOnce(() => new Promise<string[]>(() => undefined));
    const service = createService(updater);
    service.start(false);
    await service.checkForUpdates();
    void service.downloadUpdate();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(DOWNLOAD_STALL_TIMEOUT);
    expect(updater.tokens.at(0)?.cancelled).toBe(true);
    expect(updater.checkForUpdates).toHaveBeenCalledOnce();

    completeDownload(updater);
    await service.downloadUpdate();

    // A cancellation token is single use, so the retry has to mint a second one.
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(updater.tokens).toHaveLength(2);
    expect(updater.downloadTokens.at(-1)).toBe(updater.tokens.at(1));
    expect(service.getStatus()).toMatchObject({ phase: "ready", availableVersion: "0.1.1" });
  });

  it("fails a download that stops reporting progress", async () => {
    vi.useFakeTimers();
    const updater = new FakeUpdater();
    makeUpdateAvailable(updater);
    updater.downloadUpdate.mockImplementation(() => new Promise<string[]>(() => undefined));
    const service = createService(updater);
    service.start(false);
    await service.checkForUpdates();
    void service.downloadUpdate();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.getStatus().phase).toBe("downloading");

    await vi.advanceTimersByTimeAsync(DOWNLOAD_STALL_TIMEOUT);

    expect(service.getStatus()).toMatchObject({
      phase: "error",
      errorCode: "download_failed",
      message: "The update download stopped responding. Try again.",
    });
    expect(updater.tokens.at(0)?.cancel).toHaveBeenCalledOnce();
  });

  it("keeps a slow download alive while progress still arrives", async () => {
    vi.useFakeTimers();
    const updater = new FakeUpdater();
    makeUpdateAvailable(updater);
    updater.downloadUpdate.mockImplementation(() => new Promise<string[]>(() => undefined));
    const service = createService(updater);
    service.start(false);
    await service.checkForUpdates();
    void service.downloadUpdate();
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(DOWNLOAD_STALL_TIMEOUT - 1);
    updater.emit("download-progress", { percent: 10 });
    await vi.advanceTimersByTimeAsync(DOWNLOAD_STALL_TIMEOUT - 1);

    expect(service.getStatus()).toMatchObject({ phase: "downloading", progress: 10 });
  });

  it("fails a check that never answers", async () => {
    vi.useFakeTimers();
    const updater = new FakeUpdater();
    updater.checkForUpdates.mockImplementation(() => new Promise<never>(() => undefined));
    const service = createService(updater);
    service.start(false);
    void service.checkForUpdates();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.getStatus().phase).toBe("checking");

    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT);

    expect(service.getStatus()).toMatchObject({ phase: "error", errorCode: "check_failed" });
  });

  it("recovers when the installer hands back control without quitting", async () => {
    vi.useFakeTimers();
    const updater = new FakeUpdater();
    makeUpdateAvailable(updater);
    completeDownload(updater);
    const service = createService(updater, { platform: "win32" });
    service.start(false);
    await service.checkForUpdates();
    await service.downloadUpdate();
    await service.installUpdate();
    expect(service.getStatus().phase).toBe("installing");

    await vi.advanceTimersByTimeAsync(INSTALL_TIMEOUT);

    expect(service.getStatus()).toMatchObject({
      phase: "error",
      errorCode: "install_failed",
      message: "Could not restart to install the update. Quit and reopen OpenBot to finish updating.",
    });
    // The restart action has to come back, otherwise the update can never be applied.
    await service.installUpdate();
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(2);
  });

  it("keeps the install deadline through the shutdown preparation that stops the service", async () => {
    vi.useFakeTimers();
    const updater = new FakeUpdater();
    makeUpdateAvailable(updater);
    completeDownload(updater);
    let service: UpdateService | undefined;
    // Production beforeInstall is prepareForUpdateInstall, which runs prepareForShutdown and stops
    // the service. The install deadline is the only escape from a restart that never happens, so it
    // has to outlive that teardown.
    const beforeInstall = vi.fn(async () => {
      service?.stop();
    });
    service = createService(updater, { platform: "darwin", beforeInstall });
    service.start(false);
    await service.checkForUpdates();
    await service.downloadUpdate();
    await service.installUpdate();
    expect(beforeInstall).toHaveBeenCalledOnce();
    expect(service.getStatus().phase).toBe("installing");

    await vi.advanceTimersByTimeAsync(INSTALL_TIMEOUT);

    expect(service.getStatus()).toMatchObject({ phase: "error", errorCode: "install_failed" });
  });

  it("releases the restart action when the installer reports a failure", async () => {
    const updater = new FakeUpdater();
    makeUpdateAvailable(updater);
    completeDownload(updater);
    const service = createService(updater, { platform: "win32" });
    service.start(false);
    await service.checkForUpdates();
    await service.downloadUpdate();
    updater.quitAndInstall.mockImplementationOnce(() => {
      updater.emit("error", new Error("no update filepath provided"));
    });

    await service.installUpdate();

    expect(service.getStatus()).toMatchObject({ phase: "error", errorCode: "install_failed" });
    await service.installUpdate();
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(2);
  });

  it("does not run the installer if shutdown preparation fails", async () => {
    const updater = new FakeUpdater();
    makeUpdateAvailable(updater);
    completeDownload(updater);
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
      autoDownload: true,
      beforeInstall: vi.fn(async () => undefined),
    });
    service.start(false);

    expect((await service.checkForUpdates()).phase).toBe("unsupported");
    expect((await service.downloadUpdate()).phase).toBe("unsupported");
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
  });
});

/**
 * The guarantee issue #152 was missing: a phase the UI renders as a spinner must always resolve. The
 * driver table is typed over UpdateBusyPhase, so a new busy phase cannot be added without giving it a
 * way to be entered here and proving it still times out.
 */
describe("every busy update phase is bounded", () => {
  const LONGEST_TIMEOUT = Math.max(CHECK_TIMEOUT, DOWNLOAD_STALL_TIMEOUT, INSTALL_TIMEOUT);

  const enterPhase: Record<UpdateBusyPhase, (service: UpdateService, updater: FakeUpdater) => Promise<void>> = {
    checking: async (service, updater) => {
      updater.checkForUpdates.mockImplementation(() => new Promise<never>(() => undefined));
      void service.checkForUpdates();
    },
    downloading: async (service, updater) => {
      makeUpdateAvailable(updater);
      updater.downloadUpdate.mockImplementation(() => new Promise<string[]>(() => undefined));
      await service.checkForUpdates();
      void service.downloadUpdate();
    },
    installing: async (service, updater) => {
      makeUpdateAvailable(updater);
      completeDownload(updater);
      await service.checkForUpdates();
      await service.downloadUpdate();
      await service.installUpdate();
    },
  };

  it.each(UPDATE_BUSY_PHASES)("reports an actionable error instead of waiting forever in %s", async (phase) => {
    vi.useFakeTimers();
    const updater = new FakeUpdater();
    const service = createService(updater, { platform: "win32" });
    service.start(false);

    await enterPhase[phase](service, updater);
    await vi.advanceTimersByTimeAsync(0);
    expect(service.getStatus().phase).toBe(phase);

    await vi.advanceTimersByTimeAsync(LONGEST_TIMEOUT);

    const settled = service.getStatus();
    expect(isUpdateBusyPhase(settled.phase)).toBe(false);
    expect(settled.phase).toBe("error");
    expect(settled.errorCode).not.toBeNull();
    expect(settled.message).toBeTruthy();
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
