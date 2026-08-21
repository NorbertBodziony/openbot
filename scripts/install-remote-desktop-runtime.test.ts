import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { installRemoteDesktopRuntime, validateManifest } from "./install-remote-desktop-runtime";
import {
  createRemoteDesktopInputDigest,
  createRemoteDesktopReleaseTag,
  loadNativeRuntimeLock,
} from "./native-runtime-lock";
import { pinRemoteDesktopRuntime } from "./pin-remote-desktop-runtime";
import {
  createDeterministicTarGz,
  createReleaseManifest,
  sha256,
  validateArchivePath,
} from "./remote-desktop-runtime-release";

describe("remote desktop runtime installer", () => {
  it("downloads, verifies, installs, and then reuses a current runtime", async () => {
    const fixture = await createFixture();
    let requestCount = 0;
    const fetchImpl = createFixtureFetch(fixture, () => {
      requestCount += 1;
    });

    await expect(
      installRemoteDesktopRuntime({
        sourceRoot: fixture.sourceRoot,
        outputRoot: fixture.outputRoot,
        target: "darwin-arm64",
        fetchImpl,
      }),
    ).resolves.toBe("installed");
    await expect(readFile(join(fixture.outputRoot, "darwin/arm64/web-server"), "utf8")).resolves.toBe("web");
    await expect(
      installRemoteDesktopRuntime({
        sourceRoot: fixture.sourceRoot,
        outputRoot: fixture.outputRoot,
        target: "darwin-arm64",
        fetchImpl,
      }),
    ).resolves.toBe("current");
    expect(requestCount).toBe(3);
  });

  it("rejects a damaged archive", async () => {
    const fixture = await createFixture();
    const fetchImpl = createFixtureFetch(fixture, undefined, Buffer.concat([fixture.archiveBytes, Buffer.from("bad")]));
    await expect(
      installRemoteDesktopRuntime({
        sourceRoot: fixture.sourceRoot,
        outputRoot: fixture.outputRoot,
        target: "darwin-arm64",
        fetchImpl,
      }),
    ).rejects.toThrow("archive checksum is invalid");
  });

  it("rejects path traversal entries", () => {
    for (const path of ["../escape", "remote-desktop-runtime/../escape", "/absolute", "C:\\escape"]) {
      expect(() => validateArchivePath(path)).toThrow("Unsafe runtime archive path");
    }
  });

  it("rejects a manifest with a different source commit", async () => {
    const fixture = await createFixture();
    const changed = structuredClone(fixture.manifest);
    changed.sources.sunshine.commit = "f".repeat(40);
    expect(() => validateManifest(fixture.lock, changed, "darwin-arm64")).toThrow("does not match the lock file");
  });
});

async function createFixture() {
  const sourceRoot = await mkdtemp(join(tmpdir(), "openbot-runtime-source-"));
  const outputRoot = join(sourceRoot, "build/remote-desktop-runtime");
  const stagingRoot = join(sourceRoot, "staging");
  const targetRoot = join(stagingRoot, "darwin/arm64");
  await Promise.all([
    mkdir(join(targetRoot, "Sunshine.app/Contents/MacOS"), { recursive: true }),
    mkdir(join(targetRoot, "static/stream"), { recursive: true }),
    mkdir(join(stagingRoot, "licenses"), { recursive: true }),
    mkdir(join(stagingRoot, "sources"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(targetRoot, "Sunshine.app/Contents/MacOS/Sunshine"), "sunshine"),
    writeFile(join(targetRoot, "web-server"), "web"),
    writeFile(join(targetRoot, "streamer"), "streamer"),
    writeFile(join(targetRoot, "static/stream.html"), "html"),
    writeFile(join(targetRoot, "static/stream/index.js"), "index"),
    writeFile(join(stagingRoot, "licenses/Sunshine-GPL-3.0.txt"), "license"),
    writeFile(join(stagingRoot, "licenses/moonlight-web-stream-GPL-3.0.txt"), "license"),
    writeFile(join(stagingRoot, "sources/README.txt"), "source"),
  ]);
  const baseLock = await loadNativeRuntimeLock();
  await Promise.all(
    [baseLock.remoteDesktop.sunshine.patch.path, baseLock.remoteDesktop.moonlightWeb.patch.path].map(async (path) => {
      const destination = join(sourceRoot, ...path.split("/"));
      await mkdir(dirname(destination), { recursive: true });
      await cp(path, destination);
    }),
  );
  const digest = createRemoteDesktopInputDigest(baseLock);
  await writeFile(
    join(stagingRoot, "source-manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      recipeVersion: baseLock.remoteDesktop.recipeVersion,
      inputDigest: digest,
      sunshine: baseLock.remoteDesktop.sunshine,
      moonlightWeb: baseLock.remoteDesktop.moonlightWeb,
      targets: baseLock.remoteDesktop.targets,
    }),
  );
  await writeChecksums(
    targetRoot,
    ["Sunshine.app/Contents/MacOS/Sunshine", "web-server", "streamer", "static/stream.html", "static/stream/index.js"],
    "SHA256SUMS.txt",
  );
  await writeChecksums(
    stagingRoot,
    [
      "darwin/arm64/SHA256SUMS.txt",
      "darwin/arm64/Sunshine.app/Contents/MacOS/Sunshine",
      "darwin/arm64/static/stream.html",
      "darwin/arm64/static/stream/index.js",
      "darwin/arm64/streamer",
      "darwin/arm64/web-server",
      "licenses/Sunshine-GPL-3.0.txt",
      "licenses/moonlight-web-stream-GPL-3.0.txt",
      "source-manifest.json",
      "sources/README.txt",
    ],
    "DISTRIBUTION-SHA256SUMS.txt",
  );
  const archivePath = join(sourceRoot, "runtime.tar.gz");
  await createDeterministicTarGz(stagingRoot, archivePath);
  const archiveBytes = await readFile(archivePath);
  const manifest = createReleaseManifest({
    lock: baseLock,
    inputDigest: digest,
    repository: "NorbertBodziony/openbot",
    tag: createRemoteDesktopReleaseTag(digest),
    artifacts: {
      "darwin-arm64": {
        asset: "remote-desktop-runtime-darwin-arm64.tar.gz",
        sha256: sha256(archiveBytes),
        sbomAsset: "remote-desktop-runtime-darwin-arm64.spdx.json",
        sbomSha256: "d".repeat(64),
      },
      "win32-x64": {
        asset: "remote-desktop-runtime-win32-x64.tar.gz",
        sha256: "c".repeat(64),
        sbomAsset: "remote-desktop-runtime-win32-x64.spdx.json",
        sbomSha256: "e".repeat(64),
      },
    },
  });
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const lock = pinRemoteDesktopRuntime(baseLock, manifest, sha256(manifestBytes));
  await writeFile(join(sourceRoot, "native-runtime.lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
  return { sourceRoot, outputRoot, archiveBytes, manifest, manifestBytes, lock };
}

function createFixtureFetch(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  onRequest?: () => void,
  archiveBytes = fixture.archiveBytes,
): typeof fetch {
  return async (request) => {
    onRequest?.();
    const url = String(request);
    if (url.startsWith("https://api.github.com/")) {
      return Response.json({
        tag_name: fixture.manifest.tag,
        draft: false,
        prerelease: true,
        assets: [
          { name: "remote-desktop-runtime-manifest.json", browser_download_url: "https://assets.test/manifest" },
          {
            name: "remote-desktop-runtime-darwin-arm64.tar.gz",
            browser_download_url: "https://assets.test/archive",
          },
        ],
      });
    }
    if (url === "https://assets.test/manifest") return new Response(fixture.manifestBytes);
    if (url === "https://assets.test/archive") return new Response(archiveBytes);
    return new Response("missing", { status: 404 });
  };
}

async function writeChecksums(root: string, names: string[], fileName: string): Promise<void> {
  const lines = await Promise.all(
    names.map(async (name) => {
      const digest = createHash("sha256")
        .update(await readFile(join(root, ...name.split("/"))))
        .digest("hex");
      return `${digest}  ${name}`;
    }),
  );
  await writeFile(join(root, fileName), `${lines.join("\n")}\n`);
}
