import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { createRemoteDesktopInputDigest, loadNativeRuntimeLock, type NativeRuntimeLock } from "./native-runtime-lock";
import {
  listArchiveEntries,
  parseReleaseManifest,
  type RemoteDesktopReleaseManifest,
  type RemoteDesktopTarget,
  rejectNonRegularFiles,
  runtimeTarget,
  runtimeTargetParts,
  sha256,
} from "./remote-desktop-runtime-release";

const githubReleaseSchema = z.object({
  tag_name: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  assets: z.array(z.object({ name: z.string(), browser_download_url: z.url() })),
});
type GitHubRelease = z.infer<typeof githubReleaseSchema>;
type GitHubReleaseAsset = GitHubRelease["assets"][number];

export async function installRemoteDesktopRuntime(
  input: { sourceRoot?: string; outputRoot?: string; target?: RemoteDesktopTarget; fetchImpl?: typeof fetch } = {},
): Promise<"installed" | "current"> {
  const sourceRoot = input.sourceRoot ?? process.cwd();
  const outputRoot = input.outputRoot ?? resolve(sourceRoot, "build/remote-desktop-runtime");
  const target = input.target ?? runtimeTarget();
  const fetchImpl = input.fetchImpl ?? fetch;
  const lock = await loadNativeRuntimeLock(sourceRoot);
  const release = lock.remoteDesktop.artifactRelease;
  const artifact = lock.remoteDesktop.releaseArtifacts[target];
  if (!release || !artifact) throw new Error(`No published remote desktop runtime is pinned for ${target}.`);

  if (await isCurrentInstallation(outputRoot, target, lock)) {
    console.log(`The ${target} remote desktop runtime is current.`);
    return "current";
  }

  const releaseResponse = await fetchImpl(
    `https://api.github.com/repos/${release.repository}/releases/tags/${encodeURIComponent(release.tag)}`,
    { headers: { Accept: "application/vnd.github+json", "User-Agent": "OpenBot-runtime-installer" } },
  );
  if (!releaseResponse.ok) throw new Error(`Runtime release lookup failed with HTTP ${releaseResponse.status}.`);
  const githubRelease = githubReleaseSchema.parse(await releaseResponse.json());
  validateGitHubRelease(githubRelease, release.tag);

  const manifestAsset = findAsset(githubRelease, release.manifestAsset);
  const manifestBytes = await download(fetchImpl, manifestAsset.browser_download_url);
  if (sha256(manifestBytes) !== release.manifestSha256)
    throw new Error("The runtime release manifest checksum is invalid.");
  const manifest = parseReleaseManifest(JSON.parse(manifestBytes.toString("utf8")));
  validateManifest(lock, manifest, target);

  const archiveAsset = findAsset(githubRelease, artifact.asset);
  const archiveBytes = await download(fetchImpl, archiveAsset.browser_download_url);
  if (sha256(archiveBytes) !== artifact.sha256) throw new Error(`The ${target} runtime archive checksum is invalid.`);

  const temporaryRoot = await mkdtemp(join(tmpdir(), "openbot-runtime-install-"));
  try {
    const archive = join(temporaryRoot, artifact.asset);
    const extracted = join(temporaryRoot, "extracted");
    await writeFile(archive, archiveBytes);
    listArchiveEntries(archive);
    await mkdir(extracted, { recursive: true });
    execFileSync("tar", ["-xzf", archive, "-C", extracted, "--no-same-owner"], { stdio: "inherit" });
    const extractedRuntime = join(extracted, "remote-desktop-runtime");
    await rejectNonRegularFiles(extractedRuntime);
    await verifyRuntimeTree(extractedRuntime, target, lock);
    await installValidatedTree(extractedRuntime, outputRoot, target);
    await verifyRuntimeTree(outputRoot, target, lock);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  console.log(`Installed the pinned ${target} remote desktop runtime.`);
  return "installed";
}

export function validateGitHubRelease(release: GitHubRelease, expectedTag: string): void {
  if (release.tag_name !== expectedTag || release.draft || !release.prerelease) {
    throw new Error("The pinned runtime release is not a published prerelease with the expected tag.");
  }
}

export function validateManifest(
  lock: NativeRuntimeLock,
  manifest: RemoteDesktopReleaseManifest,
  target: RemoteDesktopTarget,
): void {
  const release = lock.remoteDesktop.artifactRelease;
  const artifact = lock.remoteDesktop.releaseArtifacts[target];
  if (!release || !artifact) throw new Error(`No published remote desktop runtime is pinned for ${target}.`);
  const digest = createRemoteDesktopInputDigest(lock);
  if (
    manifest.inputDigest !== digest ||
    manifest.inputDigest !== release.inputDigest ||
    manifest.repository !== release.repository ||
    manifest.tag !== release.tag ||
    manifest.recipeVersion !== lock.remoteDesktop.recipeVersion ||
    manifest.sources.sunshine.commit !== lock.remoteDesktop.sunshine.commit ||
    manifest.sources.sunshine.licenseSha256 !== lock.remoteDesktop.sunshine.licenseSha256 ||
    manifest.sources.moonlightWeb.commit !== lock.remoteDesktop.moonlightWeb.commit ||
    manifest.sources.moonlightWeb.licenseSha256 !== lock.remoteDesktop.moonlightWeb.licenseSha256 ||
    manifest.artifacts[target].asset !== artifact.asset ||
    manifest.artifacts[target].sha256 !== artifact.sha256
  ) {
    throw new Error("The runtime release manifest does not match the lock file.");
  }
}

export async function verifyRuntimeTree(
  root: string,
  target: RemoteDesktopTarget,
  lock: NativeRuntimeLock,
): Promise<void> {
  const { platform, architecture } = runtimeTargetParts(target);
  const sourceManifest = JSON.parse(await readFile(join(root, "source-manifest.json"), "utf8"));
  if (
    sourceManifest.inputDigest !== createRemoteDesktopInputDigest(lock) ||
    sourceManifest.sunshine?.commit !== lock.remoteDesktop.sunshine.commit ||
    sourceManifest.moonlightWeb?.commit !== lock.remoteDesktop.moonlightWeb.commit
  ) {
    throw new Error("The installed runtime source manifest does not match the lock file.");
  }
  await verifyChecksumFile(root, "DISTRIBUTION-SHA256SUMS.txt");
  await verifyChecksumFile(join(root, platform, architecture), "SHA256SUMS.txt");
  const required = [
    ...lock.remoteDesktop.targets[target],
    "static/stream.html",
    "static/stream/index.js",
    "SHA256SUMS.txt",
  ];
  for (const name of required) await readFile(join(root, platform, architecture, ...name.split("/")));
}

async function isCurrentInstallation(
  root: string,
  target: RemoteDesktopTarget,
  lock: NativeRuntimeLock,
): Promise<boolean> {
  try {
    await verifyRuntimeTree(root, target, lock);
    return true;
  } catch {
    return false;
  }
}

async function download(fetchImpl: typeof fetch, url: string): Promise<Buffer> {
  const response = await fetchImpl(url, { headers: { "User-Agent": "OpenBot-runtime-installer" } });
  if (!response.ok) throw new Error(`Runtime asset download failed with HTTP ${response.status}.`);
  return Buffer.from(await response.arrayBuffer());
}

function findAsset(release: GitHubRelease, name: string): GitHubReleaseAsset {
  const asset = release.assets.find((candidate) => candidate.name === name);
  if (!asset) throw new Error(`The runtime release does not contain ${name}.`);
  return asset;
}

async function verifyChecksumFile(root: string, fileName: string): Promise<void> {
  const contents = await readFile(join(root, fileName), "utf8");
  for (const line of contents.trim().split("\n")) {
    const match = /^([0-9a-f]{64}) {2}(.+)$/u.exec(line);
    if (!match) throw new Error(`Invalid runtime checksum line: ${line}`);
    const name = match[2];
    if (!name) throw new Error("A runtime checksum has no file name.");
    if (
      name.includes("\\") ||
      name.startsWith("/") ||
      /^[A-Za-z]:/u.test(name) ||
      name.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      throw new Error(`Unsafe checksum path: ${name}`);
    }
    const path = join(root, ...name.split("/"));
    if (sha256(await readFile(path)) !== match[1]) throw new Error(`Invalid runtime checksum for ${name}.`);
  }
}

async function installValidatedTree(source: string, destination: string, target: RemoteDesktopTarget): Promise<void> {
  const { platform, architecture } = runtimeTargetParts(target);
  const exactTarget = join(destination, platform, architecture);
  const temporaryTarget = join(dirname(exactTarget), `.${architecture}.installing`);
  await mkdir(dirname(exactTarget), { recursive: true });
  await rm(temporaryTarget, { recursive: true, force: true });
  await cp(join(source, platform, architecture), temporaryTarget, { recursive: true });
  await rm(exactTarget, { recursive: true, force: true });
  await rename(temporaryTarget, exactTarget);
  for (const name of ["licenses", "sources"]) {
    const destinationPath = join(destination, name);
    await rm(destinationPath, { recursive: true, force: true });
    await cp(join(source, name), destinationPath, { recursive: true });
  }
  await mkdir(destination, { recursive: true });
  await Promise.all(
    ["source-manifest.json", "DISTRIBUTION-SHA256SUMS.txt"].map((name) =>
      cp(join(source, name), join(destination, name)),
    ),
  );
}

if (import.meta.main) {
  const platform = process.argv[2] ?? process.platform;
  const architecture = process.argv[3] ?? process.arch;
  await installRemoteDesktopRuntime({ target: runtimeTarget(platform, architecture) });
}
