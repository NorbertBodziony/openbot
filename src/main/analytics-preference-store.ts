import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import type { AnalyticsPreference } from "@openbot/contracts/ipc";
import { isBoolean, isDynamicRecord } from "@openbot/contracts/runtime-values";

const DEFAULT_PREFERENCE: AnalyticsPreference = { enabled: true };

export async function readAnalyticsPreference(path: string): Promise<AnalyticsPreference> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (!isDynamicRecord(parsed) || parsed.version !== 1 || !isBoolean(parsed.enabled)) {
      return { enabled: false };
    }
    return { enabled: parsed.enabled };
  } catch (error) {
    if (isMissing(error)) return { ...DEFAULT_PREFERENCE };
    if (error instanceof SyntaxError) return { enabled: false };
    throw error;
  }
}

export async function writeAnalyticsPreference(path: string, enabled: boolean): Promise<AnalyticsPreference> {
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
