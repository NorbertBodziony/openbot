import { renderToString } from "@solidjs/web";
import { describe, expect, it } from "vitest";
import { LandingPage } from "../src/components/landing/LandingPage";
import { OPENBOT_DOWNLOAD_LINKS, OPENBOT_LINKS } from "../src/lib/landing-links";
import { AppPreviewPage } from "../src/routes/app-preview.lazy";

describe("landing page", () => {
  it("renders the marketing hero during SSR", () => {
    const markup = renderToString(() => <LandingPage />);

    expect(markup).toContain("Meet");
    expect(markup).toContain("OpenBot");
    expect(markup).toContain("Persistent AI teammates for real work.");
    expect(markup).toContain('data-provider="codex"');
    expect(markup).toContain('data-provider="claude"');
    expect(markup).toContain("NEW");
    expect(markup).toContain("Available on");
    expect(markup).toContain('data-platform="macos"');
    expect(markup).toContain('data-platform="windows"');
    expect(markup).toContain('data-slot="hero-grid"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain("Open source · macOS and Windows");
    expect(markup).not.toContain("Interactive demo coming soon");
    expect(markup).toContain("Interactive OpenBot application preview");
    expect(markup).toContain("landing-button-glass");
    expect(markup).toContain(`href="${OPENBOT_LINKS.repository}"`);
    expect(markup).toContain("GitHub");
    expect(markup.indexOf(`href="${OPENBOT_LINKS.repository}"`)).toBeLessThan(markup.indexOf("</header>"));
    expect(markup).toContain("Download for macOS");
    expect(markup).toContain('aria-label="Choose download platform"');
    expect(markup).toContain('data-detected-platform="macos"');
  });

  it("embeds the real OpenBot application preview during SSR", () => {
    const markup = renderToString(() => <LandingPage />);

    expect(markup).toContain("landing-preview-window-controls");
    expect(markup).toContain("landing-preview-stage");
    expect(markup).not.toContain("OpenBot workspace");
    expect(markup).not.toContain("Live demo");
    expect(markup).toContain('src="/app-preview"');
    expect(markup).toContain('title="Interactive OpenBot application preview"');
    expect(markup).toContain('loading="lazy"');
    expect(markup).toContain('sandbox="allow-forms allow-same-origin allow-scripts"');
    expect(markup).not.toContain("landing-product-demo");
    expect(markup).not.toContain("data-demo-agent");
  });

  it("keeps the application preview SSR-safe until hydration", () => {
    expect(() => renderToString(() => <AppPreviewPage />)).not.toThrow();
    const markup = renderToString(() => <AppPreviewPage />);

    expect(markup).toContain('id="root"');
    expect(markup).toContain('data-preview-variant="landing"');
    expect(markup).toContain('aria-label="Loading OpenBot preview"');
    expect(markup).not.toContain('aria-label="Bot navigation"');
  });

  it("renders the download section and exact platform details", () => {
    const markup = renderToString(() => <LandingPage />);

    expect(markup).toContain('id="download"');
    expect(markup).toContain("Download OpenBot");
    expect(markup).toContain("Choose your platform. Run Codex and Claude side by side from one desktop app.");
    expect(markup).toContain("macOS 12+ · Apple silicon");
    expect(markup).toContain("Windows 10+ · x64");
    expect(markup).toContain("Native Linux build in progress");
    expect(markup).toContain('data-platform="linux"');
    expect(markup.match(/data-download-platform=/g)).toHaveLength(3);
  });

  it("links available downloads and keeps Linux noninteractive", () => {
    const markup = renderToString(() => <LandingPage />);
    const linuxStart = markup.indexOf('data-download-platform="linux"');
    const linuxEnd = markup.indexOf("</article>", linuxStart);
    const linuxCard = markup.slice(linuxStart, linuxEnd);

    expect(markup.match(new RegExp(`href=\\"${OPENBOT_LINKS.releases}\\"`, "g"))).toHaveLength(1);
    expect(markup.match(new RegExp(`href=\\"${OPENBOT_DOWNLOAD_LINKS.macos}\\"`, "g"))).toHaveLength(2);
    expect(markup.match(new RegExp(`href=\\"${OPENBOT_DOWNLOAD_LINKS.windows}\\"`, "g"))).toHaveLength(1);
    expect(markup).toContain("Download for macOS");
    expect(markup).toContain("Download for Windows");
    expect(linuxCard).not.toContain("href=");
    expect(linuxCard).not.toContain("target=");
    expect(linuxCard).not.toContain("<button");
  });

  it("renders the OpenBot footer and glow during SSR", () => {
    const markup = renderToString(() => <LandingPage />);

    expect(markup).toContain('data-slot="landing-footer"');
    expect(markup).toContain('aria-label="Footer navigation"');
    expect(markup).toContain("Persistent AI teammates");
    expect(markup).not.toContain("landing-footer-eyebrow");
    expect(markup).toContain("Product");
    expect(markup).toContain("Resources");
    expect(markup).toContain("Available for macOS and Windows");
    expect(markup).toContain("Made with");
    expect(markup).toContain("in Poland");
    expect(markup).toContain('data-slot="landing-glow"');
  });

  it("renders exact, safe external links", () => {
    const markup = renderToString(() => <LandingPage />);

    expect(markup.match(new RegExp(`href=\\"${OPENBOT_LINKS.download}\\"`, "g"))).toHaveLength(4);
    expect(markup.match(new RegExp(`href=\\"${OPENBOT_LINKS.contact}\\"`, "g"))).toHaveLength(3);
    for (const href of Object.values(OPENBOT_LINKS)) expect(markup).toContain(`href="${href}"`);
    expect(markup.match(/target="_blank"/g)).toHaveLength(15);
    expect(markup.match(/rel="noopener noreferrer"/g)).toHaveLength(15);
    expect(markup).not.toMatch(/href="#download"[^>]+target=/);
  });

  it("keeps the headline logo interactive without browser access during SSR", () => {
    expect(() => renderToString(() => <LandingPage />)).not.toThrow();
    const markup = renderToString(() => <LandingPage />);

    expect(markup).toContain('aria-label="Animate OpenBot logo"');
    expect(markup).toContain('data-animation="blink"');
  });
});
