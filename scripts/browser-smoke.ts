import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsRoot = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(scriptsRoot);
const outputRoot = await mkdtemp(join(tmpdir(), "openbot-browser-build-"));
try {
  const outputPath = join(outputRoot, "browser-smoke.mjs");
  const buildCode = await run(process.execPath, [
    "build",
    join(scriptsRoot, "browser-smoke-electron.ts"),
    "--target=node",
    "--format=esm",
    "--external=electron",
    `--outfile=${outputPath}`,
  ]);
  if (buildCode !== 0) throw new Error("Unable to build browser smoke test.");

  const electron = join(projectRoot, "node_modules", ".bin", "electron");
  const exitCode = await run(electron, [outputPath, ...process.argv.slice(2)], true);
  if (exitCode !== 0) process.exitCode = exitCode;
} finally {
  await rm(outputRoot, { recursive: true, force: true });
}

function run(executable: string, arguments_: string[], filterExpectedElectronNoise = false): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      stdio: filterExpectedElectronNoise ? ["inherit", "inherit", "pipe"] : "inherit",
      env: process.env,
    });
    if (child.stderr) {
      let pending = "";
      let suppressTraceHint = false;
      const flushLine = (line: string): void => {
        const isExpectedAbort =
          /^\(node:\d+\) electron: Failed to load URL: http:\/\/127\.0\.0\.1:\d+\/abort with error: ERR_EMPTY_RESPONSE$/.test(
            line,
          );
        if (isExpectedAbort) {
          suppressTraceHint = true;
          return;
        }
        const isMacOsBackupServiceNoise =
          /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+ Electron Helper\[\d+:\d+\] XPC error for connection com\.apple\.backupd\.sandbox\.xpc: Connection invalid$/.test(
            line,
          );
        if (isMacOsBackupServiceNoise) return;
        if (suppressTraceHint && line.startsWith("(Use `Electron --trace-warnings")) {
          suppressTraceHint = false;
          return;
        }
        suppressTraceHint = false;
        process.stderr.write(`${line}\n`);
      };
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        pending += chunk;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) flushLine(line);
      });
      child.stderr.once("end", () => {
        if (pending.length > 0) flushLine(pending);
      });
    }
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}
