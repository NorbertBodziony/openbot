import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { ATTACHMENT_LIMITS } from "@openbot/contracts/input-limits";
import type { FilePreview } from "@openbot/contracts/ipc";

const TEXT_EXTENSIONS = new Set([
  ".bash",
  ".c",
  ".conf",
  ".cpp",
  ".cs",
  ".css",
  ".csv",
  ".env",
  ".fish",
  ".go",
  ".h",
  ".hpp",
  ".htm",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".jsx",
  ".json",
  ".kt",
  ".kts",
  ".log",
  ".php",
  ".ps1",
  ".py",
  ".rb",
  ".rs",
  ".scala",
  ".sh",
  ".sql",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
  ".zsh",
]);

export function mimeTypeForName(
  name: string,
):
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp"
  | "image/avif"
  | "application/pdf"
  | "text/markdown"
  | "text/plain"
  | "application/octet-stream" {
  switch (extname(name).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".avif":
      return "image/avif";
    case ".pdf":
      return "application/pdf";
    case ".md":
    case ".markdown":
      return "text/markdown";
    default:
      return TEXT_EXTENSIONS.has(extname(name).toLowerCase()) || /^(dockerfile|makefile)$/iu.test(basename(name))
        ? "text/plain"
        : "application/octet-stream";
  }
}

function previewKind(name: string, mimeType: string): FilePreview["previewKind"] {
  if (/\.(md|markdown)$/iu.test(name)) return "markdown";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType.startsWith("text/") || mimeType === "application/json") return "text";
  return "none";
}

export function filePreviewFromBytes(name: string, bytes: Uint8Array): FilePreview {
  if (bytes.byteLength > ATTACHMENT_LIMITS.fileBytes) throw new Error("The file exceeds the 100 MB limit.");
  const mimeType = mimeTypeForName(name);
  const kind = previewKind(name, mimeType);
  return { name, size: bytes.byteLength, mimeType, previewKind: kind, bytes: kind === "none" ? null : bytes };
}

export async function localFilePreview(path: string, name: string, size: number): Promise<FilePreview> {
  if (size > ATTACHMENT_LIMITS.fileBytes) throw new Error("The file exceeds the 100 MB limit.");
  const mimeType = mimeTypeForName(name);
  const kind = previewKind(name, mimeType);
  return {
    name,
    size,
    mimeType,
    previewKind: kind,
    bytes: kind === "none" ? null : new Uint8Array(await readFile(path)),
  };
}
