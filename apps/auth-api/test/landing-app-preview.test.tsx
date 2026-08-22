import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LandingAppPreview } from "../src/components/landing/LandingAppPreview";

describe("LandingAppPreview", () => {
  let nextAnimationFrameId: number;
  let cancelAnimationFrameMock: ReturnType<typeof vi.spyOn>;

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
    cancelAnimationFrameMock = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
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

  it("loads after a short delay, reveals when ready, and starts after the reveal", () => {
    const view = render(() => <LandingAppPreview />);
    const frame = view.container.querySelector("iframe");
    const preview = view.container.querySelector(".landing-preview");
    if (!frame?.contentWindow || !preview) throw new Error("Expected the landing preview");
    expect(frame).not.toHaveAttribute("src");
    expect(preview).toHaveAttribute("data-preview-state", "idle");

    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(149);
    expect(frame).not.toHaveAttribute("src");
    vi.advanceTimersByTime(1);
    expect(frame).toHaveAttribute("src", "/app-preview");
    expect(frame).not.toHaveAttribute("loading");
    expect(preview).toHaveAttribute("data-preview-state", "loading");
    if (!frame.contentWindow) throw new Error("Expected the loaded preview window");
    const postMessage = vi.spyOn(frame.contentWindow, "postMessage");

    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        source: frame.contentWindow,
        data: { type: "openbot:landing-preview-ready" },
      }),
    );
    expect(preview).toHaveClass("is-revealed");
    expect(preview).toHaveAttribute("data-preview-state", "ready");
    expect(postMessage).not.toHaveBeenCalled();

    vi.advanceTimersByTime(239);
    expect(postMessage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(postMessage).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledWith({ type: "openbot:landing-preview-start" }, window.location.origin);
    expect(preview).toHaveAttribute("data-preview-state", "shown");
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        source: frame.contentWindow,
        data: { type: "openbot:landing-preview-ready" },
      }),
    );
    expect(postMessage).toHaveBeenCalledOnce();
  });

  it("waits for a valid same-origin ready message", () => {
    const removeEventListener = vi.spyOn(window, "removeEventListener");
    const view = render(() => <LandingAppPreview />);
    const frame = view.container.querySelector("iframe");
    const preview = view.container.querySelector(".landing-preview");
    if (!frame?.contentWindow || !preview) throw new Error("Expected the landing preview");
    const previewWindow: Window = Object.create(window);
    const postMessage = vi.fn();
    Object.defineProperty(previewWindow, "postMessage", { value: postMessage });
    Object.defineProperty(frame, "contentWindow", { configurable: true, value: previewWindow });
    vi.advanceTimersByTime(150);

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
    expect(preview).not.toHaveClass("is-revealed");
    expect(postMessage).not.toHaveBeenCalled();

    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        source: previewWindow,
        data: { type: "openbot:landing-preview-ready" },
      }),
    );
    expect(preview).toHaveClass("is-revealed");
    vi.advanceTimersByTime(240);
    expect(postMessage).toHaveBeenCalledOnce();

    view.unmount();
    expect(removeEventListener).toHaveBeenCalledWith("message", expect.any(Function));
  });

  it("starts without a reveal delay for reduced motion", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true })),
    );
    const view = render(() => <LandingAppPreview />);
    const frame = view.container.querySelector("iframe");
    const preview = view.container.querySelector(".landing-preview");
    if (!frame?.contentWindow || !preview) throw new Error("Expected the landing preview");
    vi.advanceTimersByTime(150);
    if (!frame.contentWindow) throw new Error("Expected the loaded preview window");
    const postMessage = vi.spyOn(frame.contentWindow, "postMessage");
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        source: frame.contentWindow,
        data: { type: "openbot:landing-preview-ready" },
      }),
    );

    expect(preview).toHaveClass("is-revealed");
    expect(preview).toHaveAttribute("data-preview-state", "shown");
    expect(postMessage).toHaveBeenCalledOnce();
  });

  it("clears a pending start when the preview unmounts", () => {
    const view = render(() => <LandingAppPreview />);
    const frame = view.container.querySelector("iframe");
    if (!frame?.contentWindow) throw new Error("Expected the landing iframe");
    vi.advanceTimersByTime(150);
    if (!frame.contentWindow) throw new Error("Expected the loaded preview window");
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

  it("does not load after unmounting during the delay", () => {
    const view = render(() => <LandingAppPreview />);
    const frame = view.container.querySelector("iframe");
    if (!frame) throw new Error("Expected the landing iframe");
    view.unmount();

    vi.advanceTimersByTime(150);

    expect(frame).not.toHaveAttribute("src");
    expect(cancelAnimationFrameMock).toHaveBeenCalledTimes(2);
  });
});
