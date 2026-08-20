import { fireEvent, render, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentAvatar } from "./AgentAvatar";

const originalMatchMedia = window.matchMedia;

afterEach(() => {
  window.matchMedia = originalMatchMedia;
  vi.unstubAllGlobals();
});

describe("AgentAvatar", () => {
  it("keeps the default avatar static until its interactive parent is hovered", async () => {
    const requestAnimationFrame = vi.fn(() => 1);
    vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    window.matchMedia = reducedMotion(false);
    const view = render(() => (
      <button type="button">
        <AgentAvatar seed="chief" hue={215} />
      </button>
    ));

    expect(view.container.querySelector(".bot-avatar-bloub > svg")).not.toBeNull();
    expect(requestAnimationFrame).not.toHaveBeenCalled();

    const button = view.container.querySelector("button");
    if (!(button instanceof HTMLButtonElement)) throw new Error("Avatar button is missing.");
    await fireEvent.pointerEnter(button);
    await waitFor(() => expect(requestAnimationFrame).toHaveBeenCalled());
  });

  it("does not animate an always-on avatar when reduced motion is enabled", () => {
    const requestAnimationFrame = vi.fn(() => 1);
    vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
    window.matchMedia = reducedMotion(true);

    render(() => <AgentAvatar seed="chief" hue={215} motion="always" />);

    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });

  it("falls back to Bloub when a custom image fails", async () => {
    const view = render(() => <AgentAvatar seed="chief" hue={215} url="mock-avatar://missing" />);
    const image = view.container.querySelector("img");
    if (!(image instanceof HTMLImageElement)) throw new Error("Custom avatar image is missing.");

    await fireEvent.error(image);

    expect(view.container.querySelector(".bot-avatar-bloub > svg")).not.toBeNull();
  });
});

function reducedMotion(matches: boolean): typeof window.matchMedia {
  return vi.fn().mockReturnValue({
    matches,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
}
