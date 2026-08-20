import { PlatformLogo, type PlatformLogoVariant } from "@openbot/brand";
import { Show } from "solid-js";
import { DOWNLOAD_PLATFORMS } from "../../lib/download-platforms";
import { createLandingReveal } from "./createLandingReveal";
import { LandingIcon } from "./LandingIcon";

interface DownloadCardContentProps {
  action?: string;
  description: string;
  platform: PlatformLogoVariant;
  status: string;
  title: string;
}

function DownloadCardContent(props: DownloadCardContentProps) {
  return (
    <>
      <div class="landing-download-card-top">
        <PlatformLogo platform={props.platform} class="landing-download-platform-logo" />
        <span class="landing-download-status">{props.status}</span>
      </div>
      <div class="landing-download-card-copy">
        <h3>{props.title}</h3>
        <p>{props.description}</p>
        <Show when={props.action}>
          <span class="landing-download-action">
            {props.action}
            <LandingIcon name="arrow-up-right" class="landing-download-arrow" />
          </span>
        </Show>
      </div>
    </>
  );
}

export function DownloadSection() {
  let sectionRef: HTMLElement | undefined;
  const revealed = createLandingReveal(() => sectionRef);
  const revealState = () => (revealed() ? "true" : "false");
  const macos = DOWNLOAD_PLATFORMS.macos;
  const windows = DOWNLOAD_PLATFORMS.windows;
  const linux = DOWNLOAD_PLATFORMS.linux;

  return (
    <section ref={sectionRef} id="download" class="landing-download" aria-labelledby="download-title">
      <div class="landing-download-inner">
        <header class="landing-download-heading" data-revealed={revealState()}>
          <h2 id="download-title">Download OpenBot</h2>
          <p>Choose your platform. Run Codex and Claude side by side from one desktop app.</p>
        </header>

        <div class="landing-download-grid">
          <a
            class="landing-download-card"
            href={macos.href}
            data-download-platform="macos"
            data-state="available"
            data-revealed={revealState()}
          >
            <DownloadCardContent
              platform="macos"
              status={macos.status}
              title={macos.label}
              description={macos.description}
              action={macos.action}
            />
          </a>

          <a
            class="landing-download-card"
            href={windows.href}
            data-download-platform="windows"
            data-state="available"
            data-revealed={revealState()}
          >
            <DownloadCardContent
              platform="windows"
              status={windows.status}
              title={windows.label}
              description={windows.description}
              action={windows.action}
            />
          </a>

          <article
            class="landing-download-card"
            data-download-platform="linux"
            data-state="coming-soon"
            data-revealed={revealState()}
          >
            <DownloadCardContent
              platform="linux"
              status={linux.status}
              title={linux.label}
              description={linux.description}
            />
          </article>
        </div>
      </div>
    </section>
  );
}
