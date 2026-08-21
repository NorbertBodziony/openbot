import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FuseV1Options, getCurrentFuseWire } from "@electron/fuses";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";

const FUSE_DISABLED = 48;
const FUSE_ENABLED = 49;

const appPath = resolve(process.argv[2] ?? "dist/mac-arm64/OpenBot.app");
const contentsPath = resolve(appPath, "Contents");
const executablePath = resolve(contentsPath, "MacOS/OpenBot");
const resourcesPath = resolve(contentsPath, "Resources");
const plistPath = resolve(contentsPath, "Info.plist");
const whisperExecutablePath = resolve(resourcesPath, "whisper/bin/whisper-cli");
const whisperModelPath = resolve(resourcesPath, "whisper/model/ggml-small-q5_1.bin");

await Promise.all([
  access(executablePath),
  access(resolve(resourcesPath, "app.asar")),
  access(resolve(resourcesPath, "icon.icns")),
  access(resolve(resourcesPath, "licenses/Electron-LICENSE")),
  access(resolve(resourcesPath, "licenses/LICENSES.chromium.html")),
  access(resolve(resourcesPath, "licenses/OpenAI-Whisper-LICENSE")),
  access(resolve(resourcesPath, "licenses/whisper.cpp-LICENSE")),
  access(whisperExecutablePath),
  access(whisperModelPath),
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
expectEqual(
  createHash("sha256")
    .update(await readFile(whisperModelPath))
    .digest("hex"),
  "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
  "Whisper model digest",
);

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
  `OpenBot ${String(packageJson.version)} · ARM64 · icon · licenses · ASAR integrity · hardened fuses · launch`,
);

function expectEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`Unexpected ${label}: ${String(actual)} (expected ${String(expected)})`);
  }
}

function run(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: "utf8" }).trim();
}

async function verifyLaunch(executable: string): Promise<void> {
  const userDataPath = await mkdtemp(join(tmpdir(), "openbot-package-smoke-"));
  const child = spawn(executable, [`--user-data-dir=${userDataPath}`], {
    env: { ...process.env, OPENBOT_CODEX_PATH: join(userDataPath, "missing-codex") },
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
      new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 3_000)),
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
  const second = spawn(executable, [`--user-data-dir=${userDataPath}`], {
    env: { ...process.env, OPENBOT_CODEX_PATH: join(userDataPath, "missing-codex") },
    stdio: "ignore",
  });
  const result = await Promise.race([
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
      second.once("exit", (code, signal) => resolveExit({ code, signal }));
    }),
    new Promise<null>((resolveDelay) => setTimeout(() => resolveDelay(null), 3_000)),
  ]);
  if (!result) {
    second.kill("SIGKILL");
    throw new Error("A second OpenBot instance did not exit.");
  }
  if (result.code !== 0 || result.signal) {
    throw new Error(
      `A second OpenBot instance exited unexpectedly (${result.signal ?? `code ${String(result.code)}`}).`,
    );
  }
}
