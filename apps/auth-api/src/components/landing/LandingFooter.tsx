import { AppLogo } from "@openbot/brand";
import { For } from "solid-js";
import { EXTERNAL_LINK_REL, FOOTER_COLUMNS, OPENBOT_LINKS } from "../../lib/landing-links";
import { createLandingReveal } from "./createLandingReveal";
import { LandingIcon } from "./LandingIcon";

const FOOTER_DESCRIPTION =
  "Persistent AI teammates for real work. Run Codex, Claude, and Grok side by side, each with its own workspace, queue, and context.";

const SOCIALS = [
  {
    label: "GitHub",
    href: OPENBOT_LINKS.repository,
    path: "M12 .7C5.7.7.8 5.6.8 11.9c0 5 3.2 9.3 7.6 10.8.6.1.8-.3.8-.6v-2.2c-3.1.7-3.8-1.3-3.8-1.3-.5-1.3-1.3-1.7-1.3-1.7-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.5-.3-5.1-1.2-5.1-5.6 0-1.2.4-2.2 1.2-3-.1-.3-.5-1.5.1-3 0 0 1-.3 3.3 1.2a11.4 11.4 0 0 1 6 0C17.7 6 18.8 6.3 18.8 6.3c.6 1.5.2 2.7.1 3 .8.8 1.2 1.8 1.2 3 0 4.4-2.6 5.3-5.1 5.6.4.4.8 1.1.8 2.1v3.2c0 .3.2.7.8.6a11.2 11.2 0 0 0 7.6-10.8C23.2 5.6 18.3.7 12 .7Z",
  },
  {
    label: "X",
    href: OPENBOT_LINKS.contact,
    path: "M17.5 3h3.2l-7 8 8.2 10h-6.4l-5-6.5L4.7 21H1.5l7.5-8.5L1.1 3h6.5l4.5 6 5.4-6Zm-1.1 16h1.8L7.6 4.9H5.7L16.4 19Z",
  },
] as const;

export function LandingFooter() {
  let footerRef: HTMLElement | undefined;
  const currentYear = new Date().getFullYear();
  const revealed = createLandingReveal(() => footerRef);

  const revealState = () => (revealed() ? "true" : "false");

  return (
    <footer ref={footerRef} class="landing-footer" data-slot="landing-footer">
      <div class="landing-footer-inner">
        <div class="landing-footer-grid">
          <div class="landing-footer-brand" data-revealed={revealState()}>
            <a class="landing-footer-lockup" href="/" aria-label="OpenBot home">
              <AppLogo variant="production" class="landing-footer-logo" />
              <span>OpenBot</span>
            </a>

            <p class="landing-footer-description">{FOOTER_DESCRIPTION}</p>

            <a class="landing-footer-cta" href={OPENBOT_LINKS.download}>
              <span>Download OpenBot</span>
              <LandingIcon name="download" />
            </a>

            <div class="landing-footer-socials">
              <For each={SOCIALS}>
                {(social) => (
                  <a
                    class="landing-footer-social"
                    href={social.href}
                    target="_blank"
                    rel={EXTERNAL_LINK_REL}
                    aria-label={social.label}
                  >
                    <span class="landing-visually-hidden">{social.label}</span>
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d={social.path} />
                    </svg>
                  </a>
                )}
              </For>
            </div>
          </div>

          <nav class="landing-footer-columns" aria-label="Footer navigation" data-revealed={revealState()}>
            <For each={FOOTER_COLUMNS}>
              {(column) => (
                <div class="landing-footer-column">
                  <h2>{column.title}</h2>
                  <ul>
                    <For each={column.links}>
                      {(link) => (
                        <li>
                          <a
                            href={link.href}
                            target={link.external ? "_blank" : undefined}
                            rel={link.external ? EXTERNAL_LINK_REL : undefined}
                          >
                            {link.label}
                          </a>
                        </li>
                      )}
                    </For>
                  </ul>
                </div>
              )}
            </For>
          </nav>
        </div>

        <div class="landing-footer-bottom" data-revealed={revealState()}>
          <p>&copy; {currentYear} OpenBot. All rights reserved.</p>
          <div class="landing-footer-meta">
            <a href={OPENBOT_LINKS.download}>
              <span class="landing-footer-availability" aria-hidden="true" />
              Available for macOS and Windows
            </a>
            <p class="landing-footer-made">
              Made with
              <LandingIcon name="heart" label="love" />
              in Poland
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
}
