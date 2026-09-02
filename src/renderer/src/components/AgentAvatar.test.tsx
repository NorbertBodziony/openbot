import { render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentAvatar } from "./AgentAvatar";

afterEach(() => vi.unstubAllGlobals());

describe("AgentAvatar", () => {
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
