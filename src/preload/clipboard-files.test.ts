import { describe, expect, it } from "vitest";
import { clipboardFiles } from "./clipboard-files";

describe("clipboardFiles", () => {
  it("reads an image exposed only through clipboard items", () => {
    const image = new File(["image"], "pasted.png", { type: "image/png" });
    const clipboard = {
      files: [],
      items: [
        { kind: "string", type: "text/plain", getAsFile: () => null },
        { kind: "file", type: "image/png", getAsFile: () => image },
      ],
    };

    expect(clipboardFiles(clipboard)).toEqual([image]);
  });
});
