import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { z } from "zod";
import type { NativeRuntimeLock } from "./native-runtime-lock";

export const remoteDesktopTargets = ["darwin-arm64", "win32-x64"] as const;
export type RemoteDesktopTarget = (typeof remoteDesktopTargets)[number];

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const artifactSchema = z.object({
  asset: z.string().min(1),
  sha256: sha256Schema,
  sbomAsset: z.string().min(1),
  sbomSha256: sha256Schema,
});

export const remoteDesktopReleaseManifestSchema = z.object({
  schemaVersion: z.literal(1),
  recipeVersion: z.number().int().positive(),
  inputDigest: sha256Schema,
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
  tag: z.string().regex(/^remote-desktop-runtime-[0-9a-f]{64}$/u),
  sources: z.object({
    sunshine: z.object({
      repository: z.url(),
      commit: z.string().regex(/^[0-9a-f]{40}$/u),
      license: z.string(),
      licenseSha256: sha256Schema,
    }),
    moonlightWeb: z.object({
      repository: z.url(),
      commit: z.string().regex(/^[0-9a-f]{40}$/u),
      license: z.string(),
      licenseSha256: sha256Schema,
    }),
  }),
  artifacts: z.object({
    "darwin-arm64": artifactSchema,
    "win32-x64": artifactSchema,
  }),
});

export type RemoteDesktopReleaseManifest = z.infer<typeof remoteDesktopReleaseManifestSchema>;

export function runtimeTarget(
  platform: string = process.platform,
  architecture: string = process.arch,
): RemoteDesktopTarget {
  if (platform === "darwin" && architecture === "arm64") return "darwin-arm64";
  if (platform === "win32" && architecture === "x64") return "win32-x64";
  throw new Error(`Unsupported remote desktop target: ${platform}-${architecture}.`);
}

export function runtimeTargetParts(target: RemoteDesktopTarget): {
  platform: "darwin" | "win32";
  architecture: string;
} {
  return target === "darwin-arm64"
    ? { platform: "darwin", architecture: "arm64" }
    : { platform: "win32", architecture: "x64" };
}

export function runtimeArtifactName(target: RemoteDesktopTarget): string {
  return `remote-desktop-runtime-${target}.tar.gz`;
}

export function runtimeSbomName(target: RemoteDesktopTarget): string {
  return `remote-desktop-runtime-${target}.spdx.json`;
}

export function createReleaseManifest(input: {
  lock: NativeRuntimeLock;
  inputDigest: string;
  repository: string;
  tag: string;
  artifacts: Record<RemoteDesktopTarget, { asset: string; sha256: string; sbomAsset: string; sbomSha256: string }>;
}): RemoteDesktopReleaseManifest {
  return remoteDesktopReleaseManifestSchema.parse({
    schemaVersion: 1,
    recipeVersion: input.lock.remoteDesktop.recipeVersion,
    inputDigest: input.inputDigest,
    repository: input.repository,
    tag: input.tag,
    sources: {
      sunshine: {
        repository: input.lock.remoteDesktop.sunshine.repository,
        commit: input.lock.remoteDesktop.sunshine.commit,
        license: input.lock.remoteDesktop.sunshine.license,
        licenseSha256: input.lock.remoteDesktop.sunshine.licenseSha256,
      },
      moonlightWeb: {
        repository: input.lock.remoteDesktop.moonlightWeb.repository,
        commit: input.lock.remoteDesktop.moonlightWeb.commit,
        license: input.lock.remoteDesktop.moonlightWeb.license,
        licenseSha256: input.lock.remoteDesktop.moonlightWeb.licenseSha256,
      },
    },
    artifacts: input.artifacts,
  });
}

export function parseReleaseManifest(value: unknown): RemoteDesktopReleaseManifest {
  return remoteDesktopReleaseManifestSchema.parse(value);
}

export function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function sha256File(path: string): Promise<string> {
  return sha256(await readFile(path));
}

export function listArchiveEntries(archive: string): string[] {
  const names = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).split(/\r?\n/u).filter(Boolean);
  const details = execFileSync("tar", ["-tvzf", archive], { encoding: "utf8" }).split(/\r?\n/u).filter(Boolean);
  if (details.some((line) => !["-", "d"].includes(line.trimStart().charAt(0)))) {
    throw new Error("The runtime archive contains a link or a special file.");
  }
  for (const name of names) validateArchivePath(name);
  return names;
}

export function validateArchivePath(name: string): void {
  if (name.includes("\0") || name.includes("\\")) throw new Error(`Unsafe runtime archive path: ${name}`);
  const normalized = name.replace(/\/+$/u, "");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized)) {
    throw new Error(`Unsafe runtime archive path: ${name}`);
  }
  const parts = normalized.split("/");
  if (parts[0] !== "remote-desktop-runtime" || parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Unsafe runtime archive path: ${name}`);
  }
}

export async function rejectNonRegularFiles(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
      throw new Error(`The runtime archive contains an unsafe file: ${path}`);
    }
    if (metadata.isDirectory()) await rejectNonRegularFiles(path);
  }
}

export async function createDeterministicTarGz(root: string, archive: string): Promise<void> {
  const chunks: Buffer[] = [];
  await appendTarEntry(root, "remote-desktop-runtime", chunks);
  chunks.push(Buffer.alloc(1024));
  await writeFile(archive, gzipSync(Buffer.concat(chunks), { level: 9 }));
}

async function appendTarEntry(path: string, name: string, chunks: Buffer[]): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
    throw new Error(`Cannot package unsafe runtime file: ${path}`);
  }
  const tarName = metadata.isDirectory() ? `${name}/` : name;
  const header = createTarHeader(tarName, metadata.isDirectory() ? 0 : metadata.size, metadata.mode & 0o777);
  chunks.push(header);
  if (metadata.isFile()) {
    const contents = await readFile(path);
    chunks.push(contents);
    const padding = (512 - (contents.length % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
    return;
  }
  for (const entry of (await readdir(path)).sort()) {
    await appendTarEntry(join(path, entry), `${name}/${entry}`, chunks);
  }
}

function createTarHeader(path: string, size: number, mode: number): Buffer {
  const header = Buffer.alloc(512);
  const { name, prefix } = splitTarPath(path);
  writeTarText(header, name, 0, 100);
  writeTarOctal(header, mode || 0o644, 100, 8);
  writeTarOctal(header, 0, 108, 8);
  writeTarOctal(header, 0, 116, 8);
  writeTarOctal(header, size, 124, 12);
  writeTarOctal(header, 0, 136, 12);
  header.fill(0x20, 148, 156);
  header[156] = path.endsWith("/") ? 0x35 : 0x30;
  writeTarText(header, "ustar", 257, 6);
  writeTarText(header, "00", 263, 2);
  writeTarText(header, "root", 265, 32);
  writeTarText(header, "root", 297, 32);
  writeTarText(header, prefix, 345, 155);
  const checksum = header.reduce((total, value) => total + value, 0);
  const checksumText = checksum.toString(8).padStart(6, "0");
  header.write(checksumText, 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function splitTarPath(path: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  for (let index = path.lastIndexOf("/"); index > 0; index = path.lastIndexOf("/", index - 1)) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw new Error(`Runtime archive path is too long for tar: ${path}`);
}

function writeTarText(buffer: Buffer, value: string, offset: number, length: number): void {
  if (Buffer.byteLength(value) > length) throw new Error(`Tar value is too long: ${value}`);
  buffer.write(value, offset, length, "utf8");
}

function writeTarOctal(buffer: Buffer, value: number, offset: number, length: number): void {
  const text = value.toString(8).padStart(length - 1, "0");
  if (text.length >= length) throw new Error(`Tar number is too large: ${value}`);
  buffer.write(text, offset, length - 1, "ascii");
  buffer[offset + length - 1] = 0;
}
