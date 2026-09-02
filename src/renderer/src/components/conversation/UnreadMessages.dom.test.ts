import { afterEach, describe, expect, it, vi } from "vitest";
import { scrollToUnreadBoundary, unreadMessagesDividerIsVisible } from "./UnreadMessages";

// The boundary geometry is shared by the agent conversation and the private
// conversation, so it is tested here once instead of twice through the app.
function elementWithBounds(bounds: { top: number; bottom: number }, attached = true): HTMLElement {
  const element = document.createElement("div");
  Object.defineProperty(element, "getBoundingClientRect", { value: () => bounds });
  if (attached) document.body.append(element);
  return element;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("unread message boundary", () => {
  it("reports the divider visible only while it overlaps the scrolled viewport", () => {
    const scrollElement = elementWithBounds({ top: 100, bottom: 700 });

    expect(unreadMessagesDividerIsVisible(scrollElement, elementWithBounds({ top: 200, bottom: 212 }))).toBe(true);
    expect(unreadMessagesDividerIsVisible(scrollElement, elementWithBounds({ top: 80, bottom: 92 }))).toBe(false);
    expect(unreadMessagesDividerIsVisible(scrollElement, elementWithBounds({ top: 800, bottom: 812 }))).toBe(false);
    expect(unreadMessagesDividerIsVisible(scrollElement, elementWithBounds({ top: 200, bottom: 212 }, false))).toBe(
      false,
    );
  });

  it("scrolls the boundary to the top of its container without passing the first message", () => {
    const scrollElement = elementWithBounds({ top: 100, bottom: 700 });
    const scrollTo = vi.fn();
    Object.defineProperty(scrollElement, "scrollTo", { value: scrollTo });
    Object.defineProperty(scrollElement, "scrollTop", { configurable: true, value: 720 });

    scrollToUnreadBoundary(scrollElement, elementWithBounds({ top: 460, bottom: 472 }), "smooth");
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 1080, behavior: "smooth" });

    scrollToUnreadBoundary(scrollElement, elementWithBounds({ top: -900, bottom: -888 }), "auto");
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: "auto" });
  });
});
