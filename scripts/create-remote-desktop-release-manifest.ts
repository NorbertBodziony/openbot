import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
  createRemoteDesktopInputDigest,
  createRemoteDesktopReleaseTag,
  loadNativeRuntimeLock,
} from "./native-runtime-lock";
import { createReleaseManifest, remoteDesktopTargets } from "./remote-desktop-runtime-release";

const metadataSchema = z.object({
  schemaVersion: z.literal(1),
  target: z.enum(remoteDesktopTargets),
  inputDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  asset: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  sbomAsset: z.string().min(1),
});

const repository = process.argv[2];
const output = process.argv[3];
const metadataPaths = process.argv.slice(4);
if (!repository || !output || metadataPaths.length !== remoteDesktopTargets.length) {
  throw new Error(
    "Usage: bun scripts/create-remote-desktop-release-manifest.ts owner/repository output.json darwin.json windows.json",
  );
}

const lock = await loadNativeRuntimeLock();
const inputDigest = createRemoteDesktopInputDigest(lock);
const metadataEntries = await Promise.all(
  metadataPaths.map(async (path) => metadataSchema.parse(JSON.parse(await readFile(resolve(path), "utf8")))),
);
const artifacts = Object.fromEntries(
  await Promise.all(
    metadataEntries.map(async (entry, index) => {
      if (entry.inputDigest !== inputDigest)
        throw new Error(`The ${entry.target} build used a different input digest.`);
      const metadataDirectory = dirname(resolve(metadataPaths[index]));
      const sbomSha256 = createHash("sha256")
        .update(await readFile(join(metadataDirectory, entry.sbomAsset)))
        .digest("hex");
      return [entry.target, { asset: entry.asset, sha256: entry.sha256, sbomAsset: entry.sbomAsset, sbomSha256 }];
    }),
  ),
);
const parsedArtifacts = z
  .object({
    "darwin-arm64": metadataSchema
      .pick({ asset: true, sha256: true, sbomAsset: true })
      .extend({ sbomSha256: z.string().regex(/^[0-9a-f]{64}$/u) }),
    "win32-x64": metadataSchema
      .pick({ asset: true, sha256: true, sbomAsset: true })
      .extend({ sbomSha256: z.string().regex(/^[0-9a-f]{64}$/u) }),
  })
  .parse(artifacts);
const manifest = createReleaseManifest({
  lock,
  inputDigest,
  repository,
  tag: createRemoteDesktopReleaseTag(inputDigest),
  artifacts: parsedArtifacts,
});
await writeFile(resolve(output), `${JSON.stringify(manifest, null, 2)}\n`);
// Machine-readable: release tag consumed by tooling.
process.stdout.write(`${manifest.tag}\n`);
