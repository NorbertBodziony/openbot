import { render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import { PlatformLogo, type PlatformLogoVariant } from "./PlatformLogo";

describe("PlatformLogo", () => {
  it.each<PlatformLogoVariant>(["linux", "macos", "windows"])("renders the decorative %s logo", (platform) => {
    const view = render(() => <PlatformLogo platform={platform} class="platform-logo" />);
    const logo = view.container.querySelector("svg");

    expect(logo).toHaveClass("platform-logo");
    expect(logo).toHaveAttribute("data-platform", platform);
    expect(logo).toHaveAttribute("aria-hidden", "true");
    expect(logo).toHaveAttribute("fill", "currentColor");
    expect(logo?.querySelector("path")).not.toBeNull();
  });

  it("renders the Linux mark with its own path", () => {
    const view = render(() => <PlatformLogo platform="linux" />);

    expect(view.container.querySelector("path")?.getAttribute("d")).toContain("M12.504 0");
  });
});
