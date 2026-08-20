import { describe, expect, it } from "vitest";
import { DOWNLOAD_PLATFORMS, detectDownloadPlatform } from "../src/lib/download-platforms";
import { OPENBOT_DOWNLOAD_LINKS } from "../src/lib/landing-links";

describe("download platforms", () => {
  it.each([
    [{ userAgentData: { platform: "macOS" } }, "macos"],
    [{ platform: "MacIntel" }, "macos"],
    [{ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }, "windows"],
    [{ platform: "Linux x86_64" }, "linux"],
    [{ userAgent: "Mozilla/5.0 (X11; Ubuntu; Linux x86_64)" }, "linux"],
  ] as const)("detects %o as %s", (source, expected) => {
    expect(detectDownloadPlatform(source)).toBe(expected);
  });

  it("returns no platform for an unknown client", () => {
    expect(detectDownloadPlatform({ platform: "Unknown" })).toBeUndefined();
  });

  it("keeps available platform links and Linux state in one data source", () => {
    expect(DOWNLOAD_PLATFORMS.macos.href).toBe(OPENBOT_DOWNLOAD_LINKS.macos);
    expect(DOWNLOAD_PLATFORMS.windows.href).toBe(OPENBOT_DOWNLOAD_LINKS.windows);
    expect(DOWNLOAD_PLATFORMS.linux).toMatchObject({ available: false, status: "Coming soon" });
    expect(DOWNLOAD_PLATFORMS.linux.href).toBeUndefined();
  });
});
