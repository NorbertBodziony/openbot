import { render, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLandingReveal } from "../src/components/landing/createLandingReveal";

class IntersectionObserverMock {
  static instances: IntersectionObserverMock[] = [];
  callback: (entries: Array<{ isIntersecting: boolean }>) => void;
  disconnect = vi.fn();
  observe = vi.fn();

  constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
    this.callback = callback;
    IntersectionObserverMock.instances.push(this);
  }

  reveal(): void {
    this.callback([{ isIntersecting: true }]);
  }
}

function installBrowserMocks(reducedMotion = false): void {
  vi.stubGlobal("IntersectionObserver", IntersectionObserverMock);
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: reducedMotion }),
  });
}

function RevealFixture() {
  let root: HTMLElement | undefined;
  const revealed = createLandingReveal(() => root);

  return <section ref={root} data-revealed={revealed() ? "true" : "false"} />;
}

describe("createLandingReveal", () => {
  beforeEach(() => {
    IntersectionObserverMock.instances = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reveals when the observed section enters the viewport", async () => {
    installBrowserMocks();
    const view = render(() => <RevealFixture />);
    const section = view.container.querySelector("section");
    const observer = IntersectionObserverMock.instances[0];

    expect(section).toHaveAttribute("data-revealed", "false");
    expect(observer?.observe).toHaveBeenCalledWith(section);
    observer?.reveal();
    await waitFor(() => expect(section).toHaveAttribute("data-revealed", "true"));
    expect(observer?.disconnect).toHaveBeenCalled();
  });

  it("disconnects the observer on cleanup", () => {
    installBrowserMocks();
    const view = render(() => <RevealFixture />);
    const observer = IntersectionObserverMock.instances[0];

    view.unmount();
    expect(observer?.disconnect).toHaveBeenCalled();
  });

  it("reveals immediately for reduced motion", () => {
    installBrowserMocks(true);
    const view = render(() => <RevealFixture />);

    expect(view.container.querySelector("section")).toHaveAttribute("data-revealed", "true");
    expect(IntersectionObserverMock.instances).toHaveLength(0);
  });
});
