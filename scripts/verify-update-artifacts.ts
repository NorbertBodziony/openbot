import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import { parse } from "yaml";

const MIB = 1024 * 1024;
const platform = process.argv[2];
if (platform !== "macos" && platform !== "windows") {
  throw new Error("Usage: bun scripts/verify-update-artifacts.ts <macos|windows>");
}

const distRoot = resolve("dist");
const artifactExtension = platform === "macos" ? ".zip" : ".exe";
const manifestPath = join(distRoot, platform === "macos" ? "latest-mac.yml" : "latest.yml");
const artifacts = (await readdir(distRoot)).filter((name) => name.endsWith(artifactExtension));
if (artifacts.length !== 1) throw new Error(`Expected one ${artifactExtension} update artifact.`);

const artifactPath = join(distRoot, artifacts[0]);
await verifyMaximumSize(artifactPath, 700 * MIB);
if (platform === "macos") {
  const dmgs = (await readdir(distRoot)).filter((name) => name.endsWith(".dmg"));
  if (dmgs.length !== 1) throw new Error("Expected one DMG artifact.");
  await verifyMaximumSize(join(distRoot, dmgs[0]), 750 * MIB);
}
await verifyManifest(manifestPath, artifactPath);
if (!existsSync(`${artifactPath}.blockmap`)) throw new Error(`Missing blockmap for ${basename(artifactPath)}.`);

const resourcesRoot =
  platform === "macos"
    ? join(distRoot, "mac-arm64", "OpenBot.app", "Contents", "Resources")
    : join(distRoot, "win-unpacked", "resources");
if (existsSync(join(resourcesRoot, "whisper", "model"))) {
  throw new Error("The packaged application contains the on-demand Whisper model.");
}
const unpackedRoot = join(resourcesRoot, "app.asar.unpacked", "node_modules", "@anthropic-ai");
if (existsSync(unpackedRoot)) {
  const entries = await walk(unpackedRoot);
  if (entries.some((path) => /claude-agent-sdk-(?:darwin|win32)-/u.test(path))) {
    throw new Error("The packaged application contains a duplicate native Claude runtime.");
  }
}
console.log(`Verified ${platform} update artifact ${basename(artifactPath)}.`);

async function verifyMaximumSize(path: string, maximumBytes: number): Promise<void> {
  const size = (await stat(path)).size;
  if (size > maximumBytes) {
    throw new Error(`${basename(path)} is ${size} bytes. The limit is ${maximumBytes} bytes.`);
  }
}

async function verifyManifest(path: string, artifact: string): Promise<void> {
  const manifest = parse(await readFile(path, "utf8"));
  if (!isDynamicRecord(manifest) || !Array.isArray(manifest.files)) {
    throw new Error("The update manifest has no file list.");
  }
  const artifactName = basename(artifact);
  const entry = manifest.files?.find((candidate) => {
    if (!isDynamicRecord(candidate) || !isString(candidate.url)) return false;
    return basename(decodeURIComponent(candidate.url)) === artifactName;
  });
  if (!isDynamicRecord(entry)) throw new Error(`The update manifest does not contain ${artifactName}.`);
  const size = (await stat(artifact)).size;
  if (!isNumber(entry.size) || entry.size !== size) {
    throw new Error(`The manifest size does not match ${artifactName}.`);
  }
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(artifact)) hash.update(chunk);
  if (!isString(entry.sha512) || entry.sha512 !== hash.digest("base64")) {
    throw new Error(`The manifest SHA-512 does not match ${artifactName}.`);
  }
}

async function walk(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    result.push(path);
    if (entry.isDirectory()) result.push(...(await walk(path)));
  }
  return result;
}
