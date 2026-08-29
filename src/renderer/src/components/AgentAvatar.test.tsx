import { fireEvent, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentAvatar } from "./AgentAvatar";

afterEach(() => vi.unstubAllGlobals());

describe("AgentAvatar", () => {
  it("falls back to Bloub when a custom image fails", async () => {
    const view = render(() => <AgentAvatar seed="chief" hue={215} url="mock-avatar://missing" />);
    const image = view.container.querySelector("img");
    if (!(image instanceof HTMLImageElement)) throw new Error("Custom avatar image is missing.");

    await fireEvent.error(image);

    expect(view.container.querySelector("img")).toBeNull();
    expect(view.container.querySelector(".bot-avatar-bloub > svg")).not.toBeNull();
  });

  it("does not animate a working avatar when reduced motion is requested", () => {
    const requestAnimationFrame = vi.fn(() => 1);
    vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );

    render(() => <AgentAvatar seed="chief" hue={215} motion="working" shape="cercle" />);

    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });
});
