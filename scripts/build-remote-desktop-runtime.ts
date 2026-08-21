import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRemoteDesktopSourceManifest, loadNativeRuntimeLock } from "./native-runtime-lock";

const platform = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : null;
if (!platform) throw new Error("The remote desktop runtime supports macOS and Windows only.");
const architecture = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
if (
  !architecture ||
  (platform === "darwin" && architecture !== "arm64") ||
  (platform === "win32" && architecture !== "x64")
) {
  throw new Error(`Unsupported remote desktop target: ${process.platform}-${process.arch}.`);
}

const lock = await loadNativeRuntimeLock();
const outputRoot = resolve("build/remote-desktop-runtime", platform, architecture);
const workRoot = await mkdtemp(join(tmpdir(), "openbot-remote-desktop-build-"));

try {
  const sunshineSource = await downloadAndExtract(
    lock.remoteDesktop.sunshine.sourceArchive,
    lock.remoteDesktop.sunshine.sourceSha256,
    join(workRoot, "sunshine"),
  );
  const moonlightSource = await downloadAndExtract(
    lock.remoteDesktop.moonlightWeb.sourceArchive,
    lock.remoteDesktop.moonlightWeb.sourceSha256,
    join(workRoot, "moonlight"),
  );
  await preparePinnedCheckout(sunshineSource, lock.remoteDesktop.sunshine, requiredSunshineSubmodules(platform));
  await preparePinnedCheckout(moonlightSource, lock.remoteDesktop.moonlightWeb);
  await prepareOpenBotSource(sunshineSource, lock.remoteDesktop.sunshine);
  await prepareOpenBotSource(moonlightSource, lock.remoteDesktop.moonlightWeb);
  auditNpmDependencies(sunshineSource);
  auditNpmDependencies(moonlightSource);

  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });
  await packageCorrespondingSource(sunshineSource, moonlightSource, lock);
  buildSunshine(sunshineSource, lock.remoteDesktop.sunshine.version, lock.remoteDesktop.sunshine.commit);
  buildMoonlight(moonlightSource);

  const sunshineBinary = findSunshineBinary(sunshineSource);
  const executableSuffix = platform === "win32" ? ".exe" : "";
  if (platform === "darwin") {
    await cp(join(sunshineSource, "build-openbot", "Sunshine.app"), join(outputRoot, "Sunshine.app"), {
      recursive: true,
    });
  } else {
    await cp(sunshineBinary, join(outputRoot, `sunshine${executableSuffix}`));
  }
  await cp(
    join(moonlightSource, "target/release", `web-server${executableSuffix}`),
    join(outputRoot, `web-server${executableSuffix}`),
  );
  await cp(
    join(moonlightSource, "target/release", `streamer${executableSuffix}`),
    join(outputRoot, `streamer${executableSuffix}`),
  );
  await cp(join(moonlightSource, "dist"), join(outputRoot, "static"), { recursive: true });
  if (platform === "darwin") signMacRuntime(outputRoot);

  const licenses = resolve("build/remote-desktop-runtime/licenses");
  await mkdir(licenses, { recursive: true });
  await Promise.all([
    cp(join(sunshineSource, "LICENSE"), join(licenses, "Sunshine-GPL-3.0.txt")),
    cp(join(moonlightSource, "LICENSE"), join(licenses, "moonlight-web-stream-GPL-3.0.txt")),
    writeFile(
      resolve("build/remote-desktop-runtime/source-manifest.json"),
      `${JSON.stringify(createRemoteDesktopSourceManifest(lock), null, 2)}\n`,
    ),
  ]);
  await writeChecksums(outputRoot);
  await writeChecksums(resolve("build/remote-desktop-runtime"), "DISTRIBUTION-SHA256SUMS.txt");
  console.log(`Built the pinned Sunshine and Moonlight Web runtime in ${outputRoot}`);
} finally {
  await rm(workRoot, { recursive: true, force: true });
}

async function packageCorrespondingSource(
  sunshineSource: string,
  moonlightSource: string,
  lock: Awaited<ReturnType<typeof loadNativeRuntimeLock>>,
): Promise<void> {
  const sourceOutput = resolve("build/remote-desktop-runtime/sources");
  await rm(sourceOutput, { recursive: true, force: true });
  await mkdir(sourceOutput, { recursive: true });
  const exclusions = [
    "--exclude=.git",
    "--exclude=node_modules",
    "--exclude=target",
    "--exclude=dist",
    "--exclude=build-openbot",
  ];
  execFileSync(
    "tar",
    [
      "-czf",
      join(sourceOutput, `Sunshine-${lock.remoteDesktop.sunshine.version}-source.tar.gz`),
      ...exclusions,
      "-C",
      sunshineSource,
      ".",
    ],
    { stdio: "inherit" },
  );
  execFileSync(
    "tar",
    [
      "-czf",
      join(sourceOutput, `moonlight-web-stream-${lock.remoteDesktop.moonlightWeb.version}-openbot-source.tar.gz`),
      ...exclusions,
      "-C",
      moonlightSource,
      ".",
    ],
    { stdio: "inherit" },
  );
  await cp(
    resolve(lock.remoteDesktop.sunshine.patch.path),
    join(sourceOutput, lock.remoteDesktop.sunshine.patch.path.split("/").at(-1) ?? "sunshine-openbot.patch"),
  );
  await cp(
    resolve(lock.remoteDesktop.moonlightWeb.patch.path),
    join(sourceOutput, lock.remoteDesktop.moonlightWeb.patch.path.split("/").at(-1) ?? "moonlight-openbot.patch"),
  );
  await writeFile(
    join(sourceOutput, "README.txt"),
    "These archives are the corresponding source used to build the bundled GPL-3.0 Sunshine and Moonlight Web programs. Both archives already contain the OpenBot changes. The separate patches show those changes against the pinned upstream versions.\n",
  );
}

async function downloadAndExtract(url: string, expectedSha256: string, destination: string): Promise<string> {
  const archive = `${destination}.tar.gz`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Runtime source download failed with HTTP ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== expectedSha256) throw new Error(`Runtime source checksum failed for ${url}.`);
  await writeFile(archive, bytes);
  await mkdir(destination, { recursive: true });
  const tarArguments = ["-xzf", archive, "--strip-components=1", "-C", destination];
  if (process.platform === "win32") tarArguments.unshift("--force-local");
  execFileSync("tar", tarArguments, { stdio: "inherit" });
  return destination;
}

async function preparePinnedCheckout(
  source: string,
  runtime: { repository: string; commit: string; licenseSha256: string; submodules: Record<string, string> },
  requiredSubmodules: string[] = Object.keys(runtime.submodules),
): Promise<void> {
  if (sha256(await readFile(join(source, "LICENSE"))) !== runtime.licenseSha256) {
    throw new Error(`Runtime license checksum failed for ${runtime.repository}.`);
  }
  await rm(source, { recursive: true, force: true });
  execFileSync("git", ["clone", "--quiet", "--filter=blob:none", "--no-checkout", runtime.repository, source]);
  execFileSync("git", ["fetch", "--quiet", "--depth", "1", "origin", runtime.commit], { cwd: source });
  execFileSync("git", ["checkout", "--quiet", "--detach", "FETCH_HEAD"], { cwd: source });
  if (requiredSubmodules.length === 0) return;
  const rootSubmodules = requiredSubmodules.filter(
    (path) => !requiredSubmodules.some((candidate) => candidate !== path && path.startsWith(`${candidate}/`)),
  );
  execFileSync("git", ["submodule", "update", "--init", ...rootSubmodules], { cwd: source, stdio: "inherit" });
  for (const root of rootSubmodules) {
    const nested = requiredSubmodules
      .filter((path) => path.startsWith(`${root}/`))
      .map((path) => path.slice(root.length + 1));
    if (nested.length > 0) {
      execFileSync("git", ["submodule", "update", "--init", ...nested], { cwd: join(source, root), stdio: "inherit" });
    }
  }
  for (const path of requiredSubmodules) {
    const expectedCommit = runtime.submodules[path];
    if (!expectedCommit) throw new Error(`The required submodule is not pinned: ${path}.`);
    const actualCommit = execFileSync("git", ["-C", join(source, path), "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    if (actualCommit !== expectedCommit) throw new Error(`Unexpected submodule commit for ${path}.`);
  }
}

function requiredSunshineSubmodules(targetPlatform: "darwin" | "win32"): string[] {
  const common = [
    "third-party/Simple-Web-Server",
    "third-party/build-deps",
    "third-party/libdisplaydevice",
    "third-party/moonlight-common-c",
    "third-party/moonlight-common-c/enet",
    "third-party/moonlight-common-c/nanors/deps/simde",
    "third-party/nanors",
    "third-party/nv-codec-headers",
    "third-party/tray",
  ];
  return targetPlatform === "darwin"
    ? [...common, "third-party/TPCircularBuffer"]
    : [...common, "third-party/ViGEmClient", "third-party/glad", "third-party/nvapi"];
}

function buildSunshine(source: string, version: string, commit: string): void {
  const build = join(source, "build-openbot");
  const generator = process.env.CMAKE_GENERATOR ?? (hasExecutable("ninja") ? "Ninja" : "Unix Makefiles");
  const buildEnvironment = {
    ...process.env,
    BRANCH: "master",
    BUILD_VERSION: version,
    COMMIT: commit,
    TAG: version,
  };
  execFileSync(
    "cmake",
    [
      "-S",
      source,
      "-B",
      build,
      "-G",
      generator,
      "-DCMAKE_BUILD_TYPE=Release",
      "-DBUILD_DOCS=OFF",
      "-DBUILD_TESTS=OFF",
      "-DBUILD_WERROR=OFF",
    ],
    { env: buildEnvironment, stdio: "inherit" },
  );
  execFileSync("cmake", ["--build", build, "--config", "Release", "--parallel", "--target", "web-ui"], {
    stdio: "inherit",
  });
  execFileSync("cmake", ["--build", build, "--config", "Release", "--parallel", "--target", "sunshine"], {
    stdio: "inherit",
  });
}

function buildMoonlight(source: string): void {
  execFileSync("npm", ["ci"], { cwd: source, stdio: "inherit" });
  execFileSync("npm", ["run", "build"], { cwd: source, stdio: "inherit" });
  execFileSync("cargo", ["build", "--locked", "--release"], { cwd: source, stdio: "inherit" });
}

async function applyOpenBotPatch(source: string, entry: { path: string; sha256: string }): Promise<void> {
  const patch = resolve(entry.path);
  if (sha256(await readFile(patch)) !== entry.sha256) {
    throw new Error(`Runtime patch checksum failed for ${entry.path}.`);
  }
  execFileSync("git", ["apply", "--check", patch], { cwd: source, stdio: "inherit" });
  execFileSync("git", ["apply", patch], { cwd: source, stdio: "inherit" });
}

async function prepareOpenBotSource(
  source: string,
  runtime: Awaited<ReturnType<typeof loadNativeRuntimeLock>>["remoteDesktop"]["sunshine"],
): Promise<void> {
  if (runtime.sourceMode === "upstream-with-patch") {
    await applyOpenBotPatch(source, runtime.patch);
    await applyRuntimeOverrides(source, runtime.overrides);
    return;
  }

  if (runtime.overrides.length > 0) {
    throw new Error(`The OpenBot fork must include its overrides: ${runtime.repository}.`);
  }
}

async function applyRuntimeOverrides(
  sourceRoot: string,
  entries: Array<{ source: string; destination: string; sha256: string }>,
): Promise<void> {
  for (const entry of entries) {
    const source = resolve(entry.source);
    if (sha256(await readFile(source)) !== entry.sha256) {
      throw new Error(`Runtime override checksum failed for ${entry.source}.`);
    }
    const destination = join(sourceRoot, ...entry.destination.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination);
  }
}

function auditNpmDependencies(source: string): void {
  execFileSync("npm", ["audit", "--audit-level=high"], { cwd: source, stdio: "inherit" });
}

function signMacRuntime(root: string): void {
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", join(root, "Sunshine.app")], {
    stdio: "inherit",
  });
  for (const executable of ["web-server", "streamer"]) {
    execFileSync("codesign", ["--force", "--sign", "-", join(root, executable)], { stdio: "inherit" });
  }
}

function findSunshineBinary(source: string): string {
  const suffix = platform === "win32" ? ".exe" : "";
  const candidates = [
    join(source, "build-openbot", `sunshine${suffix}`),
    join(source, "build-openbot", "sunshine", `sunshine${suffix}`),
    join(source, "build-openbot", "Release", `sunshine${suffix}`),
    join(source, "build-openbot", "Sunshine.app", "Contents", "MacOS", "Sunshine"),
  ];
  for (const candidate of candidates) {
    try {
      accessSync(candidate);
      return candidate;
    } catch {
      // Continue to the next platform-specific CMake output.
    }
  }
  throw new Error("The Sunshine build did not produce its executable.");
}

function hasExecutable(name: string): boolean {
  try {
    execFileSync(platform === "win32" ? "where" : "which", [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function writeChecksums(root: string, fileName = "SHA256SUMS.txt"): Promise<void> {
  const names = (await listFiles(root)).filter((name) => name !== fileName);
  const lines = await Promise.all(
    names.map(async (name) => `${sha256(await readFile(join(root, ...name.split("/"))))}  ${name}`),
  );
  await writeFile(join(root, fileName), `${lines.join("\n")}\n`);
}

async function listFiles(root: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(root, ...prefix.split("/").filter(Boolean)), { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listFiles(root, relativePath)));
    else files.push(relativePath);
  }
  return files.sort();
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
