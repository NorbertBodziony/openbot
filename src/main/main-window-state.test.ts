// @vitest-environment node

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readMainWindowBounds, resolveMainWindowBounds, writeMainWindowBounds } from "./main-window-state";

const primary = { x: 0, y: 0, width: 1440, height: 900 };
const secondary = { x: 1440, y: 0, width: 1920, height: 1080 };

describe("main window state", () => {
  it("restores the last visible bounds", () => {
    expect(
      resolveMainWindowBounds(
        { x: 1700, y: 120, width: 1100, height: 760 },
        [primary, secondary],
        { x: 200, y: 100 },
        { width: 1200, height: 820 },
        { width: 960, height: 640 },
      ),
    ).toEqual({ x: 1700, y: 120, width: 1100, height: 760 });
  });

  it("centers a new window on the display containing the cursor", () => {
    expect(
      resolveMainWindowBounds(
        null,
        [primary, secondary],
        { x: 2000, y: 500 },
        { width: 1200, height: 820 },
        { width: 960, height: 640 },
      ),
    ).toEqual({ x: 1800, y: 130, width: 1200, height: 820 });
  });

  it("moves stale off-screen bounds onto the current display", () => {
    expect(
      resolveMainWindowBounds(
        { x: 4000, y: 120, width: 1200, height: 820 },
        [primary],
        { x: 300, y: 200 },
        { width: 1200, height: 820 },
        { width: 960, height: 640 },
      ),
    ).toEqual({ x: 120, y: 40, width: 1200, height: 820 });
  });

  it("persists valid bounds and ignores malformed state", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-main-window-state-"));
    const path = join(root, "state.json");
    const bounds = { x: 25, y: 30, width: 1200, height: 820 };

    await writeMainWindowBounds(path, bounds);
    await expect(readMainWindowBounds(path)).resolves.toEqual(bounds);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1, ...bounds });

    await writeFile(path, '{"version":1,"x":"bad"}\n');
    await expect(readMainWindowBounds(path)).resolves.toBeNull();
  });
});
