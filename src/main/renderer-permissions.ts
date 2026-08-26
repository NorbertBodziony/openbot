import { isTrustedRendererUrl } from "./trusted-renderer";

interface RendererPermissionDetails {
  mediaType?: string;
  mediaTypes?: readonly string[];
}

export function canCheckRendererPermission(
  permission: string,
  requestingOrigin: string,
  details: RendererPermissionDetails,
  developmentUrl = process.env.ELECTRON_RENDERER_URL,
): boolean {
  if (!isTrustedRendererUrl(requestingOrigin, developmentUrl)) return false;
  if (permission === "clipboard-sanitized-write") return true;
  return permission === "media" && details.mediaType === "audio";
}

export function canRequestRendererPermission(
  permission: string,
  rendererUrl: string,
  details: RendererPermissionDetails,
  developmentUrl = process.env.ELECTRON_RENDERER_URL,
): boolean {
  if (!isTrustedRendererUrl(rendererUrl, developmentUrl)) return false;
  if (permission === "clipboard-sanitized-write") return true;
  const mediaTypes = details.mediaTypes ?? [];
  return permission === "media" && mediaTypes.length > 0 && mediaTypes.every((mediaType) => mediaType === "audio");
}
