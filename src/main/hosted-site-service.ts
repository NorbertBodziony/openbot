import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  HostedSiteFramework,
  HostedSiteSummary,
  PublishHostedSiteInput,
  ReplaceHostedSiteInput,
} from "@openbot/contracts/ipc";
import { isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import type { CentralAuthManager } from "./central-auth-manager";

const MAX_FILES = 20;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const UNSAFE_FILE_NAME = /(?:^|[-_.])(?:credentials?|private[-_]?key|secret|service[-_]?account)(?:[-_.]|$)/iu;
const SERVER_SOURCE_NAME = /^(?:server|worker)\.[cm]?[jt]s$/iu;

interface PreparedFile {
  path: string;
  size: number;
  mimeType: string;
  bytes: Uint8Array;
}

interface PreparedSite {
  framework: HostedSiteFramework;
  files: PreparedFile[];
}

interface UploadSession {
  uploadId: string;
  expiresAt: string;
}

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain",
  ".webmanifest": "application/manifest+json",
};

export class HostedSiteDesktopService {
  constructor(private readonly auth: CentralAuthManager) {}

  async list(): Promise<HostedSiteSummary[]> {
    const result = await this.auth.requestAuthorized("/v1/sites/", { method: "GET" }, decodeSiteList);
    return result.sites;
  }

  publish(input: PublishHostedSiteInput, allowedRoots?: readonly string[]): Promise<HostedSiteSummary> {
    return this.upload(input, null, allowedRoots);
  }

  replace(input: ReplaceHostedSiteInput, allowedRoots?: readonly string[]): Promise<HostedSiteSummary> {
    return this.upload(input, input.siteId, allowedRoots);
  }

  async delete(siteId: string): Promise<void> {
    await this.auth.requestAuthorized(
      `/v1/sites/${encodeURIComponent(siteId)}`,
      { method: "DELETE", headers: { "Idempotency-Key": operationKey("delete") } },
      decodeDeleteResult,
    );
  }

  private async upload(
    input: PublishHostedSiteInput,
    siteId: string | null,
    allowedRoots?: readonly string[],
  ): Promise<HostedSiteSummary> {
    const prepared = await prepareSite(input.sourcePath, allowedRoots);
    const uploadKey = operationKey(siteId ? "replace" : "publish");
    const session = await this.auth.requestAuthorized(
      "/v1/sites/",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": uploadKey },
        body: JSON.stringify({
          title: input.title,
          description: input.description,
          framework: prepared.framework,
          spaFallback: input.spaFallback ?? false,
          siteId,
          files: prepared.files.map(({ path, size, mimeType }) => ({ path, size, mimeType })),
        }),
      },
      decodeUploadSession,
    );
    for (const file of prepared.files) {
      await this.auth.requestAuthorized(
        `/v1/sites/uploads/${encodeURIComponent(session.uploadId)}/file?path=${encodeURIComponent(file.path)}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": file.mimeType,
            "Content-Length": String(file.size),
            "Idempotency-Key": `${uploadKey}:file:${createHash("sha256").update(file.path).digest("hex").slice(0, 24)}`,
          },
          body: arrayBuffer(file.bytes),
        },
        decodeUploadResult,
        30_000,
      );
    }
    return this.auth.requestAuthorized(
      `/v1/sites/uploads/${encodeURIComponent(session.uploadId)}/activate`,
      { method: "POST", headers: { "Idempotency-Key": operationKey("activate") } },
      decodeSite,
      30_000,
    );
  }
}

export async function prepareSite(sourcePath: string, allowedRoots?: readonly string[]): Promise<PreparedSite> {
  if (!isAbsolute(sourcePath)) throw new Error("Choose an absolute site directory path.");
  const root = await realpath(resolve(sourcePath));
  const rootStats = await lstat(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw new Error("The site source must be a directory.");
  if (allowedRoots?.length) {
    const roots = await Promise.all(allowedRoots.map((candidate) => realpath(resolve(candidate))));
    if (!roots.some((candidate) => isInside(candidate, root))) {
      throw new Error("The site must be inside this bot's workspace or OpenBot Shared.");
    }
  }
  const framework = await detectFramework(root);
  const output = framework === "astro" ? await staticAstroOutput(root) : root;
  return { framework, files: await collectFiles(output) };
}

async function detectFramework(root: string): Promise<HostedSiteFramework> {
  const packagePath = join(root, "package.json");
  try {
    const value = JSON.parse(await readFile(packagePath, "utf8"));
    if (
      isDynamicRecord(value) &&
      [value.dependencies, value.devDependencies].some((group) => isDynamicRecord(group) && isString(group.astro))
    ) {
      return "astro";
    }
  } catch (error) {
    if (!isMissing(error)) throw new Error("The site package.json is invalid.");
  }
  for (const name of ["astro.config.mjs", "astro.config.js", "astro.config.ts"]) {
    try {
      await lstat(join(root, name));
      return "astro";
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return "vanilla";
}

async function staticAstroOutput(root: string): Promise<string> {
  const configPath = await firstExisting(
    ["astro.config.mjs", "astro.config.js", "astro.config.ts"].map((name) => join(root, name)),
  );
  if (configPath) {
    const config = await readFile(configPath, "utf8");
    if (/output\s*:\s*["'](?:server|hybrid)["']/u.test(config)) throw new Error("Astro must use static output.");
    if (/adapter|@astrojs\/react|integrations\s*:\s*\[[^\]]*react/isu.test(config)) {
      throw new Error("Astro server adapters and React integration are not allowed.");
    }
  }
  const forbidden = [join(root, "src", "pages", "api"), join(root, "src", "actions")];
  for (const path of forbidden) {
    if (await exists(path)) throw new Error("Astro API routes and server actions are not allowed.");
  }
  const sourceEntries = await readdir(join(root, "src"), { recursive: true }).catch(() => []);
  if (sourceEntries.some((entry) => /(^|\/)(?:middleware|[^/]+\.server)\.[cm]?[jt]s$/u.test(String(entry)))) {
    throw new Error("Astro middleware and server source are not allowed.");
  }
  const output = join(root, "dist");
  if (!(await exists(output)))
    throw new Error("Build the Astro project first. Its existing dist/ directory is required.");
  return output;
}

async function collectFiles(root: string): Promise<PreparedFile[]> {
  const files: PreparedFile[] = [];
  let total = 0;
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const stats = await lstat(absolute);
      if (stats.isSymbolicLink()) throw new Error(`Symlinks are not allowed: ${entry.name}`);
      if (stats.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!stats.isFile()) throw new Error(`Unsupported site entry: ${entry.name}`);
      if (files.length >= MAX_FILES) throw new Error(`A site can contain at most ${MAX_FILES} files.`);
      const path = relative(root, absolute).split("\\").join("/");
      if (path.split("/").some((segment) => segment.startsWith("."))) {
        throw new Error(`Hidden files are not allowed: ${path}`);
      }
      if (UNSAFE_FILE_NAME.test(entry.name) || SERVER_SOURCE_NAME.test(entry.name)) {
        throw new Error(`Credentials, private keys, and server source are not allowed: ${path}`);
      }
      const extension = extname(path).toLowerCase();
      const mimeType = MIME_TYPES[extension];
      if (!mimeType) throw new Error(`This file type is not allowed: ${path}`);
      if (stats.size > MAX_FILE_BYTES) throw new Error(`A file exceeds the 1 MB limit: ${path}`);
      total += stats.size;
      if (total > MAX_TOTAL_BYTES) throw new Error("The site exceeds the 2 MB limit.");
      files.push({ path, size: stats.size, mimeType, bytes: new Uint8Array(await readFile(absolute)) });
    }
  }
  await visit(root);
  if (!files.some((file) => file.path === "index.html")) throw new Error("The site root must contain index.html.");
  return files;
}

function decodeSiteList(value: unknown): { sites: HostedSiteSummary[] } {
  if (!isDynamicRecord(value) || !Array.isArray(value.sites)) throw new Error("The site list response is invalid.");
  return { sites: value.sites.map(decodeSite) };
}

function decodeSite(value: unknown): HostedSiteSummary {
  if (
    !isDynamicRecord(value) ||
    !isString(value.id) ||
    !isString(value.hostname) ||
    !isString(value.url) ||
    !isString(value.title) ||
    !isString(value.description) ||
    (value.framework !== "vanilla" && value.framework !== "astro") ||
    !["active", "deleted", "expired", "blocked", "uploading"].includes(String(value.status)) ||
    !isNumber(value.fileCount) ||
    !isNumber(value.size) ||
    (value.expiresAt !== null && !isString(value.expiresAt)) ||
    !isString(value.updatedAt)
  ) {
    throw new Error("The site response is invalid.");
  }
  return {
    id: value.id,
    hostname: value.hostname,
    url: value.url,
    title: value.title,
    description: value.description,
    framework: value.framework,
    status: decodeSiteStatus(value.status),
    fileCount: value.fileCount,
    size: value.size,
    expiresAt: value.expiresAt,
    updatedAt: value.updatedAt,
  };
}

function decodeUploadSession(value: unknown): UploadSession {
  if (!isDynamicRecord(value) || !isString(value.uploadId) || !isString(value.expiresAt)) {
    throw new Error("The upload session response is invalid.");
  }
  return { uploadId: value.uploadId, expiresAt: value.expiresAt };
}

function decodeUploadResult(value: unknown): undefined {
  if (!isDynamicRecord(value) || value.uploaded !== true) throw new Error("The file upload response is invalid.");
  return undefined;
}

function decodeDeleteResult(value: unknown): undefined {
  if (!isDynamicRecord(value) || value.deleted !== true) throw new Error("The site deletion response is invalid.");
  return undefined;
}

function operationKey(operation: string): string {
  return `desktop:${operation}:${randomUUID()}`;
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function decodeSiteStatus(value: unknown): HostedSiteSummary["status"] {
  if (value === "active" || value === "deleted" || value === "expired" || value === "blocked") return value;
  throw new Error("The hosted site status is invalid.");
}

function isInside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function firstExisting(paths: string[]): Promise<string | null> {
  for (const path of paths) if (await exists(path)) return path;
  return null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return isDynamicRecord(error) && error.code === "ENOENT";
}
