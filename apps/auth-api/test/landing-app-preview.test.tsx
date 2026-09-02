import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LandingAppPreview } from "../src/components/landing/LandingAppPreview";

describe("LandingAppPreview", () => {
  let nextAnimationFrameId: number;

  beforeEach(() => {
    nextAnimationFrameId = 1;
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false })),
    );
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback: FrameRequestCallback) => {
      callback(0);
      return nextAnimationFrameId++;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    document.documentElement.style.setProperty("--reveal-dur", "240ms");
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    document.documentElement.style.removeProperty("--reveal-dur");
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("waits for a valid same-origin ready message", () => {
    const removeEventListener = vi.spyOn(window, "removeEventListener");
    const view = render(() => <LandingAppPreview />);
    const frame = view.container.querySelector("iframe");
    if (!frame?.contentWindow) throw new Error("Expected the landing preview");
    const previewWindow: Window = Object.create(window);
    const postMessage = vi.fn();
    Object.defineProperty(previewWindow, "postMessage", { value: postMessage });
    Object.defineProperty(frame, "contentWindow", { configurable: true, value: previewWindow });
    vi.advanceTimersByTime(300);

    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "https://invalid.example",
        source: previewWindow,
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
        source: previewWindow,
        data: { type: "openbot:landing-preview-ready" },
      }),
    );
    vi.advanceTimersByTime(240);
    expect(postMessage).toHaveBeenCalledOnce();

    view.unmount();
    expect(removeEventListener).toHaveBeenCalledWith("message", expect.any(Function));
  });

  it("clears a pending start when the preview unmounts", () => {
    const view = render(() => <LandingAppPreview />);
    const frame = view.container.querySelector("iframe");
    if (!frame?.contentWindow) throw new Error("Expected the landing iframe");
    vi.advanceTimersByTime(300);
    const postMessage = vi.spyOn(frame.contentWindow, "postMessage");
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        source: frame.contentWindow,
        data: { type: "openbot:landing-preview-ready" },
      }),
    );
    view.unmount();
    vi.advanceTimersByTime(240);

    expect(postMessage).not.toHaveBeenCalled();
  });
});
