import { access } from "node:fs/promises";
import { join } from "node:path";

export interface RemoteDesktopRuntimePaths {
  sunshine: string;
  moonlightWebServer: string;
  moonlightStreamer: string;
}

export async function resolveRemoteDesktopRuntime(input: {
  isPackaged: boolean;
  resourcesPath: string;
  sourceRoot: string;
  platform: "darwin" | "win32" | "linux";
  architecture: string;
  overrideRoot?: string;
}): Promise<RemoteDesktopRuntimePaths | null> {
  if (input.platform === "linux") return null;
  const platformDirectory = input.platform;
  const architecture = input.platform === "darwin" ? "arm64" : "x64";
  if (input.architecture !== architecture) return null;
  const root = input.overrideRoot
    ? input.overrideRoot
    : input.isPackaged
      ? join(input.resourcesPath, "remote-desktop-runtime", platformDirectory, architecture)
      : join(input.sourceRoot, "build", "remote-desktop-runtime", platformDirectory, architecture);
  const suffix = input.platform === "win32" ? ".exe" : "";
  const paths = {
    sunshine:
      input.platform === "darwin"
        ? join(root, "Sunshine.app", "Contents", "MacOS", "Sunshine")
        : join(root, `sunshine${suffix}`),
    moonlightWebServer: join(root, `web-server${suffix}`),
    moonlightStreamer: join(root, `streamer${suffix}`),
  };
  try {
    await Promise.all(Object.values(paths).map((path) => access(path)));
    return paths;
  } catch {
    return null;
  }
}
