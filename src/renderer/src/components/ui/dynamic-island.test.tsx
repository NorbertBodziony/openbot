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
    await fireEvent.click(toggle, { detail: 1 });
    expect(changed).toHaveBeenCalledWith("expanded", "pointer");
    expect(screen.getByRole("button", { name: "Open Chief" })).toBeVisible();
    await fireEvent.keyDown(screen.getByRole("button", { name: "Open Chief" }), { key: "Escape" });
    expect(changed).toHaveBeenLastCalledWith("compact", "escape");
    expect(screen.getByRole("button", { name: "Expand working bots" })).toHaveAttribute("aria-expanded", "false");
  });

  it("makes the mounted panel inert as soon as it collapses", async () => {
    vi.useFakeTimers();
    render(() => {
      const [state, setState] = createSignal<DynamicIslandViewState>("expanded");
      return (
        <DynamicIsland
          label="question from AI"
          state={state()}
          onStateChange={setState}
          compactLeading={<span>Research</span>}
          compactTrailing={<span>Question</span>}
          expandedContent={<button type="button">Answer question</button>}
        />
      );
    });

    const answer = screen.getByRole("button", { name: "Answer question" });
    const panel = answer.closest("[data-slot='dynamic-island-panel']");
    expect(panel).not.toHaveAttribute("inert");

    await fireEvent.click(screen.getByRole("button", { name: "Collapse question from AI" }), { detail: 1 });

    expect(panel).toHaveAttribute("inert");
    expect(panel).toHaveAttribute("aria-hidden", "true");
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
    await fireEvent.mouseEnter(island);
    expect(changed).not.toHaveBeenCalled();
    expect(screen.getByText("active")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open Chief" })).not.toBeInTheDocument();
    await vi.runAllTimersAsync();
    expect(changed).toHaveBeenLastCalledWith("expanded", "hover");
    expect(screen.getByRole("button", { name: "Open Chief" })).toBeVisible();

    await fireEvent.mouseLeave(island);
    expect(screen.getByRole("button", { name: "Open Chief" })).toBeVisible();
    await vi.runAllTimersAsync();
    expect(changed).toHaveBeenLastCalledWith("compact", "hover-exit");
  });
});
