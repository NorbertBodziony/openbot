import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

const commitSchema = z.string().regex(/^[0-9a-f]{40}$/u, "Must use a complete Git commit.");
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u, "Must use a complete SHA-256 value.");
const cloudflaredArtifactSchema = z.object({
  asset: z.string().min(1),
  assetSha256: sha256Schema,
  binarySha256: sha256Schema,
  executable: z.string().min(1),
  platformDirectory: z.enum(["mac", "win"]),
});
const remoteDesktopReleaseArtifactSchema = z.object({
  asset: z.string().min(1),
  sha256: sha256Schema,
});
const remoteDesktopArtifactReleaseSchema = z.object({
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u, "Must use a GitHub owner/repository name."),
  tag: z.string().regex(/^remote-desktop-runtime-[0-9a-f]{64}$/u, "Must use the runtime digest tag."),
  inputDigest: sha256Schema,
  manifestAsset: z.literal("remote-desktop-runtime-manifest.json"),
  manifestSha256: sha256Schema,
});
const sourceRuntimeSchema = z.object({
  sourceMode: z.enum(["upstream-with-patch", "openbot-fork"]),
  repository: z.url(),
  version: z.string().min(1),
  commit: commitSchema,
  upstream: z.object({ repository: z.url(), commit: commitSchema }),
  sourceArchive: z.url(),
  sourceSha256: sha256Schema,
  license: z.literal("GPL-3.0"),
  licenseSha256: sha256Schema,
  patch: z.object({ path: z.string().min(1), sha256: sha256Schema }),
  overrides: z.array(
    z.object({
      source: z.string().min(1),
      destination: z.string().min(1),
      sha256: sha256Schema,
    }),
  ),
  submodules: z.record(z.string().min(1), commitSchema),
});

const nativeRuntimeLockSchema = z.object({
  schemaVersion: z.literal(1),
  cloudflared: z.object({
    repository: z.url(),
    version: z.string().min(1),
    license: z.literal("Apache-2.0"),
    licenseSha256: sha256Schema,
    artifacts: z.object({
      "darwin-arm64": cloudflaredArtifactSchema,
      "win32-x64": cloudflaredArtifactSchema,
    }),
  }),
  remoteDesktop: z.object({
    recipeVersion: z.number().int().positive(),
    sunshine: sourceRuntimeSchema,
    moonlightWeb: sourceRuntimeSchema,
    artifactRelease: remoteDesktopArtifactReleaseSchema.optional(),
    releaseArtifacts: z.partialRecord(z.enum(["darwin-arm64", "win32-x64"]), remoteDesktopReleaseArtifactSchema),
    targets: z.object({
      "darwin-arm64": z.array(z.string().min(1)).min(1),
      "win32-x64": z.array(z.string().min(1)).min(1),
    }),
  }),
});

export type NativeRuntimeLock = z.infer<typeof nativeRuntimeLockSchema>;

export async function loadNativeRuntimeLock(sourceRoot = process.cwd()): Promise<NativeRuntimeLock> {
  const path = resolve(sourceRoot, "native-runtime.lock.json");
  const lock = parseNativeRuntimeLock(JSON.parse(await readFile(path, "utf8")));
  await validateRemoteDesktopInputFiles(lock, sourceRoot);
  return lock;
}

export function parseNativeRuntimeLock(value: unknown): NativeRuntimeLock {
  const lock = nativeRuntimeLockSchema.parse(value);
  const release = lock.remoteDesktop.artifactRelease;
  const artifacts = lock.remoteDesktop.releaseArtifacts;
  if (!release) {
    if (Object.keys(artifacts).length > 0) {
      throw new Error("Runtime artifacts require artifactRelease metadata.");
    }
    return lock;
  }

  for (const target of ["darwin-arm64", "win32-x64"] as const) {
    if (!artifacts[target]) throw new Error(`The runtime lock is missing the ${target} artifact.`);
  }
  const expectedDigest = createRemoteDesktopInputDigest(lock);
  if (release.inputDigest !== expectedDigest)
    throw new Error("The runtime input digest does not match the build recipe.");
  if (release.tag !== createRemoteDesktopReleaseTag(expectedDigest)) {
    throw new Error("The runtime release tag does not match the input digest.");
  }
  return lock;
}

export function createRemoteDesktopInputDigest(lock: NativeRuntimeLock): string {
  const input = {
    recipeVersion: lock.remoteDesktop.recipeVersion,
    sunshine: lock.remoteDesktop.sunshine,
    moonlightWeb: lock.remoteDesktop.moonlightWeb,
    targets: lock.remoteDesktop.targets,
  };
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function createRemoteDesktopReleaseTag(inputDigest: string): string {
  return `remote-desktop-runtime-${inputDigest}`;
}

export function hasPinnedRemoteDesktopArtifacts(lock: NativeRuntimeLock): boolean {
  return Boolean(
    lock.remoteDesktop.artifactRelease &&
      lock.remoteDesktop.releaseArtifacts["darwin-arm64"] &&
      lock.remoteDesktop.releaseArtifacts["win32-x64"],
  );
}

async function validateRemoteDesktopInputFiles(lock: NativeRuntimeLock, sourceRoot: string): Promise<void> {
  for (const runtime of [lock.remoteDesktop.sunshine, lock.remoteDesktop.moonlightWeb]) {
    const patchDigest = createHash("sha256")
      .update(await readFile(resolve(sourceRoot, runtime.patch.path)))
      .digest("hex");
    if (patchDigest !== runtime.patch.sha256)
      throw new Error(`Runtime patch checksum failed for ${runtime.patch.path}.`);
    for (const override of runtime.overrides) {
      const overrideDigest = createHash("sha256")
        .update(await readFile(resolve(sourceRoot, override.source)))
        .digest("hex");
      if (overrideDigest !== override.sha256) {
        throw new Error(`Runtime override checksum failed for ${override.source}.`);
      }
    }
  }
}

export function createRemoteDesktopSourceManifest(lock: NativeRuntimeLock) {
  return {
    schemaVersion: 1,
    recipeVersion: lock.remoteDesktop.recipeVersion,
    inputDigest: createRemoteDesktopInputDigest(lock),
    sunshine: lock.remoteDesktop.sunshine,
    moonlightWeb: lock.remoteDesktop.moonlightWeb,
    buildScript: "scripts/build-remote-desktop-runtime.ts",
    targets: lock.remoteDesktop.targets,
  };
}
