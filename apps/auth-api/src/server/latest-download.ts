import { OPENBOT_LINKS } from "../lib/landing-links";

export type AvailableDownloadPlatform = "macos" | "windows";

interface DownloadManifestConfig {
  extension: ".dmg" | ".exe";
  manifest: "latest-mac.yml" | "latest.yml";
}

const RELEASES_BASE_URL = "https://github.com/NorbertBodziony/openbot/releases";

const DOWNLOAD_MANIFESTS: Record<AvailableDownloadPlatform, DownloadManifestConfig> = {
  macos: { extension: ".dmg", manifest: "latest-mac.yml" },
  windows: { extension: ".exe", manifest: "latest.yml" },
};

function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      "cache-control": "no-store",
      location,
    },
  });
}

function findInstaller(manifest: string, extension: DownloadManifestConfig["extension"]): string | undefined {
  const assetLines = manifest.matchAll(/^\s*-\s+url:\s*["']?([^\s"']+)["']?\s*$/gim);
  for (const match of assetLines) {
    const asset = match[1];
    if (asset?.toLowerCase().endsWith(extension) && /^[a-z0-9][a-z0-9._+-]+$/i.test(asset)) return asset;
  }
  return undefined;
}

export async function latestDownloadResponse(
  platform: AvailableDownloadPlatform,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const config = DOWNLOAD_MANIFESTS[platform];
  const manifestUrl = `${RELEASES_BASE_URL}/latest/download/${config.manifest}`;

  try {
    const response = await fetcher(manifestUrl, { headers: { accept: "text/yaml, text/plain" } });
    if (!response.ok) return redirect(OPENBOT_LINKS.releases);

    const installer = findInstaller(await response.text(), config.extension);
    if (!installer) return redirect(OPENBOT_LINKS.releases);

    return redirect(`${RELEASES_BASE_URL}/latest/download/${encodeURIComponent(installer)}`);
  } catch {
    return redirect(OPENBOT_LINKS.releases);
  }
}
