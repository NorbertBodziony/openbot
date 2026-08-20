import { render } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LandingGlow, landingGlowHeights, landingGlowProgress } from "../src/components/landing/LandingGlow";

function installWindowMocks(reducedMotion = false) {
  const scrollTo = vi.fn();
  Object.defineProperties(window, {
    innerHeight: { configurable: true, value: 900 },
    scrollY: { configurable: true, value: 900 },
    matchMedia: {
      configurable: true,
      value: () => ({
        matches: reducedMotion,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    },
    requestAnimationFrame: {
      configurable: true,
      value: (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      },
    },
    cancelAnimationFrame: { configurable: true, value: vi.fn() },
    requestIdleCallback: {
      configurable: true,
      value: (callback: IdleRequestCallback) => {
        callback({ didTimeout: false, timeRemaining: () => 50 });
        return 1;
      },
    },
    cancelIdleCallback: { configurable: true, value: vi.fn() },
    scrollTo: { configurable: true, value: scrollTo },
  });
  return scrollTo;
}

describe("LandingGlow", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("builds a symmetric nine-column profile and clamps scroll progress", () => {
    const heights = landingGlowHeights();

    expect(heights).toHaveLength(9);
    expect(heights[0]).toBeCloseTo(heights[8]);
    expect(heights[4]).toBeGreaterThan(heights[0] ?? 0);
    expect(landingGlowProgress(900, 500, 900)).toBe(0);
    expect(landingGlowProgress(650, 500, 900)).toBe(0.5);
    expect(landingGlowProgress(300, 500, 900)).toBe(1);
  });

  it("reveals with scroll and returns after the same delay as Jarvis", () => {
    const scrollTo = installWindowMocks();
    const view = render(() => <LandingGlow />);
    const root = view.container.querySelector<HTMLElement>("[data-slot='landing-glow']");
    const rise = view.container.querySelector<HTMLElement>(".landing-glow-rise");
    if (!root || !rise) throw new Error("Expected the landing glow to render");
    Object.defineProperty(root, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ top: 400, height: 500 }),
    });

    window.dispatchEvent(new Event("scroll"));
    expect(rise.style.transform).toBe("scaleY(1)");
    vi.advanceTimersByTime(449);
    expect(scrollTo).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(scrollTo).toHaveBeenCalledWith({ top: 400, behavior: "smooth" });
  });

  it("pins the glow open and disables the return for reduced motion", () => {
    const scrollTo = installWindowMocks(true);
    const view = render(() => <LandingGlow />);
    const rise = view.container.querySelector<HTMLElement>(".landing-glow-rise");

    expect(rise?.style.transform).toBe("scaleY(1)");
    window.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(2000);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("removes scroll and resize listeners on cleanup", () => {
    installWindowMocks();
    const removeEventListener = vi.spyOn(window, "removeEventListener");
    const view = render(() => <LandingGlow />);

    view.unmount();

    expect(removeEventListener).toHaveBeenCalledWith("scroll", expect.any(Function));
    expect(removeEventListener).toHaveBeenCalledWith("resize", expect.any(Function));
  });
});
