import { render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLandingDemoController } from "./landing-demo";
import { createMockOpenBot } from "./mock-openbot";
import { OpenBotPlayground } from "./OpenBotPlayground";

describe("OpenBotPlayground", () => {
  let previousParent: PropertyDescriptor | undefined;

  afterEach(() => {
    if (previousParent) Object.defineProperty(window, "parent", previousParent);
    previousParent = undefined;
    vi.useRealTimers();
  });

  it("scopes preview usage to the requested agent model", async () => {
    const mock = createMockOpenBot();

    await expect(mock.api.agent.getUsage("chief")).resolves.toMatchObject({
      limits: [{ id: "codex", secondary: { usedPercent: 41 } }],
    });
    await expect(mock.api.agent.getUsage("research")).resolves.toEqual({ limits: [] });
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
    previousParent = Object.getOwnPropertyDescriptor(window, "parent");
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
    parentFrame.remove();
  });
});
