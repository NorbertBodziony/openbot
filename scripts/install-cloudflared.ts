import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { loadNativeRuntimeLock } from "./native-runtime-lock";

const run = promisify(execFile);
const lock = await loadNativeRuntimeLock();
const cloudflared = lock.cloudflared;

const targetPlatform = process.argv[2] ?? process.platform;
const targetArch = process.argv[3] ?? process.arch;
const artifactKey = `${targetPlatform}-${targetArch}`;
const artifact =
  artifactKey === "darwin-arm64"
    ? cloudflared.artifacts["darwin-arm64"]
    : artifactKey === "win32-x64"
      ? cloudflared.artifacts["win32-x64"]
      : null;
if (!artifact) throw new Error(`Unsupported cloudflared target: ${targetPlatform}-${targetArch}`);
const selectedArtifact = artifact;

const outputRoot = resolve("build", "cloudflared", selectedArtifact.platformDirectory, targetArch);
const outputExecutable = join(outputRoot, selectedArtifact.executable);
const licenseRoot = resolve("build", "cloudflared", "licenses");
const manifestPath = resolve("build", "cloudflared", "source-manifest.json");

if ((await sha256File(outputExecutable).catch(() => null)) === selectedArtifact.binarySha256) {
  await writeMetadata();
  console.log(`Using verified cloudflared ${cloudflared.version} at ${outputExecutable}`);
  process.exit(0);
}

const workRoot = await mkdtemp(join(tmpdir(), "openbot-cloudflared-"));
try {
  const assetPath = join(workRoot, selectedArtifact.asset);
  await download(
    `${cloudflared.repository}/releases/download/${cloudflared.version}/${selectedArtifact.asset}`,
    assetPath,
  );
  await expectSha256(assetPath, selectedArtifact.assetSha256, selectedArtifact.asset);

  const sourceExecutable = targetPlatform === "darwin" ? await extractDarwinArchive(assetPath, workRoot) : assetPath;
  await expectSha256(sourceExecutable, selectedArtifact.binarySha256, selectedArtifact.executable);

  await mkdir(outputRoot, { recursive: true });
  await copyFile(sourceExecutable, outputExecutable);
  if (targetPlatform !== "win32") await chmod(outputExecutable, 0o755);
  await writeMetadata();
  console.log(`Installed cloudflared ${cloudflared.version} at ${outputExecutable}`);
} finally {
  await rm(workRoot, { recursive: true, force: true });
}

async function extractDarwinArchive(assetPath: string, workRoot: string): Promise<string> {
  const extractionRoot = join(workRoot, "extracted");
  await mkdir(extractionRoot, { recursive: true });
  await run("tar", ["-xzf", assetPath, "-C", extractionRoot]);
  return join(extractionRoot, "cloudflared");
}

async function writeMetadata(): Promise<void> {
  await mkdir(licenseRoot, { recursive: true });
  const licensePath = join(licenseRoot, "cloudflared-Apache-2.0.txt");
  if ((await sha256File(licensePath).catch(() => null)) !== cloudflared.licenseSha256) {
    await download(`${cloudflared.repository}/raw/${cloudflared.version}/LICENSE`, licensePath);
    await expectSha256(licensePath, cloudflared.licenseSha256, "cloudflared license");
  }
  await writeFile(
    join(outputRoot, "SHA256SUMS.txt"),
    `${selectedArtifact.binarySha256}  ${selectedArtifact.executable}\n`,
  );
  await writeFile(join(outputRoot, "VERSION.txt"), `${cloudflared.version}\n`);
  await writeFile(manifestPath, `${JSON.stringify({ name: "cloudflared", ...cloudflared }, null, 2)}\n`);
}

async function download(url: string, path: string): Promise<void> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Could not download ${url}: HTTP ${response.status}`);
  await writeFile(path, new Uint8Array(await response.arrayBuffer()), { mode: 0o600 });
}

async function expectSha256(path: string, expected: string, label: string): Promise<void> {
  const actual = await sha256File(path);
  if (actual !== expected) throw new Error(`Invalid SHA-256 for ${label}: ${actual}`);
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}
