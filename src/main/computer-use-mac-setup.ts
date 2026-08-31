import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ComputerUseMacSetupState } from "@openbot/contracts/ipc";

export const COMPUTER_USE_HELPER_NAME = "Codex Computer Use";
export const COMPUTER_USE_HELPER_BUNDLE_ID = "com.openai.sky.CUAService";
export const COMPUTER_USE_HELPER_RELATIVE_PATH = join("computer-use", "Codex Computer Use.app");

export interface ComputerUseMacHelper {
  path: string;
  name: string;
}

interface ComputerUseMacSetupOptions {
  platform?: NodeJS.Platform;
  codexHome?: string;
  readTextFile?: (path: string) => Promise<string>;
  statPath?: typeof stat;
  getIconDataUrl?: (path: string) => Promise<string | null>;
}

export class ComputerUseMacSetupService {
  readonly #platform: NodeJS.Platform;
  readonly #codexHome: string;
  readonly #readTextFile: (path: string) => Promise<string>;
  readonly #statPath: typeof stat;
  readonly #getIconDataUrl: (path: string) => Promise<string | null>;

  constructor(options: ComputerUseMacSetupOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#codexHome = options.codexHome ?? (process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"));
    this.#readTextFile = options.readTextFile ?? ((path) => readFile(path, "utf8"));
    this.#statPath = options.statPath ?? stat;
    this.#getIconDataUrl = options.getIconDataUrl ?? (async () => null);
  }

  async getState(): Promise<ComputerUseMacSetupState> {
    if (this.#platform !== "darwin") {
      return {
        status: "unsupported",
        helperName: COMPUTER_USE_HELPER_NAME,
        helperIconDataUrl: null,
        message: "Computer Use permission setup is available on macOS.",
      };
    }

    try {
      const helper = await this.requireHelper();
      return {
        status: "available",
        helperName: helper.name,
        helperIconDataUrl: await this.#getIconDataUrl(helper.path).catch(() => null),
        message: null,
      };
    } catch {
      return {
        status: "unavailable",
        helperName: COMPUTER_USE_HELPER_NAME,
        helperIconDataUrl: null,
        message: "Codex Computer Use is not installed. Install or enable the Computer Use plugin, then try again.",
      };
    }
  }

  async requireHelper(): Promise<ComputerUseMacHelper> {
    if (this.#platform !== "darwin") throw new Error("Computer Use permission setup requires macOS.");

    const helperPath = join(this.#codexHome, COMPUTER_USE_HELPER_RELATIVE_PATH);
    const helperInfo = await this.#statPath(helperPath);
    if (!helperInfo.isDirectory()) throw new Error("Computer Use helper is not an application bundle.");

    const plistPath = join(helperPath, "Contents", "Info.plist");
    const plist = await this.#readTextFile(plistPath);
    if (readPlistString(plist, "CFBundleIdentifier") !== COMPUTER_USE_HELPER_BUNDLE_ID) {
      throw new Error("Computer Use helper has an unexpected bundle identifier.");
    }

    const executable = readPlistString(plist, "CFBundleExecutable");
    if (!executable) throw new Error("Computer Use helper has no executable.");
    const executableInfo = await this.#statPath(join(helperPath, "Contents", "MacOS", executable));
    if (!executableInfo.isFile()) throw new Error("Computer Use helper executable is missing.");

    return {
      path: helperPath,
      name: readPlistString(plist, "CFBundleName") ?? COMPUTER_USE_HELPER_NAME,
    };
  }
}

function readPlistString(plist: string, key: string): string | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`<key>\\s*${escapedKey}\\s*</key>\\s*<string>\\s*([^<]+?)\\s*</string>`).exec(plist);
  return match?.[1]?.trim() ?? null;
}
