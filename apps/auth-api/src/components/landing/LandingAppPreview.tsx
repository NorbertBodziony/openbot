import { onSettled } from "solid-js";

const LANDING_PREVIEW_READY_MESSAGE = "openbot:landing-preview-ready";
const LANDING_PREVIEW_START_MESSAGE = "openbot:landing-preview-start";
const LANDING_PREVIEW_URL = "/app-preview";
const LANDING_PREVIEW_LOAD_DELAY_MS = 200;
const LANDING_PREVIEW_REVEAL_FALLBACK_MS = 400;

function readDuration(name: string, fallback: number): number {
  const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return Number.isFinite(value) ? value : fallback;
}

export function LandingAppPreview() {
  let root: HTMLElement | undefined;
  let iframe: HTMLIFrameElement | undefined;
  let placeholder: HTMLDivElement | undefined;

  onSettled(() => {
    const preview = root;
    const loadingPlaceholder = placeholder;
    const previewFrame = iframe;
    if (!preview || !loadingPlaceholder || !previewFrame) return;

    const origin = window.location.origin;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    let loading = false;
    let ready = false;
    let started = false;
    let loadTimer: ReturnType<typeof setTimeout> | undefined;
    let startTimer: ReturnType<typeof setTimeout> | undefined;

    const start = () => {
      if (!ready || started) return;
      const previewWindow = previewFrame.contentWindow;
      if (!previewWindow) return;
      started = true;
      preview.dataset.previewState = "shown";
      loadingPlaceholder.setAttribute("aria-hidden", "true");
      previewWindow.postMessage({ type: LANDING_PREVIEW_START_MESSAGE }, origin);
    };
    const reveal = () => {
      if (ready) return;
      ready = true;
      preview.dataset.previewState = "ready";
      preview.classList.add("is-revealed");
      const delay = reducedMotion ? 0 : readDuration("--reveal-dur", LANDING_PREVIEW_REVEAL_FALLBACK_MS);
      if (delay === 0) start();
      else startTimer = setTimeout(start, delay);
    };
    const load = () => {
      if (loading) return;
      loading = true;
      preview.dataset.previewState = "loading";
      previewFrame.setAttribute("src", LANDING_PREVIEW_URL);
    };
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== previewFrame.contentWindow) return;
      if (event.data?.type !== LANDING_PREVIEW_READY_MESSAGE) return;
      reveal();
    };

    window.addEventListener("message", handleMessage);
    loadTimer = setTimeout(load, LANDING_PREVIEW_LOAD_DELAY_MS);

    return () => {
      if (loadTimer) clearTimeout(loadTimer);
      if (startTimer) clearTimeout(startTimer);
      window.removeEventListener("message", handleMessage);
    };
  });

  return (
    <section
      ref={root}
      class="landing-preview landing-app-preview t-skel"
      aria-labelledby="app-preview-title"
      data-enter="preview"
      data-preview-state="idle"
    >
      <h2 id="app-preview-title" class="landing-visually-hidden">
        Interactive OpenBot application preview
      </h2>
      <span class="landing-preview-window-controls" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <div
        ref={placeholder}
        class="landing-preview-placeholder t-skel-skeleton"
        role="status"
        aria-label="Loading OpenBot preview"
      />
      <div class="landing-preview-stage t-skel-content">
        <iframe
          ref={iframe}
          title="Interactive OpenBot application preview"
          loading="lazy"
          sandbox="allow-forms allow-same-origin allow-scripts"
        />
      </div>
    </section>
  );
}
