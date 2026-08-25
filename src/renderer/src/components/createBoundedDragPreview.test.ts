import { afterEach, describe, expect, it, vi } from "vitest";
import { createBoundedDragPreview } from "./createBoundedDragPreview";

describe("createBoundedDragPreview", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("keeps the preview inside horizontal and vertical bounds", () => {
    const bounds = document.createElement("div");
    const source = document.createElement("div");
    bounds.append(source);
    document.body.append(bounds);
    vi.spyOn(bounds, "getBoundingClientRect").mockReturnValue(rect(12, 5, 256, 200));
    vi.spyOn(source, "getBoundingClientRect").mockReturnValue(rect(12, 10, 72, 94));
    const setDragImage = vi.fn();
    const event = { clientX: 48, clientY: 30, dataTransfer: { setDragImage } };
    const preview = createBoundedDragPreview();

    preview.start({ bounds, className: "test-drag-preview", event, source });
    preview.move(800, 800);

    const clone = document.querySelector<HTMLElement>(".test-drag-preview");
    expect(clone?.style.left).toBe("196px");
    expect(clone?.style.top).toBe("111px");

    preview.move(-100, -100);
    expect(clone?.style.left).toBe("12px");
    expect(clone?.style.top).toBe("5px");
    expect(setDragImage).toHaveBeenCalledOnce();
    preview.stop();
    expect(document.querySelector(".test-drag-preview")).not.toBeInTheDocument();
  });
});

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    left,
    right: left + width,
    width,
    height,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}
