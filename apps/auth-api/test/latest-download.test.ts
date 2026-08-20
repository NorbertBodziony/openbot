import { describe, expect, it, vi } from "vitest";
import { OPENBOT_LINKS } from "../src/lib/landing-links";
import { latestDownloadResponse } from "../src/server/latest-download";

describe("latest download", () => {
  it.each([
    ["macos", "latest-mac.yml", "OpenBot-0.1.11-arm64.dmg"],
    ["windows", "latest.yml", "OpenBot-0.1.11-x64.exe"],
  ] as const)("redirects %s to its installer from the latest manifest", async (platform, manifest, installer) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(`files:\n  - url: ${installer}\npath: ignored.zip`, { status: 200 }));

    const response = await latestDownloadResponse(platform, fetcher);

    expect(fetcher).toHaveBeenCalledWith(
      `https://github.com/NorbertBodziony/openbot/releases/latest/download/${manifest}`,
      { headers: { accept: "text/yaml, text/plain" } },
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `https://github.com/NorbertBodziony/openbot/releases/latest/download/${installer}`,
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it.each([
    new Response("Not found", { status: 404 }),
    new Response("files:\n  - url: checksums.txt", { status: 200 }),
  ])("falls back to the Releases page when no installer can be resolved", async (manifestResponse) => {
    const response = await latestDownloadResponse("macos", vi.fn<typeof fetch>().mockResolvedValue(manifestResponse));

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(OPENBOT_LINKS.releases);
  });
});
