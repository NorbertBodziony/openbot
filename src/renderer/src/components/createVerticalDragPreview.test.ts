import { afterEach, describe, expect, it, vi } from "vitest";
import { createVerticalDragPreview } from "./createVerticalDragPreview";

describe("createVerticalDragPreview", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("moves immediately without repeated layout reads", () => {
    const bounds = document.createElement("div");
    const source = document.createElement("button");
    document.body.append(bounds, source);

    const boundsRect = vi
      .spyOn(bounds, "getBoundingClientRect")
      .mockReturnValue(DOMRect.fromRect({ x: 10, y: 20, width: 280, height: 400 }));
    vi.spyOn(source, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ x: 18, y: 60, width: 264, height: 40 }),
    );

    const dataTransfer = { setDragImage: vi.fn() };
    const startEvent = { clientY: 70, dataTransfer };

    const preview = createVerticalDragPreview();
    preview.start({
      bounds,
      className: "test-drag-preview",
      event: startEvent,
      source,
    });
    for (let index = 0; index < 100; index += 1) {
      window.dispatchEvent(new MouseEvent("dragover", { clientX: 200, clientY: 80 + index }));
    }

    expect(boundsRect).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector<HTMLElement>(".test-drag-preview")).toHaveStyle({
      left: "18px",
      transform: "translate3d(0px, 169px, 0)",
    });

    preview.stop();
  });

  it("follows horizontal movement without leaving its bounds", () => {
    const bounds = document.createElement("div");
    const source = document.createElement("button");
    document.body.append(bounds, source);
    const boundsRect = vi
      .spyOn(bounds, "getBoundingClientRect")
      .mockReturnValue(DOMRect.fromRect({ x: 10, y: 20, width: 280, height: 400 }));
    vi.spyOn(source, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ x: 18, y: 60, width: 264, height: 54 }),
    );

    const preview = createVerticalDragPreview();
    preview.start({
      bounds,
      className: "test-drag-preview",
      event: { clientX: 150, clientY: 70, dataTransfer: null },
      horizontal: true,
      previewSize: { width: 72, height: 94 },
      source,
    });
    preview.move(200, 500);

    expect(boundsRect).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector<HTMLElement>(".test-drag-preview")).toHaveStyle({
      left: "114px",
      transform: "translate3d(104px, 190px, 0)",
    });
    preview.stop();
  });
});
