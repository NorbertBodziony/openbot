import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FuseV1Options, getCurrentFuseWire } from "@electron/fuses";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { createOpenBotLogger } from "@openbot/logging";

const logger = createOpenBotLogger("verify-macos-package");

const FUSE_DISABLED = 48;
const FUSE_ENABLED = 49;
const EXPECTED_MACOS_ICON_FILES = [
  "icon_16x16.png",
  "icon_16x16@2x.png",
  "icon_32x32.png",
  "icon_32x32@2x.png",
  "icon_128x128.png",
  "icon_128x128@2x.png",
  "icon_256x256.png",
  "icon_256x256@2x.png",
  "icon_512x512.png",
  "icon_512x512@2x.png",
] as const;

const appPath = resolve(process.argv[2] ?? "dist/mac-arm64/OpenBot.app");
const contentsPath = resolve(appPath, "Contents");
const executablePath = resolve(contentsPath, "MacOS/OpenBot");
const resourcesPath = resolve(contentsPath, "Resources");
const packagedIconPath = resolve(resourcesPath, "icon.icns");
const sourceIconPath = resolve("build/icon-production.icns");
const plistPath = resolve(contentsPath, "Info.plist");
const whisperExecutablePath = resolve(resourcesPath, "whisper/bin/whisper-cli");
const whisperModelPath = resolve(resourcesPath, "whisper/model/ggml-medium-q5_0.bin");
const remoteRuntimePath = resolve(resourcesPath, "remote-desktop-runtime/darwin/arm64");

await Promise.all([
  access(executablePath),
  access(resolve(resourcesPath, "app.asar")),
  access(packagedIconPath),
  access(sourceIconPath),
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
]);
await verifyPackagedIcon(packagedIconPath, sourceIconPath);
await Promise.all(["codex", "claude", "grok"].map((name) => assertAbsent(resolve(resourcesPath, name))));
await assertAbsent(resolve(resourcesPath, "cloudflared"));
await assertAbsent(
  resolve(resourcesPath, "app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64"),
);

const plist = JSON.parse(run("plutil", ["-convert", "json", "-o", "-", plistPath]));
if (!isDynamicRecord(plist)) throw new Error("Info.plist is not a JSON object.");
expectEqual(plist.CFBundleDisplayName, "OpenBot", "display name");
expectEqual(plist.CFBundleExecutable, "OpenBot", "executable name");
expectEqual(plist.CFBundleIdentifier, "app.openbot.desktop", "bundle identifier");
expectEqual(plist.CFBundleIconFile, "icon.icns", "application icon");
expectEqual(plist.LSMinimumSystemVersion, "13.0", "minimum macOS version");
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
if (existsSync(whisperModelPath)) throw new Error("The on-demand Whisper model must not be in the application.");

for (const name of ["Sunshine.app", "web-server", "streamer"]) {
  run("codesign", ["--verify", "--strict", "--verbose=2", resolve(remoteRuntimePath, name)]);
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

logger.info(`Verified ${appPath}`);
logger.info(
  `OpenBot ${String(packageJson.version)} · ARM64 · icon · GPL remote runtime · WebRTC remote stack · ASAR integrity · hardened fuses · launch`,
);

function expectEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`Unexpected ${label}: ${String(actual)} (expected ${String(expected)})`);
  }
}

async function assertAbsent(path: string): Promise<void> {
  try {
    await access(path);
  } catch {
    return;
  }
  throw new Error(`Provider runtime must not be packaged: ${path}`);
}

async function verifyPackagedIcon(packagedPath: string, sourcePath: string): Promise<void> {
  const [packagedIcon, sourceIcon] = await Promise.all([readFile(packagedPath), readFile(sourcePath)]);
  if (!packagedIcon.equals(sourceIcon)) {
    throw new Error("The packaged macOS icon does not match build/icon-production.icns.");
  }

  const iconRoot = await mkdtemp(join(tmpdir(), "openbot-icon-"));
  const iconSetPath = join(iconRoot, "OpenBot.iconset");
  try {
    run("iconutil", ["--convert", "iconset", packagedPath, "--output", iconSetPath]);
    await Promise.all(EXPECTED_MACOS_ICON_FILES.map((name) => access(join(iconSetPath, name))));
  } finally {
    await rm(iconRoot, { recursive: true, force: true });
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
