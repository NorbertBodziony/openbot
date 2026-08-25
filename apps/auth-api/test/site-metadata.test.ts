import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  OPENBOT_SECURITY_HEADERS,
  OPENBOT_SITE_DESCRIPTION,
  OPENBOT_SITE_TITLE,
  OPENBOT_SITE_URL,
  OPENBOT_SOCIAL_IMAGE_ALT,
  OPENBOT_SOCIAL_IMAGE_URL,
  OPENBOT_SOFTWARE_APPLICATION,
  openBotHomeHead,
  openBotRootHead,
} from "../src/lib/site-metadata";

const PUBLIC_DIRECTORY = new URL("../public/", import.meta.url);

async function readPngDimensions(fileName: string): Promise<{ width: number; height: number }> {
  const image = await readFile(new URL(fileName, PUBLIC_DIRECTORY));
  expect(image.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

describe("site metadata", () => {
  it("defines the default title, description, browser color, icons, and manifest", () => {
    const head = openBotRootHead();

    expect(head.meta).toContainEqual({ title: OPENBOT_SITE_TITLE });
    expect(head.meta).toContainEqual({ name: "description", content: OPENBOT_SITE_DESCRIPTION });
    expect(head.meta).toContainEqual({ name: "theme-color", content: "#070707" });
    expect(head.links).toEqual([
      { rel: "icon", href: "/favicon.ico", sizes: "any" },
      { rel: "icon", href: "/favicon-32x32.png", type: "image/png", sizes: "32x32" },
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png", sizes: "180x180" },
      { rel: "manifest", href: "/site.webmanifest" },
    ]);
    expect(head.meta.some((entry) => "property" in entry)).toBe(false);
  });

  it("defines canonical, Open Graph, and Twitter metadata only for the home route", () => {
    const head = openBotHomeHead();

    expect(head.links).toEqual([{ rel: "canonical", href: OPENBOT_SITE_URL }]);
    expect(head.meta).toContainEqual({ "script:ld+json": OPENBOT_SOFTWARE_APPLICATION });
    expect(head.meta).toContainEqual({ property: "og:title", content: OPENBOT_SITE_TITLE });
    expect(head.meta).toContainEqual({ property: "og:description", content: OPENBOT_SITE_DESCRIPTION });
    expect(head.meta).toContainEqual({ property: "og:image", content: OPENBOT_SOCIAL_IMAGE_URL });
    expect(head.meta).toContainEqual({ property: "og:image:type", content: "image/png" });
    expect(head.meta).toContainEqual({ property: "og:image:width", content: "1600" });
    expect(head.meta).toContainEqual({ property: "og:image:height", content: "900" });
    expect(head.meta).toContainEqual({ property: "og:image:alt", content: OPENBOT_SOCIAL_IMAGE_ALT });
    expect(head.meta).toContainEqual({ name: "twitter:card", content: "summary_large_image" });
    expect(head.meta).toContainEqual({ name: "twitter:title", content: OPENBOT_SITE_TITLE });
    expect(head.meta).toContainEqual({ name: "twitter:description", content: OPENBOT_SITE_DESCRIPTION });
    expect(head.meta).toContainEqual({ name: "twitter:image", content: OPENBOT_SOCIAL_IMAGE_URL });
    expect(head.meta).toContainEqual({ name: "twitter:image:alt", content: OPENBOT_SOCIAL_IMAGE_ALT });
  });

  it("defines truthful software application data for search engines", () => {
    expect(OPENBOT_SOFTWARE_APPLICATION).toMatchObject({
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: "OpenBot",
      url: OPENBOT_SITE_URL,
      description: OPENBOT_SITE_DESCRIPTION,
      applicationCategory: "DeveloperApplication",
      operatingSystem: ["macOS 12 or later", "Windows 10 or later"],
      isAccessibleForFree: true,
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    });
    expect(OPENBOT_SOFTWARE_APPLICATION.downloadUrl).toEqual([
      "https://openbot.run/download/macos",
      "https://openbot.run/download/windows",
    ]);
  });

  it("defines production security headers", () => {
    expect(OPENBOT_SECURITY_HEADERS).toEqual({
      "Permissions-Policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "SAMEORIGIN",
    });
  });

  it("ships the web manifest with the production identity", async () => {
    const manifest = JSON.parse(await readFile(new URL("site.webmanifest", PUBLIC_DIRECTORY), "utf8"));

    expect(manifest).toMatchObject({
      id: "/",
      name: "OpenBot",
      short_name: "OpenBot",
      description: OPENBOT_SITE_DESCRIPTION,
      start_url: "/",
      scope: "/",
      display: "browser",
      background_color: "#070707",
      theme_color: "#070707",
    });
    expect(manifest.icons).toEqual([
      { src: "/icon-192x192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512x512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    ]);
  });

  it("ships the social image and browser icons at their declared sizes", async () => {
    await expect(readPngDimensions("openbot-social.png")).resolves.toEqual({ width: 1600, height: 900 });
    await expect(readPngDimensions("favicon-32x32.png")).resolves.toEqual({ width: 32, height: 32 });
    await expect(readPngDimensions("apple-touch-icon.png")).resolves.toEqual({ width: 180, height: 180 });
    await expect(readPngDimensions("icon-192x192.png")).resolves.toEqual({ width: 192, height: 192 });
    await expect(readPngDimensions("icon-512x512.png")).resolves.toEqual({ width: 512, height: 512 });

    const favicon = await readFile(new URL("favicon.ico", PUBLIC_DIRECTORY));
    expect(favicon.subarray(0, 4)).toEqual(Buffer.from([0, 0, 1, 0]));
    const faviconView = new DataView(favicon.buffer, favicon.byteOffset, favicon.byteLength);
    expect(faviconView.getUint16(4, true)).toBeGreaterThanOrEqual(3);
  });

  it("ships crawler rules and a home-only sitemap", async () => {
    const [robots, sitemap] = await Promise.all([
      readFile(new URL("robots.txt", PUBLIC_DIRECTORY), "utf8"),
      readFile(new URL("sitemap.xml", PUBLIC_DIRECTORY), "utf8"),
    ]);

    expect(robots).toContain("Allow: /");
    expect(robots).not.toContain("Disallow:");
    expect(robots).toContain("Sitemap: https://openbot.run/sitemap.xml");
    expect(sitemap).toContain(`<loc>${OPENBOT_SITE_URL}</loc>`);
    expect(sitemap.match(/<url>/g)).toHaveLength(1);
  });
});
