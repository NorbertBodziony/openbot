import { render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockOpenBot, type MockOpenBotOptions } from "./mock-openbot";
import { OpenBotPlayground } from "./OpenBotPlayground";

describe("OpenBotPlayground", () => {
  afterEach(() => {
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

  it("uses the curated landing workspace only for the landing variant", () => {
    const activeMock = createMockOpenBot();
    let receivedOptions: MockOpenBotOptions | undefined;

    const view = render(() => (
      <OpenBotPlayground
        variant="landing"
        dependencies={{
          createMock: (options) => {
            receivedOptions = options;
            return activeMock;
          },
          renderApp: () => <div data-testid="landing-openbot-app" />,
        }}
      />
    ));

    expect(view.getByTestId("landing-openbot-app")).toBeInTheDocument();
    expect(receivedOptions?.bots?.map((bot) => bot.name)).toEqual(["Chief", "Research", "Builder", "Launch"]);
    expect(receivedOptions?.servers?.find((server) => server.id === "team")).toMatchObject({
      name: "OpenBot team",
      active: true,
    });
    expect(receivedOptions?.servers?.every((server) => server.logoUrl?.includes("openbot-logo"))).toBe(true);
    expect(receivedOptions?.snapshots?.chief.messages.some((message) => message.text.includes("## Launch plan"))).toBe(
      true,
    );
    expect(receivedOptions?.snapshots?.chief.messages.some((message) => message.exchange)).toBe(true);
    expect(receivedOptions?.directThreads?.map((thread) => thread.otherMemberId).sort()).toEqual([
      "member-alice",
      "member-jon",
      "member-maya",
    ]);
    expect(receivedOptions?.directSnapshots?.["member-alice"]?.messages.at(-1)?.text).toContain("release-note.md");
    expect(receivedOptions?.directSnapshots?.["member-maya"]?.messages).toHaveLength(3);
    expect(receivedOptions?.directSnapshots?.["member-jon"]?.messages).toHaveLength(3);

    view.unmount();
  });

  it("reports ready and accepts a same-origin start message only from its parent", () => {
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
          renderApp: () => <div data-testid="landing-handshake-app" />,
        }}
      />
    ));

    expect(postMessage).not.toHaveBeenCalled();
    frames.get(1)?.(0);
    expect(postMessage).not.toHaveBeenCalled();
    frames.get(2)?.(16);
    expect(postMessage).toHaveBeenCalledWith({ type: "openbot:landing-preview-ready" }, window.location.origin);
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
    expect(updateConversation).toHaveBeenCalled();

    view.unmount();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(cancelAnimationFrame).toHaveBeenCalledWith(2);
    parentFrame.remove();
    if (previousParent) Object.defineProperty(window, "parent", previousParent);
  });
});
