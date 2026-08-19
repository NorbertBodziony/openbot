import { fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScrollToLatestButton, scrollToLatestMessage } from "./MessageNavigation";

const originalMatchMedia = window.matchMedia;

afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

describe("latest message navigation", () => {
  it("scrolls smoothly to the bottom", () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: false });
    const scrollElement = document.createElement("div");
    const scrollTo = vi.fn();
    Object.defineProperties(scrollElement, {
      scrollHeight: { configurable: true, value: 1_200 },
      scrollTo: { configurable: true, value: scrollTo },
    });

    scrollToLatestMessage(scrollElement);

    expect(scrollTo).toHaveBeenCalledWith({ top: 1_200, behavior: "smooth" });
  });

  it("respects reduced motion", () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true });
    const scrollElement = document.createElement("div");
    const scrollTo = vi.fn();
    Object.defineProperties(scrollElement, {
      scrollHeight: { configurable: true, value: 800 },
      scrollTo: { configurable: true, value: scrollTo },
    });

    scrollToLatestMessage(scrollElement);

    expect(scrollTo).toHaveBeenCalledWith({ top: 800, behavior: "auto" });
  });

  it("exposes an accessible button and handles a click", async () => {
    const onClick = vi.fn();
    render(() => <ScrollToLatestButton onClick={onClick} />);

    await fireEvent.click(screen.getByRole("button", { name: "Scroll to latest message" }));

    expect(onClick).toHaveBeenCalledOnce();
  });
});
