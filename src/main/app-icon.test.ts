import { describe, expect, it } from "vitest";
import { appIconFileName, readAppVariant, resolveAppIconPath } from "./app-icon";

describe("app icon variant", () => {
  it("defaults to dev for an unpackaged app and production for a packaged app", () => {
    expect(readAppVariant(undefined, false)).toBe("dev");
    expect(readAppVariant(undefined, true)).toBe("production");
  });

  it("accepts explicit dev, preview, and production variants", () => {
    expect(readAppVariant("dev", true)).toBe("dev");
    expect(readAppVariant("preview", false)).toBe("preview");
    expect(readAppVariant("production", false)).toBe("production");
  });

  it("falls back safely for unknown values", () => {
    expect(readAppVariant("staging", false)).toBe("dev");
    expect(readAppVariant("staging", true)).toBe("production");
  });

  it("resolves source and packaged icon paths", () => {
    expect(appIconFileName("preview")).toBe("icon-preview.png");
    expect(
      resolveAppIconPath({
        variant: "dev",
        isPackaged: false,
        resourcesPath: "/Applications/OpenBot.app/Contents/Resources",
        sourceRoot: "/workspace/openbot",
      }),
    ).toBe("/workspace/openbot/build/icon-dev.png");
    expect(
      resolveAppIconPath({
        variant: "production",
        isPackaged: true,
        resourcesPath: "/Applications/OpenBot.app/Contents/Resources",
        sourceRoot: "/workspace/openbot",
      }),
    ).toBe("/Applications/OpenBot.app/Contents/Resources/icons/icon-production.png");
  });
});
