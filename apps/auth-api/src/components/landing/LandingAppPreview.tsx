import { onSettled } from "solid-js";

const LANDING_PREVIEW_READY_MESSAGE = "openbot:landing-preview-ready";
const LANDING_PREVIEW_START_MESSAGE = "openbot:landing-preview-start";
const LANDING_PREVIEW_URL = "/app-preview";
const LANDING_PREVIEW_LOAD_DELAY_MS = 300;
const LANDING_PREVIEW_REVEAL_FALLBACK_MS = 240;

const LANDING_PREVIEW_MARKS = {
  ready: "openbot:landing-preview:ready",
  shown: "openbot:landing-preview:shown",
  src: "openbot:landing-preview:src",
} as const;

function readDuration(name: string, fallback: number): number {
  const rawValue = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const value = Number.parseFloat(rawValue);
  if (!Number.isFinite(value)) return fallback;
  return rawValue.endsWith("s") && !rawValue.endsWith("ms") ? value * 1_000 : value;
}

function markPreviewTiming(name: (typeof LANDING_PREVIEW_MARKS)[keyof typeof LANDING_PREVIEW_MARKS]): void {
  window.performance.mark?.(name);
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
    let firstPaintFrame: number | undefined;
    let stablePaintFrame: number | undefined;
    let loadTimer: ReturnType<typeof setTimeout> | undefined;
    let startTimer: ReturnType<typeof setTimeout> | undefined;

    const start = () => {
      if (!ready || started) return;
      const previewWindow = previewFrame.contentWindow;
      if (!previewWindow) return;
      started = true;
      preview.dataset.previewState = "shown";
      loadingPlaceholder.setAttribute("aria-hidden", "true");
      markPreviewTiming(LANDING_PREVIEW_MARKS.shown);
      previewWindow.postMessage({ type: LANDING_PREVIEW_START_MESSAGE }, origin);
    };
    const reveal = () => {
      if (ready) return;
      ready = true;
      preview.dataset.previewState = "ready";
      markPreviewTiming(LANDING_PREVIEW_MARKS.ready);
      preview.classList.add("is-revealed");
      const delay = reducedMotion ? 0 : readDuration("--reveal-dur", LANDING_PREVIEW_REVEAL_FALLBACK_MS);
      if (delay === 0) start();
      else startTimer = setTimeout(start, delay);
    };
    const load = () => {
      if (loading) return;
      loading = true;
      preview.dataset.previewState = "loading";
      markPreviewTiming(LANDING_PREVIEW_MARKS.src);
      previewFrame.setAttribute("src", LANDING_PREVIEW_URL);
    };
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== previewFrame.contentWindow) return;
      if (event.data?.type !== LANDING_PREVIEW_READY_MESSAGE) return;
      reveal();
    };

    window.addEventListener("message", handleMessage);
    firstPaintFrame = window.requestAnimationFrame(() => {
      stablePaintFrame = window.requestAnimationFrame(() => {
        loadTimer = setTimeout(load, LANDING_PREVIEW_LOAD_DELAY_MS);
      });
    });

    return () => {
      if (firstPaintFrame !== undefined) window.cancelAnimationFrame(firstPaintFrame);
      if (stablePaintFrame !== undefined) window.cancelAnimationFrame(stablePaintFrame);
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
          sandbox="allow-forms allow-same-origin allow-scripts"
        />
      </div>
    </section>
  );
}
