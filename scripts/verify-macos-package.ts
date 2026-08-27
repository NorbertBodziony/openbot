import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FuseV1Options, getCurrentFuseWire } from "@electron/fuses";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { verifyCodexRuntimeProcess } from "./verify-codex-runtime-process";

const FUSE_DISABLED = 48;
const FUSE_ENABLED = 49;

const appPath = resolve(process.argv[2] ?? "dist/mac-arm64/OpenBot.app");
const contentsPath = resolve(appPath, "Contents");
const executablePath = resolve(contentsPath, "MacOS/OpenBot");
const resourcesPath = resolve(contentsPath, "Resources");
const plistPath = resolve(contentsPath, "Info.plist");
const whisperExecutablePath = resolve(resourcesPath, "whisper/bin/whisper-cli");
const whisperModelPath = resolve(resourcesPath, "whisper/model/ggml-medium-q5_0.bin");
const remoteRuntimePath = resolve(resourcesPath, "remote-desktop-runtime/darwin/arm64");
const codexRuntimePath = resolve(resourcesPath, "codex/mac/arm64");
const codexExecutablePath = resolve(codexRuntimePath, "bin/codex");
const claudeRuntimePath = resolve(resourcesPath, "claude/mac/arm64");
const claudeExecutablePath = resolve(claudeRuntimePath, "bin/claude");
const grokRuntimePath = resolve(resourcesPath, "grok/mac/arm64");
const grokExecutablePath = resolve(grokRuntimePath, "bin/grok");

await Promise.all([
  access(executablePath),
  access(resolve(resourcesPath, "app.asar")),
  access(resolve(resourcesPath, "icon.icns")),
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
  access(resolve(remoteRuntimePath, "Sunshine.app/Contents/MacOS/Sunshine")),
  access(resolve(remoteRuntimePath, "web-server")),
  access(resolve(remoteRuntimePath, "streamer")),
  access(resolve(remoteRuntimePath, "static/stream.html")),
  access(resolve(remoteRuntimePath, "SHA256SUMS.txt")),
  access(resolve(resourcesPath, "cloudflared/mac/arm64/cloudflared")),
  access(resolve(resourcesPath, "cloudflared/mac/arm64/SHA256SUMS.txt")),
  access(resolve(resourcesPath, "cloudflared/mac/arm64/VERSION.txt")),
  access(resolve(resourcesPath, "cloudflared/licenses/cloudflared-Apache-2.0.txt")),
  access(resolve(resourcesPath, "cloudflared/source-manifest.json")),
  access(codexExecutablePath),
  access(resolve(codexRuntimePath, "bin/codex-code-mode-host")),
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

const plist = JSON.parse(run("plutil", ["-convert", "json", "-o", "-", plistPath]));
if (!isDynamicRecord(plist)) throw new Error("Info.plist is not a JSON object.");
expectEqual(plist.CFBundleDisplayName, "OpenBot", "display name");
expectEqual(plist.CFBundleExecutable, "OpenBot", "executable name");
expectEqual(plist.CFBundleIdentifier, "app.openbot.desktop", "bundle identifier");
expectEqual(plist.CFBundleIconFile, "icon.icns", "application icon");
expectEqual(plist.LSMinimumSystemVersion, "12.0", "minimum macOS version");
expectEqual(plist.ElectronTeamID, "ZTRDTUL87R", "Apple Team ID");
if (!Array.isArray(plist.NSUserActivityTypes) || !plist.NSUserActivityTypes.includes("NSUserActivityTypeBrowsingWeb")) {
  throw new Error("The Universal Links activity type is missing.");
}
if (!plist.ElectronAsarIntegrity) throw new Error("ASAR integrity metadata is missing.");
expectEqual(
  plist.NSMicrophoneUsageDescription,
  "OpenBot uses the microphone to transcribe voice prompts locally on this Mac.",
  "microphone usage description",
);

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
if (!isDynamicRecord(packageJson)) throw new Error("package.json is not a JSON object.");
expectEqual(plist.CFBundleShortVersionString, packageJson.version, "application version");

const architecture = run("file", [executablePath]);
if (!architecture.includes("arm64")) throw new Error(`Expected an ARM64 executable: ${architecture}`);
const whisperArchitecture = run("file", [whisperExecutablePath]);
if (!whisperArchitecture.includes("arm64")) {
  throw new Error(`Expected an ARM64 Whisper executable: ${whisperArchitecture}`);
}
const codexArchitecture = run("file", [codexExecutablePath]);
if (!codexArchitecture.includes("arm64")) throw new Error(`Expected an ARM64 Codex executable: ${codexArchitecture}`);
const claudeArchitecture = run("file", [claudeExecutablePath]);
if (!claudeArchitecture.includes("arm64")) {
  throw new Error(`Expected an ARM64 Claude executable: ${claudeArchitecture}`);
}
const grokArchitecture = run("file", [grokExecutablePath]);
if (!grokArchitecture.includes("arm64")) {
  throw new Error(`Expected an ARM64 Grok executable: ${grokArchitecture}`);
}
if (existsSync(whisperModelPath)) throw new Error("The on-demand Whisper model must not be in the application.");

for (const name of ["Sunshine.app", "web-server", "streamer"]) {
  run("codesign", ["--verify", "--strict", "--verbose=2", resolve(remoteRuntimePath, name)]);
}
for (const name of ["bin/codex", "bin/codex-code-mode-host", "codex-path/rg", "codex-resources/zsh/bin/zsh"]) {
  run("codesign", ["--verify", "--strict", "--verbose=2", resolve(codexRuntimePath, name)]);
}
await verifyCodexRuntimeProcess(codexExecutablePath, "0.149.1");
run("codesign", ["--verify", "--strict", "--verbose=2", claudeExecutablePath]);
if (!run(claudeExecutablePath, ["--version"]).startsWith("2.1.246")) {
  throw new Error("The bundled Claude runtime returned an unexpected version.");
}
run("codesign", ["--verify", "--strict", "--verbose=2", grokExecutablePath]);
if (!run(grokExecutablePath, ["--version"]).includes("1.0.5")) {
  throw new Error("The bundled Grok runtime returned an unexpected version.");
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
  `OpenBot ${String(packageJson.version)} · ARM64 · icon · GPL remote runtime · bundled cloudflared · ASAR integrity · hardened fuses · launch`,
);

function expectEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`Unexpected ${label}: ${String(actual)} (expected ${String(expected)})`);
  }
}

function run(command: string, args: string[], includeStderr = false): string {
  if (includeStderr) {
    const result = spawnSync(command, args, { encoding: "utf8", stdio: "pipe" });
    if (result.status !== 0) {
      throw new Error(`${command} failed: ${result.stderr.trim()}`);
    }
    return `${result.stdout}${result.stderr}`.trim();
  }
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

async function verifyLaunch(executable: string): Promise<void> {
  const userDataPath = await mkdtemp(join(tmpdir(), "openbot-package-smoke-"));
  const child = spawn(executable, [`--user-data-dir=${userDataPath}`, "--use-mock-keychain"], {
    env: {
      ...process.env,
      CODEX_HOME: join(userDataPath, "codex-home"),
      CLAUDE_CONFIG_DIR: join(userDataPath, "claude-home"),
      OPENBOT_CODEX_PATH: join(userDataPath, "missing-codex"),
      OPENBOT_CLAUDE_PATH: join(userDataPath, "missing-claude"),
      OPENBOT_GROK_PATH: join(userDataPath, "missing-grok"),
    },
    stdio: ["ignore", "ignore", "pipe"],
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
      new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 15_000)),
    ]);
    await verifySecondInstanceExits(executable, userDataPath);
  } finally {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
      new Promise<void>((resolveDelay) =>
        setTimeout(() => {
          child.kill("SIGKILL");
          resolveDelay();
        }, 2_000),
      ),
    ]);
    await rm(userDataPath, { recursive: true, force: true });
  }
}

async function verifySecondInstanceExits(executable: string, userDataPath: string): Promise<void> {
  const second = spawn(executable, [`--user-data-dir=${userDataPath}`, "--use-mock-keychain"], {
    env: {
      ...process.env,
      CODEX_HOME: join(userDataPath, "codex-home"),
      CLAUDE_CONFIG_DIR: join(userDataPath, "claude-home"),
      OPENBOT_CODEX_PATH: join(userDataPath, "missing-codex"),
      OPENBOT_CLAUDE_PATH: join(userDataPath, "missing-claude"),
      OPENBOT_GROK_PATH: join(userDataPath, "missing-grok"),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  second.stderr.setEncoding("utf8");
  second.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-4_000);
  });
  const result = await Promise.race([
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
      second.once("exit", (code, signal) => resolveExit({ code, signal }));
    }),
    new Promise<null>((resolveDelay) => setTimeout(() => resolveDelay(null), 10_000)),
  ]);
  if (!result) {
    second.kill("SIGKILL");
    throw new Error(`A second OpenBot instance did not exit: ${stderr.trim()}`);
  }
  if (result.code !== 0 || result.signal) {
    throw new Error(
      `A second OpenBot instance exited unexpectedly (${result.signal ?? `code ${String(result.code)}`}).`,
    );
  }
}
