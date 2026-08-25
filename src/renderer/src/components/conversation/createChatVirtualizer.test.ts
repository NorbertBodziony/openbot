import { describe, expect, it } from "vitest";
import { calculateChatScrollMargin } from "./createChatVirtualizer";

describe("chat virtualizer layout", () => {
  it("measures the virtual root within the scroll viewport", () => {
    const scrollElement = document.createElement("div");
    const virtualRoot = document.createElement("div");
    scrollElement.scrollTop = 240;
    Object.defineProperty(scrollElement, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ top: 38 }),
    });
    Object.defineProperty(virtualRoot, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ top: -170 }),
    });

    expect(calculateChatScrollMargin(scrollElement, virtualRoot)).toBe(32);
  });
});
