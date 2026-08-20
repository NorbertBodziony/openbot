import { fireEvent, render } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProductDemo } from "../src/components/landing/ProductDemo";

interface DemoIntersectionEntry {
  intersectionRatio: number;
  isIntersecting: boolean;
}

class IntersectionObserverMock {
  static instances: IntersectionObserverMock[] = [];
  callback: (entries: DemoIntersectionEntry[]) => void;
  disconnect = vi.fn();
  observe = vi.fn();

  constructor(callback: (entries: DemoIntersectionEntry[]) => void) {
    this.callback = callback;
    IntersectionObserverMock.instances.push(this);
  }

  setVisibility(intersectionRatio: number): void {
    this.callback([{ intersectionRatio, isIntersecting: intersectionRatio > 0 }]);
  }
}

function installBrowserMocks(reducedMotion = false): void {
  vi.stubGlobal("IntersectionObserver", IntersectionObserverMock);
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      addEventListener: vi.fn(),
      matches: reducedMotion,
      removeEventListener: vi.fn(),
    }),
  });
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
}

function getDemo(view: ReturnType<typeof render>): HTMLElement {
  const demo = view.container.querySelector<HTMLElement>(".landing-product-demo");
  if (!demo) throw new Error("Product demo was not rendered");
  return demo;
}

function getObserver(): IntersectionObserverMock {
  const observer = IntersectionObserverMock.instances[0];
  if (!observer) throw new Error("Product demo observer was not created");
  return observer;
}

describe("ProductDemo", () => {
  beforeEach(() => {
    IntersectionObserverMock.instances = [];
    installBrowserMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("switches agents and keeps the composer disabled", async () => {
    const view = render(() => <ProductDemo />);
    const demo = getDemo(view);
    const research = view.container.querySelector<HTMLButtonElement>('.landing-demo-sidebar [data-agent="research"]');

    expect(demo).toHaveAttribute("data-demo-agent", "chief");
    expect(research).not.toBeNull();
    if (!research) return;
    await fireEvent.click(research);

    expect(demo).toHaveAttribute("data-demo-agent", "research");
    expect(demo).toHaveAttribute("data-demo-user-controlled", "true");
    expect(research).toHaveAttribute("aria-pressed", "true");
    expect(view.container.querySelector('[data-demo-content="research"]')).not.toHaveAttribute("hidden");
    expect(view.container.querySelector('[data-demo-content="chief"]')).toHaveAttribute("hidden");
    expect(view.getByPlaceholderText("Download OpenBot to send messages")).toBeDisabled();
    expect(view.getByRole("button", { name: "Send message unavailable in demo" })).toBeDisabled();
  });

  it("runs the automatic sequence once after 45 percent visibility", async () => {
    const view = render(() => <ProductDemo />);
    const demo = getDemo(view);
    const observer = getObserver();

    observer.setVisibility(0.44);
    await vi.advanceTimersByTimeAsync(7_600);
    expect(demo).toHaveAttribute("data-demo-agent", "chief");

    observer.setVisibility(0.45);
    await vi.advanceTimersByTimeAsync(3_800);
    expect(demo).toHaveAttribute("data-demo-agent", "research");
    await vi.advanceTimersByTimeAsync(3_800);
    expect(demo).toHaveAttribute("data-demo-agent", "release");
    await vi.advanceTimersByTimeAsync(7_600);
    expect(demo).toHaveAttribute("data-demo-agent", "release");
  });

  it("pauses outside the viewport and while the document is hidden", async () => {
    const view = render(() => <ProductDemo />);
    const demo = getDemo(view);
    const observer = getObserver();

    observer.setVisibility(0.45);
    await vi.advanceTimersByTimeAsync(2_000);
    observer.setVisibility(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(demo).toHaveAttribute("data-demo-agent", "chief");

    observer.setVisibility(0.45);
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(demo).toHaveAttribute("data-demo-agent", "chief");

    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(3_800);
    expect(demo).toHaveAttribute("data-demo-agent", "research");
  });

  it("stops autoplay after user input", async () => {
    const view = render(() => <ProductDemo />);
    const demo = getDemo(view);
    const release = view.container.querySelector<HTMLButtonElement>('.landing-demo-sidebar [data-agent="release"]');

    getObserver().setVisibility(0.45);
    expect(release).not.toBeNull();
    if (!release) return;
    await fireEvent.click(release);
    await vi.advanceTimersByTimeAsync(15_200);

    expect(demo).toHaveAttribute("data-demo-agent", "release");
    expect(demo).toHaveAttribute("data-demo-user-controlled", "true");
  });

  it("disables autoplay for reduced motion and cleans up the observer", async () => {
    installBrowserMocks(true);
    const view = render(() => <ProductDemo />);
    const demo = getDemo(view);
    const observer = getObserver();

    observer.setVisibility(0.45);
    await vi.advanceTimersByTimeAsync(7_600);
    expect(demo).toHaveAttribute("data-demo-agent", "chief");

    view.unmount();
    expect(observer.disconnect).toHaveBeenCalledOnce();
  });
});
