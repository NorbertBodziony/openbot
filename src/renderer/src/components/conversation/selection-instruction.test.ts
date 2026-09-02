import { describe, expect, it } from "vitest";
import { parseSelectionInstruction, selectionActionsPosition, serializeSelectionInstruction } from "./SelectionActions";

describe("selection instruction messages", () => {
  it("serializes and parses multiline quotes", () => {
    const body = serializeSelectionInstruction("Make this clearer.", "First line\n\nSecond line");

    expect(body).toBe("Make this clearer.\n\n> First line\n> \n> Second line");
    expect(parseSelectionInstruction(body)).toEqual({
      instruction: "Make this clearer.",
      quote: "First line\n\nSecond line",
    });
  });

  it("ignores ordinary blockquotes without an instruction", () => {
    expect(parseSelectionInstruction("> Just a quote")).toBeNull();
    expect(parseSelectionInstruction("Question\n\nNot a quote")).toBeNull();
  });
});

describe("selection actions positioning", () => {
  const toolbar = { width: 280, height: 36 };

  it("centers below the selected lines", () => {
    expect(
      selectionActionsPosition(
        [
          { top: 100, right: 400, bottom: 120, left: 200, width: 200, height: 20 },
          { top: 120, right: 360, bottom: 140, left: 200, width: 160, height: 20 },
        ],
        toolbar,
        { width: 800, height: 600 },
      ),
    ).toEqual({ top: 148, left: 160, placement: "bottom" });
  });

  it("flips above and clamps horizontally near viewport edges", () => {
    expect(
      selectionActionsPosition([{ top: 540, right: 90, bottom: 560, left: 20, width: 70, height: 20 }], toolbar, {
        width: 320,
        height: 600,
      }),
    ).toEqual({ top: 496, left: 12, placement: "top" });
  });
});
