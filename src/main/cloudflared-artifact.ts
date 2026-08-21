import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolveCloudflaredExecutable } from "./host-tunnel-runtime";

export async function resolveOpenBotCloudflaredExecutable(input: {
  isPackaged: boolean;
  resourcesPath: string;
  sourceRoot: string;
  platform?: NodeJS.Platform;
  arch?: string;
  overridePath?: string;
  pathValue?: string;
}): Promise<string | null> {
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  if (platform !== "darwin" && platform !== "win32") return null;

  const platformDirectory = platform === "darwin" ? "mac" : "win";
  const executableName = platform === "win32" ? "cloudflared.exe" : "cloudflared";
  const candidates = [
    input.overridePath?.trim(),
    input.isPackaged ? join(input.resourcesPath, "cloudflared", platformDirectory, arch, executableName) : null,
    join(resolve(input.sourceRoot), "build", "cloudflared", platformDirectory, arch, executableName),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    try {
      await access(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
      return candidate;
    } catch {
      // Continue to the next OpenBot-managed artifact location.
    }
  }

  return resolveCloudflaredExecutable(input.pathValue);
}
