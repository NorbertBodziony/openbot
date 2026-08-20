import { fireEvent, render, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
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

  it("updates the selected animation dynamically", async () => {
    const [animation, setAnimation] = createSignal<AppLogoAnimation>("blink");
    const view = render(() => <AppLogo variant="production" animation={animation()} />);
    const logo = view.container.querySelector(".app-logo");

    expect(logo).toHaveAttribute("data-animation", "blink");
    setAnimation("look-around");
    await waitFor(() => expect(logo).toHaveAttribute("data-animation", "look-around"));
  });

  it("follows the pointer and winks when an interactive logo is clicked", async () => {
    const view = render(() => <AppLogo variant="production" animation="blink" interactive />);
    const logo = view.container.querySelector<SVGSVGElement>(".app-logo");
    if (!logo) throw new Error("Expected the AppLogo SVG to render");
    Object.defineProperty(logo, "getBoundingClientRect", {
      configurable: true,
      value: () =>
        ({
          left: 0,
          top: 0,
          right: 100,
          bottom: 100,
          width: 100,
          height: 100,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) satisfies DOMRect,
    });

    expect(logo).toHaveAttribute("role", "button");
    expect(logo).toHaveAttribute("aria-label", "Animate OpenBot logo");

    await fireEvent.pointerMove(logo, { clientX: 100, clientY: 25, pointerType: "mouse" });
    expect(logo.style.getPropertyValue("--app-logo-eye-x")).toBe("2.4%");
    expect(logo.style.getPropertyValue("--app-logo-eye-y")).toBe("-0.9%");

    await fireEvent.click(logo);
    expect(logo).toHaveAttribute("data-click-reaction", "wink");

    await fireEvent.pointerLeave(logo);
    expect(logo.style.getPropertyValue("--app-logo-eye-x")).toBe("0%");
    expect(logo.style.getPropertyValue("--app-logo-eye-y")).toBe("0%");
  });

  it("reveals the party easter egg after five rapid clicks", async () => {
    const view = render(() => <AppLogo variant="production" interactive />);
    const logo = view.container.querySelector<SVGSVGElement>(".app-logo");
    if (!logo) throw new Error("Expected the AppLogo SVG to render");

    for (let click = 0; click < 5; click += 1) await fireEvent.click(logo);

    expect(logo).toHaveAttribute("data-easter-egg", "party");
  });
});
