import { describe, expect, it } from "vitest";
import {
  developmentUserDataName,
  readDevelopmentProfile,
  shouldAutoStartHost,
} from "./development-profile";

describe("development profile", () => {
  it("uses a separate userData folder for the host", () => {
    expect(developmentUserDataName(readDevelopmentProfile("host"))).toBe("OpenBot Dev Host");
    expect(developmentUserDataName(readDevelopmentProfile("app"))).toBe("OpenBot Dev");
  });

  it("does not accept an arbitrary profile as a path component", () => {
    expect(readDevelopmentProfile("../../other")).toBe("app");
  });

  it("starts only a configured host", () => {
    expect(
      shouldAutoStartHost({
        configured: true,
        enabledOnLaunch: false,
        forcedByDevelopmentScript: true,
      }),
    ).toBe(true);
    expect(
      shouldAutoStartHost({
        configured: false,
        enabledOnLaunch: true,
        forcedByDevelopmentScript: true,
      }),
    ).toBe(false);
  });
});
