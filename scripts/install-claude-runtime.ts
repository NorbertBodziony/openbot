import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { loadNativeRuntimeLock, type NativeRuntimeLock } from "./native-runtime-lock";
import { rejectNonRegularFiles, sha256 } from "./remote-desktop-runtime-release";

export type ClaudeRuntimeTarget = "darwin-arm64" | "win32-x64";

const packageManifestSchema = z.object({
  name: z.string(),
  version: z.string(),
});

const installedManifestSchema = z.object({
  layoutVersion: z.literal(1),
  version: z.string(),
  sdkVersion: z.string(),
  target: z.enum(["darwin-arm64", "win32-x64"]),
  executable: z.string(),
});

export async function installClaudeRuntime(
  input: {
    sourceRoot?: string;
    outputRoot?: string;
    target?: ClaudeRuntimeTarget;
    fetchImpl?: typeof fetch;
    lock?: NativeRuntimeLock;
  } = {},
): Promise<"installed" | "current"> {
  const sourceRoot = input.sourceRoot ?? process.cwd();
  const outputRoot = input.outputRoot ?? resolve(sourceRoot, "build/claude");
  const target = input.target ?? claudeRuntimeTarget();
  const fetchImpl = input.fetchImpl ?? fetch;
  const lock = input.lock ?? (await loadNativeRuntimeLock(sourceRoot));
  const artifact = lock.claude.artifacts[target];
  const targetRoot = claudeRuntimePath(outputRoot, target);

  if (await isCurrentInstallation(targetRoot, target, lock)) {
    await writeMetadata(outputRoot, targetRoot, lock);
    console.log(`Using verified bundled Claude Code ${lock.claude.version} for ${target}.`);
    return "current";
  }

  const url = `${lock.claude.registry}/${artifact.package}/-/${artifact.asset}`;
  const response = await fetchImpl(url, {
    headers: { "User-Agent": "OpenBot-runtime-installer" },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`Claude runtime download failed with HTTP ${response.status}.`);
  const archiveBytes = Buffer.from(await response.arrayBuffer());
  if (sha256(archiveBytes) !== artifact.assetSha256) {
    throw new Error(`The ${target} Claude runtime archive checksum is invalid.`);
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), "openbot-claude-install-"));
  try {
    const archive = join(temporaryRoot, artifact.asset);
    const extracted = join(temporaryRoot, "extracted");
    const staged = join(temporaryRoot, "runtime");
    await writeFile(archive, archiveBytes, { mode: 0o600 });
    validateClaudeArchive(archive, artifact.executable);
    await mkdir(extracted, { recursive: true });
    execFileSync("tar", ["-xzf", archive, "-C", extracted, "--no-same-owner"], { stdio: "inherit" });
    await rejectNonRegularFiles(extracted);
    await stageClaudeRuntime(join(extracted, "package"), staged, target, lock);
    await verifyClaudeRuntime(staged, target, lock);
    await installValidatedTree(staged, targetRoot);
    await verifyClaudeRuntime(targetRoot, target, lock);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }

  await writeMetadata(outputRoot, targetRoot, lock);
  console.log(`Installed bundled Claude Code ${lock.claude.version} for ${target}.`);
  return "installed";
}

export function claudeRuntimeTarget(
  platform: string = process.platform,
  architecture: string = process.arch,
): ClaudeRuntimeTarget {
  const target = `${platform}-${architecture}`;
  if (target === "darwin-arm64" || target === "win32-x64") return target;
  throw new Error(`Unsupported bundled Claude target: ${target}`);
}

export function claudeRuntimePath(root: string, target: ClaudeRuntimeTarget): string {
  return target === "darwin-arm64" ? join(root, "mac", "arm64") : join(root, "win", "x64");
}

export async function verifyClaudeRuntime(
  root: string,
  target: ClaudeRuntimeTarget,
  lock: NativeRuntimeLock,
): Promise<void> {
  const artifact = lock.claude.artifacts[target];
  const manifest = installedManifestSchema.parse(JSON.parse(await readFile(join(root, "claude-package.json"), "utf8")));
  if (
    manifest.version !== lock.claude.version ||
    manifest.sdkVersion !== lock.claude.sdkVersion ||
    manifest.target !== target ||
    manifest.executable !== `bin/${artifact.executable}`
  ) {
    throw new Error("The bundled Claude package manifest does not match the runtime lock.");
  }
  const executable = join(root, "bin", artifact.executable);
  if (sha256(await readFile(executable)) !== artifact.binarySha256) {
    throw new Error("The bundled Claude executable checksum is invalid.");
  }
  if (sha256(await readFile(join(root, "LICENSE.md"))) !== lock.claude.licenseSha256) {
    throw new Error("The bundled Claude license checksum is invalid.");
  }
  const output = execFileSync(executable, ["--version"], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  if (!new RegExp(`^${escapeRegExp(lock.claude.version)}(?:\\s|$)`, "u").test(output)) {
    throw new Error(`Unexpected bundled Claude version: ${output}`);
  }
}

export function validateClaudeArchive(archive: string, executable: string): string[] {
  const names = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).split(/\r?\n/u).filter(Boolean);
  const details = execFileSync("tar", ["-tvzf", archive], { encoding: "utf8" }).split(/\r?\n/u).filter(Boolean);
  if (details.some((line) => !["-", "d"].includes(line.trimStart().charAt(0)))) {
    throw new Error("The Claude runtime archive contains a link or a special file.");
  }
  for (const name of names) validateArchivePath(name);
  for (const required of [`package/${executable}`, "package/package.json", "package/LICENSE.md"]) {
    if (!names.includes(required)) throw new Error(`The Claude runtime archive is missing ${required}.`);
  }
  return names;
}

async function stageClaudeRuntime(
  packageRoot: string,
  destination: string,
  target: ClaudeRuntimeTarget,
  lock: NativeRuntimeLock,
): Promise<void> {
  const artifact = lock.claude.artifacts[target];
  const packageManifest = packageManifestSchema.parse(
    JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")),
  );
  if (packageManifest.name !== artifact.package || packageManifest.version !== lock.claude.sdkVersion) {
    throw new Error("The Claude runtime npm package does not match the runtime lock.");
  }
  await mkdir(join(destination, "bin"), { recursive: true });
  await Promise.all([
    copyFile(join(packageRoot, artifact.executable), join(destination, "bin", artifact.executable)),
    copyFile(join(packageRoot, "LICENSE.md"), join(destination, "LICENSE.md")),
    writeFile(
      join(destination, "claude-package.json"),
      `${JSON.stringify(
        {
          layoutVersion: 1,
          version: lock.claude.version,
          sdkVersion: lock.claude.sdkVersion,
          target,
          executable: `bin/${artifact.executable}`,
        },
        null,
        2,
      )}\n`,
    ),
  ]);
  if (target === "darwin-arm64") await chmod(join(destination, "bin", artifact.executable), 0o755);
}

function validateArchivePath(name: string): void {
  if (name.includes("\0") || name.includes("\\")) throw new Error(`Unsafe Claude archive path: ${name}`);
  const normalized = name.replace(/\/+$/u, "");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized)) {
    throw new Error(`Unsafe Claude archive path: ${name}`);
  }
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..") || parts[0] !== "package") {
    throw new Error(`Unsafe Claude archive path: ${name}`);
  }
}

async function isCurrentInstallation(
  root: string,
  target: ClaudeRuntimeTarget,
  lock: NativeRuntimeLock,
): Promise<boolean> {
  try {
    await verifyClaudeRuntime(root, target, lock);
    return true;
  } catch {
    return false;
  }
}

async function installValidatedTree(source: string, destination: string): Promise<void> {
  const temporaryTarget = join(dirname(destination), `.${destination.split(/[\\/]/u).at(-1)}.installing`);
  await mkdir(dirname(destination), { recursive: true });
  await rm(temporaryTarget, { recursive: true, force: true });
  await rename(source, temporaryTarget);
  await rm(destination, { recursive: true, force: true });
  await rename(temporaryTarget, destination);
}

async function writeMetadata(outputRoot: string, targetRoot: string, lock: NativeRuntimeLock): Promise<void> {
  const licenseRoot = join(outputRoot, "licenses");
  await mkdir(licenseRoot, { recursive: true });
  await Promise.all([
    copyFile(join(targetRoot, "LICENSE.md"), join(licenseRoot, "Claude-Code-LICENSE.md")),
    writeFile(
      join(outputRoot, "source-manifest.json"),
      `${JSON.stringify({ name: "claude-code", ...lock.claude }, null, 2)}\n`,
    ),
  ]);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

if (import.meta.main) {
  await installClaudeRuntime({
    target: claudeRuntimeTarget(process.argv[2] ?? process.platform, process.argv[3] ?? process.arch),
  });
}
