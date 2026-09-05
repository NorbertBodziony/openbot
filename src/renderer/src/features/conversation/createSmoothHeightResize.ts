import { onCleanup, onSettled } from "solid-js";

interface SmoothHeightResizeOptions {
  container: () => HTMLElement | undefined;
  content: () => HTMLElement | undefined;
  enabled?: () => boolean;
  skip?: () => boolean;
}

export function createSmoothHeightResize(options: SmoothHeightResizeOptions): void {
  let animation: Animation | undefined;
  let previousHeight: number | undefined;

  const finishAnimation = (current?: Animation) => {
    if (current && animation !== current) return;
    animation = undefined;
    options.container()?.removeAttribute("data-resizing");
  };

  const cancelAnimation = () => {
    animation?.cancel();
    finishAnimation();
  };

  onSettled(() => {
    const observer = new ResizeObserver(() => {
      const container = options.container();
      const content = options.content();
      if (!container || !content) return;
      const nextHeight = content.getBoundingClientRect().height;
      const previous = previousHeight;
      previousHeight = nextHeight;
      if (
        previous === undefined ||
        previous === nextHeight ||
        options.enabled?.() === false ||
        prefersReducedMotion()
      ) {
        return;
      }
      if (options.skip?.()) {
        cancelAnimation();
        return;
      }

      const animatedHeight = Number.parseFloat(getComputedStyle(container).height);
      const startHeight = animation && Number.isFinite(animatedHeight) ? animatedHeight : previous;
      animation?.cancel();
      container.setAttribute("data-resizing", "true");
      const current = container.animate([{ height: `${startHeight}px` }, { height: `${nextHeight}px` }], {
        duration: resizeDuration(),
        easing: resizeEasing(),
      });
      animation = current;
      void current.finished.then(() => finishAnimation(current)).catch(() => undefined);
    });
    const content = options.content();
    if (content) observer.observe(content);
    return () => observer.disconnect();
  });

  onCleanup(cancelAnimation);
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function resizeDuration(): number {
  const value = getComputedStyle(document.documentElement).getPropertyValue("--openbot-duration-overlay").trim();
  if (value.endsWith("ms")) return Number.parseFloat(value) || 240;
  if (value.endsWith("s")) return (Number.parseFloat(value) || 0.24) * 1_000;
  return 240;
}

function resizeEasing(): string {
  return (
    getComputedStyle(document.documentElement).getPropertyValue("--openbot-ease-out").trim() ||
    "cubic-bezier(0.23, 1, 0.32, 1)"
  );
}
