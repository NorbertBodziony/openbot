import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRemoteDesktopInputDigest, loadNativeRuntimeLock } from "./native-runtime-lock";
import {
  createDeterministicTarGz,
  runtimeArtifactName,
  runtimeSbomName,
  runtimeTarget,
  runtimeTargetParts,
  sha256,
  sha256File,
} from "./remote-desktop-runtime-release";

const target = runtimeTarget(process.argv[2], process.argv[3]);
const { platform, architecture } = runtimeTargetParts(target);
const lock = await loadNativeRuntimeLock();
const inputDigest = createRemoteDesktopInputDigest(lock);
const runtimeRoot = resolve("build/remote-desktop-runtime");
const outputRoot = resolve("build/remote-desktop-release");
const temporaryRoot = await mkdtemp(join(tmpdir(), "openbot-runtime-package-"));
const stagedRoot = join(temporaryRoot, "remote-desktop-runtime");

try {
  await mkdir(join(stagedRoot, platform), { recursive: true });
  await Promise.all([
    cp(join(runtimeRoot, platform, architecture), join(stagedRoot, platform, architecture), { recursive: true }),
    cp(join(runtimeRoot, "licenses"), join(stagedRoot, "licenses"), { recursive: true }),
    cp(join(runtimeRoot, "sources"), join(stagedRoot, "sources"), { recursive: true }),
    cp(join(runtimeRoot, "source-manifest.json"), join(stagedRoot, "source-manifest.json")),
  ]);
  await writeChecksums(stagedRoot, "DISTRIBUTION-SHA256SUMS.txt");
  await mkdir(outputRoot, { recursive: true });
  const archive = join(outputRoot, runtimeArtifactName(target));
  await rm(archive, { force: true });
  await createDeterministicTarGz(stagedRoot, archive);
  const metadata = {
    schemaVersion: 1,
    target,
    inputDigest,
    asset: runtimeArtifactName(target),
    sha256: await sha256File(archive),
    sbomAsset: runtimeSbomName(target),
  };
  await writeFile(join(outputRoot, `${target}.json`), `${JSON.stringify(metadata, null, 2)}\n`);
  // Machine-readable: release tooling parses the metadata JSON from stdout.
  process.stdout.write(`${JSON.stringify(metadata)}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function writeChecksums(root: string, fileName: string): Promise<void> {
  const names = (await listFiles(root)).filter((name) => name !== fileName);
  const lines = await Promise.all(
    names.map(async (name) => `${sha256(await readFile(join(root, ...name.split("/"))))}  ${name}`),
  );
  await writeFile(join(root, fileName), `${lines.join("\n")}\n`);
}

async function listFiles(root: string, prefix = ""): Promise<string[]> {
  const directory = prefix ? join(root, ...prefix.split("/")) : root;
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listFiles(root, relativePath)));
    else files.push(relativePath);
  }
  return files.sort();
}
