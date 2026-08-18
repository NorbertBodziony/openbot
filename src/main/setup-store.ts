import { readFile, writeFile } from "node:fs/promises";
import type { AgentProviderId, AppSetupState } from "@openbot/contracts/ipc";

interface StoredSetup {
  version: 2;
  preferredProvider: AgentProviderId;
  completedAt: string;
}

const EMPTY_SETUP: AppSetupState = { completed: false, preferredProvider: null };

export async function readSetupState(path: string): Promise<AppSetupState> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<StoredSetup>;
    if (
      parsed.version !== 2 ||
      (parsed.preferredProvider !== "codex" && parsed.preferredProvider !== "claude") ||
      typeof parsed.completedAt !== "string"
    ) {
      return { ...EMPTY_SETUP };
    }
    return { completed: true, preferredProvider: parsed.preferredProvider };
  } catch (error) {
    if (isMissing(error) || error instanceof SyntaxError) return { ...EMPTY_SETUP };
    throw error;
  }
}

export async function writeSetupState(
  path: string,
  preferredProvider: AgentProviderId,
): Promise<AppSetupState> {
  const stored: StoredSetup = {
    version: 2,
    preferredProvider,
    completedAt: new Date().toISOString(),
  };
  await writeFile(path, `${JSON.stringify(stored)}\n`, { encoding: "utf8", mode: 0o600 });
  return { completed: true, preferredProvider };
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
