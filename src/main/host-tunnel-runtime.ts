import { constants as fsConstants } from "node:fs";
import { access, appendFile, mkdir, rename, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";

interface ManagedChildProcess {
  exitCode: number | null;
  killed: boolean;
  kill: (signal?: NodeJS.Signals) => boolean;
  once(event: string, listener: (...args: unknown[]) => unknown): unknown;
}

export async function resolveCloudflaredExecutable(pathValue = process.env.PATH ?? ""): Promise<string | null> {
  const candidates = new Set([
    "/opt/homebrew/opt/cloudflared/bin/cloudflared",
    "/usr/local/opt/cloudflared/bin/cloudflared",
    ...pathValue
      .split(delimiter)
      .filter(Boolean)
      .map((folder) => join(folder, "cloudflared")),
    "/opt/homebrew/bin/cloudflared",
    "/usr/local/bin/cloudflared",
  ]);
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue to the next explicit candidate.
    }
  }
  return null;
}

export async function stopOwnedProcess(child: ManagedChildProcess, graceMs = 2_000): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  await new Promise<void>((resolve) => {
    let complete = false;
    const finish = () => {
      if (complete) return;
      complete = true;
      clearTimeout(forceTimer);
      resolve();
    };
    const forceTimer = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      finish();
    }, graceMs);
    child.once("exit", finish);
    child.kill("SIGTERM");
  });
}

export async function appendDiagnosticLog(directory: string, name: string, chunk: Uint8Array | string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80);
  const path = join(directory, `${safeName}.log`);
  try {
    if ((await stat(path)).size >= 1024 * 1024) await rename(path, `${path}.1`);
  } catch {
    // A missing log does not need rotation.
  }
  const clean = Buffer.from(chunk)
    .toString("utf8")
    .replace(/(?:Bearer\s+|token[=: ]+)[A-Za-z0-9._-]{8,}/giu, "[redacted]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[redacted-email]")
    .slice(0, 8_000);
  if (clean) await appendFile(path, clean, { encoding: "utf8", mode: 0o600 });
}
