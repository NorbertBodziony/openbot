import { AppLogo, PlatformLogo, ProviderLogo } from "@openbot/brand";
import { onSettled } from "solid-js";
import { landingAnalytics } from "../../lib/analytics";
import { EXTERNAL_LINK_REL, OPENBOT_LINKS } from "../../lib/landing-links";
import { Button } from "../ui/button";
import { DownloadSection } from "./DownloadSection";
import { HeroDownloadSelector } from "./HeroDownloadSelector";
import { LandingAppPreview } from "./LandingAppPreview";
import { LandingFooter } from "./LandingFooter";
import { LandingGlow } from "./LandingGlow";

export function LandingPage() {
  let hero: HTMLDivElement | undefined;

  onSettled(() => {
    landingAnalytics.start(document, window.location.hostname);
    if (!hero) return;
    hero.classList.remove("is-hiding");
    hero.classList.remove("is-shown");
    void hero.offsetHeight;
    hero.classList.add("is-shown");
  });

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
            class="landing-header-contact"
          >
            Contact
          </Button>
          <Button
            href={OPENBOT_LINKS.repository}
            target="_blank"
            rel={EXTERNAL_LINK_REL}
            variant="secondary"
            size="sm"
            icon="github"
            class="landing-button-glass landing-header-github"
            aria-label="Open OpenBot on GitHub"
          >
            <span class="landing-header-github-label">GitHub</span>
          </Button>
          <Button href={OPENBOT_LINKS.download} variant="primary" size="sm" icon="download">
            Download
          </Button>
        </nav>
      </header>

      <main>
        <section class="landing-hero" aria-labelledby="landing-title">
          <div class="landing-hero-grid" data-slot="hero-grid" aria-hidden="true" />
          <div ref={hero} class="landing-hero-copy t-stagger">
            <p class="landing-availability t-stagger-line t-stagger-line--1">
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

            <h1 id="landing-title" class="landing-title t-stagger-line t-stagger-line--2">
              <span>Meet</span>
              <AppLogo variant="production" animation="blink" interactive class="landing-hero-logo" />
              <span>OpenBot</span>
            </h1>

            <p class="landing-description t-stagger-line t-stagger-line--3">
              Persistent AI teammates for real work. Run{" "}
              <span class="landing-provider">
                <ProviderLogo provider="codex" class="landing-provider-logo" />
                Codex
              </span>
              ,{" "}
              <span class="landing-provider">
                <ProviderLogo provider="claude" class="landing-provider-logo" />
                Claude
              </span>{" "}
              and{" "}
              <span class="landing-provider">
                <ProviderLogo provider="grok" class="landing-provider-logo" />
                Grok
              </span>{" "}
              side by side, each with its own workspace, queue, and context.
            </p>

            <div class="landing-actions t-stagger-line t-stagger-line--4">
              <HeroDownloadSelector />
              <Button
                href={OPENBOT_LINKS.contact}
                target="_blank"
                rel={EXTERNAL_LINK_REL}
                variant="secondary"
                size="lg"
                icon="contact"
                class="landing-button-glass"
              >
                Contact
              </Button>
            </div>
          </div>

          <LandingAppPreview />
        </section>
        <DownloadSection />
      </main>
      <LandingFooter />
      <LandingGlow />
    </div>
  );
}
