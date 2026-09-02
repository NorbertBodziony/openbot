import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { isDynamicRecord, isNumber } from "@openbot/contracts/runtime-values";
import type { Rectangle } from "electron";

interface WindowSize {
  width: number;
  height: number;
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
