import { describe, expect, it } from "vitest";
import { developmentUserDataName, readDevelopmentProfile, shouldAutoStartHost } from "./development-profile";

describe("development profile", () => {
  it("uses a separate userData folder for the test client", () => {
    expect(developmentUserDataName(readDevelopmentProfile("test-client"))).toBe("OpenBot Dev Test Client");
    expect(developmentUserDataName(readDevelopmentProfile("app"))).toBe("OpenBot Dev");
  });

  it("does not accept an arbitrary profile as a path component", () => {
    expect(readDevelopmentProfile("../../other")).toBe("app");
  });

  it("republishes only when the configured instance was public on the previous launch", () => {
    expect(
      shouldAutoStartHost({
        configured: true,
        enabledOnLaunch: true,
      }),
    ).toBe(true);
    expect(
      shouldAutoStartHost({
        configured: true,
        enabledOnLaunch: false,
      }),
    ).toBe(false);
    expect(shouldAutoStartHost({ configured: false, enabledOnLaunch: true })).toBe(false);
  });
});
