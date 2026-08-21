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

  it.each(["always", "idle", "working"] as const)(
    "does not animate the %s avatar motion when reduced motion is enabled",
    (motion) => {
      const requestAnimationFrame = vi.fn(() => 1);
      vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
      window.matchMedia = reducedMotion(true);

      render(() => <AgentAvatar seed="chief" hue={215} motion={motion} />);

      expect(requestAnimationFrame).not.toHaveBeenCalled();
    },
  );

  it.each(["idle", "working"] as const)("continuously animates the %s avatar motion", (motion) => {
    const requestAnimationFrame = vi.fn(() => 1);
    vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    window.matchMedia = reducedMotion(false);

    const view = render(() => <AgentAvatar seed="chief" hue={215} motion={motion} />);

    expect(view.container.querySelector(`.bot-avatar-motion-${motion}`)).not.toBeNull();
    expect(requestAnimationFrame).toHaveBeenCalled();
  });

  it("falls back to Bloub when a custom image fails", async () => {
    const view = render(() => <AgentAvatar seed="chief" hue={215} url="mock-avatar://missing" />);
    const image = view.container.querySelector("img");
    if (!(image instanceof HTMLImageElement)) throw new Error("Custom avatar image is missing.");

    await fireEvent.error(image);

    expect(view.container.querySelector(".bot-avatar-bloub > svg")).not.toBeNull();
  });

  it("keeps a custom image static while the agent is working", () => {
    const requestAnimationFrame = vi.fn(() => 1);
    vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
    window.matchMedia = reducedMotion(false);

    const view = render(() => <AgentAvatar seed="chief" hue={215} url="mock-avatar://chief" motion="working" />);

    expect(view.container.querySelector(".bot-avatar-custom.bot-avatar-motion-working > img")).not.toBeNull();
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });
});

function reducedMotion(matches: boolean): typeof window.matchMedia {
  return vi.fn().mockReturnValue({
    matches,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
}
