import { fireEvent, render, waitFor } from "@solidjs/testing-library";
import type { JSX } from "@solidjs/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LandingPreviewApp } from "./LandingPreviewApp";
import type { LandingPreviewPeopleProps } from "./LandingPreviewPeople";

describe("LandingPreviewApp", () => {
  const originalParent = Object.getOwnPropertyDescriptor(window, "parent");

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (originalParent) Object.defineProperty(window, "parent", originalParent);
  });

  it("renders the lightweight Agents view without installing the desktop API", async () => {
    const previousApi = window.openbot;
    const view = render(() => <LandingPreviewApp />);

    expect(view.getByTestId("landing-preview-app")).toBeInTheDocument();
    expect(view.getByRole("navigation", { name: "Chats" })).toBeInTheDocument();
    expect(view.getByRole("main", { name: "Chief conversation" })).toBeInTheDocument();
    expect(window.openbot).toBe(previousApi);

    await fireEvent.click(view.getByRole("button", { name: /Research/ }));
    await waitFor(() => expect(view.getByRole("main", { name: "Research conversation" })).toBeInTheDocument());
  });

  it("preloads People on intent once and preserves the selected conversation", async () => {
    let resolvePeople:
      | ((module: { LandingPreviewPeople: (props: LandingPreviewPeopleProps) => JSX.Element }) => void)
      | undefined;
    const loadPeople = vi.fn(
      () =>
        new Promise<{ LandingPreviewPeople: (props: LandingPreviewPeopleProps) => JSX.Element }>((resolve) => {
          resolvePeople = resolve;
        }),
    );
    const view = render(() => <LandingPreviewApp dependencies={{ loadPeople }} />);
    const people = view.getByRole("heading", { name: "People" }).parentElement;
    if (!people) throw new Error("Expected the People section");

    await fireEvent.pointerEnter(people);
    await fireEvent.focusIn(people);
    expect(loadPeople).toHaveBeenCalledOnce();

    await fireEvent.click(view.getByRole("button", { name: /Alice/ }));
    expect(view.getByText("Loading conversation…")).toBeInTheDocument();
    expect(loadPeople).toHaveBeenCalledOnce();

    resolvePeople?.({
      LandingPreviewPeople: (props) => <main aria-label={`${props.selectedPersonId} loaded`} />,
    });
    await waitFor(() => expect(view.getByRole("main", { name: "member-alice loaded" })).toBeInTheDocument());
  });

  it("reports a stable frame, validates start, and cleans up timers and listeners", async () => {
    vi.useFakeTimers();
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    });
    const cancelAnimationFrame = vi.fn((id: number) => frames.delete(id));
    vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
    vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false })),
    );

    const parentFrame = document.createElement("iframe");
    document.body.append(parentFrame);
    const parentWindow = parentFrame.contentWindow;
    if (!parentWindow) throw new Error("Expected a parent window");
    Object.defineProperty(window, "parent", { configurable: true, value: parentWindow });
    const postMessage = vi.spyOn(parentWindow, "postMessage");
    const loadPeople = vi.fn(async () => ({
      LandingPreviewPeople: (_props: LandingPreviewPeopleProps) => <main aria-label="People loaded" />,
    }));
    const removeEventListener = vi.spyOn(window, "removeEventListener");
    const view = render(() => <LandingPreviewApp dependencies={{ loadPeople }} />);

    frames.get(1)?.(0);
    expect(postMessage).not.toHaveBeenCalled();
    frames.get(2)?.(16);
    expect(postMessage).toHaveBeenCalledWith({ type: "openbot:landing-preview-ready" }, window.location.origin);
    await vi.advanceTimersByTimeAsync(250);
    expect(postMessage).toHaveBeenCalledTimes(2);

    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "https://invalid.example",
        source: parentWindow,
        data: { type: "openbot:landing-preview-start" },
      }),
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(loadPeople).not.toHaveBeenCalled();

    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        source: parentWindow,
        data: { type: "openbot:landing-preview-start" },
      }),
    );
    await vi.advanceTimersByTimeAsync(1_250);
    expect(view.getByText(/The final launch brief is ready/)).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(3_750);
    expect(loadPeople).toHaveBeenCalledOnce();

    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        source: parentWindow,
        data: { type: "openbot:landing-preview-start" },
      }),
    );
    expect(loadPeople).toHaveBeenCalledOnce();

    view.unmount();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(cancelAnimationFrame).toHaveBeenCalledWith(2);
    expect(removeEventListener).toHaveBeenCalledWith("message", expect.any(Function));
    parentFrame.remove();
  });

  it("shows the final scripted state immediately for reduced motion", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true })),
    );
    const parentFrame = document.createElement("iframe");
    document.body.append(parentFrame);
    const parentWindow = parentFrame.contentWindow;
    if (!parentWindow) throw new Error("Expected a parent window");
    Object.defineProperty(window, "parent", { configurable: true, value: parentWindow });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    const view = render(() => <LandingPreviewApp />);

    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        source: parentWindow,
        data: { type: "openbot:landing-preview-start" },
      }),
    );

    await waitFor(() => expect(view.getByText(/The final launch brief is ready/)).toBeInTheDocument());
    parentFrame.remove();
  });
});
