import { AppLogo, PlatformLogo, ProviderLogo } from "@openbot/brand";
import { EXTERNAL_LINK_REL, OPENBOT_LINKS } from "../../lib/landing-links";
import { Button } from "../ui/button";
import { DownloadSection } from "./DownloadSection";
import { HeroDownloadSelector } from "./HeroDownloadSelector";
import { LandingFooter } from "./LandingFooter";
import { LandingGlow } from "./LandingGlow";
import { ProductDemo } from "./ProductDemo";

export function LandingPage() {
  return (
    <div class="landing-page">
      <header class="landing-header" data-enter="header">
        <a class="landing-brand" href="/" aria-label="OpenBot home">
          <AppLogo variant="production" class="landing-brand-logo" />
          <span>OpenBot</span>
        </a>

        <nav class="landing-navigation" aria-label="Primary navigation">
          <Button
            href={OPENBOT_LINKS.contact}
            target="_blank"
            rel={EXTERNAL_LINK_REL}
            variant="secondary"
            size="sm"
            icon="contact"
          >
            Contact
          </Button>
          <Button href={OPENBOT_LINKS.download} variant="primary" size="sm" icon="download">
            Download
          </Button>
        </nav>
      </header>

      <main>
        <section class="landing-hero" aria-labelledby="landing-title">
          <div class="landing-hero-grid" data-slot="hero-grid" aria-hidden="true" />
          <div class="landing-hero-copy" data-enter="hero">
            <p class="landing-availability">
              <span class="landing-availability-new">NEW</span>
              <span class="landing-availability-copy">Available on</span>
              <span class="landing-availability-platform">
                <PlatformLogo platform="macos" />
                macOS
              </span>
              <span class="landing-availability-separator" aria-hidden="true">
                ·
              </span>
              <span class="landing-availability-platform">
                <PlatformLogo platform="windows" />
                Windows
              </span>
            </p>

            <h1 id="landing-title" class="landing-title">
              <span>Meet</span>
              <AppLogo variant="production" animation="blink" interactive class="landing-hero-logo" />
              <span>OpenBot</span>
            </h1>

            <p class="landing-description">
              Persistent AI teammates for real work. Run{" "}
              <span class="landing-provider">
                <ProviderLogo provider="codex" class="landing-provider-logo" />
                Codex
              </span>{" "}
              and{" "}
              <span class="landing-provider">
                <ProviderLogo provider="claude" class="landing-provider-logo" />
                Claude
              </span>{" "}
              side by side, each with its own workspace, queue, and context.
            </p>

            <div class="landing-actions">
              <HeroDownloadSelector />
              <Button
                href={OPENBOT_LINKS.contact}
                target="_blank"
                rel={EXTERNAL_LINK_REL}
                variant="secondary"
                size="lg"
                icon="contact"
              >
                Contact
              </Button>
            </div>
          </div>

          <ProductDemo />
        </section>
        <DownloadSection />
      </main>
      <LandingFooter />
      <LandingGlow />
    </div>
  );
}
