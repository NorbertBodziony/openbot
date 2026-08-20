import { createSignal, createUniqueId, For, onSettled, Show } from "solid-js";

export interface LandingGlowStop {
  offset: number;
  color: string;
  opacity?: number;
}

const VIEWBOX_WIDTH = 1271;
const VIEWBOX_HEIGHT = 599;
const BAR_COUNT = 9;
const BLUR = 15;
const PEAK = 0.98;
const VALLEY = 0.55;
const RISE_MS = 1100;
const RETURN_DELAY_MS = 450;

export const landingGlowStops: readonly LandingGlowStop[] = [
  { offset: 0, color: "var(--openbot-logo-production)" },
  { offset: 0.22, color: "var(--openbot-logo-production)" },
  { offset: 0.42, color: "var(--openbot-logo-dev)" },
  { offset: 0.62, color: "var(--openbot-logo-preview)" },
  { offset: 0.82, color: "var(--openbot-logo-production)" },
  { offset: 1, color: "var(--openbot-logo-production)", opacity: 0 },
];

export function landingGlowHeights(): number[] {
  const midpoint = (BAR_COUNT - 1) / 2;
  return Array.from({ length: BAR_COUNT }, (_, index) => {
    const distance = midpoint === 0 ? 0 : Math.abs(index - midpoint) / midpoint;
    const eased = 1 - distance ** 1.24;
    return PEAK * VIEWBOX_HEIGHT * (VALLEY + (1 - VALLEY) * eased);
  });
}

export function landingGlowProgress(top: number, height: number, viewportHeight: number): number {
  return Math.max(0, Math.min(1, (viewportHeight - top) / (height || viewportHeight || 1)));
}

export function LandingGlow() {
  const gradientId = createUniqueId();
  const blurId = createUniqueId();
  const [ready, setReady] = createSignal(false);
  const [rise, setRise] = createSignal(0);
  let root: HTMLDivElement | undefined;

  onSettled(() => {
    const requestIdle = window.requestIdleCallback;
    if (requestIdle) {
      const idleId = requestIdle(() => setReady(true), { timeout: 400 });
      return () => window.cancelIdleCallback?.(idleId);
    }
    const timeoutId = window.setTimeout(() => setReady(true), 0);
    return () => window.clearTimeout(timeoutId);
  });

  onSettled(() => {
    const element = root;
    if (!element) {
      setRise(1);
      return;
    }

    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    let frameId: number | undefined;
    let ticking = false;
    let returnTimer: number | undefined;
    let resetTimer: number | undefined;
    let settle: (() => void) | undefined;
    let returning = false;

    const clearReturn = () => {
      if (returnTimer === undefined) return;
      window.clearTimeout(returnTimer);
      returnTimer = undefined;
    };

    const measure = () => {
      ticking = false;
      if (!element.isConnected) return;
      if (reducedMotion?.matches) {
        setRise(1);
        clearReturn();
        return;
      }

      const bounds = element.getBoundingClientRect();
      const viewportHeight = window.innerHeight || 1;
      const progress = landingGlowProgress(bounds.top, bounds.height, viewportHeight);
      setRise(progress);

      if (returning) return;
      const needed = viewportHeight - bounds.top;
      if (progress <= 0.02 || window.scrollY < needed - 1) {
        clearReturn();
        return;
      }

      clearReturn();
      returnTimer = window.setTimeout(() => {
        returnTimer = undefined;
        returning = true;
        const nextViewportHeight = window.innerHeight || 1;
        const target = window.scrollY - (nextViewportHeight - element.getBoundingClientRect().top);
        window.scrollTo({ top: Math.max(0, target), behavior: "smooth" });

        const finishReturn = () => {
          if (resetTimer !== undefined) {
            window.clearTimeout(resetTimer);
            resetTimer = undefined;
          }
          window.removeEventListener("scrollend", finishReturn);
          settle = undefined;
          returning = false;
          measure();
        };
        settle = finishReturn;
        window.addEventListener("scrollend", finishReturn, { once: true });
        resetTimer = window.setTimeout(finishReturn, 1200);
      }, RETURN_DELAY_MS);
    };

    const scheduleMeasure = () => {
      if (ticking) return;
      ticking = true;
      frameId = window.requestAnimationFrame(measure);
    };

    const handleReducedMotion = () => {
      clearReturn();
      if (settle) settle();
      else measure();
    };

    measure();
    window.addEventListener("scroll", scheduleMeasure, { passive: true });
    window.addEventListener("resize", scheduleMeasure, { passive: true });
    reducedMotion?.addEventListener?.("change", handleReducedMotion);
    return () => {
      clearReturn();
      if (resetTimer !== undefined) window.clearTimeout(resetTimer);
      if (frameId !== undefined) window.cancelAnimationFrame(frameId);
      if (settle) window.removeEventListener("scrollend", settle);
      window.removeEventListener("scroll", scheduleMeasure);
      window.removeEventListener("resize", scheduleMeasure);
      reducedMotion?.removeEventListener?.("change", handleReducedMotion);
    };
  });

  const heights = landingGlowHeights();
  const columnWidth = VIEWBOX_WIDTH / BAR_COUNT;

  return (
    <div ref={root} class="landing-glow" aria-hidden="true" data-slot="landing-glow">
      <div
        class="landing-glow-rise"
        style={{
          transform: `scaleY(${rise()})`,
          "will-change": rise() > 0 && rise() < 1 ? "transform" : "auto",
          "--landing-glow-rise-ms": `${RISE_MS}ms`,
        }}
      >
        <Show when={ready()}>
          <svg
            class="landing-glow-svg"
            viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
            preserveAspectRatio="none"
            fill="none"
            aria-hidden="true"
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="1" x2="0" y2="0">
                <For each={landingGlowStops}>
                  {(stop) => <stop offset={stop.offset} stop-color={stop.color} stop-opacity={stop.opacity ?? 1} />}
                </For>
              </linearGradient>
              <filter id={blurId} x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation={BLUR} />
              </filter>
            </defs>
            <For each={heights}>
              {(height, index) => (
                <g filter={`url(#${blurId})`}>
                  <rect
                    x={index() * columnWidth}
                    y={VIEWBOX_HEIGHT - height}
                    width={columnWidth * 1.23}
                    height={height}
                    fill={`url(#${gradientId})`}
                  />
                </g>
              )}
            </For>
          </svg>
        </Show>
      </div>
    </div>
  );
}
