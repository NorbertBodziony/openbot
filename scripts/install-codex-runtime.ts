import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { loadNativeRuntimeLock, type NativeRuntimeLock } from "./native-runtime-lock";
import { rejectNonRegularFiles, sha256 } from "./remote-desktop-runtime-release";

export type CodexRuntimeTarget = "darwin-arm64" | "win32-x64";

const packageManifestSchema = z.object({
  layoutVersion: z.literal(1),
  version: z.string(),
  target: z.enum(["aarch64-apple-darwin", "x86_64-pc-windows-msvc"]),
  variant: z.literal("codex"),
  entrypoint: z.string(),
  resourcesDir: z.literal("codex-resources"),
  pathDir: z.literal("codex-path"),
});

export async function installCodexRuntime(
  input: {
    sourceRoot?: string;
    outputRoot?: string;
    target?: CodexRuntimeTarget;
    fetchImpl?: typeof fetch;
    lock?: NativeRuntimeLock;
  } = {},
): Promise<"installed" | "current"> {
  const sourceRoot = input.sourceRoot ?? process.cwd();
  const outputRoot = input.outputRoot ?? resolve(sourceRoot, "build/codex");
  const target = input.target ?? codexRuntimeTarget();
  const fetchImpl = input.fetchImpl ?? fetch;
  const lock = input.lock ?? (await loadNativeRuntimeLock(sourceRoot));
  const artifact = lock.codex.artifacts[target];
  const targetRoot = codexRuntimePath(outputRoot, target);

  if (await isCurrentInstallation(targetRoot, target, lock)) {
    await writeMetadata(outputRoot, lock, fetchImpl);
    console.log(`Using verified bundled Codex ${lock.codex.version} for ${target}.`);
    return "current";
  }

  const response = await fetchImpl(
    `${lock.codex.repository}/releases/download/${encodeURIComponent(lock.codex.tag)}/${artifact.asset}`,
    { headers: { "User-Agent": "OpenBot-runtime-installer" }, redirect: "follow" },
  );
  if (!response.ok) throw new Error(`Codex runtime download failed with HTTP ${response.status}.`);
  const archiveBytes = Buffer.from(await response.arrayBuffer());
  if (sha256(archiveBytes) !== artifact.assetSha256) {
    throw new Error(`The ${target} Codex runtime archive checksum is invalid.`);
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), "openbot-codex-install-"));
  try {
    const archive = join(temporaryRoot, artifact.asset);
    const extracted = join(temporaryRoot, "extracted");
    await writeFile(archive, archiveBytes, { mode: 0o600 });
    validateCodexArchive(archive);
    await mkdir(extracted, { recursive: true });
    execFileSync("tar", ["-xzf", archive, "-C", extracted, "--no-same-owner"], { stdio: "inherit" });
    await rejectNonRegularFiles(extracted);
    await verifyCodexRuntime(extracted, target, lock);
    await installValidatedTree(extracted, targetRoot);
    await verifyCodexRuntime(targetRoot, target, lock);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }

  await writeMetadata(outputRoot, lock, fetchImpl);
  console.log(`Installed bundled Codex ${lock.codex.version} for ${target}.`);
  return "installed";
}

export function codexRuntimeTarget(
  platform: string = process.platform,
  architecture: string = process.arch,
): CodexRuntimeTarget {
  const target = `${platform}-${architecture}`;
  if (target === "darwin-arm64" || target === "win32-x64") return target;
  throw new Error(`Unsupported bundled Codex target: ${target}`);
}

export function codexRuntimePath(root: string, target: CodexRuntimeTarget): string {
  return target === "darwin-arm64" ? join(root, "mac", "arm64") : join(root, "win", "x64");
}

export async function verifyCodexRuntime(
  root: string,
  target: CodexRuntimeTarget,
  lock: NativeRuntimeLock,
): Promise<void> {
  const artifact = lock.codex.artifacts[target];
  const manifest = packageManifestSchema.parse(JSON.parse(await readFile(join(root, "codex-package.json"), "utf8")));
  const expectedTarget = target === "darwin-arm64" ? "aarch64-apple-darwin" : "x86_64-pc-windows-msvc";
  if (
    manifest.version !== lock.codex.version ||
    manifest.target !== expectedTarget ||
    manifest.entrypoint !== artifact.executable
  ) {
    throw new Error("The bundled Codex package manifest does not match the runtime lock.");
  }
  const executable = join(root, ...artifact.executable.split("/"));
  const output = execFileSync(executable, ["--version"], { encoding: "utf8", windowsHide: true }).trim();
  if (!new RegExp(`(?:codex-cli\\s+)?${escapeRegExp(lock.codex.version)}(?:\\s|$)`, "u").test(output)) {
    throw new Error(`Unexpected bundled Codex version: ${output}`);
  }
  await readFile(join(root, "bin", target === "win32-x64" ? "codex-code-mode-host.exe" : "codex-code-mode-host"));
  await readFile(join(root, "codex-path", target === "win32-x64" ? "rg.exe" : "rg"));
}

export function validateCodexArchive(archive: string): string[] {
  const names = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).split(/\r?\n/u).filter(Boolean);
  const details = execFileSync("tar", ["-tvzf", archive], { encoding: "utf8" }).split(/\r?\n/u).filter(Boolean);
  if (details.some((line) => !["-", "d"].includes(line.trimStart().charAt(0)))) {
    throw new Error("The Codex runtime archive contains a link or a special file.");
  }
  for (const name of names) validateArchivePath(name);
  if (!names.includes("codex-package.json") || !names.some((name) => /^bin\/codex(?:\.exe)?$/u.test(name))) {
    throw new Error("The Codex runtime archive is incomplete.");
  }
  return names;
}

function validateArchivePath(name: string): void {
  if (name.includes("\0") || name.includes("\\")) throw new Error(`Unsafe Codex archive path: ${name}`);
  const normalized = name.replace(/\/+$/u, "");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized)) {
    throw new Error(`Unsafe Codex archive path: ${name}`);
  }
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Unsafe Codex archive path: ${name}`);
  }
  if (!["bin", "codex-package.json", "codex-path", "codex-resources"].includes(parts[0] ?? "")) {
    throw new Error(`Unexpected Codex archive path: ${name}`);
  }
}

async function isCurrentInstallation(
  root: string,
  target: CodexRuntimeTarget,
  lock: NativeRuntimeLock,
): Promise<boolean> {
  try {
    await verifyCodexRuntime(root, target, lock);
    return true;
  } catch {
    return false;
  }
}

async function installValidatedTree(source: string, destination: string): Promise<void> {
  const temporaryTarget = join(dirname(destination), `.${destination.split(/[\\/]/u).at(-1)}.installing`);
  await mkdir(dirname(destination), { recursive: true });
  await rm(temporaryTarget, { recursive: true, force: true });
  await cp(source, temporaryTarget, { recursive: true });
  await rm(destination, { recursive: true, force: true });
  await rename(temporaryTarget, destination);
}

async function writeMetadata(root: string, lock: NativeRuntimeLock, fetchImpl: typeof fetch): Promise<void> {
  const licenseRoot = join(root, "licenses");
  const licensePath = join(licenseRoot, "Codex-Apache-2.0.txt");
  await mkdir(licenseRoot, { recursive: true });
  let currentLicense: string | null = null;
  try {
    currentLicense = sha256(await readFile(licensePath));
  } catch {
    // Download the pinned license below.
  }
  if (currentLicense !== lock.codex.licenseSha256) {
    const response = await fetchImpl(`${lock.codex.repository}/raw/${encodeURIComponent(lock.codex.tag)}/LICENSE`, {
      headers: { "User-Agent": "OpenBot-runtime-installer" },
      redirect: "follow",
    });
    if (!response.ok) throw new Error(`Codex license download failed with HTTP ${response.status}.`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) !== lock.codex.licenseSha256) throw new Error("The Codex license checksum is invalid.");
    await writeFile(licensePath, bytes);
  }
  await writeFile(join(root, "source-manifest.json"), `${JSON.stringify({ name: "codex", ...lock.codex }, null, 2)}\n`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

if (import.meta.main) {
  await installCodexRuntime({
    target: codexRuntimeTarget(process.argv[2] ?? process.platform, process.argv[3] ?? process.arch),
  });
}
