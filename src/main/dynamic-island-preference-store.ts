import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import type { DynamicIslandPreference } from "@openbot/contracts/ipc";
import { isBoolean, isDynamicRecord } from "@openbot/contracts/runtime-values";

const DEFAULT_PREFERENCE: DynamicIslandPreference = { enabled: true };

export async function readDynamicIslandPreference(path: string): Promise<DynamicIslandPreference> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (!isDynamicRecord(parsed) || parsed.version !== 1 || !isBoolean(parsed.enabled)) {
      return { ...DEFAULT_PREFERENCE };
    }
    return { enabled: parsed.enabled };
  } catch (error) {
    if (isMissing(error) || error instanceof SyntaxError) return { ...DEFAULT_PREFERENCE };
    throw error;
  }
}

export async function writeDynamicIslandPreference(path: string, enabled: boolean): Promise<DynamicIslandPreference> {
  const preference = { enabled };
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify({ version: 1, enabled })}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
    return preference;
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
