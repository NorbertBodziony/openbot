import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MINIMUM_CODEX_VERSION = [0, 144, 1] as const;

export interface CodexCliInfo {
  executable: string;
  version: string;
}

export class CodexCliError extends Error {
  constructor(
    message: string,
    readonly code: "missing" | "invalid" | "outdated",
  ) {
    super(message);
    this.name = "CodexCliError";
  }
}

export async function resolveCodexCli(): Promise<CodexCliInfo> {
  const candidates = await collectCandidates();

  for (const candidate of candidates) {
    if (!(await isExecutable(candidate))) continue;

    try {
      const { stdout } = await execFileAsync(candidate, ["--version"], {
        timeout: 5_000,
        maxBuffer: 64 * 1024,
      });
      const version = parseCodexVersion(stdout);
      if (!isMinimumVersion(version)) {
        throw new CodexCliError(
          `Codex CLI ${version} is too old. OpenBot requires 0.144.1 or newer.`,
          "outdated",
        );
      }

      return { executable: candidate, version };
    } catch (error) {
      if (error instanceof CodexCliError) throw error;
    }
  }

  throw new CodexCliError(
    "Codex CLI was not found. Install Codex, run `codex login`, then restart OpenBot.",
    "missing",
  );
}

export function parseCodexVersion(output: string): string {
  const match = output.match(/(?:codex-cli\s+)?(\d+)\.(\d+)\.(\d+)/i);
  if (!match) throw new CodexCliError("Unable to read the Codex CLI version.", "invalid");
  return `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`;
}

function isMinimumVersion(version: string): boolean {
  const parts = version.split(".").map(Number);
  for (let index = 0; index < MINIMUM_CODEX_VERSION.length; index += 1) {
    if (parts[index] > MINIMUM_CODEX_VERSION[index]) return true;
    if (parts[index] < MINIMUM_CODEX_VERSION[index]) return false;
  }
  return true;
}

async function collectCandidates(): Promise<string[]> {
  const candidates: string[] = [];
  const override = process.env.OPENBOT_CODEX_PATH?.trim();
  if (override) candidates.push(override);

  try {
    const { stdout } = await execFileAsync("/bin/zsh", ["-lic", "command -v codex"], {
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    if (stdout.trim()) candidates.push(stdout.trim());
  } catch {
    // Packaged macOS apps often have a restricted PATH; known locations are checked next.
  }

  candidates.push(
    join(homedir(), ".local", "bin", "codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  );

  return [...new Set(candidates)];
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
