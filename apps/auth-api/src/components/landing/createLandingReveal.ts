import { type Accessor, createSignal, onSettled } from "solid-js";

export interface LandingRevealOptions {
  rootMargin?: string;
}

export function createLandingReveal(
  getElement: () => Element | undefined,
  options: LandingRevealOptions = {},
): Accessor<boolean> {
  const [revealed, setRevealed] = createSignal(false);

  onSettled(() => {
    const element = getElement();
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (!element || reducedMotion || !globalThis.IntersectionObserver) {
      setRevealed(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setRevealed(true);
        observer.disconnect();
      },
      { threshold: 0, rootMargin: options.rootMargin ?? "0px 0px -40% 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  });

  return revealed;
}
