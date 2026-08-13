export function isTrustedRendererUrl(
  frameUrl: string | null | undefined,
  developmentUrl = process.env.ELECTRON_RENDERER_URL,
): boolean {
  if (!frameUrl) return false;
  try {
    const senderUrl = new URL(frameUrl);
    if (developmentUrl) return senderUrl.origin === new URL(developmentUrl).origin;
    return senderUrl.protocol === "openbot-app:" && senderUrl.host === "app";
  } catch {
    return false;
  }
}
