export function isAllowedBrowserStoragePermission(
  permission: string,
  requestingOrigin: string,
  embeddingOrigin?: string,
): boolean {
  if (permission !== "storage-access" && permission !== "top-level-storage-access") return false;
  if (!isHttpUrl(requestingOrigin)) return false;
  return !embeddingOrigin || isHttpUrl(embeddingOrigin);
}

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
