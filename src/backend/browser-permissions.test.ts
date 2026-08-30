import { describe, expect, it } from "vitest";
import { isAllowedBrowserStoragePermission } from "./browser-permissions";

describe("isAllowedBrowserStoragePermission", () => {
  it("allows browser storage access for HTTP(S) pages and embeds", () => {
    expect(isAllowedBrowserStoragePermission("storage-access", "https://x.com")).toBe(true);
    expect(
      isAllowedBrowserStoragePermission("top-level-storage-access", "https://accounts.google.com", "https://x.com"),
    ).toBe(true);
  });

  it("denies other permissions and non-web origins", () => {
    expect(isAllowedBrowserStoragePermission("media", "https://x.com")).toBe(false);
    expect(isAllowedBrowserStoragePermission("storage-access", "file:///tmp/page.html")).toBe(false);
    expect(isAllowedBrowserStoragePermission("storage-access", "https://x.com", "file:///tmp/frame.html")).toBe(false);
  });
});
