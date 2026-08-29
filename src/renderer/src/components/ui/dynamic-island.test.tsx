import { fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DynamicIsland, type DynamicIslandViewState } from "./dynamic-island";

afterEach(() => vi.useRealTimers());

describe("DynamicIsland", () => {
  it("opens from the compact control and closes with Escape", async () => {
    const changed = vi.fn();
    render(() => {
      const [state, setState] = createSignal<DynamicIslandViewState>("compact");
      return (
        <DynamicIsland
          label="working bots"
          state={state()}
          onStateChange={(next, reason) => {
            changed(next, reason);
            setState(next);
          }}
          compactLeading={<span>3</span>}
          compactTrailing={<span>active</span>}
          expandedContent={<button type="button">Open Chief</button>}
        />
      );
    });

    const toggle = screen.getByRole("button", { name: "Expand working bots" });
    toggle.focus();
    expect(toggle).toHaveFocus();
    await fireEvent.click(toggle, { detail: 1 });
    expect(changed).toHaveBeenCalledWith("expanded", "pointer");
    expect(screen.getByRole("button", { name: "Open Chief" })).toBeVisible();
    await fireEvent.keyDown(screen.getByRole("button", { name: "Open Chief" }), { key: "Escape" });
    expect(changed).toHaveBeenLastCalledWith("compact", "escape");
    expect(screen.getByRole("button", { name: "Expand working bots" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "Expand working bots" })).toHaveFocus();
  });

  it("keeps compact content during hover intent and opens the full panel after it", async () => {
    vi.useFakeTimers();
    const changed = vi.fn();
    render(() => {
      const [state, setState] = createSignal<DynamicIslandViewState>("compact");
      return (
        <DynamicIsland
          label="working bots"
          state={state()}
          hoverBehavior="expand"
          onStateChange={(next, reason) => {
            changed(next, reason);
            setState(next);
          }}
          compactLeading={<span>3</span>}
          compactTrailing={<span>active</span>}
          expandedContent={<button type="button">Open Chief</button>}
        />
      );
    });

    const island = screen.getByRole("region", { name: "working bots" });
    const toggle = screen.getByRole("button", { name: "Expand working bots" });
    await fireEvent.mouseEnter(island);
    await vi.advanceTimersByTimeAsync(299);
    expect(changed).not.toHaveBeenCalled();
    expect(screen.getByText("active")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open Chief" })).not.toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(1);
    expect(changed).toHaveBeenLastCalledWith("expanded", "hover");
    expect(screen.getByRole("button", { name: "Open Chief" })).toBeVisible();
    expect(toggle).not.toHaveFocus();

    await fireEvent.mouseLeave(island);
    await vi.advanceTimersByTimeAsync(99);
    expect(screen.getByRole("button", { name: "Open Chief" })).toBeVisible();
    await vi.advanceTimersByTimeAsync(1);
    expect(changed).toHaveBeenLastCalledWith("compact", "hover-exit");
  });

  it("does not restart hover intent when pointer and mouse events describe the same entry", async () => {
    vi.useFakeTimers();
    const changed = vi.fn();
    render(() => {
      const [state, setState] = createSignal<DynamicIslandViewState>("compact");
      return (
        <DynamicIsland
          label="idle status"
          state={state()}
          hoverBehavior="expand"
          onStateChange={(next, reason) => {
            changed(next, reason);
            setState(next);
          }}
          compactLeading={<span>OpenBot</span>}
          compactTrailing={<span>Wave</span>}
          expandedContent={<span />}
        />
      );
    });

    const island = screen.getByRole("region", { name: "idle status" });
    await fireEvent.pointerEnter(island, { pointerType: "mouse" });
    await vi.advanceTimersByTimeAsync(150);
    await fireEvent.mouseEnter(island);
    await vi.advanceTimersByTimeAsync(150);

    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenLastCalledWith("expanded", "hover");

    await fireEvent.pointerLeave(island, { pointerType: "mouse" });
    await vi.advanceTimersByTimeAsync(50);
    await fireEvent.mouseLeave(island);
    await vi.advanceTimersByTimeAsync(50);

    expect(changed).toHaveBeenCalledTimes(2);
    expect(changed).toHaveBeenLastCalledWith("compact", "hover-exit");
  });

  it("ignores a hover inherited from the mounting pointer position", async () => {
    vi.useFakeTimers();
    const changed = vi.fn();
    render(() => {
      const [state, setState] = createSignal<DynamicIslandViewState>("compact");
      return (
        <DynamicIsland
          label="storybook status"
          state={state()}
          hoverBehavior="expand"
          suppressInitialHover
          onStateChange={(next, reason) => {
            changed(next, reason);
            setState(next);
          }}
          compactLeading={<span>OpenBot</span>}
          compactTrailing={<span>Message</span>}
          expandedContent={<button type="button">Open message</button>}
        />
      );
    });

    const island = screen.getByRole("region", { name: "storybook status" });
    await fireEvent.mouseEnter(island);
    await vi.advanceTimersByTimeAsync(500);
    expect(changed).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Open message" })).not.toBeInTheDocument();

    await fireEvent.mouseLeave(island);
    await fireEvent.mouseEnter(island);
    await vi.advanceTimersByTimeAsync(300);
    expect(changed).toHaveBeenLastCalledWith("expanded", "hover");
    expect(screen.getByRole("button", { name: "Open message" })).toBeVisible();
  });

  it("keeps the compact state for grow-only hover", async () => {
    vi.useFakeTimers();
    const changed = vi.fn();
    render(() => (
      <DynamicIsland
        label="idle status"
        state="compact"
        hoverBehavior="grow"
        onStateChange={changed}
        compactLeading={<span>OpenBot</span>}
        compactTrailing={<span>Wave</span>}
        expandedContent={<button type="button">Open app</button>}
      />
    ));

    const island = screen.getByRole("region", { name: "idle status" });
    await fireEvent.pointerEnter(island, { pointerType: "mouse" });
    await vi.advanceTimersByTimeAsync(500);
    expect(changed).not.toHaveBeenCalled();
    expect(screen.getByText("OpenBot")).toBeVisible();
    expect(screen.getByText("Wave")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open app" })).not.toBeInTheDocument();
  });

  it("ignores pointer clicks and opens the full panel from hover when pointer toggle is disabled", async () => {
    vi.useFakeTimers();
    const changed = vi.fn();
    render(() => {
      const [state, setState] = createSignal<DynamicIslandViewState>("compact");
      return (
        <DynamicIsland
          label="question from AI"
          state={state()}
          hoverBehavior="expand"
          pointerToggle={false}
          onStateChange={(next, reason) => {
            changed(next, reason);
            setState(next);
          }}
          compactLeading={<span>Research</span>}
          compactTrailing={<span>?</span>}
          expandedContent={<button type="button">Answer question</button>}
        />
      );
    });

    const island = screen.getByRole("region", { name: "question from AI" });
    await fireEvent.click(screen.getByRole("button", { name: "Expand question from AI" }), { detail: 1 });
    expect(changed).not.toHaveBeenCalled();
    await fireEvent.mouseEnter(island);
    await vi.advanceTimersByTimeAsync(300);
    expect(changed).toHaveBeenLastCalledWith("expanded", "hover");
    expect(screen.getByRole("button", { name: "Answer question" })).toBeVisible();

    await fireEvent.mouseLeave(island);
    await vi.advanceTimersByTimeAsync(100);
    expect(changed).toHaveBeenLastCalledWith("compact", "hover-exit");
  });

  it("keeps the panel mounted when a closing animation is reopened", async () => {
    vi.useFakeTimers();
    render(() => {
      const [state, setState] = createSignal<DynamicIslandViewState>("expanded");
      return (
        <DynamicIsland
          label="approval request"
          state={state()}
          contentMotion="spring"
          onStateChange={setState}
          compactLeading={<span>!</span>}
          compactTrailing={<span>1</span>}
          expandedContent={<button type="button">Review request</button>}
        />
      );
    });

    const collapse = screen.getByRole("button", { name: "Collapse approval request" });
    await fireEvent.click(collapse, { detail: 1 });
    await vi.advanceTimersByTimeAsync(90);
    await fireEvent.click(screen.getByRole("button", { name: "Expand approval request" }), { detail: 1 });
    await vi.advanceTimersByTimeAsync(180);

    expect(screen.getByRole("button", { name: "Review request" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Collapse approval request" })).toHaveAttribute("aria-expanded", "true");
  });
});
