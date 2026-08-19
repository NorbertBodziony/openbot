import { AVATAR_IMAGE_LIMITS } from "./input-limits";

export const AVATAR_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type AvatarMimeType = (typeof AVATAR_MIME_TYPES)[number];

export function isAvatarMimeType(value: string): value is AvatarMimeType {
  return AVATAR_MIME_TYPES.includes(value as AvatarMimeType);
}

export function isValidAvatarImage(mimeType: string, bytes: Uint8Array): boolean {
  if (!isAvatarMimeType(mimeType) || bytes.byteLength === 0) return false;
  if (bytes.byteLength > AVATAR_IMAGE_LIMITS.storedBytes) return false;
  switch (mimeType) {
    case "image/png":
      return hasBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return hasBytes(bytes, [0xff, 0xd8, 0xff]);
    case "image/webp":
      return (
        hasBytes(bytes, [0x52, 0x49, 0x46, 0x46]) && hasBytes(bytes, [0x57, 0x45, 0x42, 0x50], 8)
      );
  }
}

export function avatarFileExtension(mimeType: AvatarMimeType): "png" | "jpg" | "webp" {
  if (mimeType === "image/png") return "png";
  return mimeType === "image/jpeg" ? "jpg" : "webp";
}

function hasBytes(bytes: Uint8Array, expected: number[], offset = 0): boolean {
  return expected.every((value, index) => bytes[offset + index] === value);
}
