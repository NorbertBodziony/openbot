import { isBoolean, isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";

export const HOSTED_SITE_LIMITS = {
  activeSites: 10,
  concurrentUploads: 2,
  files: 20,
  totalBytes: 2 * 1024 * 1024,
  fileBytes: 1024 * 1024,
  uploadLifetimeMs: 15 * 60_000,
  siteLifetimeMs: 30 * 24 * 60 * 60_000,
  tombstoneLifetimeMs: 90 * 24 * 60 * 60_000,
} as const;

export type HostedSiteFramework = "vanilla" | "astro";

export interface HostedSiteFileManifest {
  path: string;
  size: number;
  mimeType: string;
}

export interface HostedSiteUploadRequest {
  title: string;
  description: string;
  framework: HostedSiteFramework;
  spaFallback: boolean;
  siteId: string | null;
  files: HostedSiteFileManifest[];
}

const ALLOWED_MIME_BY_EXTENSION: Readonly<Record<string, readonly string[]>> = {
  html: ["text/html"],
  css: ["text/css"],
  js: ["text/javascript", "application/javascript"],
  mjs: ["text/javascript", "application/javascript"],
  json: ["application/json"],
  svg: ["image/svg+xml"],
  webp: ["image/webp"],
  png: ["image/png"],
  jpg: ["image/jpeg"],
  jpeg: ["image/jpeg"],
  ico: ["image/x-icon", "image/vnd.microsoft.icon"],
  woff2: ["font/woff2"],
  txt: ["text/plain"],
  webmanifest: ["application/manifest+json"],
};

const UNSAFE_SEGMENTS = new Set([".env", ".git", "node_modules", "server", "api"]);
const UNSAFE_FILE_NAME = /(?:^|[-_.])(?:credentials?|private[-_]?key|secret|service[-_]?account)(?:[-_.]|$)/iu;
const SERVER_SOURCE_NAME = /^(?:server|worker)\.[cm]?[jt]s$/iu;

export class HostedSiteInputError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 413 | 429,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function parseHostedSiteUploadRequest(value: unknown): HostedSiteUploadRequest {
  if (!isDynamicRecord(value)) throw invalid("The upload request is invalid.");
  const title = limitedText(value.title, "title", 120);
  const description = limitedText(value.description, "description", 500);
  if (value.framework !== "vanilla" && value.framework !== "astro") {
    throw invalid("The site type must be vanilla or Astro static.");
  }
  if (!isBoolean(value.spaFallback)) throw invalid("spaFallback must be a boolean.");
  if (value.siteId !== null && value.siteId !== undefined && !isString(value.siteId)) {
    throw invalid("siteId is invalid.");
  }
  if (!Array.isArray(value.files) || value.files.length === 0 || value.files.length > HOSTED_SITE_LIMITS.files) {
    throw new HostedSiteInputError(413, "file_limit", `A site can contain 1 to ${HOSTED_SITE_LIMITS.files} files.`);
  }
  const seen = new Set<string>();
  const files = value.files.map((file) => parseFile(file, seen));
  if (!seen.has("index.html")) throw invalid("The site root must contain index.html.");
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > HOSTED_SITE_LIMITS.totalBytes) {
    throw new HostedSiteInputError(413, "site_too_large", "The site exceeds the 2 MB limit.");
  }
  return {
    title,
    description,
    framework: value.framework,
    spaFallback: value.spaFallback,
    siteId: isString(value.siteId) && value.siteId ? value.siteId : null,
    files,
  };
}

export function expectedFile(files: HostedSiteFileManifest[], path: string): HostedSiteFileManifest {
  const file = files.find((candidate) => candidate.path === path);
  if (!file) throw invalid("This file is not part of the upload manifest.");
  return file;
}

function parseFile(value: unknown, seen: Set<string>): HostedSiteFileManifest {
  if (!isDynamicRecord(value) || !isString(value.path) || !isNumber(value.size) || !isString(value.mimeType)) {
    throw invalid("A file manifest entry is invalid.");
  }
  const path = normalizeHostedSitePath(value.path);
  if (seen.has(path)) throw invalid("The file manifest contains a duplicate path.");
  seen.add(path);
  if (!Number.isSafeInteger(value.size) || value.size < 0 || value.size > HOSTED_SITE_LIMITS.fileBytes) {
    throw new HostedSiteInputError(413, "file_too_large", "A file exceeds the 1 MB limit.");
  }
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  const allowed = ALLOWED_MIME_BY_EXTENSION[extension];
  if (!allowed?.includes(value.mimeType.toLowerCase())) {
    throw invalid(`The file type for ${path} is not allowed.`);
  }
  return { path, size: value.size, mimeType: value.mimeType.toLowerCase() };
}

export function normalizeHostedSitePath(value: string): string {
  const path = value.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (!path || path.length > 240 || path.startsWith("/") || path.endsWith("/") || path.includes("//")) {
    throw invalid("A file path is invalid.");
  }
  const segments = path.split("/");
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.startsWith(".") ||
        UNSAFE_SEGMENTS.has(segment.toLowerCase()),
    )
  ) {
    throw invalid("A file path is unsafe.");
  }
  const lower = path.toLowerCase();
  const fileName = segments.at(-1) ?? "";
  if (UNSAFE_FILE_NAME.test(fileName) || SERVER_SOURCE_NAME.test(fileName)) {
    throw invalid("Credentials, private keys, and server source are not allowed.");
  }
  if (lower.endsWith(".map") || lower.endsWith(".zip") || lower.endsWith(".tar") || lower.endsWith(".gz")) {
    throw invalid("Archives and source maps are not allowed.");
  }
  return path;
}

function limitedText(value: unknown, label: string, limit: number): string {
  if (!isString(value) || !value.trim() || value.length > limit) throw invalid(`The ${label} is invalid.`);
  return value.trim();
}

function invalid(message: string): HostedSiteInputError {
  return new HostedSiteInputError(400, "invalid_site", message);
}
