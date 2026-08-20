import type { PlatformLogoVariant } from "@openbot/brand";
import { OPENBOT_LINKS } from "./landing-links";

export type DownloadPlatform = PlatformLogoVariant;

export interface DownloadPlatformDetails {
  action: string;
  available: boolean;
  description: string;
  href?: string;
  id: DownloadPlatform;
  label: string;
  status: "Available" | "Coming soon";
}

export interface PlatformNavigator {
  platform?: string;
  userAgent?: string;
  userAgentData?: {
    platform?: string;
  };
}

export const DOWNLOAD_PLATFORMS: Record<DownloadPlatform, DownloadPlatformDetails> = {
  macos: {
    id: "macos",
    label: "macOS",
    status: "Available",
    description: "macOS 12+ · Apple silicon",
    action: "Download for macOS",
    available: true,
    href: OPENBOT_LINKS.releases,
  },
  windows: {
    id: "windows",
    label: "Windows",
    status: "Available",
    description: "Windows 10+ · x64",
    action: "Download for Windows",
    available: true,
    href: OPENBOT_LINKS.releases,
  },
  linux: {
    id: "linux",
    label: "Linux",
    status: "Coming soon",
    description: "Native Linux build in progress",
    action: "Linux coming soon",
    available: false,
  },
};

export const DOWNLOAD_PLATFORM_ORDER: readonly DownloadPlatform[] = ["macos", "windows", "linux"];

export function detectDownloadPlatform(source: PlatformNavigator): DownloadPlatform | undefined {
  const platform =
    `${source.userAgentData?.platform ?? ""} ${source.platform ?? ""} ${source.userAgent ?? ""}`.toLowerCase();

  if (/windows|win32|win64/.test(platform)) return "windows";
  if (/macintosh|macintel|mac os|iphone|ipad|ipod|mac/.test(platform)) return "macos";
  if (/linux|x11|ubuntu|debian|fedora|android|cros/.test(platform)) return "linux";
  return undefined;
}
