import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { type AgentRuntimeLock, loadAgentRuntimeLock } from "./agent-runtime-lock";
import { sha256 } from "./remote-desktop-runtime-release";

export type GrokRuntimeTarget = "darwin-arm64" | "win32-x64";

const installedManifestSchema = z.object({
  layoutVersion: z.literal(1),
  version: z.string(),
  target: z.enum(["darwin-arm64", "win32-x64"]),
  executable: z.string(),
});

export async function installGrokRuntime(
  input: {
    sourceRoot?: string;
    outputRoot?: string;
    target?: GrokRuntimeTarget;
    fetchImpl?: typeof fetch;
    lock?: AgentRuntimeLock;
  } = {},
): Promise<"installed" | "current"> {
  const sourceRoot = input.sourceRoot ?? process.cwd();
  const outputRoot = input.outputRoot ?? resolve(sourceRoot, "build/grok");
  const target = input.target ?? grokRuntimeTarget();
  const fetchImpl = input.fetchImpl ?? fetch;
  const lock = input.lock ?? (await loadAgentRuntimeLock(sourceRoot));
  const artifact = lock.grok.artifacts[target];
  const targetRoot = grokRuntimePath(outputRoot, target);

  if (await isCurrentInstallation(targetRoot, target, lock)) {
    await writeMetadata(outputRoot, targetRoot, lock);
    console.log(`Using verified bundled Grok CLI ${lock.grok.version} for ${target}.`);
    return "current";
  }

  const [binary, license, notices] = await Promise.all([
    download(fetchImpl, `${lock.grok.distribution}/${artifact.asset}`, "Grok runtime"),
    download(
      fetchImpl,
      `${lock.grok.repository.replace("github.com", "raw.githubusercontent.com")}/${lock.grok.sourceCommit}/LICENSE`,
      "Grok license",
    ),
    download(
      fetchImpl,
      `${lock.grok.repository.replace("github.com", "raw.githubusercontent.com")}/${lock.grok.sourceCommit}/THIRD-PARTY-NOTICES`,
      "Grok third-party notices",
    ),
  ]);
  verifyChecksum(binary, artifact.assetSha256, `${target} Grok runtime`);
  verifyChecksum(license, lock.grok.licenseSha256, "Grok license");
  verifyChecksum(notices, lock.grok.noticesSha256, "Grok third-party notices");

  const temporaryRoot = await mkdtemp(join(tmpdir(), "openbot-grok-install-"));
  try {
    const staged = join(temporaryRoot, "runtime");
    await mkdir(join(staged, "bin"), { recursive: true });
    await Promise.all([
      writeFile(join(staged, "bin", artifact.executable), binary, { mode: target === "darwin-arm64" ? 0o755 : 0o644 }),
      writeFile(join(staged, "LICENSE"), license),
      writeFile(join(staged, "THIRD-PARTY-NOTICES"), notices),
      writeFile(
        join(staged, "grok-package.json"),
        `${JSON.stringify(
          { layoutVersion: 1, version: lock.grok.version, target, executable: `bin/${artifact.executable}` },
          null,
          2,
        )}\n`,
      ),
    ]);
    await verifyGrokRuntime(staged, target, lock);
    await installValidatedTree(staged, targetRoot);
    await verifyGrokRuntime(targetRoot, target, lock);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }

  await writeMetadata(outputRoot, targetRoot, lock);
  console.log(`Installed bundled Grok CLI ${lock.grok.version} for ${target}.`);
  return "installed";
}

export function grokRuntimeTarget(
  platform: string = process.platform,
  architecture: string = process.arch,
): GrokRuntimeTarget {
  const target = `${platform}-${architecture}`;
  if (target === "darwin-arm64" || target === "win32-x64") return target;
  throw new Error(`Unsupported bundled Grok target: ${target}`);
}

export function grokRuntimePath(root: string, target: GrokRuntimeTarget): string {
  return target === "darwin-arm64" ? join(root, "mac", "arm64") : join(root, "win", "x64");
}

export async function verifyGrokRuntime(
  root: string,
  target: GrokRuntimeTarget,
  lock: AgentRuntimeLock,
): Promise<void> {
  const artifact = lock.grok.artifacts[target];
  const manifest = installedManifestSchema.parse(JSON.parse(await readFile(join(root, "grok-package.json"), "utf8")));
  if (
    manifest.version !== lock.grok.version ||
    manifest.target !== target ||
    manifest.executable !== `bin/${artifact.executable}`
  ) {
    throw new Error("The bundled Grok package manifest does not match the runtime lock.");
  }
  const executable = join(root, "bin", artifact.executable);
  if (sha256(await readFile(executable)) !== artifact.assetSha256) {
    throw new Error("The bundled Grok executable checksum is invalid.");
  }
  if (sha256(await readFile(join(root, "LICENSE"))) !== lock.grok.licenseSha256) {
    throw new Error("The bundled Grok license checksum is invalid.");
  }
  if (sha256(await readFile(join(root, "THIRD-PARTY-NOTICES"))) !== lock.grok.noticesSha256) {
    throw new Error("The bundled Grok third-party notices checksum is invalid.");
  }
  if (target === "darwin-arm64") await chmod(executable, 0o755);
  const output = execFileSync(executable, ["--version"], { encoding: "utf8", windowsHide: true }).trim();
  if (!new RegExp(`(?:^|\\s)${escapeRegExp(lock.grok.version)}(?:\\s|$)`, "u").test(output)) {
    throw new Error(`Unexpected bundled Grok version: ${output}`);
  }
}

async function download(fetchImpl: typeof fetch, url: string, label: string): Promise<Buffer> {
  const response = await fetchImpl(url, {
    headers: { "User-Agent": "OpenBot-runtime-installer" },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`${label} download failed with HTTP ${response.status}.`);
  return Buffer.from(await response.arrayBuffer());
}

function verifyChecksum(value: Buffer, expected: string, label: string): void {
  if (sha256(value) !== expected) throw new Error(`The ${label} checksum is invalid.`);
}

async function isCurrentInstallation(
  root: string,
  target: GrokRuntimeTarget,
  lock: AgentRuntimeLock,
): Promise<boolean> {
  try {
    await verifyGrokRuntime(root, target, lock);
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

async function writeMetadata(outputRoot: string, targetRoot: string, lock: AgentRuntimeLock): Promise<void> {
  const licenseRoot = join(outputRoot, "licenses");
  await mkdir(licenseRoot, { recursive: true });
  await Promise.all([
    copyFile(join(targetRoot, "LICENSE"), join(licenseRoot, "Grok-CLI-LICENSE")),
    copyFile(join(targetRoot, "THIRD-PARTY-NOTICES"), join(licenseRoot, "Grok-CLI-THIRD-PARTY-NOTICES")),
    writeFile(
      join(outputRoot, "source-manifest.json"),
      `${JSON.stringify({ name: "grok-cli", ...lock.grok }, null, 2)}\n`,
    ),
  ]);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

if (import.meta.main) {
  await installGrokRuntime({
    target: grokRuntimeTarget(process.argv[2] ?? process.platform, process.argv[3] ?? process.arch),
  });
}
