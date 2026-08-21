import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createRemoteDesktopInputDigest, loadNativeRuntimeLock } from "./native-runtime-lock";

const platform = process.argv.includes("--windows") ? "win32" : "darwin";
const architecture = platform === "win32" ? "x64" : "arm64";
const distributionRoot = resolve("build/remote-desktop-runtime");
const root = resolve("build/remote-desktop-runtime", platform, architecture);
const lock = await loadNativeRuntimeLock();
const manifest = JSON.parse(await readFile(resolve("build/remote-desktop-runtime/source-manifest.json"), "utf8"));

if (manifest.inputDigest !== createRemoteDesktopInputDigest(lock))
  throw new Error("The runtime input digest is not approved.");
if (manifest.sunshine?.commit !== lock.remoteDesktop.sunshine.commit)
  throw new Error("The Sunshine commit is not approved.");
if (manifest.moonlightWeb?.commit !== lock.remoteDesktop.moonlightWeb.commit) {
  throw new Error("The Moonlight Web commit is not approved.");
}
if (manifest.sunshine?.patch?.sha256 !== lock.remoteDesktop.sunshine.patch.sha256) {
  throw new Error("The Sunshine OpenBot patch is not approved.");
}
if (manifest.moonlightWeb?.patch?.sha256 !== lock.remoteDesktop.moonlightWeb.patch.sha256) {
  throw new Error("The Moonlight Web OpenBot patch is not approved.");
}

const target = platform === "darwin" ? "darwin-arm64" : "win32-x64";
const names = lock.remoteDesktop.targets[target];
const sunshinePatch = basename(lock.remoteDesktop.sunshine.patch.path);
const moonlightPatch = basename(lock.remoteDesktop.moonlightWeb.patch.path);
await Promise.all([
  ...names.map((name) => access(join(root, name))),
  access(join(root, "static/stream.html")),
  access(resolve("build/remote-desktop-runtime/licenses/Sunshine-GPL-3.0.txt")),
  access(resolve("build/remote-desktop-runtime/licenses/moonlight-web-stream-GPL-3.0.txt")),
  access(resolve(`build/remote-desktop-runtime/sources/Sunshine-${lock.remoteDesktop.sunshine.version}-source.tar.gz`)),
  access(resolve("build/remote-desktop-runtime/sources", sunshinePatch)),
  access(
    resolve(
      `build/remote-desktop-runtime/sources/moonlight-web-stream-${lock.remoteDesktop.moonlightWeb.version}-openbot-source.tar.gz`,
    ),
  ),
  access(resolve("build/remote-desktop-runtime/sources", moonlightPatch)),
  access(join(distributionRoot, "DISTRIBUTION-SHA256SUMS.txt")),
]);

await expectMissing(join(root, "static/stream/audio"));
await expectMissing(join(root, "static/stream/transport/web_socket.js"));
const embeddedStreamSource = await readFile(join(root, "static/stream/index.js"), "utf8");
if (embeddedStreamSource.includes("WebSocketTransport") || embeddedStreamSource.includes("buildAudioPipeline")) {
  throw new Error("The embedded viewer still contains a WebSocket or audio media pipeline.");
}

const checksumEntries = await verifyChecksums(root, "SHA256SUMS.txt");
const distributionChecksumEntries = await verifyChecksums(distributionRoot, "DISTRIBUTION-SHA256SUMS.txt");
for (const name of names) {
  if (!checksumEntries.some((entry) => entry.name === name)) throw new Error(`Missing runtime checksum for ${name}.`);
}
for (const name of [
  "source-manifest.json",
  "licenses/Sunshine-GPL-3.0.txt",
  "licenses/moonlight-web-stream-GPL-3.0.txt",
  `sources/${sunshinePatch}`,
  `sources/${moonlightPatch}`,
]) {
  if (!distributionChecksumEntries.some((entry) => entry.name === name)) {
    throw new Error(`Missing distribution checksum for ${name}.`);
  }
}

console.log(`Verified the Sunshine and Moonlight Web runtime in ${root}`);

async function verifyChecksums(checksumRoot: string, fileName: string) {
  const checksums = await readFile(join(checksumRoot, fileName), "utf8");
  const entries = checksums
    .trim()
    .split("\n")
    .map((line) => {
      const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line);
      if (!match) throw new Error(`Invalid runtime checksum line: ${line}`);
      return { digest: match[1], name: match[2] };
    });
  for (const { digest: expectedDigest, name } of entries) {
    const digest = createHash("sha256")
      .update(await readFile(join(checksumRoot, ...name.split("/"))))
      .digest("hex");
    if (digest !== expectedDigest) throw new Error(`Invalid runtime checksum for ${name}.`);
  }
  return entries;
}

async function expectMissing(path: string) {
  try {
    await access(path);
  } catch {
    return;
  }
  throw new Error(`Forbidden embedded media module exists: ${path}`);
}
