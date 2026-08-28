// @vitest-environment node

import { describe, expect, it } from "vitest";
import { constrainBrowserPictureInPictureBounds } from "./browser-picture-in-picture-bounds";

describe("browser Picture in Picture bounds", () => {
  const mainWindow = { x: 100, y: 80, width: 1200, height: 820 };
  const displays = [
    { x: 0, y: 0, width: 1440, height: 900 },
    { x: 1440, y: 0, width: 1920, height: 1080 },
  ];

  it("places a new window at the bottom-right of the main display", () => {
    expect(constrainBrowserPictureInPictureBounds(undefined, mainWindow, displays)).toEqual({
      x: 1004,
      y: 584,
      width: 420,
      height: 300,
    });
  });

  it("restores bounds on another display and clamps disconnected or oversized bounds", () => {
    expect(
      constrainBrowserPictureInPictureBounds({ x: 1700, y: 120, width: 500, height: 400 }, mainWindow, displays),
    ).toEqual({ x: 1700, y: 120, width: 500, height: 400 });
    expect(
      constrainBrowserPictureInPictureBounds({ x: 5000, y: -900, width: 3000, height: 2000 }, mainWindow, displays),
    ).toEqual({ x: 0, y: 0, width: 1440, height: 900 });
  });
});
