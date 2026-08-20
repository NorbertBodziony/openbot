import { render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import { ProviderLogo, type ProviderLogoVariant } from "./ProviderLogo";

describe("ProviderLogo", () => {
  it.each<ProviderLogoVariant>(["codex", "claude"])("renders the decorative %s logo", (provider) => {
    const view = render(() => <ProviderLogo provider={provider} class="provider-logo" />);
    const logo = view.container.querySelector("svg");

    expect(logo).toHaveClass("provider-logo");
    expect(logo).toHaveAttribute("data-provider", provider);
    expect(logo).toHaveAttribute("aria-hidden", "true");
    expect(logo?.querySelector("path")).not.toBeNull();
  });
});
