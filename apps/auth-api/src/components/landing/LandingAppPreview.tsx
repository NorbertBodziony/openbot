import { onSettled } from "solid-js";

const LANDING_PREVIEW_READY_MESSAGE = "openbot:landing-preview-ready";
const LANDING_PREVIEW_START_MESSAGE = "openbot:landing-preview-start";

export function LandingAppPreview() {
  let root: HTMLElement | undefined;
  let iframe: HTMLIFrameElement | undefined;

  onSettled(() => {
    const preview = root;
    const previewWindow = iframe?.contentWindow;
    if (!preview || !previewWindow) return;

    const origin = window.location.origin;
    let ready = false;
    let visible = false;
    let started = false;
    let observer: IntersectionObserver | undefined;

    const startWhenReady = () => {
      if (!ready || !visible || started) return;
      started = true;
      previewWindow.postMessage({ type: LANDING_PREVIEW_START_MESSAGE }, origin);
      observer?.disconnect();
    };
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== previewWindow) return;
      if (event.data?.type !== LANDING_PREVIEW_READY_MESSAGE) return;
      ready = true;
      startWhenReady();
    };

    window.addEventListener("message", handleMessage);
    const IntersectionObserverConstructor = window.IntersectionObserver;
    if (!IntersectionObserverConstructor) {
      visible = true;
      startWhenReady();
    } else {
      observer = new IntersectionObserverConstructor(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting && entry.intersectionRatio >= 0.4)) {
            visible = true;
            startWhenReady();
          }
        },
        { threshold: [0.4] },
      );
      observer.observe(preview);
    }

    return () => {
      observer?.disconnect();
      window.removeEventListener("message", handleMessage);
    };
  });

  return (
    <section
      ref={root}
      class="landing-preview landing-app-preview"
      aria-labelledby="app-preview-title"
      data-enter="preview"
    >
      <h2 id="app-preview-title" class="landing-visually-hidden">
        Interactive OpenBot application preview
      </h2>
      <span class="landing-preview-window-controls" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <div class="landing-preview-stage">
        <iframe
          ref={iframe}
          src="/app-preview"
          title="Interactive OpenBot application preview"
          loading="lazy"
          sandbox="allow-forms allow-same-origin allow-scripts"
        />
      </div>
    </section>
  );
}
