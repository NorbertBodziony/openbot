import { fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScrollToLatestButton, scrollToLatestMessage } from "./MessageNavigation";

const originalMatchMedia = window.matchMedia;

afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

describe("latest message navigation", () => {
  it("scrolls to the bottom of the conversation", () => {
    const scrollElement = document.createElement("div");
    const scrollTo = vi.fn();
    Object.defineProperties(scrollElement, {
      scrollHeight: { configurable: true, value: 1_200 },
      scrollTo: { configurable: true, value: scrollTo },
    });

    scrollToLatestMessage(scrollElement);

    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 1_200 }));
  });

  it("exposes an accessible button and handles a click", async () => {
    const onClick = vi.fn();
    render(() => <ScrollToLatestButton onClick={onClick} />);

    await fireEvent.click(screen.getByRole("button", { name: "Scroll to latest message" }));

    expect(onClick).toHaveBeenCalledOnce();
  });
});
