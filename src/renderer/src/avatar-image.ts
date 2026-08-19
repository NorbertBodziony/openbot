import { isAvatarMimeType } from "@openbot/contracts/avatar-images";
import { AVATAR_IMAGE_LIMITS } from "@openbot/contracts/input-limits";
import type { AvatarImageInput } from "@openbot/contracts/ipc";

const OUTPUT_SIZES = [512, 448, 384, 320] as const;
const OUTPUT_QUALITIES = [0.88, 0.82, 0.76, 0.7] as const;

export async function normalizeAvatarFile(file: File): Promise<AvatarImageInput> {
  if (!isAvatarMimeType(file.type)) throw new Error("Choose a PNG, JPEG, or WebP image.");
  if (file.size > AVATAR_IMAGE_LIMITS.sourceBytes) {
    throw new Error("Choose an image smaller than 10 MB.");
  }
  const source = await createImageBitmap(file);
  try {
    for (const [index, outputSize] of OUTPUT_SIZES.entries()) {
      const blob = await renderAvatar(source, outputSize, OUTPUT_QUALITIES[index] ?? 0.7);
      if (blob.size <= AVATAR_IMAGE_LIMITS.storedBytes) {
        return {
          mimeType: "image/webp",
          bytes: new Uint8Array(await blob.arrayBuffer()),
        };
      }
    }
  } finally {
    source.close();
  }
  throw new Error("OpenBot could not make this image small enough. Choose a simpler image.");
}

export function avatarCrop(width: number, height: number): { sourceX: number; sourceY: number; sourceSize: number } {
  const sourceSize = Math.min(width, height);
  return {
    sourceX: Math.max(0, (width - sourceSize) / 2),
    sourceY: Math.max(0, (height - sourceSize) / 2),
    sourceSize,
  };
}

async function renderAvatar(source: ImageBitmap, outputSize: number, quality: number): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = outputSize;
  canvas.height = outputSize;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Image processing is unavailable.");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  const crop = avatarCrop(source.width, source.height);
  context.drawImage(source, crop.sourceX, crop.sourceY, crop.sourceSize, crop.sourceSize, 0, 0, outputSize, outputSize);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", quality));
  if (!blob) throw new Error("OpenBot could not process this image.");
  return blob;
}
