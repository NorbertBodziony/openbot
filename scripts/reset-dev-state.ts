import { lstat, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, parse, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type DevelopmentProfile, developmentUserDataName } from "../src/main/development-profile";
import { resolveDevelopmentAppDataRoot } from "./development-state-paths";
import { cleanupSeedOwnedTransfers } from "./seed-dev-state";

export { resolveDevelopmentAppDataRoot } from "./development-state-paths";

const developmentProfiles = ["app", "test-client"] as const satisfies readonly DevelopmentProfile[];
const legacyDevelopmentStateNames = ["OpenBot Dev Host"] as const;

export function developmentStatePaths(appDataRoot: string): string[] {
  const safeRoot = resolve(appDataRoot);
  if (safeRoot === parse(safeRoot).root) {
    throw new Error("The application data root cannot be a filesystem root.");
  }

  return [
    ...developmentProfiles.map((profile) => developmentUserDataName(profile)),
    ...legacyDevelopmentStateNames,
  ].map((name) => {
    const target = resolve(safeRoot, name);
    if (dirname(target) !== safeRoot) {
      throw new Error(`Unsafe OpenBot dev state path: ${target}`);
    }
    return target;
  });
}

export async function resetDevelopmentState(appDataRoot: string, homeDirectory = homedir()): Promise<string[]> {
  const deletedPaths: string[] = [];

  for (const statePath of developmentStatePaths(appDataRoot)) {
    try {
      await lstat(statePath);
    } catch (error) {
      if (isMissing(error)) {
        continue;
      }
      throw error;
    }

    await cleanupSeedOwnedTransfers(statePath, homeDirectory);
    await rm(statePath, { force: true, maxRetries: 3, recursive: true, retryDelay: 100 });
    deletedPaths.push(statePath);
  }

  return deletedPaths;
}

async function main(): Promise<void> {
  const appDataRoot = resolveDevelopmentAppDataRoot();
  const deletedPaths = await resetDevelopmentState(appDataRoot);

  if (deletedPaths.length === 0) {
    console.log("No OpenBot development state was found.");
  } else {
    console.log("OpenBot development state reset:");
    for (const deletedPath of deletedPaths) {
      console.log(`- ${deletedPath}`);
    }
  }

  console.log("Seed-owned transfer files were removed. Other shared files were not changed.");
  console.log("Agent workspaces, ~/.codex, and ~/.claude were not changed.");
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isMainModule(): boolean {
  const entryPath = process.argv[1];
  return entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href;
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
