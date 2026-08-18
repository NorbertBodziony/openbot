import { lstat, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type DevelopmentProfile, developmentUserDataName } from "../src/main/development-profile";

const developmentProfiles = ["app", "host"] as const satisfies readonly DevelopmentProfile[];

export function resolveDevelopmentAppDataRoot(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): string {
  if (platform === "darwin") {
    return join(homeDirectory, "Library", "Application Support");
  }

  if (platform === "win32") {
    const appData = environment.APPDATA?.trim();
    if (!appData) {
      throw new Error("APPDATA is not set. OpenBot dev state was not changed.");
    }
    return appData;
  }

  return environment.XDG_CONFIG_HOME?.trim() || join(homeDirectory, ".config");
}

export function developmentStatePaths(appDataRoot: string): string[] {
  const safeRoot = resolve(appDataRoot);
  if (safeRoot === parse(safeRoot).root) {
    throw new Error("The application data root cannot be a filesystem root.");
  }

  return developmentProfiles.map((profile) => {
    const target = resolve(safeRoot, developmentUserDataName(profile));
    if (dirname(target) !== safeRoot) {
      throw new Error(`Unsafe OpenBot dev state path: ${target}`);
    }
    return target;
  });
}

export async function resetDevelopmentState(appDataRoot: string): Promise<string[]> {
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
