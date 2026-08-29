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
          peekContent={<span>3 bots working</span>}
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

  it("opens a hover peek after intent and closes only that peek after exit", async () => {
    vi.useFakeTimers();
    const changed = vi.fn();
    render(() => {
      const [state, setState] = createSignal<DynamicIslandViewState>("compact");
      return (
        <DynamicIsland
          label="working bots"
          state={state()}
          hoverBehavior="peek"
          onStateChange={(next, reason) => {
            changed(next, reason);
            setState(next);
          }}
          compactLeading={<span>3</span>}
          compactTrailing={<span>active</span>}
          peekContent={<span>3 bots working</span>}
          expandedContent={<button type="button">Open Chief</button>}
        />
      );
    });

    const island = screen.getByRole("region", { name: "working bots" });
    const toggle = screen.getByRole("button", { name: "Expand working bots" });
    await fireEvent.mouseEnter(island);
    await vi.advanceTimersByTimeAsync(299);
    expect(changed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(changed).toHaveBeenLastCalledWith("peek", "hover");
    expect(toggle).not.toHaveFocus();

    await fireEvent.mouseLeave(island);
    await vi.advanceTimersByTimeAsync(50);
    await fireEvent.mouseEnter(island);
    await vi.advanceTimersByTimeAsync(100);
    expect(changed).toHaveBeenLastCalledWith("peek", "hover");

    await fireEvent.mouseLeave(island);
    await vi.advanceTimersByTimeAsync(99);
    expect(screen.getByText("3 bots working")).toBeVisible();
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
          hoverBehavior="peek"
          onStateChange={(next, reason) => {
            changed(next, reason);
            setState(next);
          }}
          compactLeading={<span>OpenBot</span>}
          compactTrailing={<span>Wave</span>}
          peekContent={<span />}
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
    expect(changed).toHaveBeenLastCalledWith("peek", "hover");

    await fireEvent.pointerLeave(island, { pointerType: "mouse" });
    await vi.advanceTimersByTimeAsync(50);
    await fireEvent.mouseLeave(island);
    await vi.advanceTimersByTimeAsync(50);

    expect(changed).toHaveBeenCalledTimes(2);
    expect(changed).toHaveBeenLastCalledWith("compact", "hover-exit");
  });

  it("does not close an externally controlled peek on pointer exit", async () => {
    vi.useFakeTimers();
    const changed = vi.fn();
    render(() => (
      <DynamicIsland
        label="chat update"
        state="peek"
        hoverBehavior="peek"
        onStateChange={changed}
        compactLeading={<span>Research</span>}
        compactTrailing={<span>1</span>}
        peekContent={<span>New reply</span>}
        expandedContent={<button type="button">Open chat</button>}
      />
    ));

    const island = screen.getByRole("region", { name: "chat update" });
    await fireEvent.pointerEnter(island, { pointerType: "mouse" });
    await fireEvent.pointerLeave(island, { pointerType: "mouse" });
    await vi.advanceTimersByTimeAsync(500);
    expect(changed).not.toHaveBeenCalled();
    expect(screen.getByText("New reply")).toBeVisible();
  });

  it("promotes a hover peek to the full panel on click", async () => {
    vi.useFakeTimers();
    const changed = vi.fn();
    render(() => {
      const [state, setState] = createSignal<DynamicIslandViewState>("compact");
      return (
        <DynamicIsland
          label="question from AI"
          state={state()}
          hoverBehavior="peek"
          onStateChange={(next, reason) => {
            changed(next, reason);
            setState(next);
          }}
          compactLeading={<span>Research</span>}
          compactTrailing={<span>?</span>}
          peekContent={<span>Question preview</span>}
          expandedContent={<button type="button">Answer question</button>}
        />
      );
    });

    const island = screen.getByRole("region", { name: "question from AI" });
    await fireEvent.mouseEnter(island);
    await vi.advanceTimersByTimeAsync(300);
    await fireEvent.click(screen.getByRole("button", { name: "Expand question from AI" }), { detail: 1 });
    expect(changed).toHaveBeenLastCalledWith("expanded", "pointer");

    await fireEvent.mouseLeave(island);
    await vi.advanceTimersByTimeAsync(100);
    expect(screen.getByRole("button", { name: "Answer question" })).toBeVisible();
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
          peekContent={<span>Question preview</span>}
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
          contentMotion="atoll"
          onStateChange={setState}
          compactLeading={<span>!</span>}
          compactTrailing={<span>1</span>}
          peekContent={<span>Approval needed</span>}
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
