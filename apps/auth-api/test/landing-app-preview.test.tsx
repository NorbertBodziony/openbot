import { render } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LandingAppPreview } from "../src/components/landing/LandingAppPreview";

class IntersectionObserverMock {
  static instances: IntersectionObserverMock[] = [];
  callback: (entries: Array<{ isIntersecting: boolean; intersectionRatio: number }>) => void;
  disconnect = vi.fn();
  observe = vi.fn();

  constructor(callback: (entries: Array<{ isIntersecting: boolean; intersectionRatio: number }>) => void) {
    this.callback = callback;
    IntersectionObserverMock.instances.push(this);
  }

  intersect(intersectionRatio: number): void {
    this.callback([{ isIntersecting: intersectionRatio > 0, intersectionRatio }]);
  }
}

describe("LandingAppPreview", () => {
  beforeEach(() => {
    IntersectionObserverMock.instances = [];
    vi.stubGlobal("IntersectionObserver", IntersectionObserverMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("starts once only after the iframe is ready and 40% visible", () => {
    const view = render(() => <LandingAppPreview />);
    const frame = view.container.querySelector("iframe");
    const observer = IntersectionObserverMock.instances[0];
    if (!frame?.contentWindow || !observer) throw new Error("Expected the landing iframe and observer");
    const postMessage = vi.spyOn(frame.contentWindow, "postMessage");

    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        source: frame.contentWindow,
        data: { type: "openbot:landing-preview-ready" },
      }),
    );
    observer.intersect(0.39);
    expect(postMessage).not.toHaveBeenCalled();

    observer.intersect(0.4);
    expect(postMessage).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledWith({ type: "openbot:landing-preview-start" }, window.location.origin);
    observer.intersect(1);
    expect(postMessage).toHaveBeenCalledOnce();
  });

  it("waits for a valid same-origin ready message and cleans up", () => {
    const removeEventListener = vi.spyOn(window, "removeEventListener");
    const view = render(() => <LandingAppPreview />);
    const frame = view.container.querySelector("iframe");
    const observer = IntersectionObserverMock.instances[0];
    if (!frame?.contentWindow || !observer) throw new Error("Expected the landing iframe and observer");
    const postMessage = vi.spyOn(frame.contentWindow, "postMessage");
    observer.intersect(0.8);

    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "https://invalid.example",
        source: frame.contentWindow,
        data: { type: "openbot:landing-preview-ready" },
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        source: window,
        data: { type: "openbot:landing-preview-ready" },
      }),
    );
    expect(postMessage).not.toHaveBeenCalled();

    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        source: frame.contentWindow,
        data: { type: "openbot:landing-preview-ready" },
      }),
    );
    expect(postMessage).toHaveBeenCalledOnce();

    view.unmount();
    expect(observer.disconnect).toHaveBeenCalled();
    expect(removeEventListener).toHaveBeenCalledWith("message", expect.any(Function));
  });
});
