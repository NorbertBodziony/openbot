import { AppLogo } from "@openbot/brand";
import { OPENBOT_INVITE_ORIGIN, toOpenBotInviteUrl } from "@openbot/contracts/invite-links";
import { createSignal, onSettled, Show } from "solid-js";
import { landingAnalytics } from "../../lib/analytics";
import { detectDownloadPlatform } from "../../lib/download-platforms";
import { OPENBOT_DOWNLOAD_LINKS } from "../../lib/landing-links";
import { Button } from "../ui/button";

export function JoinPage() {
  const [openUrl, setOpenUrl] = createSignal("");
  const [downloadUrl, setDownloadUrl] = createSignal<string>(OPENBOT_DOWNLOAD_LINKS.macos);
  const [invalid, setInvalid] = createSignal(false);

  onSettled(() => {
    const cleanup = landingAnalytics.startJoin(document, window.location.hostname);
    try {
      const pageUrl = new URL(window.location.href);
      const canonicalUrl = new URL(`${pageUrl.pathname}${pageUrl.search}`, OPENBOT_INVITE_ORIGIN);
      setOpenUrl(toOpenBotInviteUrl(canonicalUrl.toString()));
    } catch {
      setInvalid(true);
    }
    if (detectDownloadPlatform(globalThis.navigator) === "windows") {
      setDownloadUrl(OPENBOT_DOWNLOAD_LINKS.windows);
    }
    return cleanup;
  });

  return (
    <main class="join-page">
      <a class="landing-brand join-page-brand" href="/" aria-label="OpenBot home">
        <AppLogo variant="production" class="landing-brand-logo" />
        <span>OpenBot</span>
      </a>

      <section class="join-card" aria-labelledby="join-title">
        <div class="join-card-signal" aria-hidden="true">
          <span />
          <i />
          <span />
        </div>
        <AppLogo variant="production" animation="blink" class="join-card-logo" />
        <p class="join-card-eyebrow">Private invitation</p>
        <h1 id="join-title">Connect to an OpenBot host</h1>
        <p class="join-card-copy">
          Open this one-time invitation in OpenBot. The app will verify the host and ask for confirmation before it
          connects.
        </p>

        <Show
          when={!invalid()}
          fallback={<p class="join-card-error">This invitation link is invalid or incomplete.</p>}
        >
          <div class="join-card-actions">
            <Show
              when={openUrl()}
              fallback={
                <span class="landing-button landing-button-primary landing-button-lg join-card-disabled">
                  Open OpenBot
                </span>
              }
            >
              {(href) => (
                <Button href={href()} variant="primary" size="lg" icon="open">
                  Open OpenBot
                </Button>
              )}
            </Show>
            <Button href={downloadUrl()} variant="secondary" size="lg" icon="download">
              Download OpenBot
            </Button>
          </div>
        </Show>

        <p class="join-card-note">Do not forward this link. It can be used only once and expires after 24 hours.</p>
      </section>
    </main>
  );
}
