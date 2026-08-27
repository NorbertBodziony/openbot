import { EventEmitter } from "node:events";
import { appendFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { UpdateFailureCode, UpdateStatus } from "@openbot/contracts/ipc";
import type { AppUpdater, ProgressInfo, UpdateInfo } from "electron-updater";

type UpdateAdapter = {
  allowPrerelease: boolean;
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  checkForUpdates: () => Promise<Awaited<ReturnType<AppUpdater["checkForUpdates"]>>>;
  downloadUpdate: () => Promise<unknown>;
  on(event: "checking-for-update", listener: () => void): unknown;
  on(event: "update-available", listener: (info: UpdateInfo) => void): unknown;
  on(event: "update-not-available", listener: (info: UpdateInfo) => void): unknown;
  on(event: "download-progress", listener: (progress: ProgressInfo) => void): unknown;
  on(event: "update-downloaded", listener: (info: UpdateInfo) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  quitAndInstall: (isSilent?: boolean, isForceRunAfter?: boolean) => void;
};

type NativeUpdateAdapter = {
  on(event: "update-downloaded", listener: () => void): unknown;
};

type UpdateOperation = "check" | "download" | "prepare" | "install";

interface UpdateServiceEvents {
  status: [status: UpdateStatus];
}

interface UpdateServiceOptions {
  currentVersion: string;
  enabled: boolean;
  beforeInstall: () => Promise<void>;
  platform?: NodeJS.Platform;
  nativeUpdater?: NativeUpdateAdapter;
  logDirectory?: string;
  shipItDirectory?: string;
  initialCheckDelayMs?: number;
  checkIntervalMs?: number;
}

export interface UpdateDiagnosticEvent {
  at: string;
  phase: UpdateStatus["phase"];
  errorCode: UpdateFailureCode | null;
}

const DEFAULT_CHECK_INTERVAL = 4 * 60 * 60 * 1_000;
const MAX_LOG_BYTES = 1024 * 1024;
const MAX_DIAGNOSTIC_EVENTS = 20;

export function supportsInstalledUpdates(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "win32";
}

export class UpdateService extends EventEmitter<UpdateServiceEvents> {
  readonly #updater: UpdateAdapter;
  readonly #options: Required<
    Pick<UpdateServiceOptions, "currentVersion" | "enabled" | "platform" | "initialCheckDelayMs" | "checkIntervalMs">
  > &
    Pick<UpdateServiceOptions, "beforeInstall" | "nativeUpdater" | "logDirectory" | "shipItDirectory">;
  #status: UpdateStatus;
  #checkTimer: ReturnType<typeof setTimeout> | null = null;
  #started = false;
  #installStarted = false;
  #operation: UpdateOperation = "check";
  #history: UpdateDiagnosticEvent[] = [];
  #logWrite = Promise.resolve();

  constructor(updater: UpdateAdapter, options: UpdateServiceOptions) {
    super();
    this.#updater = updater;
    this.#options = {
      ...options,
      platform: options.platform ?? process.platform,
      initialCheckDelayMs: options.initialCheckDelayMs ?? 12_000,
      checkIntervalMs: options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL,
    };
    this.#status = {
      phase: options.enabled ? "idle" : "unsupported",
      currentVersion: options.currentVersion,
      availableVersion: null,
      progress: null,
      checkedAt: null,
      message: options.enabled ? null : "Updates are available in installed desktop builds.",
      errorCode: null,
    };
    this.#recordStatus();
  }

  start(scheduleChecks = true): void {
    if (this.#started) return;
    this.#started = true;
    this.#updater.autoDownload = false;
    this.#updater.autoInstallOnAppQuit = false;
    this.#updater.allowPrerelease = false;

    this.#updater.on("checking-for-update", () => {
      this.#operation = "check";
      this.#setStatus({ phase: "checking", progress: null, message: null, errorCode: null });
    });
    this.#updater.on("update-available", (info: UpdateInfo) => {
      this.#setStatus({
        phase: "available",
        availableVersion: info.version,
        progress: null,
        checkedAt: new Date().toISOString(),
        message: null,
        errorCode: null,
      });
    });
    this.#updater.on("update-not-available", () => {
      this.#setStatus({
        phase: "up-to-date",
        availableVersion: null,
        progress: null,
        checkedAt: new Date().toISOString(),
        message: null,
        errorCode: null,
      });
    });
    this.#updater.on("download-progress", (progress: ProgressInfo) => {
      this.#operation = "download";
      this.#setStatus({ phase: "downloading", progress: clampProgress(progress.percent), errorCode: null });
    });
    this.#updater.on("update-downloaded", (info: UpdateInfo) => {
      if (this.#options.platform === "darwin") {
        this.#operation = "prepare";
        this.#setStatus({
          phase: "preparing",
          availableVersion: info.version,
          progress: 100,
          message: null,
          errorCode: null,
        });
        return;
      }
      this.#markReady(info.version);
    });
    this.#updater.on("error", () => this.#setError(failureCode(this.#operation)));
    if (this.#options.platform === "darwin") {
      this.#options.nativeUpdater?.on("update-downloaded", () => {
        if (this.#status.phase === "preparing") this.#markReady(this.#status.availableVersion);
      });
      if (this.#options.shipItDirectory) void pruneShipItLogs(this.#options.shipItDirectory);
    }

    if (scheduleChecks && this.#options.enabled) {
      this.#scheduleCheck(this.#options.initialCheckDelayMs);
    }
  }

  getStatus(): UpdateStatus {
    return { ...this.#status };
  }

  getDiagnostics(): UpdateDiagnosticEvent[] {
    return this.#history.map((event) => ({ ...event }));
  }

  async checkForUpdates(): Promise<UpdateStatus> {
    if (!this.#options.enabled) return this.getStatus();
    if (["checking", "downloading", "preparing", "ready", "installing"].includes(this.#status.phase)) {
      return this.getStatus();
    }
    this.#operation = "check";
    this.#setStatus({ phase: "checking", progress: null, message: null, errorCode: null });
    try {
      const result = await this.#updater.checkForUpdates();
      if (this.getStatus().phase === "checking") {
        this.#setStatus(
          result?.isUpdateAvailable
            ? {
                phase: "available",
                availableVersion: result.updateInfo.version,
                checkedAt: new Date().toISOString(),
              }
            : {
                phase: "up-to-date",
                availableVersion: null,
                checkedAt: new Date().toISOString(),
              },
        );
      }
    } catch {
      this.#setError("check_failed");
    } finally {
      this.#scheduleCheck(this.#options.checkIntervalMs);
    }
    return this.getStatus();
  }

  async downloadUpdate(): Promise<UpdateStatus> {
    if (this.#status.phase !== "available") return this.getStatus();
    this.#operation = "download";
    this.#setStatus({ phase: "downloading", progress: 0, message: null, errorCode: null });
    try {
      await this.#updater.downloadUpdate();
    } catch {
      this.#setError("download_failed");
    }
    return this.getStatus();
  }

  async installUpdate(): Promise<void> {
    if (this.#status.phase !== "ready" || this.#installStarted) {
      throw new Error("An update is not ready to install.");
    }
    this.#installStarted = true;
    this.#operation = "install";
    this.#setStatus({ phase: "installing", message: null, errorCode: null });
    try {
      await this.#options.beforeInstall();
      this.#updater.quitAndInstall(false, true);
    } catch {
      this.#installStarted = false;
      this.#setError("install_failed");
      throw new Error("OpenBot could not restart to install the update.");
    }
  }

  stop(): void {
    if (this.#checkTimer) clearTimeout(this.#checkTimer);
    this.#checkTimer = null;
  }

  #markReady(version: string | null): void {
    this.#setStatus({
      phase: "ready",
      availableVersion: version,
      progress: 100,
      message: null,
      errorCode: null,
    });
  }

  #scheduleCheck(delayMs: number): void {
    if (this.#checkTimer) clearTimeout(this.#checkTimer);
    this.#checkTimer = setTimeout(() => void this.checkForUpdates(), delayMs);
    this.#checkTimer.unref?.();
  }

  #setError(errorCode: UpdateFailureCode): void {
    this.#setStatus({
      phase: "error",
      progress: null,
      checkedAt: new Date().toISOString(),
      message: errorMessage(errorCode),
      errorCode,
    });
  }

  #setStatus(patch: Partial<UpdateStatus>): void {
    this.#status = { ...this.#status, ...patch };
    this.#recordStatus();
    this.emit("status", this.getStatus());
  }

  #recordStatus(): void {
    const event = { at: new Date().toISOString(), phase: this.#status.phase, errorCode: this.#status.errorCode };
    this.#history = [...this.#history.slice(-(MAX_DIAGNOSTIC_EVENTS - 1)), event];
    const logDirectory = this.#options.logDirectory;
    if (logDirectory) {
      this.#logWrite = this.#logWrite.then(() => appendUpdateLog(logDirectory, event));
    }
  }
}

function failureCode(operation: UpdateOperation): UpdateFailureCode {
  if (operation === "download") return "download_failed";
  if (operation === "prepare") return "prepare_failed";
  if (operation === "install") return "install_failed";
  return "check_failed";
}

function errorMessage(code: UpdateFailureCode) {
  if (code === "download_failed") return "Could not download the update. Try again.";
  if (code === "prepare_failed") return "Could not prepare the update. Restart OpenBot and try again.";
  if (code === "install_failed") return "Could not restart to install the update. Try again.";
  return "Could not check for updates. Try again.";
}

async function appendUpdateLog(directory: string, event: UpdateDiagnosticEvent): Promise<void> {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, "update.log");
    const rotatedPath = `${path}.1`;
    const size = await stat(path)
      .then((value) => value.size)
      .catch(() => 0);
    if (size >= MAX_LOG_BYTES) {
      await rm(rotatedPath, { force: true });
      await rename(path, rotatedPath);
    }
    await appendFile(path, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    // Update logging must not block updates.
  }
}

export async function pruneShipItLogs(directory: string): Promise<void> {
  try {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /^ShipIt_(?:stdout|stderr)\.log\.\d+$/u.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => Number(right.split(".").at(-1)) - Number(left.split(".").at(-1)));
    await Promise.all(entries.slice(10).map((entry) => rm(join(directory, entry), { force: true })));
  } catch {
    // ShipIt creates this directory only after its first update.
  }
}

function clampProgress(value: number): number {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? Math.round(value) : 0));
}
