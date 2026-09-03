import { ATTACHMENT_LIMITS } from "@openbot/contracts/input-limits";
import { type ConversationMessage, isImageGenerationAspectRatio } from "@openbot/contracts/ipc";
import { getRecord, getString, type ThreadItem } from "../protocol";

export function isImageGenerationItem(item: ThreadItem): boolean {
  return item.type === "image_generation_call" || item.type === "imageGeneration";
}

export function imageGenerationAspectRatio(item: ThreadItem) {
  const value = item.aspectRatio ?? item.aspect_ratio;
  return isImageGenerationAspectRatio(value) ? value : null;
}

export function imageGenerationFailure(item: ThreadItem): string | null {
  const failure = getRecord(item, "failure");
  return getString(failure, "message") ?? getString(item, "error") ?? getString(item, "failure");
}

export function generatedImageName(savedPath: string): string {
  const extension = savedPath.match(/\.(png|jpe?g|webp|gif|avif)$/i)?.[1]?.toLowerCase() ?? "png";
  return `generated-image.${extension}`;
}

export function decodeGeneratedImage(value: string): Uint8Array {
  const payload = value.match(/^data:[^,]+,([\s\S]*)$/)?.[1] ?? value;
  const maxEncodedBytes = Math.ceil((ATTACHMENT_LIMITS.fileBytes * 4) / 3) + 8;
  if (payload.length > maxEncodedBytes || payload.length % 4 === 1) {
    throw new Error("Generated image exceeds the 100 MB limit.");
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) {
    throw new Error("Generated image data is invalid.");
  }
  const bytes = Buffer.from(payload, "base64");
  if (bytes.byteLength === 0 || bytes.byteLength > ATTACHMENT_LIMITS.fileBytes) {
    throw new Error("Generated image data is invalid or too large.");
  }
  return bytes;
}

export function markIncompleteImageGeneration(
  message: ConversationMessage,
  status: ConversationMessage["status"],
): void {
  if (message.itemType !== "image_generation" || !message.imageGeneration) return;
  if (status === "interrupted") {
    message.imageGeneration.error ??= "Image generation was interrupted.";
    return;
  }
  if (!message.attachments?.length) {
    message.imageGeneration.error ??= "Image generation did not return an image.";
    if (status === "completed") message.status = "failed";
  }
}
