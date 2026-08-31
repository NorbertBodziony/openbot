import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";

export async function appendRemoteDiagnosticLog(
  directory: string,
  name: string,
  message: string | Uint8Array,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  const safeName = name.replace(/[^a-zA-Z0-9_-]/gu, "-").slice(0, 80);
  const path = join(directory, `${safeName}.log`);
  try {
    if ((await stat(path)).size >= 1024 * 1024) await rename(path, `${path}.1`);
  } catch {
    // A missing diagnostic file does not need rotation.
  }
  const clean = Buffer.from(message)
    .toString("utf8")
    .replace(/(?:Bearer\s+|token[=: ]+)[A-Za-z0-9._-]{8,}/giu, "[redacted]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[redacted-email]")
    .slice(0, 8_000);
  if (clean) await appendFile(path, clean, { encoding: "utf8", mode: 0o600 });
}

interface ManagedChildProcess {
  exitCode: number | null;
  killed: boolean;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: string, listener: (...args: unknown[]) => unknown): unknown;
}

export async function stopRemoteProcess(child: ManagedChildProcess, graceMs = 2_000): Promise<void> {
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
