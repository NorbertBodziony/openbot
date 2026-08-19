import { render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import { AppLogo, type AppLogoAnimation } from "./AppLogo";

describe("AppLogo", () => {
  it("renders a static decorative logo by default", () => {
    const view = render(() => <AppLogo variant="production" class="custom-logo" />);
    const logo = view.container.querySelector(".app-logo");

    expect(logo).toHaveClass("custom-logo");
    expect(logo).toHaveAttribute("data-animation", "none");
    expect(logo).toHaveAttribute("data-variant", "production");
    expect(logo).toHaveAttribute("aria-hidden", "true");
    expect(logo?.tagName).toBe("svg");
    expect(logo?.querySelector(".app-logo-background")).not.toBeNull();
    expect(logo?.querySelector("img")).toBeNull();
  });

  it.each<AppLogoAnimation>(["blink", "look-around", "surprised"])("selects the %s eye animation", (animation) => {
    const view = render(() => <AppLogo variant="preview" animation={animation} />);
    const logo = view.container.querySelector(".app-logo");

    expect(logo).toHaveAttribute("data-animation", animation);
    expect(logo).toHaveAttribute("data-variant", "preview");
    expect(logo?.querySelectorAll(".app-logo-eye")).toHaveLength(2);
  });
});
