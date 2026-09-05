import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { isDynamicRecord, isNumber } from "@openbot/contracts/runtime-values";
import type { Rectangle } from "electron";

interface WindowSize {
  width: number;
  height: number;
}

interface MainWindowPresentationTarget {
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

export async function ensureMacApplicationPresence(
  platform: NodeJS.Platform,
  setActivationPolicy: (policy: "regular") => void,
  showDock: () => Promise<void>,
): Promise<void> {
  if (platform !== "darwin") return;
  setActivationPolicy("regular");
  await showDock();
}

export function presentMainWindow(
  window: MainWindowPresentationTarget,
  platform: NodeJS.Platform,
  showApplication: () => void,
): void {
  if (platform === "darwin") showApplication();
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

export async function readMainWindowBounds(path: string): Promise<Rectangle | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (
      !isDynamicRecord(parsed) ||
      parsed.version !== 1 ||
      !isNumber(parsed.x) ||
      !isNumber(parsed.y) ||
      !isNumber(parsed.width) ||
      !isNumber(parsed.height) ||
      !Number.isFinite(parsed.x) ||
      !Number.isFinite(parsed.y) ||
      !Number.isFinite(parsed.width) ||
      !Number.isFinite(parsed.height) ||
      parsed.width <= 0 ||
      parsed.height <= 0
    ) {
      return null;
    }
    return {
      x: Math.round(parsed.x),
      y: Math.round(parsed.y),
      width: Math.round(parsed.width),
      height: Math.round(parsed.height),
    };
  } catch (error) {
    if (isMissing(error) || error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function writeMainWindowBounds(path: string, bounds: Rectangle): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify({ version: 1, ...bounds })}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

/**
 * The window the recorder reads. Structural, like `MainWindowPresentationTarget` above, so this
 * module still imports no Electron value and its tests still need no mock.
 */
interface MainWindowBoundsSource {
  isDestroyed(): boolean;
  getNormalBounds(): Rectangle;
}

export interface MainWindowBoundsDependencies {
  /**
   * Read on every call, never captured: the `closed` handler drops the main window and a later
   * relaunch builds a new one, so a captured reference would flush a destroyed window.
   */
  getMainWindow: () => MainWindowBoundsSource | null;
  /**
   * The recorder decides *when* to persist; the caller decides *where*. Both of these are
   * `readMainWindowBounds` / `writeMainWindowBounds` above bound to a path in production - they are
   * parameters so that this file's own tests can observe how often a write actually happens, which
   * is the whole point of the debounce and is not otherwise visible from outside.
   */
  readBounds: () => Promise<Rectangle | null>;
  writeBounds: (bounds: Rectangle) => Promise<void>;
  reportError: (message: string, error: unknown) => void;
}

export interface MainWindowBoundsRecorder {
  restoreMainWindowBounds: () => Promise<void>;
  currentMainWindowBounds: () => Rectangle | null;
  rememberMainWindowBounds: (bounds: Rectangle) => void;
  flushMainWindowBounds: () => Promise<void>;
}

/** Long enough that a drag-resize writes once, short enough to survive a quit that follows it. */
const BOUNDS_WRITE_DELAY_MS = 250;

export function createMainWindowBoundsRecorder({
  getMainWindow,
  readBounds,
  writeBounds,
  reportError,
}: MainWindowBoundsDependencies): MainWindowBoundsRecorder {
  let bounds: Rectangle | null = null;
  let writeTimer: ReturnType<typeof setTimeout> | null = null;
  let write = Promise.resolve();

  // One shared chain, with the `.catch` before the `.then` so a rejected write is absorbed instead
  // of poisoning every write queued after it.
  function queueWrite(): Promise<void> {
    if (!bounds) return write;
    const pending = { ...bounds };
    write = write
      .catch((error) => reportError("Unable to save the previous main window position:", error))
      .then(() => writeBounds(pending));
    return write;
  }

  return {
    async restoreMainWindowBounds() {
      bounds = await readBounds().catch((error) => {
        reportError("Unable to restore the main window position:", error);
        return null;
      });
    },
    currentMainWindowBounds: () => bounds,
    rememberMainWindowBounds(next) {
      bounds = { ...next };
      if (writeTimer) clearTimeout(writeTimer);
      writeTimer = setTimeout(() => {
        writeTimer = null;
        void queueWrite().catch((error) => reportError("Unable to save the main window position:", error));
      }, BOUNDS_WRITE_DELAY_MS);
    },
    async flushMainWindowBounds() {
      const window = getMainWindow();
      if (window && !window.isDestroyed()) bounds = window.getNormalBounds();
      // Cleared before the first await: Windows session-end calls this from a synchronous handler
      // it never awaits, so a pending timer left here can outlive the decision to quit.
      if (writeTimer) {
        clearTimeout(writeTimer);
        writeTimer = null;
      }
      await queueWrite();
    },
  };
}

export function resolveMainWindowBounds(
  stored: Rectangle | null,
  workAreas: Rectangle[],
  currentWorkArea: Rectangle,
  defaultSize: WindowSize,
  minimumSize: WindowSize,
): Rectangle {
  const storedWorkArea = stored
    ? workAreas
        .map((workArea) => ({ workArea, overlap: intersectionArea(stored, workArea) }))
        .sort((left, right) => right.overlap - left.overlap)[0]
    : undefined;
  const restoreStoredPosition = Boolean(storedWorkArea?.overlap);
  const workArea = restoreStoredPosition ? storedWorkArea?.workArea : currentWorkArea;
  if (!workArea) return { x: 0, y: 0, ...defaultSize };

  const requestedSize = stored ?? { x: 0, y: 0, ...defaultSize };
  const width = Math.min(Math.max(requestedSize.width, minimumSize.width), workArea.width);
  const height = Math.min(Math.max(requestedSize.height, minimumSize.height), workArea.height);
  if (!restoreStoredPosition || !stored) {
    return {
      x: Math.round(workArea.x + (workArea.width - width) / 2),
      y: Math.round(workArea.y + (workArea.height - height) / 2),
      width,
      height,
    };
  }
  return {
    x: clamp(stored.x, workArea.x, workArea.x + workArea.width - width),
    y: clamp(stored.y, workArea.y, workArea.y + workArea.height - height),
    width,
    height,
  };
}

function intersectionArea(left: Rectangle, right: Rectangle): number {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  return width * height;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
