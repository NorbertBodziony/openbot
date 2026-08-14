import { execFileSync, spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FuseV1Options, getCurrentFuseWire } from "@electron/fuses";

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

await Promise.all([
  access(executablePath),
  access(resolve(resourcesPath, "app.asar")),
  access(resolve(resourcesPath, "licenses/Electron-LICENSE")),
  access(resolve(resourcesPath, "licenses/LICENSES.chromium.html")),
]);

const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { version?: unknown };
if (typeof packageJson.version !== "string") throw new Error("package.json version is missing.");

const executable = await readFile(executablePath);
if (executable.toString("ascii", 0, 2) !== "MZ")
  throw new Error("The executable has no MZ header.");
const peOffset = executable.readUInt32LE(0x3c);
if (executable.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0") {
  throw new Error("The executable has no PE header.");
}
const machine = executable.readUInt16LE(peOffset + 4);
if (machine !== 0x8664) {
  throw new Error(
    `Expected a Windows x64 executable, but its machine type is 0x${machine.toString(16)}.`,
  );
}

const versionInfo = JSON.parse(
  run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `$value = (Get-Item -LiteralPath '${powerShellLiteral(executablePath)}').VersionInfo; ` +
      "[pscustomobject]@{ ProductName = $value.ProductName; FileDescription = $value.FileDescription; ProductVersion = $value.ProductVersion } | ConvertTo-Json -Compress",
  ]),
) as Record<string, unknown>;
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
  `OpenBot ${packageJson.version} · Windows x64 · metadata · licenses · ASAR integrity · hardened fuses · launch`,
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

async function verifyLaunch(executable: string): Promise<void> {
  const userDataPath = await mkdtemp(join(tmpdir(), "openbot-package-smoke-"));
  const child = spawn(executable, [`--user-data-dir=${userDataPath}`], {
    env: {
      ...process.env,
      OPENBOT_CODEX_PATH: join(userDataPath, "missing-codex.exe"),
      OPENBOT_CLAUDE_PATH: join(userDataPath, "missing-claude.exe"),
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
            new Error(
              `Packaged OpenBot exited during launch (${signal ?? `code ${String(code)}`}): ${stderr.trim()}`,
            ),
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
      OPENBOT_CODEX_PATH: join(userDataPath, "missing-codex.exe"),
      OPENBOT_CLAUDE_PATH: join(userDataPath, "missing-claude.exe"),
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
