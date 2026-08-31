import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const scriptsRoot = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(scriptsRoot);
const outputRoot = await mkdtemp(join(tmpdir(), "openbot-browser-build-"));
try {
  const outputPath = join(outputRoot, "browser-smoke.mjs");
  const smokeRoot = join(outputRoot, "single-process");
  const persistenceRoot = join(outputRoot, "cross-process");
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
  const exitCode = await run(electron, [outputPath, `--smoke-root=${smokeRoot}`, ...process.argv.slice(2)], true);
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  } else {
    const persistenceServer = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/persistence") {
        response.writeHead(404).end();
        return;
      }
      const phase = url.searchParams.get("phase");
      if (phase === "write") {
        response.setHeader(
          "set-cookie",
          "openbot_persistence=kept; Max-Age=31536000; Expires=Tue, 19 Jan 2038 03:14:07 GMT; Path=/; SameSite=Lax",
        );
      } else if (phase === "clear") {
        response.setHeader("set-cookie", "openbot_persistence=; Max-Age=0; Path=/; SameSite=Lax");
      }
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(persistencePage());
    });
    try {
      const persistenceOrigin = await listen(persistenceServer);
      for (const phase of ["write", "read", "clear", "verify-cleared"]) {
        const phaseExitCode = await run(
          electron,
          [
            outputPath,
            `--smoke-root=${persistenceRoot}`,
            `--persistence-origin=${persistenceOrigin}`,
            `--persistence-phase=${phase}`,
          ],
          true,
        );
        if (phaseExitCode !== 0) {
          process.exitCode = phaseExitCode;
          break;
        }
      }
    } finally {
      await close(persistenceServer);
    }
  }
} finally {
  await rm(outputRoot, { recursive: true, force: true });
}

function persistencePage(): string {
  return `<!doctype html><body>loading<script>
  const phase = new URL(location.href).searchParams.get("phase");
  const databaseName = "openbot-persistence-smoke";
  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("state");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async function writeDatabase() {
    const database = await openDatabase();
    const transaction = database.transaction("state", "readwrite");
    transaction.objectStore("state").put("kept", "session");
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
  }
  async function readDatabase() {
    const database = await openDatabase();
    const transaction = database.transaction("state", "readonly");
    const request = transaction.objectStore("state").get("session");
    const value = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return value;
  }
  function deleteDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(databaseName);
      request.onsuccess = resolve;
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("IndexedDB deletion was blocked."));
    });
  }
  async function main() {
    if (phase === "write") {
      localStorage.setItem("openbot-persistence", "kept");
      await writeDatabase();
    } else if (phase === "clear") {
      localStorage.removeItem("openbot-persistence");
      await deleteDatabase();
    }
    const indexedDbValue = phase === "clear" ? null : await readDatabase();
    document.body.textContent = JSON.stringify({
      ready: true,
      cookie: document.cookie,
      localStorage: localStorage.getItem("openbot-persistence"),
      indexedDb: indexedDbValue,
    });
  }
  main().catch((error) => {
    document.body.textContent = JSON.stringify({ ready: false, error: String(error) });
  });
</script></body>`;
}

function listen(server: ReturnType<typeof createServer>): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = z.object({ port: z.number().int() }).parse(server.address());
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
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
