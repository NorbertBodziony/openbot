import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FuseV1Options, getCurrentFuseWire } from "@electron/fuses";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { verifyCodexRuntimeProcess } from "./verify-codex-runtime-process";

const FUSE_DISABLED = 48;
const FUSE_ENABLED = 49;

if (process.platform !== "win32") {
  throw new Error("The Windows package verifier must run on Windows.");
}

const requireUpdateMetadata = process.argv.includes("--require-update-metadata");
const appPathArgument = process.argv.slice(2).find((argument) => !argument.startsWith("--"));
const appPath = resolve(appPathArgument ?? "dist/win-unpacked");
const executablePath = resolve(appPath, "OpenBot.exe");
const resourcesPath = resolve(appPath, "resources");
const whisperExecutablePath = resolve(resourcesPath, "whisper/bin/whisper-cli.exe");
const whisperModelPath = resolve(resourcesPath, "whisper/model/ggml-medium-q5_0.bin");
const codexRuntimePath = resolve(resourcesPath, "codex/win/x64");
const codexExecutablePath = resolve(codexRuntimePath, "bin/codex.exe");
const claudeRuntimePath = resolve(resourcesPath, "claude/win/x64");
const claudeExecutablePath = resolve(claudeRuntimePath, "bin/claude.exe");
const grokRuntimePath = resolve(resourcesPath, "grok/win/x64");
const grokExecutablePath = resolve(grokRuntimePath, "bin/grok.exe");

await Promise.all([
  access(executablePath),
  access(resolve(resourcesPath, "app.asar")),
  access(resolve(resourcesPath, "licenses/Electron-LICENSE")),
  access(resolve(resourcesPath, "licenses/LICENSES.chromium.html")),
  access(resolve(resourcesPath, "licenses/OpenAI-Whisper-LICENSE")),
  access(resolve(resourcesPath, "licenses/whisper.cpp-LICENSE")),
  access(whisperExecutablePath),
  access(resolve(resourcesPath, "remote-desktop-runtime/licenses/Sunshine-GPL-3.0.txt")),
  access(resolve(resourcesPath, "remote-desktop-runtime/licenses/moonlight-web-stream-GPL-3.0.txt")),
  access(resolve(resourcesPath, "remote-desktop-runtime/source-manifest.json")),
  access(resolve(resourcesPath, "remote-desktop-runtime/DISTRIBUTION-SHA256SUMS.txt")),
  access(resolve(resourcesPath, "remote-desktop-runtime/sources/Sunshine-v2026.516.143833-source.tar.gz")),
  access(resolve(resourcesPath, "remote-desktop-runtime/sources/sunshine-v2026.516.143833-openbot.patch")),
  access(resolve(resourcesPath, "remote-desktop-runtime/sources/moonlight-web-stream-v2.10.0-openbot-source.tar.gz")),
  access(resolve(resourcesPath, "remote-desktop-runtime/sources/moonlight-web-stream-v2.10.0-openbot.patch")),
  access(resolve(resourcesPath, "remote-desktop-runtime/win32/x64/sunshine.exe")),
  access(resolve(resourcesPath, "remote-desktop-runtime/win32/x64/web-server.exe")),
  access(resolve(resourcesPath, "remote-desktop-runtime/win32/x64/streamer.exe")),
  access(resolve(resourcesPath, "remote-desktop-runtime/win32/x64/static/stream.html")),
  access(resolve(resourcesPath, "remote-desktop-runtime/win32/x64/SHA256SUMS.txt")),
  access(resolve(resourcesPath, "cloudflared/win/x64/cloudflared.exe")),
  access(resolve(resourcesPath, "cloudflared/win/x64/SHA256SUMS.txt")),
  access(resolve(resourcesPath, "cloudflared/win/x64/VERSION.txt")),
  access(resolve(resourcesPath, "cloudflared/licenses/cloudflared-Apache-2.0.txt")),
  access(resolve(resourcesPath, "cloudflared/source-manifest.json")),
  access(codexExecutablePath),
  access(resolve(codexRuntimePath, "bin/codex-code-mode-host.exe")),
  access(resolve(codexRuntimePath, "codex-package.json")),
  access(resolve(resourcesPath, "codex/licenses/Codex-Apache-2.0.txt")),
  access(resolve(resourcesPath, "codex/source-manifest.json")),
  access(claudeExecutablePath),
  access(resolve(claudeRuntimePath, "claude-package.json")),
  access(resolve(resourcesPath, "claude/licenses/Claude-Code-LICENSE.md")),
  access(resolve(resourcesPath, "claude/source-manifest.json")),
  access(grokExecutablePath),
  access(resolve(grokRuntimePath, "grok-package.json")),
  access(resolve(resourcesPath, "grok/licenses/Grok-CLI-LICENSE")),
  access(resolve(resourcesPath, "grok/licenses/Grok-CLI-THIRD-PARTY-NOTICES")),
  access(resolve(resourcesPath, "grok/source-manifest.json")),
]);

if (existsSync(whisperModelPath)) throw new Error("The on-demand Whisper model must not be in the application.");

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
if (!isDynamicRecord(packageJson)) throw new Error("package.json is not a JSON object.");
if (!isString(packageJson.version)) throw new Error("package.json version is missing.");

const executable = await readFile(executablePath);
if (executable.toString("ascii", 0, 2) !== "MZ") throw new Error("The executable has no MZ header.");
const peOffset = executable.readUInt32LE(0x3c);
if (executable.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0") {
  throw new Error("The executable has no PE header.");
}
const machine = executable.readUInt16LE(peOffset + 4);
if (machine !== 0x8664) {
  throw new Error(`Expected a Windows x64 executable, but its machine type is 0x${machine.toString(16)}.`);
}

for (const name of ["sunshine.exe", "web-server.exe", "streamer.exe"]) {
  verifyAuthenticode(resolve(resourcesPath, "remote-desktop-runtime/win32/x64", name), "NotSigned");
}
verifyAuthenticode(resolve(resourcesPath, "cloudflared/win/x64/cloudflared.exe"), "Valid");
verifyAuthenticode(codexExecutablePath, "Valid");
verifyAuthenticode(resolve(codexRuntimePath, "bin/codex-code-mode-host.exe"), "Valid");
await verifyCodexRuntimeProcess(codexExecutablePath, "0.149.1");
verifyAuthenticode(claudeExecutablePath, "Valid");
if (!run(claudeExecutablePath, ["--version"]).startsWith("2.1.246")) {
  throw new Error("The bundled Claude runtime returned an unexpected version.");
}
verifyAuthenticode(grokExecutablePath, "Valid");
if (!run(grokExecutablePath, ["--version"]).includes("1.0.5")) {
  throw new Error("The bundled Grok runtime returned an unexpected version.");
}

const versionInfo = JSON.parse(
  runWindowsPowerShell(
    `$value = (Get-Item -LiteralPath '${powerShellLiteral(executablePath)}').VersionInfo; ` +
      "[pscustomobject]@{ ProductName = $value.ProductName; FileDescription = $value.FileDescription; ProductVersion = $value.ProductVersion } | ConvertTo-Json -Compress",
  ),
);
if (!isDynamicRecord(versionInfo)) throw new Error("Windows version metadata is invalid.");
expectEqual(versionInfo.ProductName, "OpenBot", "product name");
expectEqual(versionInfo.FileDescription, "OpenBot", "file description");
if (!String(versionInfo.ProductVersion).startsWith(packageJson.version)) {
  throw new Error(
    `Unexpected product version: ${String(versionInfo.ProductVersion)} (expected ${packageJson.version})`,
  );
}

const updateMetadataPath = resolve(resourcesPath, "app-update.yml");
let updateMetadata: string | null = null;
try {
  updateMetadata = await readFile(updateMetadataPath, "utf8");
} catch (error) {
  if (requireUpdateMetadata) throw error;
}
if (updateMetadata !== null && !updateMetadata.includes("provider: github")) {
  throw new Error("The packaged update provider is not GitHub.");
}

const fuses = await getCurrentFuseWire(executablePath);
const expectedFuses: Array<[FuseV1Options, number]> = [
  [FuseV1Options.RunAsNode, FUSE_DISABLED],
  [FuseV1Options.EnableCookieEncryption, FUSE_ENABLED],
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable, FUSE_DISABLED],
  [FuseV1Options.EnableNodeCliInspectArguments, FUSE_DISABLED],
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, FUSE_ENABLED],
  [FuseV1Options.OnlyLoadAppFromAsar, FUSE_ENABLED],
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot, FUSE_DISABLED],
  [FuseV1Options.GrantFileProtocolExtraPrivileges, FUSE_DISABLED],
];
for (const [fuse, expected] of expectedFuses) {
  if (fuses[fuse] !== expected) {
    throw new Error(`Unexpected Electron fuse ${FuseV1Options[fuse]}: ${String(fuses[fuse])}`);
  }
}

await verifyLaunch(executablePath);

console.log(`Verified ${appPath}`);
console.log(
  `OpenBot ${packageJson.version} · Windows x64 · metadata · GPL remote runtime · ASAR integrity · hardened fuses · launch`,
);

function expectEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`Unexpected ${label}: ${String(actual)} (expected ${String(expected)})`);
  }
}

function run(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: "utf8" }).trim();
}

function powerShellLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

function runWindowsPowerShell(command: string): string {
  const environment = { ...process.env };
  // GitHub's pwsh runner exports its PowerShell 7 module path. Windows PowerShell
  // must rebuild its own path so built-in modules such as Security can load.
  delete environment.PSModulePath;
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    env: environment,
  }).trim();
}

function verifyAuthenticode(path: string, expectedStatus: "NotSigned" | "Valid"): void {
  const status = runWindowsPowerShell(
    `(Get-AuthenticodeSignature -LiteralPath '${powerShellLiteral(path)}').Status.ToString()`,
  );
  if (status !== expectedStatus) {
    throw new Error(`Unexpected runtime signature status for ${path}: ${status} (expected ${expectedStatus})`);
  }
}

async function verifyLaunch(executable: string): Promise<void> {
  const userDataPath = await mkdtemp(join(tmpdir(), "openbot-package-smoke-"));
  const child = spawn(executable, [`--user-data-dir=${userDataPath}`], {
    env: {
      ...process.env,
      CODEX_HOME: join(userDataPath, "codex-home"),
      CLAUDE_CONFIG_DIR: join(userDataPath, "claude-home"),
      OPENBOT_CODEX_PATH: join(userDataPath, "missing-codex.exe"),
      OPENBOT_CLAUDE_PATH: join(userDataPath, "missing-claude.exe"),
      OPENBOT_GROK_PATH: join(userDataPath, "missing-grok.exe"),
    },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-4_000);
  });

  try {
    await Promise.race([
      new Promise<never>((_, reject) => {
        child.once("exit", (code, signal) => {
          reject(
            new Error(`Packaged OpenBot exited during launch (${signal ?? `code ${String(code)}`}): ${stderr.trim()}`),
          );
        });
      }),
      new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 3_000)),
    ]);
    await verifySecondInstanceExits(executable, userDataPath);
  } finally {
    terminateProcessTree(child.pid);
    await Promise.race([
      new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
      new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 5_000)),
    ]);
    try {
      await rm(userDataPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch (error) {
      console.warn(`Could not remove the temporary Windows profile: ${String(error)}`);
    }
  }
}

function terminateProcessTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    execFileSync("taskkill.exe", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" });
  } catch {
    // The application can finish before taskkill reads the process tree.
  }
}

async function verifySecondInstanceExits(executable: string, userDataPath: string): Promise<void> {
  const second = spawn(executable, [`--user-data-dir=${userDataPath}`], {
    env: {
      ...process.env,
      CODEX_HOME: join(userDataPath, "codex-home"),
      CLAUDE_CONFIG_DIR: join(userDataPath, "claude-home"),
      OPENBOT_CODEX_PATH: join(userDataPath, "missing-codex.exe"),
      OPENBOT_CLAUDE_PATH: join(userDataPath, "missing-claude.exe"),
      OPENBOT_GROK_PATH: join(userDataPath, "missing-grok.exe"),
    },
    stdio: "ignore",
    windowsHide: true,
  });
  const result = await Promise.race([
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
      second.once("exit", (code, signal) => resolveExit({ code, signal }));
    }),
    new Promise<null>((resolveDelay) => setTimeout(() => resolveDelay(null), 3_000)),
  ]);
  if (!result) {
    second.kill();
    throw new Error("A second OpenBot instance did not exit.");
  }
  if (result.code !== 0 || result.signal) {
    throw new Error(
      `A second OpenBot instance exited unexpectedly (${result.signal ?? `code ${String(result.code)}`}).`,
    );
  }
}
