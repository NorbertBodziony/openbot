import { describe, expect, it } from "vitest";
import { anchoredTooltipPosition, type TooltipRect } from "./AnchoredTooltip";

const anchor = (input: Partial<TooltipRect>): TooltipRect => ({
  top: 100,
  right: 120,
  bottom: 120,
  left: 100,
  width: 20,
  height: 20,
  ...input,
});

describe("anchoredTooltipPosition", () => {
  it("centers a tooltip above its anchor", () => {
    expect(anchoredTooltipPosition(anchor({}), { width: 80, height: 30 }, { width: 320, height: 240 })).toEqual({
      left: 70,
      top: 62,
      placement: "top",
    });
  });

  it("clamps the tooltip to both horizontal viewport edges", () => {
    expect(
      anchoredTooltipPosition(anchor({ left: 0, right: 20 }), { width: 120, height: 30 }, { width: 320, height: 240 })
        .left,
    ).toBe(8);
    expect(
      anchoredTooltipPosition(
        anchor({ left: 300, right: 320 }),
        { width: 120, height: 30 },
        { width: 320, height: 240 },
      ).left,
    ).toBe(192);
  });

  it("flips below the anchor when there is no space above", () => {
    expect(
      anchoredTooltipPosition(anchor({ top: 4, bottom: 24 }), { width: 120, height: 40 }, { width: 320, height: 240 }),
    ).toEqual({ left: 50, top: 32, placement: "bottom" });
  });

  it("keeps an oversized tooltip inside the available viewport", () => {
    const position = anchoredTooltipPosition(
      anchor({ top: 12, bottom: 32 }),
      { width: 400, height: 300 },
      { width: 320, height: 240 },
    );
    expect(position.left).toBe(8);
    expect(position.top).toBe(8);
  });
});
