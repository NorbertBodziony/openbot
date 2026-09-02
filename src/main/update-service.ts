import { EventEmitter } from "node:events";
import { appendFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { UpdateBusyPhase, UpdateFailureCode, UpdateStatus } from "@openbot/contracts/ipc";
import { isUpdateBusyPhase } from "@openbot/contracts/ipc";
import type { ProgressInfo, UpdateInfo } from "electron-updater";

/** Only the part of electron-updater's cancellation token this service depends on. */
export type UpdateCancellationToken = {
  readonly cancelled: boolean;
  cancel: () => void;
};

/** Only the part of a check result this service depends on. */
export type UpdateCheckOutcome = {
  readonly isUpdateAvailable: boolean;
  readonly updateInfo: { readonly version: string };
  readonly cancellationToken?: UpdateCancellationToken;
};

type UpdateAdapter = {
  allowPrerelease: boolean;
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  checkForUpdates(): Promise<UpdateCheckOutcome | null>;
  downloadUpdate(cancellationToken?: UpdateCancellationToken): Promise<unknown>;
  on(event: "checking-for-update", listener: () => void): unknown;
  on(event: "update-available", listener: (info: UpdateInfo) => void): unknown;
  on(event: "update-not-available", listener: (info: UpdateInfo) => void): unknown;
  on(event: "download-progress", listener: (progress: ProgressInfo) => void): unknown;
  on(event: "update-downloaded", listener: (info: UpdateInfo) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  quitAndInstall: (isSilent?: boolean, isForceRunAfter?: boolean) => void;
};

type UpdateOperation = "check" | "download" | "install";

interface UpdateServiceEvents {
  status: [status: UpdateStatus];
}

interface UpdateServiceOptions {
  currentVersion: string;
  enabled: boolean;
  autoDownload: boolean;
  beforeInstall: () => Promise<void>;
  platform?: NodeJS.Platform;
  logDirectory?: string;
  shipItDirectory?: string;
  initialCheckDelayMs?: number;
  checkIntervalMs?: number;
  checkTimeoutMs?: number;
  downloadStallTimeoutMs?: number;
  installTimeoutMs?: number;
}

export interface UpdateDiagnosticEvent {
  at: string;
  phase: UpdateStatus["phase"];
  errorCode: UpdateFailureCode | null;
}

const DEFAULT_CHECK_INTERVAL = 4 * 60 * 60 * 1_000;
const MAX_LOG_BYTES = 1024 * 1024;
const MAX_DIAGNOSTIC_EVENTS = 20;

/**
 * Every busy phase needs a deadline, and typing this as a total record over `UpdateBusyPhase` is what
 * enforces it: adding a phase to `UPDATE_BUSY_PHASES` without a timeout here fails to compile. A busy
 * phase with no bound is exactly how "Preparing update..." became a state the UI could never leave.
 */
const DEFAULT_PHASE_TIMEOUTS: Record<UpdateBusyPhase, number> = {
  /** One metadata request. A minute is far longer than any healthy check. */
  checking: 60_000,
  /**
   * Time without a single progress event, not a cap on the whole transfer: release artifacts run to
   * hundreds of megabytes, so a slow link must stay supported while a dead socket must not.
   */
  downloading: 120_000,
  /** Shutdown preparation plus a synchronous handover to the installer. */
  installing: 60_000,
};

export function supportsInstalledUpdates(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "win32";
}

export class UpdateService extends EventEmitter<UpdateServiceEvents> {
  readonly #updater: UpdateAdapter;
  readonly #options: Required<
    Pick<UpdateServiceOptions, "currentVersion" | "enabled" | "platform" | "initialCheckDelayMs" | "checkIntervalMs">
  > &
    Pick<UpdateServiceOptions, "beforeInstall" | "logDirectory" | "shipItDirectory"> & {
      phaseTimeoutsMs: Record<UpdateBusyPhase, number>;
    };
  #status: UpdateStatus;
  #checkTimer: ReturnType<typeof setTimeout> | null = null;
  #phaseTimer: ReturnType<typeof setTimeout> | null = null;
  #started = false;
  #installStarted = false;
  #operation: UpdateOperation = "check";
  #history: UpdateDiagnosticEvent[] = [];
  #logWrite = Promise.resolve();
  #autoDownload: boolean;
  #downloadedVersion: string | null = null;
  #cancellationToken: UpdateCancellationToken | null = null;
  #cancelled = false;
  #internalCheck = false;
  #checkGeneration = 0;
  #downloadGeneration = 0;

  constructor(updater: UpdateAdapter, options: UpdateServiceOptions) {
    super();
    this.#updater = updater;
    this.#autoDownload = options.autoDownload;
    this.#options = {
      ...options,
      platform: options.platform ?? process.platform,
      initialCheckDelayMs: options.initialCheckDelayMs ?? 12_000,
      checkIntervalMs: options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL,
      phaseTimeoutsMs: {
        checking: options.checkTimeoutMs ?? DEFAULT_PHASE_TIMEOUTS.checking,
        downloading: options.downloadStallTimeoutMs ?? DEFAULT_PHASE_TIMEOUTS.downloading,
        installing: options.installTimeoutMs ?? DEFAULT_PHASE_TIMEOUTS.installing,
      },
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
    // The automatic download is driven from this service so that both flows share one download path
    // and one cancellation token. autoInstallOnAppQuit stays off so nothing installs without the
    // explicit restart action, which is the only path that runs shutdown preparation.
    this.#updater.autoDownload = false;
    this.#updater.autoInstallOnAppQuit = false;
    this.#updater.allowPrerelease = false;

    this.#updater.on("checking-for-update", () => {
      if (this.#internalCheck) return;
      this.#operation = "check";
      this.#setStatus({ phase: "checking", progress: null, message: null, errorCode: null });
    });
    this.#updater.on("update-available", (info: UpdateInfo) => {
      if (this.#internalCheck) return;
      this.#downloadedVersion = null;
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
      if (this.#internalCheck) return;
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
      // electron-updater has staged everything it needs by now. On macOS quitAndInstall asks the
      // native updater for the ZIP on demand, so the restart action is available immediately.
      this.#markReady(info.version);
    });
    this.#updater.on("error", () => {
      if (this.#cancelled) return;
      // quitAndInstall can return without quitting, so an install failure has to release the latch
      // or the restart action would never become available again.
      if (this.#operation === "install") this.#installStarted = false;
      this.#setError(failureCode(this.#operation));
    });
    if (this.#options.platform === "darwin" && this.#options.shipItDirectory) {
      void pruneShipItLogs(this.#options.shipItDirectory);
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

  getAutoDownload(): boolean {
    return this.#autoDownload;
  }

  setAutoDownload(enabled: boolean): void {
    this.#autoDownload = enabled;
    if (enabled && this.#options.enabled && this.#status.phase === "available") void this.downloadUpdate();
  }

  async checkForUpdates(): Promise<UpdateStatus> {
    if (!this.#options.enabled) return this.getStatus();
    if (["checking", "downloading", "ready", "installing"].includes(this.#status.phase)) {
      return this.getStatus();
    }
    const generation = ++this.#checkGeneration;
    this.#operation = "check";
    this.#setStatus({ phase: "checking", progress: null, message: null, errorCode: null });
    try {
      const result = await this.#updater.checkForUpdates();
      if (this.#checkGeneration !== generation) return this.getStatus();
      this.#cancellationToken = result?.cancellationToken ?? null;
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
      if (this.#checkGeneration === generation) this.#setError("check_failed");
    } finally {
      this.#scheduleCheck(this.#options.checkIntervalMs);
    }
    // downloadUpdate() moves into "downloading" before its first await, so the caller and the
    // renderer see the download start rather than a stale "available".
    if (this.#autoDownload && this.#status.phase === "available") void this.downloadUpdate();
    return this.getStatus();
  }

  async downloadUpdate(): Promise<UpdateStatus> {
    if (!this.#options.enabled || !this.#canDownload()) return this.getStatus();
    const generation = ++this.#downloadGeneration;
    this.#cancelled = false;
    this.#operation = "download";
    this.#setStatus({ phase: "downloading", progress: 0, message: null, errorCode: null });
    try {
      const token = await this.#ensureCancellationToken();
      if (this.#downloadGeneration !== generation) return this.getStatus();
      await this.#updater.downloadUpdate(token ?? undefined);
    } catch {
      if (!this.#cancelled && this.#downloadGeneration === generation) this.#setError("download_failed");
    }
    return this.getStatus();
  }

  async cancelDownload(): Promise<UpdateStatus> {
    if (this.#status.phase !== "downloading") return this.getStatus();
    this.#cancelled = true;
    this.#downloadGeneration += 1;
    this.#cancellationToken?.cancel();
    this.#cancellationToken = null;
    this.#setStatus({
      phase: "available",
      progress: null,
      message: null,
      errorCode: null,
    });
    return this.getStatus();
  }

  async installUpdate(): Promise<void> {
    if (!this.#canInstall() || this.#installStarted) {
      throw new Error("An update is not ready to install.");
    }
    this.#installStarted = true;
    this.#operation = "install";
    this.#setStatus({ phase: "installing", progress: 100, message: null, errorCode: null });
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
    this.#clearPhaseTimer();
  }

  #canDownload(): boolean {
    if (this.#status.phase === "available") return true;
    return (
      this.#status.phase === "error" &&
      this.#status.errorCode === "download_failed" &&
      this.#status.availableVersion !== null
    );
  }

  #canInstall(): boolean {
    if (this.#downloadedVersion === null) return false;
    if (this.#status.phase === "ready") return true;
    return this.#status.phase === "error" && this.#status.errorCode === "install_failed";
  }

  /**
   * A cancellation token is single use, and electron-updater only mints one alongside update
   * metadata. Re-check quietly when the stored token is missing or spent so a retry after a cancel
   * still downloads under a live token.
   */
  async #ensureCancellationToken(): Promise<UpdateCancellationToken | null> {
    if (this.#cancellationToken && !this.#cancellationToken.cancelled) return this.#cancellationToken;
    this.#internalCheck = true;
    try {
      const result = await this.#updater.checkForUpdates();
      this.#cancellationToken = result?.cancellationToken ?? null;
    } catch {
      this.#cancellationToken = null;
    } finally {
      this.#internalCheck = false;
    }
    return this.#cancellationToken;
  }

  #markReady(version: string | null): void {
    this.#downloadedVersion = version;
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

  #clearPhaseTimer(): void {
    if (this.#phaseTimer) clearTimeout(this.#phaseTimer);
    this.#phaseTimer = null;
  }

  /**
   * Every phase that renders as busy is bounded here, so no status the user waits on can outlive its
   * timeout. Re-armed on each status write, which makes download progress events refresh the stall
   * deadline for free.
   */
  #armPhaseTimer(): void {
    this.#clearPhaseTimer();
    const timeoutMs = this.#phaseTimeoutMs();
    if (timeoutMs === null) return;
    this.#phaseTimer = setTimeout(() => {
      this.#phaseTimer = null;
      this.#failStalledPhase();
    }, timeoutMs);
    this.#phaseTimer.unref?.();
  }

  #phaseTimeoutMs(): number | null {
    const phase = this.#status.phase;
    return isUpdateBusyPhase(phase) ? this.#options.phaseTimeoutsMs[phase] : null;
  }

  #failStalledPhase(): void {
    if (this.#status.phase === "checking") {
      this.#checkGeneration += 1;
      this.#setError("check_failed");
      return;
    }
    if (this.#status.phase === "downloading") {
      this.#downloadGeneration += 1;
      this.#cancellationToken?.cancel();
      this.#cancellationToken = null;
      this.#setError("download_failed", "The update download stopped responding. Try again.");
      return;
    }
    if (this.#status.phase === "installing") {
      this.#installStarted = false;
      this.#setError(
        "install_failed",
        "Could not restart to install the update. Quit and reopen OpenBot to finish updating.",
      );
    }
  }

  #setError(errorCode: UpdateFailureCode, message?: string): void {
    this.#setStatus({
      phase: "error",
      progress: null,
      checkedAt: new Date().toISOString(),
      message: message ?? errorMessage(errorCode),
      errorCode,
    });
  }

  #setStatus(patch: Partial<UpdateStatus>): void {
    this.#status = { ...this.#status, ...patch };
    this.#recordStatus();
    this.#armPhaseTimer();
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
  if (operation === "install") return "install_failed";
  return "check_failed";
}

function errorMessage(code: UpdateFailureCode) {
  if (code === "download_failed") return "Could not download the update. Try again.";
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
