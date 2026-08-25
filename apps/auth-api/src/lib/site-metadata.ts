export const OPENBOT_SITE_URL = "https://openbot.run/";
export const OPENBOT_SITE_TITLE = "OpenBot: AI teammates for real work";
export const OPENBOT_SITE_DESCRIPTION =
  "Run Codex and Claude side by side as persistent AI teammates, each with its own workspace, queue, and context.";
export const OPENBOT_SOCIAL_IMAGE_URL = `${OPENBOT_SITE_URL}openbot-social.png`;
export const OPENBOT_SOCIAL_IMAGE_ALT = "Meet OpenBot on a dark grid background";

export const OPENBOT_SOFTWARE_APPLICATION = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "OpenBot",
  url: OPENBOT_SITE_URL,
  image: OPENBOT_SOCIAL_IMAGE_URL,
  description: OPENBOT_SITE_DESCRIPTION,
  applicationCategory: "DeveloperApplication",
  operatingSystem: ["macOS 12 or later", "Windows 10 or later"],
  downloadUrl: [`${OPENBOT_SITE_URL}download/macos`, `${OPENBOT_SITE_URL}download/windows`],
  isAccessibleForFree: true,
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
  },
  sameAs: ["https://github.com/NorbertBodziony/openbot"],
} as const;

export const OPENBOT_SECURITY_HEADERS = {
  "Permissions-Policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
} as const;

export function openBotRootHead() {
  return {
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: OPENBOT_SITE_TITLE },
      { name: "description", content: OPENBOT_SITE_DESCRIPTION },
      { name: "application-name", content: "OpenBot" },
      { name: "color-scheme", content: "dark" },
      { name: "theme-color", content: "#070707" },
    ],
    links: [
      { rel: "icon", href: "/favicon.ico", sizes: "any" },
      { rel: "icon", href: "/favicon-32x32.png", type: "image/png", sizes: "32x32" },
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png", sizes: "180x180" },
      { rel: "manifest", href: "/site.webmanifest" },
    ],
  };
}

export function openBotHomeHead() {
  return {
    meta: [
      { "script:ld+json": OPENBOT_SOFTWARE_APPLICATION },
      { property: "og:type", content: "website" },
      { property: "og:site_name", content: "OpenBot" },
      { property: "og:locale", content: "en_US" },
      { property: "og:url", content: OPENBOT_SITE_URL },
      { property: "og:title", content: OPENBOT_SITE_TITLE },
      { property: "og:description", content: OPENBOT_SITE_DESCRIPTION },
      { property: "og:image", content: OPENBOT_SOCIAL_IMAGE_URL },
      { property: "og:image:type", content: "image/png" },
      { property: "og:image:width", content: "1600" },
      { property: "og:image:height", content: "900" },
      { property: "og:image:alt", content: OPENBOT_SOCIAL_IMAGE_ALT },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: OPENBOT_SITE_TITLE },
      { name: "twitter:description", content: OPENBOT_SITE_DESCRIPTION },
      { name: "twitter:image", content: OPENBOT_SOCIAL_IMAGE_URL },
      { name: "twitter:image:alt", content: OPENBOT_SOCIAL_IMAGE_ALT },
    ],
    links: [{ rel: "canonical", href: OPENBOT_SITE_URL }],
  };
}
