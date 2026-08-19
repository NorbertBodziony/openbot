import { isAvatarMimeType, isValidAvatarImage } from "@openbot/contracts/avatar-images";
import { AVATAR_IMAGE_LIMITS } from "@openbot/contracts/input-limits";
import { isUuidV4 } from "@openbot/contracts/validation";

export interface StoredAvatarUpload {
  bytes: Uint8Array;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
}

export async function readAvatarUpload(request: Request): Promise<StoredAvatarUpload> {
  const mimeType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim() ?? "";
  if (!isAvatarMimeType(mimeType)) throw new AvatarUploadError(415, "unsupported_avatar_type");
  const declaredLength = Number(request.headers.get("Content-Length") ?? 0);
  if (declaredLength > AVATAR_IMAGE_LIMITS.storedBytes) {
    throw new AvatarUploadError(413, "avatar_too_large");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new AvatarUploadError(400, "invalid_avatar");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > AVATAR_IMAGE_LIMITS.storedBytes) {
      await reader.cancel().catch(() => undefined);
      throw new AvatarUploadError(413, "avatar_too_large");
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (!isValidAvatarImage(mimeType, bytes)) {
    throw new AvatarUploadError(400, "invalid_avatar");
  }
  return { bytes, mimeType };
}

export function avatarObjectKey(userId: string, version: string): string {
  if (!isUuidV4(userId) || !isUuidV4(version)) throw new Error("Invalid avatar identifier.");
  return `users/${userId}/${version}`;
}

export function avatarVersion(avatarUrl: string | null, expectedUserId: string): string | null {
  if (!avatarUrl) return null;
  try {
    const url = new URL(avatarUrl, "https://api.openbot.run");
    const match = url.pathname.match(/^\/v1\/avatars\/([^/]+)$/u);
    const userId = decodeURIComponent(match?.[1] ?? "");
    const version = url.searchParams.get("v") ?? "";
    return userId === expectedUserId && isUuidV4(version) ? version : null;
  } catch {
    return null;
  }
}

export class AvatarUploadError extends Error {
  constructor(
    readonly status: 400 | 413 | 415,
    readonly code: "invalid_avatar" | "avatar_too_large" | "unsupported_avatar_type",
  ) {
    super(
      code === "avatar_too_large"
        ? "The avatar image is too large."
        : code === "unsupported_avatar_type"
          ? "Choose a PNG, JPEG, or WebP image."
          : "The avatar image is invalid.",
    );
  }
}
