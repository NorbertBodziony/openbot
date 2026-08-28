import type { BrowserBounds } from "@openbot/contracts/ipc";

export const BROWSER_PIP_MIN_WIDTH = 300;
export const BROWSER_PIP_MIN_HEIGHT = 220;
const DEFAULT_WIDTH = 420;
const DEFAULT_HEIGHT = 300;
const DISPLAY_MARGIN = 16;

export function constrainBrowserPictureInPictureBounds(
  savedBounds: BrowserBounds | undefined,
  mainWindowBounds: BrowserBounds,
  workAreas: BrowserBounds[],
): BrowserBounds {
  const fallbackWorkArea = workAreas[0] ?? mainWindowBounds;
  const mainCenter = {
    x: mainWindowBounds.x + mainWindowBounds.width / 2,
    y: mainWindowBounds.y + mainWindowBounds.height / 2,
  };
  const mainWorkArea =
    workAreas.find(
      (area) =>
        mainCenter.x >= area.x &&
        mainCenter.x <= area.x + area.width &&
        mainCenter.y >= area.y &&
        mainCenter.y <= area.y + area.height,
    ) ?? fallbackWorkArea;
  const target = savedBounds
    ? (workAreas.find((area) => rectanglesIntersect(savedBounds, area)) ?? mainWorkArea)
    : mainWorkArea;
  const width = Math.min(target.width, Math.max(BROWSER_PIP_MIN_WIDTH, savedBounds?.width ?? DEFAULT_WIDTH));
  const height = Math.min(target.height, Math.max(BROWSER_PIP_MIN_HEIGHT, savedBounds?.height ?? DEFAULT_HEIGHT));
  const defaultX = target.x + target.width - width - DISPLAY_MARGIN;
  const defaultY = target.y + target.height - height - DISPLAY_MARGIN;
  return {
    x: Math.round(Math.min(target.x + target.width - width, Math.max(target.x, savedBounds?.x ?? defaultX))),
    y: Math.round(Math.min(target.y + target.height - height, Math.max(target.y, savedBounds?.y ?? defaultY))),
    width: Math.round(width),
    height: Math.round(height),
  };
}

function rectanglesIntersect(left: BrowserBounds, right: BrowserBounds): boolean {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  );
}
