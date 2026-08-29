import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import type { DynamicIslandPreference } from "@openbot/contracts/ipc";
import { isBoolean, isDynamicRecord } from "@openbot/contracts/runtime-values";

const DEFAULT_PREFERENCE: DynamicIslandPreference = {
  enabled: true,
  hapticsEnabled: true,
  idleVisible: true,
  additionalDisplaysEnabled: true,
};

export async function readDynamicIslandPreference(path: string): Promise<DynamicIslandPreference> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (!isDynamicRecord(parsed) || !isBoolean(parsed.enabled)) {
      return { ...DEFAULT_PREFERENCE };
    }
    if (parsed.version === 1) return { ...DEFAULT_PREFERENCE, enabled: parsed.enabled };
    if (parsed.version === 2 && isBoolean(parsed.hapticsEnabled)) {
      return { ...DEFAULT_PREFERENCE, enabled: parsed.enabled, hapticsEnabled: parsed.hapticsEnabled };
    }
    if (
      parsed.version !== 3 ||
      !isBoolean(parsed.hapticsEnabled) ||
      !isBoolean(parsed.idleVisible) ||
      !isBoolean(parsed.additionalDisplaysEnabled)
    ) {
      return { ...DEFAULT_PREFERENCE };
    }
    return {
      enabled: parsed.enabled,
      hapticsEnabled: parsed.hapticsEnabled,
      idleVisible: parsed.idleVisible,
      additionalDisplaysEnabled: parsed.additionalDisplaysEnabled,
    };
  } catch (error) {
    if (isMissing(error) || error instanceof SyntaxError) return { ...DEFAULT_PREFERENCE };
    throw error;
  }
}

export async function writeDynamicIslandPreference(
  path: string,
  preference: DynamicIslandPreference,
): Promise<DynamicIslandPreference> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify({ version: 3, ...preference })}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
    return { ...preference };
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
