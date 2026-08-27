import { readFile } from "node:fs/promises";
import { attachmentMimeTypeForName } from "@openbot/contracts/attachment-files";
import { ATTACHMENT_LIMITS } from "@openbot/contracts/input-limits";
import type { FilePreview } from "@openbot/contracts/ipc";

export function mimeTypeForName(name: string) {
  return attachmentMimeTypeForName(name);
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
