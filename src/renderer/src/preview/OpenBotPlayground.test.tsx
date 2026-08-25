import { render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLandingDemoController } from "./landing-demo";
import { createMockOpenBot } from "./mock-openbot";
import { OpenBotPlayground } from "./OpenBotPlayground";

describe("OpenBotPlayground", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("installs the mock desktop API and restores the previous API on cleanup", () => {
    const previousMock = createMockOpenBot();
    const activeMock = createMockOpenBot();
    const dispose = vi.spyOn(activeMock, "dispose");
    const subscribe = vi.spyOn(activeMock, "onLatestConversationOpened");
    const subscribeDirect = vi.spyOn(activeMock, "onLatestDirectConversationOpened");
    window.openbot = previousMock.api;

    const view = render(() => (
      <OpenBotPlayground
        dependencies={{
          createMock: () => activeMock,
          renderApp: () => <div data-testid="openbot-app" />,
        }}
      />
    ));
    expect(view.getByTestId("openbot-app")).toBeInTheDocument();
    expect(window.openbot).toBe(activeMock.api);
    expect(subscribe).not.toHaveBeenCalled();
    expect(subscribeDirect).not.toHaveBeenCalled();

    view.unmount();
    expect(dispose).toHaveBeenCalledOnce();
    expect(window.openbot).toBe(previousMock.api);
    previousMock.dispose();
  });

  it("reports ready and accepts a same-origin start message only from its parent", async () => {
    vi.useFakeTimers();
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      const frame = nextFrame;
      nextFrame += 1;
      frames.set(frame, callback);
      return frame;
    });
    const cancelAnimationFrame = vi.fn((frame: number) => frames.delete(frame));
    vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
    vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);
    const parentFrame = document.createElement("iframe");
    document.body.append(parentFrame);
    const parentWindow = parentFrame.contentWindow;
    if (!parentWindow) throw new Error("Expected a parent window");
    const previousParent = Object.getOwnPropertyDescriptor(window, "parent");
    Object.defineProperty(window, "parent", { configurable: true, value: parentWindow });

    const activeMock = createMockOpenBot();
    const updateConversation = vi.spyOn(activeMock, "updateConversationSnapshot");
    const postMessage = vi.spyOn(parentWindow, "postMessage");
    const view = render(() => (
      <OpenBotPlayground
        variant="landing"
        dependencies={{
          createMock: () => activeMock,
          loadLandingController: async () => ({ createLandingDemoController }),
          renderApp: () => <div data-testid="landing-handshake-app" />,
        }}
      />
    ));

    expect(postMessage).not.toHaveBeenCalled();
    frames.get(1)?.(0);
    expect(postMessage).not.toHaveBeenCalled();
    frames.get(2)?.(16);
    expect(postMessage).toHaveBeenCalledWith({ type: "openbot:landing-preview-ready" }, window.location.origin);
    vi.advanceTimersByTime(250);
    expect(postMessage).toHaveBeenCalledTimes(2);
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "https://invalid.example",
        source: parentWindow,
        data: { type: "openbot:landing-preview-start" },
      }),
    );
    expect(updateConversation).not.toHaveBeenCalled();

    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        source: parentWindow,
        data: { type: "openbot:landing-preview-start" },
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(updateConversation).toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(postMessage).toHaveBeenCalledTimes(2);

    view.unmount();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(cancelAnimationFrame).toHaveBeenCalledWith(2);
    parentFrame.remove();
    if (previousParent) Object.defineProperty(window, "parent", previousParent);
  });
});
